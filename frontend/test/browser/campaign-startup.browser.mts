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

for (const phase of ["startup", "refresh"] as const) {
  void test(
    `sign-out releases a stalled campaign ${phase} and preserves the new projection`,
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
      const settled = Promise.withResolvers<void>();
      let authenticated = true,
        reads = 0;
      await page.route("**/api/auth", (route) =>
        route.fulfill({
          json: authenticated
            ? {
                ok: true,
                role: "dm",
                realRole: "dm",
                csrfToken: "x".repeat(32),
                expiresAt: "2099-01-01T00:00:00Z",
              }
            : { role: null, realRole: null },
        }),
      );
      await page.route("**/api/logout", async (route) => {
        authenticated = false;
        await route.fulfill({ json: { ok: true } });
      });
      await page.route("**/api/campaign", async (route) => {
        const privateProjection = authenticated;
        const held = ++reads === (phase === "startup" ? 1 : 2);
        if (held) {
          started.resolve();
          await release.promise;
        }
        try {
          const campaign = structuredClone(visualCampaign);
          const characters = campaign.collections.find(
            (collection) => collection.name === "characters",
          )!;
          characters.records = [
            {
              key: "visible",
              revision: 1,
              value: {
                id: "visible",
                name: privateProjection ? "Private campaign sentinel" : "Public campaign sentinel",
                visibility: "public",
              },
            },
          ];
          await route.fulfill({ json: campaign });
        } finally {
          if (held) settled.resolve();
        }
      });
      try {
        await page.goto("/#/characters", { waitUntil: "domcontentloaded" });
        await started.promise;
        await page.locator(".account-menu > summary").click();
        const account = page.locator(".account-panel");
        await account.getByRole("button", { name: "Sign out", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("codex-app")?.busy === false);
        await account.getByRole("button", { name: "Sign in", exact: true }).waitFor();
        await page.getByText("Public campaign sentinel", { exact: true }).waitFor();
        assert.equal(await page.getByText("Private campaign sentinel", { exact: true }).count(), 0);
        release.resolve();
        await settled.promise;
        await page.getByText("Public campaign sentinel", { exact: true }).waitFor();
        assert.equal(await page.locator(".application-alert").count(), 0);
        assert.equal(await page.getByText("Private campaign sentinel", { exact: true }).count(), 0);
        await page.reload();
        await page.getByText("Public campaign sentinel", { exact: true }).waitFor();
        assert.equal(await page.getByText("Private campaign sentinel", { exact: true }).count(), 0);
      } finally {
        release.resolve();
      }
    },
  );
}
