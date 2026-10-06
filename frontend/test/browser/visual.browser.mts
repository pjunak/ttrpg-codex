import { required } from "./fixture-types.mts";
import type { Browser, Page, Locator } from "playwright";
import type { TestContext } from "node:test";
import type { PreviewServer } from "vite";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";
import { visualCampaign, visualFixturePlugin } from "./visual-fixture.mts";

let server: PreviewServer, browser: Browser, origin: string;
const artifacts = fileURLToPath(new URL("../../test-results/visual/", import.meta.url));
before(async () => {
  await mkdir(artifacts, { recursive: true });
  const root = fileURLToPath(new URL("../../", import.meta.url));
  server = await preview({
    root,
    configFile: false,
    plugins: [visualFixturePlugin()],
    logLevel: "error",
    preview: { host: "127.0.0.1", port: 0 },
  });
  origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function fixture(
  t: TestContext,
  viewport: { width: number; height: number },
  role = "",
  addon = false,
) {
  const context = await browser.newContext({
    viewport,
    locale: "en-US",
    reducedMotion: "reduce",
    ...(role
      ? { extraHTTPHeaders: { "x-fixture-role": role, "x-fixture-addon": String(addon) } }
      : {}),
  });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "browser errors"));
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(origin)) external.push(request.url());
  });
  t.after(() => assert.deepEqual(external, [], "fonts and branding must load locally"));
  await page.goto(origin);
  await page.locator("#campaign-title").waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.ok(
    await page.evaluate(() =>
      ["Cinzel Variable", "Lora Variable", "Inter Variable"].every((font) =>
        document.fonts.check(`16px "${font}"`),
      ),
    ),
    "the deployed font files must actually load",
  );
  assert.equal(await page.locator(".application-alert").count(), 0);
  return page;
}

async function style(page: Page, selector: string, properties: string[]) {
  return page
    .locator(selector)
    .first()
    .evaluate((element, properties) => {
      const css = getComputedStyle(element);
      return Object.fromEntries(
        properties.map((property) => [property, css.getPropertyValue(property)]),
      );
    }, properties);
}
const gold = "rgb(200, 160, 64)",
  parchment = "rgb(245, 237, 216)",
  cinzel = '"Cinzel Variable", Georgia, serif',
  inter = '"Inter Variable", "Helvetica Neue", sans-serif';
// The Classic theme's approved typography, surfaces and card geometry.
function classicDesign(viewport: "desktop" | "mobile"): Record<string, Record<string, string>> {
  const desktop = viewport === "desktop";
  return {
    body: {
      "background-color": "rgb(20, 16, 8)",
      color: parchment,
      "font-family": '"Lora Variable", Georgia, serif',
      "font-size": "16px",
      "line-height": "25.6px",
    },
    ".campaign-content": {
      "margin-left": desktop ? "240px" : "0px",
      "padding-top": desktop ? "32px" : "16px",
      "padding-left": desktop ? "32px" : "16px",
      "padding-right": desktop ? "32px" : "16px",
    },
    ".campaign-sidebar": {
      width: desktop ? "240px" : "320px",
      "background-color": "rgb(28, 21, 9)",
      "border-right-color": "rgba(200, 160, 64, 0.15)",
    },
    "#campaign-title": {
      "font-family": cinzel,
      "font-size": "41.6px",
      "font-weight": "600",
      "line-height": "49.92px",
      "letter-spacing": "2.496px",
      color: gold,
    },
    ".campaign-title-page": {
      padding: "24px 16px 20px",
      "margin-bottom": "32px",
      "text-align": "center",
    },
    ".campaign-identity-pen": {
      width: "26px",
      height: "26px",
      "border-radius": "50%",
      "font-size": "12px",
      color: "rgb(139, 105, 20)",
      opacity: "0.45",
      "border-top-color": "rgba(200, 160, 64, 0.25)",
    },
    ".party-add": {
      padding: "4px 9.6px",
      "font-family": inter,
      "font-size": "12.48px",
      color: gold,
      "background-color": "rgba(0, 0, 0, 0)",
      "border-radius": "4px",
      "border-top-color": "rgba(200, 160, 64, 0.3)",
    },
    ".section-heading h2": {
      "font-family": cinzel,
      "font-size": "17.6px",
      "line-height": "21.12px",
      "letter-spacing": "0.88px",
      color: gold,
    },
    ".party-member": {
      width: "160px",
      padding: "12px",
      gap: "8px",
      "border-radius": "12px",
      "background-color": "rgb(36, 28, 13)",
      "border-top-color": "rgba(200, 160, 64, 0.2)",
    },
    ".party-portrait": { width: "88px", height: "88px", "border-radius": "50%" },
    ".party-member-copy strong": {
      "font-family": cinzel,
      "font-size": "14.72px",
      color: parchment,
    },
    ".party-member-copy > span": {
      "font-family": inter,
      "font-size": "11.52px",
      color: "rgb(154, 134, 96)",
    },
    ".record-row": {
      "background-color": "rgb(36, 28, 13)",
      "border-radius": "12px",
      "border-top-color": "rgba(255, 255, 255, 0.07)",
    },
    ".record-row-copy strong": { "font-family": cinzel, "font-size": "14.4px", color: parchment },
  };
}
async function expectDesign(
  page: Page,
  design: Record<string, Record<string, string>>,
  selector: string,
) {
  const expected = design[selector]!;
  assert.deepEqual(
    await style(page, selector, Object.keys(expected)),
    expected,
    `${selector} must keep the Classic design`,
  );
}
async function fits(page: Page) {
  const size = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: innerWidth,
    overflow: [...document.querySelectorAll(".campaign-content *")]
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(-8)
      .map((node) => node.className),
  }));
  assert.ok(size.content <= size.viewport, `horizontal overflow: ${JSON.stringify(size)}`);
}

