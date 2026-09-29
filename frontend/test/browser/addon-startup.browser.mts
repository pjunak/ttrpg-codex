import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { preview, type PreviewServer } from "vite";
import { chromium, type Browser } from "playwright";
import { visualFixturePlugin } from "./visual-fixture.mts";
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

for (const asset of ["graph", "stylesheet", "module"] as const) {
  void test(
    `sign-out cancels a stalled add-on ${asset} and allows a fresh sign-in`,
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
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const graphSettled = Promise.withResolvers<void>();
      let authenticated = true,
        hold = true;
      const auth = () =>
        authenticated
          ? {
              ok: true,
              role: "dm",
              realRole: "dm",
              csrfToken: "x".repeat(32),
              expiresAt: "2099-01-01T00:00:00Z",
            }
          : { role: null, realRole: null };
      await page.route("**/api/auth", (route) => route.fulfill({ json: auth() }));
      await page.route("**/api/logout", async (route) => {
        authenticated = false;
        await route.fulfill({ json: { ok: true } });
      });
      await page.route("**/api/login", async (route) => {
        authenticated = true;
        await route.fulfill({ json: auth() });
      });
      await page.route("**/api/addons/browser-graph", async (route) => {
        const response = await route.fetch();
        const graph: { addons: { entryUrl: string; styleUrls: string[] }[] } =
          await response.json();
        const held = asset === "graph" && hold;
        if (held) {
          started.resolve();
          await release.promise;
        }
        try {
          await route.fulfill({
            response,
            json: {
              ...graph,
              addons: graph.addons.map((addon) => ({
                ...addon,
                styleUrls:
                  asset === "stylesheet"
                    ? [addon.entryUrl.replace(/index\.js$/, "startup.css")]
                    : [],
              })),
            },
          });
        } finally {
          if (held) graphSettled.resolve();
        }
      });
      const stalledAsset =
        asset === "stylesheet" ? "**/assets/web/startup.css" : "**/assets/web/index.js";
      await page.route(stalledAsset, async (route) => {
        if (hold) {
          started.resolve();
          await release.promise;
        }
        if (asset === "stylesheet") await route.fulfill({ contentType: "text/css", body: "" });
        else await route.continue();
      });
      try {
        await page.goto("/#/addons/visual-fixture/tools", { waitUntil: "domcontentloaded" });
        await started.promise;
        const account = page.locator(".account-panel");
        await page.locator(".account-menu > summary").click();
        await account.getByRole("button", { name: "Sign out", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("codex-app")?.busy === false);
        await account.getByRole("button", { name: "Sign in", exact: true }).waitFor();
        assert.equal(await page.locator("link[data-codex-addon]").count(), 0);
        assert.equal(await page.locator("visual-fixture-addon").count(), 0);
        hold = false;
        if (asset !== "graph") release.resolve();
        await account.locator('input[name="password"]').fill("synthetic-password");
        await account.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("codex-app")?.busy === false);
        await page.goto("/#/addons/visual-fixture/tools");
        await page.getByText("Synthetic add-on page", { exact: true }).waitFor();
        if (asset === "graph") {
          release.resolve();
          await graphSettled.promise;
          await page.getByText("Synthetic add-on page", { exact: true }).waitFor();
        }
        assert.equal(await page.locator(".application-alert").count(), 0);
        assert.equal(await page.locator("visual-fixture-addon").count(), 1);
        assert.equal(
          await page.locator("link[data-codex-addon]").count(),
          asset === "stylesheet" ? 1 : 0,
        );
        await account.getByRole("button", { name: "Sign out", exact: true }).click();
        await account.getByRole("button", { name: "Sign in", exact: true }).waitFor();
        assert.equal(await page.locator("visual-fixture-addon").count(), 0);
      } finally {
        release.resolve();
      }
    },
  );
}
