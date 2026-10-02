import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Locator } from "playwright";
import { preview } from "vite";
import type { PreviewServer } from "vite";
import { required } from "./fixture-types.mts";
import { trackBrowserContext } from "./browser-diagnostics.mts";
import { visualCampaign, visualFixturePlugin } from "./visual-fixture.mts";

const output = fileURLToPath(new URL("../../test-results/artwork/", import.meta.url));
const tall = "/api/media/b_" + "1".repeat(32);
const missing = "/api/media/b_" + "2".repeat(32);
const corrupt = "/api/media/b_" + "3".repeat(32);
const replacement = "/api/media/b_" + "4".repeat(32);
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="240"><rect width="72" height="240" fill="#729ca5"/></svg>';
const collections = [
  ["characters", "characters"],
  ["locations", "locations"],
  ["events", "events"],
  ["mysteries", "mysteries"],
  ["factions", "factions"],
  ["pantheon", "pantheon"],
  ["artifacts", "artifacts"],
  ["history", "historicalEvents"],
  ["companions", "pets"],
] as const;
let browser: Browser, server: PreviewServer, origin: string;

before(async () => {
  await mkdir(output, { recursive: true });
  server = await preview({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    logLevel: "error",
    plugins: [visualFixturePlugin()],
    preview: { host: "127.0.0.1", port: 0 },
  });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function fixture(t: TestContext, width = 1440, theme = "classic", locale = "en") {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    locale: "en-US",
    reducedMotion: "reduce",
    extraHTTPHeaders: { "x-fixture-role": "dm" },
  });
  const errors: string[] = [];
  await trackBrowserContext(t, context, () => assert.deepEqual(errors, []));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  const campaign = structuredClone(visualCampaign);
  for (const [, collection] of collections) {
    required(campaign.collections.find((c) => c.name === collection)).records = [
      ["art", tall],
      ["missing", missing],
      ["corrupt", corrupt],
      ["empty", undefined],
    ].map(([key, portrait]) => ({
      key: required(key),
      revision: 1,
      value: {
        id: key,
        name: "Card " + key,
        visibility: "public",
        knowledge: 4,
        faction: "party",
        ownerType: "party",
        icon: "★",
        ...(portrait ? { portrait } : {}),
      },
    }));
  }
  required(campaign.collections.find((c) => c.name === "settings")).records.push({
    key: "appearance",
    revision: 1,
    value: { theme },
  });
  await page.route("**/api/campaign", (route) => route.fulfill({ json: campaign }));
  await page.route("**" + tall, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg }),
  );
  await page.route("**" + missing, (route) => route.fulfill({ status: 404, body: "Not found" }));
  await page.route("**" + corrupt, (route) =>
    route.fulfill({ contentType: "image/png", body: "Undecodable image" }),
  );
  await page.route("**" + replacement, (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg.replace('width="72"', 'width="144"') }),
  );
  await page.addInitScript((locale) => localStorage.setItem("codex_lang", locale), locale);
  return { page, campaign };
}

async function settled(image: Locator) {
  await image.scrollIntoViewIfNeeded();
  await image.evaluate(async (node: HTMLImageElement) => {
    if (!node.complete)
      await new Promise<void>((resolve) => {
        node.addEventListener("load", () => resolve(), { once: true });
        node.addEventListener("error", () => resolve(), { once: true });
      });
  });
}
async function fitsImage(mark: Locator) {
  const image = mark.locator("img");
  await settled(image);
  const bounds = required(await mark.boundingBox()),
    pixels = required(await image.boundingBox());
  assert.ok(Math.abs(pixels.width - bounds.width) < 1, "image uses the reserved width");
  assert.ok(Math.abs(pixels.height - bounds.height) < 1, "image uses the reserved height");
}
async function fallback(mark: Locator) {
  const image = mark.locator("img");
  if (await image.count()) await settled(image);
  assert.ok((await mark.textContent())?.trim(), "unavailable artwork retains a visible emblem");
  assert.ok(await mark.locator(".ui-artwork-fallback").isVisible());
  assert.equal((await image.count()) > 0 && (await image.isVisible()), false);
}