for (const [name, viewport] of Object.entries({
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
})) {
  void test(`classic ${name} keeps its typography, surfaces and card geometry`, async (t) => {
    const page = await fixture(t, viewport);
    const design = classicDesign(name as "desktop" | "mobile");
    for (const selector of [
      "body",
      ".campaign-content",
      ".campaign-sidebar",
      "#campaign-title",
      ".campaign-title-page",
      ".campaign-identity-pen",
      ".party-add",
      ".section-heading h2",
      ".party-member",
      ".party-portrait",
      ".party-member-copy strong",
      ".party-member-copy > span",
    ])
      await expectDesign(page, design, selector);
    const sections = await page.locator(".chronicle-section").evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, bottom: r.bottom };
      }),
    );
    assert.ok(
      sections[1].y >= sections[0].bottom && sections[2].y >= sections[1].bottom,
      "dashboard sections remain vertically stacked",
    );
    assert.equal(sections[0].x, sections[1].x);
    await fits(page);
    await page.screenshot({
      animations: "disabled",
      path: `${artifacts}${name}-dashboard.png`,
      fullPage: true,
    });

    await page.goto(`${origin}/#/characters`);
    await page.locator(".record-row").first().waitFor();
    await expectDesign(page, design, ".record-row");
    await expectDesign(page, design, ".record-row-copy strong");
    const card = await page.locator(".record-row-mark").first().boundingBox().then(required);
    assert.ok(
      Math.abs(card.width / card.height - 0.75) < 0.01,
      "portraits and fallback artwork preserve the same 3:4 card geometry",
    );
    await fits(page);
    await page.screenshot({
      animations: "disabled",
      path: `${artifacts}${name}-characters.png`,
      fullPage: true,
    });
    await page.locator(".record-row").first().click();
    await page.locator("#record-title").waitFor();
    assert.equal(
      (await style(page, ".record-masthead", ["background-color"]))["background-color"],
      "rgb(36, 28, 13)",
    );
    const rail = await page.locator(".record-side").boundingBox().then(required);
    const reading = await page.locator(".record-reading").boundingBox().then(required);
    assert.ok(
      name === "desktop" ? reading.x > rail.x + rail.width : reading.y >= rail.y + rail.height,
      "article rail stacks at the original breakpoint",
    );
    await fits(page);
    await page.screenshot({
      animations: "disabled",
      path: `${artifacts}${name}-article.png`,
      fullPage: true,
    });
  });
}

