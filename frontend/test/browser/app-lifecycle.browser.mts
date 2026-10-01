import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { preview, type PreviewServer } from "vite";
import { chromium, type Browser } from "playwright";
import { visualCampaign, visualFixturePlugin } from "./visual-fixture.mts";
import { trackBrowserContext } from "./browser-diagnostics.mts";

let server: PreviewServer, browser: Browser, origin: string;
before(async () => {
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

void test(
  "a completed player preview stays open when its parent application disconnects",
  { timeout: 30_000 },
  async (t) => {
    const context = await browser.newContext({
      baseURL: origin,
      extraHTTPHeaders: { "x-fixture-role": "dm" },
    });
    const errors: string[] = [];
    await trackBrowserContext(t, context, () => assert.deepEqual(errors, []));
    await context.addInitScript(() => localStorage.setItem("codex_lang", "en"));
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/player-preview", (route) =>
      route.fulfill({
        json: {
          contractVersion: "player-preview.v1",
          token: "p".repeat(32),
          expiresAt: "2099-01-01T00:00:00Z",
        },
      }),
    );
    await page.goto("/#/characters", { waitUntil: "domcontentloaded" });
    await page.getByText("Ryn", { exact: true }).waitFor();
    await page.locator(".account-menu > summary").click();
    const opened = context.waitForEvent("page");
    await page
      .locator(".account-panel")
      .getByRole("button", { name: "View as player", exact: true })
      .click();
    const popup = await opened;
    popup.on("pageerror", (error) => errors.push(error.message));
    await popup.waitForURL((url) => url.href !== "about:blank");
    await page.waitForFunction(() => document.querySelector("codex-app")?.busy === false);
    const app = await page.locator("codex-app").elementHandle();
    assert.ok(app);
    await app.evaluate((node) => node.remove());
    const freshAuth = page.waitForRequest((request) => request.url().endsWith("/api/auth"));
    await app.evaluate((node) => document.body.append(node));
    await freshAuth;
    await page.getByText("Ryn", { exact: true }).waitFor();
    assert.equal(popup.isClosed(), false);
    assert.equal(context.pages().length, 2);
  },
);

for (const outcome of ["success", "failure"] as const) {
  void test(
    `campaign and account startup proceed before a held health ${outcome}`,
    { timeout: 30_000 },
    async (t) => {
      const context = await browser.newContext({ baseURL: origin });
      const errors: string[] = [];
      await trackBrowserContext(t, context, () => assert.deepEqual(errors, []));
      await context.addInitScript(() => localStorage.setItem("codex_lang", "en"));
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on("pageerror", (error) => errors.push(error.message));
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await page.route("**/api/health", async (route) => {
        started.resolve();
        await release.promise;
        await route.fulfill(
          outcome === "success"
            ? { json: { status: "ok", version: "resumed-health" } }
            : { status: 503, json: { error: "health unavailable" } },
        );
      });
      try {
        await page.goto("/#/characters", { waitUntil: "domcontentloaded" });
        await started.promise;
        await page.getByText("Ryn", { exact: true }).waitFor();
        await page.locator(".account-menu > summary").click();
        await page
          .locator(".account-panel")
          .getByRole("button", { name: "Sign in", exact: true })
          .waitFor();
        assert.match(await page.locator(".host-state").innerText(), /Checking/);
        release.resolve();
        if (outcome === "success")
          await page.getByText("Codex resumed-health", { exact: true }).waitFor();
        else await page.locator(".host-unavailable").waitFor();
        await page.getByText("Ryn", { exact: true }).waitFor();
        assert.equal(await page.locator(".application-alert").count(), 0);
      } finally {
        release.resolve();
      }
    },
  );
}

for (const action of ["login", "logout", "view-as", "player-preview"] as const) {
  void test(
    `detaching during ${action} cancels the old action without breaking reconnect`,
    { timeout: 30_000 },
    async (t) => {
      const context = await browser.newContext({
        baseURL: origin,
        extraHTTPHeaders: action === "login" ? {} : { "x-fixture-role": "dm" },
      });
      const errors: string[] = [];
      await trackBrowserContext(t, context, () => assert.deepEqual(errors, []));
      await context.addInitScript(() => localStorage.setItem("codex_lang", "en"));
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on("pageerror", (error) => errors.push(error.message));
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      if (action === "view-as") {
        await page.route("**/api/auth", (route) =>
          route.fulfill({
            json: {
              ok: true,
              role: "player",
              realRole: "dm",
              csrfToken: "x".repeat(32),
              expiresAt: "2099-01-01T00:00:00Z",
            },
          }),
        );
      }
      await page.route(`**/api/${action}`, async (route) => {
        started.resolve();
        await release.promise;
        try {
          await route.fulfill({ json: { ok: true } });
        } finally {
          settled.resolve();
        }
      });
      try {
        await page.goto("/#/characters", { waitUntil: "domcontentloaded" });
        await page.getByText("Ryn", { exact: true }).waitFor();
        await page.locator(".account-menu > summary").click();
        const account = page.locator(".account-panel");
        if (action === "login") {
          await account.locator('input[name="password"]').fill("synthetic-password");
          await account.getByRole("button", { name: "Sign in", exact: true }).click();
        } else {
          await account
            .getByRole("button", {
              name:
                action === "logout"
                  ? "Sign out"
                  : action === "view-as"
                    ? "View as DM"
                    : "View as player",
              exact: true,
            })
            .click();
        }
        await started.promise;
        const app = await page.locator("codex-app").elementHandle();
        assert.ok(app);
        await app.evaluate((node) => node.remove());
        release.resolve();
        await settled.promise;
        const freshAuth = page.waitForRequest((request) => request.url().endsWith("/api/auth"));
        await app.evaluate((node) => document.body.append(node));
        await freshAuth;
        await page.getByText("Ryn", { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector("codex-app")?.busy === false);
        await account
          .getByRole("button", { name: action === "login" ? "Sign in" : "Sign out", exact: true })
          .waitFor();
        assert.equal(await page.locator(".application-alert").count(), 0);
        assert.equal(context.pages().length, 1);
        assert.deepEqual(errors, []);
      } finally {
        release.resolve();
      }
    },
  );
}

void test(
  "reconnecting waits for the previous add-on generation's owned cleanup",
  { timeout: 30_000 },
  async (t) => {
    const context = await browser.newContext({
      baseURL: origin,
      extraHTTPHeaders: { "x-fixture-role": "dm", "x-fixture-addon": "true" },
    });
    const errors: string[] = [];
    await trackBrowserContext(t, context, () => assert.deepEqual(errors, []));
    await context.addInitScript(() => localStorage.setItem("codex_lang", "en"));
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => errors.push(error.message));
    const disposing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let campaignReads = 0;
    await page.route("**/api/events", (route) =>
      route.fulfill({ contentType: "text/event-stream", body: ": waiting\n\n" }),
    );
    await page.route("**/api/campaign", async (route) => {
      const campaign = structuredClone(visualCampaign);
      if (++campaignReads > 1)
        campaign.collections
          .find((collection) => collection.name === "settings")!
          .records.push({ key: "branding", revision: 1, value: { title: "Reconnect frontier" } });
      await route.fulfill({ json: campaign });
    });
    await page.route("**/fixture-cleanup", async (route) => {
      disposing.resolve();
      await release.promise;
      await route.fulfill({ body: "finished" });
    });
    await page.route("**/assets/web/index.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `export function activate(context) {
      const root = document.documentElement;
      root.dataset.fixtureActivations = String(Number(root.dataset.fixtureActivations || 0) + 1);
      if (!customElements.get('visual-fixture-addon')) customElements.define('visual-fixture-addon', class extends HTMLElement {
        connectedCallback() { this.textContent = 'Synthetic add-on page'; }
      });
      context.ui.bind('fixture.route', { kind: 'element', tag: 'visual-fixture-addon' });
      return { async dispose() { await fetch('/fixture-cleanup'); } };
    }`,
      }),
    );
    try {
      await page.goto("/#/addons/visual-fixture/tools", { waitUntil: "domcontentloaded" });
      await page.getByText("Synthetic add-on page", { exact: true }).waitFor();
      const app = await page.locator("codex-app").elementHandle();
      assert.ok(app);
      await app.evaluate((node) => node.remove());
      await disposing.promise;
      await app.evaluate((node) => document.body.append(node));
      await page
        .locator(".campaign-brand strong")
        .filter({ hasText: "Reconnect frontier" })
        .waitFor();
      await app.evaluate(async (node) => {
        await (node as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.fixtureActivations),
        "1",
      );
      assert.equal(await page.locator("visual-fixture-addon").count(), 0);
      release.resolve();
      await page.getByText("Synthetic add-on page", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.fixtureActivations),
        "2",
      );
    } finally {
      release.resolve();
    }
  },
);