for (const scenario of [
  { width: 1440, theme: "classic", locale: "en" },
  { width: 390, theme: "moonlit", locale: "cs" },
]) {
  void test(
    `failed artwork preserves every entity card and article in ${scenario.width}/${scenario.theme}`,
    { timeout: 20000 },
    async (t) => {
      const { page } = await fixture(t, scenario.width, scenario.theme, scenario.locale);
      for (const [route] of collections) {
        await page.goto(origin + "/#/" + route);
        await page.locator(".record-row-shell").nth(3).waitFor();
        const good = page.locator(`.record-row[href="#/${route}/art"] .record-row-mark`);
        const goodBounds = required(await good.boundingBox());
        for (const key of ["missing", "corrupt", "empty"]) {
          const mark = page.locator(`.record-row[href="#/${route}/${key}"] .record-row-mark`);
          await fallback(mark);
          const box = required(await mark.boundingBox());
          assert.ok(Math.abs(box.width - goodBounds.width) < 1);
          assert.ok(Math.abs(box.height - goodBounds.height) < 1);
        }
        const edit = page
          .locator(`.record-row[href="#/${route}/missing"]`)
          .locator("..")
          .locator(".ui-card-action");
        assert.ok(await edit.isVisible(), "the failed image keeps the edit action reachable");
        if (route === "characters")
          await page.screenshot({
            path: output + `collection-${scenario.width}-${scenario.theme}.png`,
            fullPage: true,
          });
        await page.goto(origin + `/#/${route}/missing`);
        await page.locator("#record-title").waitFor();
        await fallback(page.locator(".record-portrait"));
        if (route === "characters")
          await page.screenshot({
            path: output + `profile-${scenario.width}-${scenario.theme}.png`,
            fullPage: true,
          });
      }
      await page.goto(origin);
      await page.locator(".party-member").first().waitFor();
      for (const [route, selector] of [
        ["characters", ".party-portrait"],
        ["companions", ".companion-mark"],
      ]) {
        for (const key of ["missing", "corrupt", "empty"])
          await fallback(page.locator(`a[href="#/${route}/${key}"] ${selector}`).first());
      }
      await page.screenshot({
        path: output + `fallback-${scenario.width}-${scenario.theme}.png`,
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
    },
  );

  void test(
    `tall portrait images fit the reserved avatar at ${scenario.width}/${scenario.theme}`,
    { timeout: 15000 },
    async (t) => {
      const { page } = await fixture(t, scenario.width, scenario.theme);
      await page.goto(origin);
      await page.locator(".party-portrait").first().waitFor();
      await fitsImage(page.locator('a[href="#/characters/art"] .party-portrait'));
      await fitsImage(page.locator('a[href="#/companions/art"] .companion-mark'));
    },
  );
}

void test(
  "obsolete portrait events cannot override replacement or repeated sources",
  { timeout: 15000 },
  async (t) => {
    const { page, campaign } = await fixture(t);
    const held = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>();
    await page.route("**" + tall, async (route) => {
      started.resolve();
      await held.promise;
      await route.fulfill({ contentType: "image/svg+xml", body: svg }).catch(() => {});
    });
    try {
      await page.goto(origin);
      await started.promise;
      const mark = page.locator('a[href="#/characters/art"] .party-portrait');
      assert.equal(await mark.getAttribute("data-ui-artwork-state"), "loading");
      assert.ok(await mark.locator(".ui-artwork-fallback").isVisible());
      const loadingBounds = required(await mark.boundingBox());
      const obsolete = required(await mark.locator("img").elementHandle());
      const character = required(campaign.collections.find((c) => c.name === "characters"));
      required(character.records.find((r) => r.key === "art")).value = {
        id: "art",
        name: "Card art",
        faction: "party",
        knowledge: 4,
        portrait: replacement,
      };
      await page.locator("codex-dashboard").evaluate((node, campaign) => {
        (node as HTMLElement & { campaign: unknown }).campaign = campaign;
      }, campaign);
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLImageElement>('a[href="#/characters/art"] .party-portrait img')
            ?.naturalWidth === 144,
      );
      await obsolete.evaluate((node) => node.dispatchEvent(new Event("error")));
      assert.equal(await mark.getAttribute("data-ui-artwork-state"), "ready");
      required(character.records.find((r) => r.key === "art")).value = {
        id: "art",
        name: "Card art",
        faction: "party",
        knowledge: 4,
        portrait: tall,
      };
      await page.locator("codex-dashboard").evaluate((node, campaign) => {
        (node as HTMLElement & { campaign: unknown }).campaign = campaign;
      }, campaign);
      await page.waitForFunction(
        () =>
          document
            .querySelector('a[href="#/characters/art"] .party-portrait')
            ?.getAttribute("data-ui-artwork-state") === "loading",
      );
      await obsolete.evaluate((node) => node.dispatchEvent(new Event("error")));
      assert.equal(await mark.getAttribute("data-ui-artwork-state"), "loading");
      held.resolve();
      await page.waitForFunction(
        () =>
          document
            .querySelector('a[href="#/characters/art"] .party-portrait')
            ?.getAttribute("data-ui-artwork-state") === "ready",
      );
      await fitsImage(mark);
      const readyBounds = required(await mark.boundingBox());
      assert.equal(readyBounds.width, loadingBounds.width);
      assert.equal(readyBounds.height, loadingBounds.height);
    } finally {
      held.resolve();
    }
  },
);

void test(
  "portrait completion during disconnect reconciles on reconnect",
  { timeout: 15000 },
  async (t) => {
    const { page } = await fixture(t);
    const held = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>();
    await page.route("**" + tall, async (route) => {
      started.resolve();
      await held.promise;
      await route.fulfill({ contentType: "image/svg+xml", body: svg }).catch(() => {});
    });
    try {
      await page.goto(origin);
      await started.promise;
      const dashboard = required(await page.locator("codex-dashboard").elementHandle());
      const image = required(await page.locator('a[href="#/characters/art"] img').elementHandle());
      await dashboard.evaluate((node) => node.remove());
      held.resolve();
      await image.evaluate(async (node: HTMLImageElement) => {
        if (!node.complete)
          await new Promise<void>((resolve) =>
            node.addEventListener("load", () => resolve(), { once: true }),
          );
        assertImage(node);
        function assertImage(image: HTMLImageElement) {
          if (image.naturalWidth !== 72) throw new Error("image did not load while disconnected");
        }
      });
      await dashboard.evaluate((node) => document.querySelector("#campaign-content")!.append(node));
      const mark = page.locator('a[href="#/characters/art"] .party-portrait');
      await page.waitForFunction(
        () =>
          document
            .querySelector('a[href="#/characters/art"] .party-portrait')
            ?.getAttribute("data-ui-artwork-state") === "ready",
      );
      await fitsImage(mark);
    } finally {
      held.resolve();
    }
  },
);

void test(
  "portrait preview failures keep replacement, removal and undo local",
  { timeout: 15000 },
  async (t) => {
    const { page } = await fixture(t, 390, "moonlit", "cs");
    await page.goto(origin + "/#/characters");
    await page
      .locator('.record-row[href="#/characters/missing"]')
      .locator("..")
      .locator(".ui-card-action")
      .click();
    await page.getByRole("img", { name: "Náhled portrétu není dostupný", exact: true }).waitFor();
    let writes = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") writes++;
    });
    await page.getByLabel("Vybrat portrét", { exact: true }).setInputFiles({
      name: "replacement.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(svg),
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".portrait-editor-preview")
          ?.getAttribute("data-ui-artwork-state") === "ready",
    );
    assert.match(
      required(await page.locator(".portrait-editor-preview img").getAttribute("src")),
      /^blob:/,
    );
    await page.getByRole("button", { name: "Vrátit změnu portrétu", exact: true }).click();
    await page.getByRole("img", { name: "Náhled portrétu není dostupný", exact: true }).waitFor();
    await page.getByRole("button", { name: "Odstranit portrét", exact: true }).click();
    await fallback(page.locator(".portrait-editor-preview"));
    assert.equal(writes, 0, "preview failure never resets, deletes or uploads saved data");
  },
);