void test("mobile drawer stays accessible and preserves dirty record edits", async (t) => {
  const page = await fixture(t, { width: 390, height: 844 }, "dm");
  await page.locator("[data-menu-toggle]").click();
  assert.equal(await page.locator("[data-menu-toggle]").getAttribute("aria-expanded"), "true");
  assert.equal(
    await page.locator("main").evaluate((element) => (element as HTMLElement).inert),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("[data-menu-toggle]").getAttribute("aria-expanded"), "false");
  assert.equal(
    await page.locator(".campaign-sidebar").evaluate((element) => (element as HTMLElement).inert),
    true,
  );
  assert.equal(
    await page
      .locator("[data-menu-toggle]")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.locator("[data-menu-toggle]").click();
  await page.locator('.core-navigation a[href="#/characters"]').click();
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("[data-menu-toggle]").getAttribute("aria-expanded"), "false");
  await page.locator('.record-row[href="#/characters/ryn"]').click();
  await page.getByLabel("More actions", { exact: true }).click();
  await page.getByRole("button", { name: "Edit all fields", exact: true }).click();
  await page.locator('[name="name"]').fill("Keep this draft");
  await page.locator("[data-menu-toggle]").click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator('.core-navigation a[href="#/"]').click();
  await page.waitForURL(/#\/characters\/ryn$/);
  assert.match(page.url(), /#\/characters\/ryn$/);
  assert.equal(await page.locator('[name="name"]').inputValue(), "Keep this draft");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "Quick search" }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForURL(/#\/characters\/ryn$/);
  assert.match(page.url(), /#\/characters\/ryn$/);
  assert.equal(await page.locator('[name="name"]').inputValue(), "Keep this draft");
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: `${artifacts}mobile-editor.png`,
    fullPage: true,
  });
});

void test("quick search preserves the mounted editor and guards destination navigation", async (t) => {
  const page = await fixture(t, { width: 1440, height: 1000 }, "dm");
  await page.goto(`${origin}/#/characters/ryn`);
  await page.getByLabel("More actions", { exact: true }).click();
  await page.getByRole("button", { name: "Edit all fields", exact: true }).click();
  const name = page.locator('[name="name"]');
  await name.fill("Unsaved Ryn");
  await name.evaluate((element) => {
    element.setAttribute("data-kept-editor", "yes");
  });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Quick search" });
  await dialog.waitFor();
  assert.match(page.url(), /#\/characters\/ryn$/);
  await dialog.locator("input").fill("Kael");
  await page.keyboard.press("ArrowDown");
  assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /Kael/);
  page.once("dialog", (prompt) => prompt.dismiss());
  await page.keyboard.press("Enter");
  await page.waitForURL(/#\/characters\/ryn$/);
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await name.inputValue(), "Unsaved Ryn");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await name.getAttribute("data-kept-editor"), "yes");
  assert.equal(await name.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Control+k");
  await dialog.locator("input").fill("Kael");
  page.once("dialog", (prompt) => prompt.accept());
  await page.keyboard.press("Enter");
  await page.waitForURL(/#\/characters\/kael$/);
  await dialog.waitFor({ state: "detached" });
});

void test("phone quick search supports focus containment, recent records and full search", async (t) => {
  const page = await fixture(t, { width: 390, height: 844 });
  await page.goto(`${origin}/#/characters/ryn`);
  await page.locator("#record-title").waitFor();
  await page.locator("[data-menu-toggle]").click();
  await page.locator(".sidebar-search").click();
  const dialog = page.getByRole("dialog", { name: "Quick search" });
  await dialog.waitFor();
  assert.match((await dialog.locator(".search-result").first().textContent()) ?? "", /Ryn/);
  for (let index = 0; index < 18; index++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => !!document.activeElement?.closest(".quick-search-dialog")),
      true,
    );
  }
  await dialog.locator("input").fill("Ryn");
  await page.screenshot({ path: `${artifacts}mobile-quick-search.png`, fullPage: true });
  await fits(page);
  await dialog.getByRole("link", { name: "Open full search" }).click();
  await page.waitForURL(/#\/search\?q=Ryn$/);
  await page.locator(".campaign-search-field input").waitFor();
  assert.equal(await page.locator(".campaign-search-field input").inputValue(), "Ryn");
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".quick-search-dialog").count(), 0);
});

void test("desktop sidebar, phone menu and settings remain usable across resize", async (t) => {
  const page = await fixture(t, { width: 820, height: 900 }, "dm");
  assert.equal(
    await page.locator(".campaign-sidebar").evaluate((element) => (element as HTMLElement).inert),
    false,
  );
  assert.equal(await page.locator("[data-menu-toggle]").isVisible(), false);
  await page.setViewportSize({ width: 320, height: 780 });
  await page.locator("[data-menu-toggle]").click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>(".campaign-sidebar")!.getBoundingClientRect().x === 0,
  );
  await page.screenshot({ animations: "disabled", path: `${artifacts}mobile-menu.png` });
  await page.locator('.sidebar-footer a[href="#/settings"]').click();
  await page.locator(".settings-page").waitFor();
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: `${artifacts}mobile-settings.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  assert.equal(
    (await style(page, ".theme-sample-classic .settings-theme-sample", ["background-color"]))[
      "background-color"
    ],
    "rgb(20, 16, 8)",
  );
  await fits(page);
  await page.screenshot({
    animations: "disabled",
    path: `${artifacts}desktop-settings.png`,
    fullPage: true,
  });
  assert.equal(await page.locator(".application-alert").count(), 0);
});

void test("one add-on navigation outlet survives desktop and mobile transitions", async (t) => {
  const page = await fixture(t, { width: 1440, height: 1000 }, "dm", true);
  const link = page.getByRole("link", { name: "Fixture tools", exact: true });
  await link.waitFor().catch(async (error) => {
    t.diagnostic(await page.locator(".account-panel small").getAttribute("title").then(required));
    throw error;
  });
  assert.equal(await link.count(), 1);
  await link.click();
  await page.locator("visual-fixture-addon").waitFor();
  assert.equal(
    await page.locator("visual-fixture-addon").textContent().then(required),
    "Synthetic add-on page",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-menu-toggle]").click();
  assert.equal(await link.count(), 1);
  assert.equal(await link.isVisible(), true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator("visual-fixture-addon").count(), 1);
  assert.equal(await page.locator(".application-alert").count(), 0);
});

void test("skip link moves focus into the campaign without changing its route", async (t) => {
  const page = await fixture(t, { width: 1440, height: 1000 });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  assert.equal(
    await page
      .locator("#campaign-content")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(new URL(page.url()).hash, "");
  assert.equal(await page.locator("#campaign-title").textContent().then(required), "Asurai");
});

async function assertCardAction(card: Locator, page: Page) {
  const primary = card.locator(":scope > a").first(),
    edit = card.locator(".ui-card-action");
  const bounds = required(await primary.boundingBox()),
    action = required(await edit.boundingBox());
  assert.ok(action.width >= 44 && action.height >= 44, "pencil keeps a full touch target");
  assert.ok(action.y >= bounds.y && action.y - bounds.y <= 10, "edit stays at the card top");
  assert.ok(
    Math.abs(bounds.x + bounds.width - action.x - action.width) <= 10,
    "edit stays at the card right edge",
  );
  assert.equal((await edit.textContent())?.trim(), "", "the pencil replaces the visible Edit text");
  assert.equal(await edit.locator('svg[aria-hidden="true"]').count(), 1);
  assert.equal(
    await primary.locator("a, button").count(),
    0,
    "card navigation and editing are sibling links",
  );
  assert.match(required(await edit.getAttribute("aria-label")), /^(Edit|Upravit)/);
  assert.equal(await edit.getAttribute("title"), await edit.getAttribute("aria-label"));
  const badge = card.locator(".dm-badge");
  if (await badge.count()) {
    const b = required(await badge.boundingBox());
    assert.ok(
      b.x + b.width <= action.x || b.y >= action.y + action.height,
      `visibility never overlaps edit: ${JSON.stringify({ badge: b, action })}`,
    );
  }
  await primary.focus();
  await page.keyboard.press("Tab");
  assert.ok(
    await edit.evaluate((node) => node === document.activeElement),
    "native tab order reaches the pencil",
  );
  assert.notEqual(await edit.evaluate((node) => getComputedStyle(node).outlineStyle), "none");
}

for (const scenario of [
  { width: 1440, locale: "en", theme: "classic" },
  { width: 1440, locale: "cs", theme: "moonlit" },
  { width: 320, locale: "cs", theme: "classic" },
  { width: 320, locale: "en", theme: "moonlit" },
])
  void test(`all entity cards preserve artwork geometry and top-right editing in ${scenario.width}/${scenario.locale}/${scenario.theme}`, async (t) => {
    const page = await fixture(t, { width: scenario.width, height: 1000 }, "dm");
    const campaign = structuredClone(visualCampaign);
    const collections = [
      ["characters", "characters"],
      ["locations", "locations"],
      ["events", "events"],
      ["mysteries", "mysteries"],
      ["factions", "factions"],
      ["pantheon", "pantheon"],
      ["artifacts", "artifacts"],
      ["history", "historicalEvents"],
      ["companions", "companions"],
    ];
    const portrait = "/api/media/b_" + "7".repeat(32);
    for (const [, collection] of collections) {
      required(campaign.collections.find((c) => c.name === collection)).records = [
        "art",
        "fallback",
      ].map((key) => ({
        key,
        revision: 1,
        value: {
          id: key,
          name: "Card " + key,
          visibility: "dm",
          faction: "party",
          ownerType: "party",
          ...(key === "art" ? { portrait } : {}),
        },
      }));
    }
    required(campaign.collections.find((c) => c.name === "settings")).records.push({
      key: "appearance",
      revision: 1,
      value: { theme: scenario.theme },
    });
    await page.route("**/api/campaign", (route) => route.fulfill({ json: campaign }));
    await page.route("**" + portrait, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="120"><rect width="90" height="120" fill="#729ca5"/></svg>',
      }),
    );
    await page.evaluate((locale) => localStorage.setItem("codex_lang", locale), scenario.locale);
    await page.reload();
    await page.locator(".party-record-card").first().waitFor();
    for (const card of await page.locator(".party-record-card").all())
      await assertCardAction(card, page);
    await fits(page);
    await page.locator(".party-roster").screenshot({
      animations: "disabled",
      path: artifacts + `entity-party-${scenario.width}-${scenario.theme}.png`,
    });
    for (const [route] of collections) {
      await page.goto(origin + "/#/" + route);
      const cards = page.locator(".record-row-shell");
      await cards.nth(1).waitFor();
      const image = page.locator('.record-row-mark[data-ui-artwork-state="ready"] img'),
        fallback = page.locator('.record-row-mark[data-ui-artwork-state="empty"]');
      await image.evaluate((node: HTMLImageElement) => node.decode());
      const art = required(await image.boundingBox()),
        mark = required(await fallback.boundingBox());
      if (route === "characters") {
        assert.ok(Math.abs(mark.width - art.width) < 1, route + " fallback has full card width");
        assert.ok(
          Math.abs(mark.height - art.height) < 1,
          route + " fallback has full artwork height",
        );
        const first = required(await cards.nth(0).boundingBox()),
          second = required(await cards.nth(1).boundingBox());
        assert.ok(
          Math.abs(first.height - second.height) < 1,
          route + " equal content has equal card height",
        );
      } else
        assert.ok(mark.width < art.width / 2, route + " entries without artwork are compact tiles");
      for (const card of await cards.all()) await assertCardAction(card, page);
      await fits(page);
      if (route === "characters")
        await page.screenshot({
          animations: "disabled",
          path: artifacts + `entity-cards-${scenario.width}-${scenario.theme}.png`,
          fullPage: true,
        });
      const edit = cards.nth(1).locator(".ui-card-action");
      await edit.press("Enter");
      await page.locator(".record-editor").waitFor();
      assert.match(page.url(), /edit/);
    }
    await page.goto(origin + "/#/characters");
    await page.locator(".record-row-shell").nth(1).waitFor();
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    for (const card of await page.locator(".record-row-shell").all())
      await assertCardAction(card, page);
    await fits(page);
  });

void test("card editing retains existing public and player permissions", async (t) => {
  for (const role of ["", "player"]) {
    const page = await fixture(t, { width: 390, height: 844 }, role);
    for (const route of ["/", "/party", "/characters", "/companions"]) {
      await page.goto(origin + "/#" + route);
      await page
        .locator(
          route.includes("characters") || route.includes("companions")
            ? ".record-row"
            : ".party-member",
        )
        .first()
        .waitFor();
      assert.equal((await page.locator(".ui-card-action").count()) > 0, role === "player");
    }
  }
});