void test(
  "a reconnected portrait editor restores the retained file preview and releases both URLs",
  { timeout: 15000 },
  async (t) => {
    const { page } = await fixture(t);
    await page.goto(origin + "/#/characters");
    await page
      .locator('.record-row[href="#/characters/missing"]')
      .locator("..")
      .locator(".ui-card-action")
      .click();
    await page.getByRole("img", { name: "Portrait preview unavailable", exact: true }).waitFor();
    let writes = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") writes++;
    });
    await page
      .getByLabel("Choose portrait", { exact: true })
      .setInputFiles({ name: "draft.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLImageElement>(".portrait-editor-preview img")?.naturalWidth ===
        72,
    );
    const originalURL = required(
      await page.locator(".portrait-editor-preview img").getAttribute("src"),
    );
    const editor = required(await page.locator("codex-portrait-editor").elementHandle());
    const parent = await editor.evaluateHandle((node) => node.parentElement!);
    await editor.evaluate((node) => node.remove());
    assert.equal(
      await page.evaluate(
        async (url) =>
          fetch(url).then(
            () => true,
            () => false,
          ),
        originalURL,
      ),
      false,
      "disconnect revokes the old object URL",
    );
    await parent.evaluate((node, editor) => node.append(editor), editor);
    await page.waitForFunction(
      () =>
        document
          .querySelector(".portrait-editor-preview")
          ?.getAttribute("data-ui-artwork-state") === "ready",
    );
    const renewedURL = required(
      await page.locator(".portrait-editor-preview img").getAttribute("src"),
    );
    assert.match(renewedURL, /^blob:/);
    assert.notEqual(renewedURL, originalURL);
    assert.equal(
      await editor.evaluate(
        (node) =>
          (node as HTMLElement & { editorValue(): File | null | undefined }).editorValue()?.name,
      ),
      "draft.svg",
    );
    await page.getByRole("button", { name: "Undo portrait change", exact: true }).click();
    await page.getByRole("img", { name: "Portrait preview unavailable", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        async (url) =>
          fetch(url).then(
            () => true,
            () => false,
          ),
        renewedURL,
      ),
      false,
      "undo releases the renewed preview",
    );
    assert.equal(writes, 0, "reconnect does not upload or commit the retained file");
  },
);
