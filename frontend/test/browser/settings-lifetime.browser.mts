import assert from "node:assert/strict";
import { before, after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { preview, type PreviewServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { visualFixturePlugin } from "./visual-fixture.mts";
import { holdCoreWrite } from "./core-write-lifetime-fixture.mts";
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

const generation = (addonId: string) => ({
  addonId,
  generationId: "a".repeat(64),
  version: "1.0.0",
  installedAt: "2026-10-01T12:00:00Z",
});
const source = {
  repo: "owner/repository",
  channel: "release",
  branch: "",
  artifact: "reviewed-package",
};
async function open(t: TestContext, mobile = false) {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 },
    extraHTTPHeaders: { "x-fixture-role": "dm" },
  });
  const errors: string[] = [];
  await trackBrowserContext(t, context, () => assert.deepEqual(errors, []));
  await context.addInitScript(() => localStorage.setItem("codex_lang", "en"));
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  const state = {
    revision: 1,
    inventory: ["initial"],
    name: "Initial source",
    candidate: "Retired package",
    stageCalls: 0,
  };
  await page.route("**/api/admin/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const snapshot = {
      revision: state.revision,
      graphRevision: "b".repeat(64),
      restartedAddonIds: [],
    };
    let value: unknown;
    if (path === "/api/admin/addons")
      value = { contractVersion: "addon-inventory.v1", addonIds: state.inventory };
    else if (path === "/api/admin/addons/generations") {
      state.stageCalls++;
      value = generation(state.stageCalls === 1 ? "obsolete" : "current");
    } else if (path.startsWith("/api/admin/addons/")) {
      const addonId = path.split("/").at(-1)!;
      value = {
        state: { addonId, revision: 1 },
        generations: [generation(addonId)],
        events: [],
      };
    } else if (path === "/api/admin/addon-github")
      value = {
        contractVersion: "addon-github.v1",
        sources: [],
        credentials: { defaultSource: "none", environmentConfigured: false, repositories: [] },
      };
    else if (path === "/api/admin/addon-github/discover")
      value = {
        source,
        candidates: [
          {
            id: "c".repeat(64),
            name: state.candidate,
            version: "1.0.0",
            digest: "",
            active: false,
          },
        ],
      };
    else if (path === "/api/admin/addon-package-storage")
      value = {
        contractVersion: "addon-package-storage.v1",
        automatic: true,
        latestOnly: true,
        pending: 0,
        packages: [],
      };
    else if (path === "/api/admin/rules-policy")
      value = {
        ...snapshot,
        contractVersion: "rules-policy.v1",
        ruleset: null,
        sources: [
          {
            addonId: "example",
            addonName: "Example",
            setId: "rules",
            id: "book",
            name: state.name,
            enabled: true,
            pending: false,
            required: false,
          },
        ],
      };
    else if (path === "/api/admin/service-selections")
      value = { ...snapshot, contractVersion: "service-selections.v1", services: [] };
    else throw new Error(`Unexpected fixture endpoint ${path}`);
    await route.fulfill({ json: value });
  });
  await page.goto("/#/settings", { waitUntil: "domcontentloaded" });
  await page.locator(".settings-page").waitFor();
  return { page, state };
}
async function reconnect(page: Page, selector: string) {
  await page.locator(selector).evaluate((node) => {
    const parent = node.parentNode!;
    node.remove();
    parent.appendChild(node);
  });
  await settle(page);
}
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function addConfiguration(page: Page) {
  await page.evaluate(() => {
    const node = document.createElement("codex-addon-configuration");
    Object.assign(node, { csrfToken: "x".repeat(32), addonId: "example" });
    node.id = "fixture-configuration";
    document.body.append(node);
  });
}
async function addWizard(page: Page) {
  await page.evaluate(() => {
    const node = document.createElement("codex-addon-install");
    Object.assign(node, { csrfToken: "x".repeat(32) });
    node.id = "fixture-wizard";
    document.body.append(node);
  });
  await page
    .locator("#fixture-wizard")
    .getByRole("button", { name: /^GitHub/ })
    .click();
  await page.locator('#fixture-wizard input[name="repo"]').fill(source.repo);
}
async function discover(page: Page) {
  await page
    .locator("#fixture-wizard .addon-source-form")
    .evaluate((node) => (node as HTMLFormElement).requestSubmit());
}

for (const outcome of ["success", "failure"] as const) {
  void test(
    `an old inventory ${outcome} cannot replace the reconnected manager`,
    { timeout: 30_000 },
    async (t) => {
      const { page, state } = await open(t);
      await page.locator('[data-category="addons"]').click();
      const manager = page.locator("codex-addon-manager");
      const check = manager.locator(".addon-toolbar button").first();
      await check.waitFor();
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>("codex-addon-manager .addon-toolbar button")!
            .disabled,
      );
      state.inventory = ["obsolete"];
      const read = await holdCoreWrite(page, "/api/admin/addons/obsolete", "headers", outcome);
      try {
        await check.click();
        await read.started();
        state.inventory = ["current"];
        await reconnect(page, "codex-addon-manager");
        await manager.getByRole("heading", { name: "current", exact: true }).waitFor();
        await read.release();
        await settle(page);
        assert.equal(
          await manager.getByRole("heading", { name: "current", exact: true }).count(),
          1,
        );
        assert.equal(
          await manager.getByRole("heading", { name: "obsolete", exact: true }).count(),
          0,
        );
        assert.equal(await manager.getByRole("alert").count(), 0);
      } finally {
        await read.release();
      }
    },
  );

  void test(
    `configuration reconnect starts a fresh read before late ${outcome}`,
    { timeout: 30_000 },
    async (t) => {
      const { page, state } = await open(t, outcome === "failure");
      const read = await holdCoreWrite(page, "/api/admin/rules-policy", "headers", outcome);
      try {
        await addConfiguration(page);
        await read.started();
        state.revision = 2;
        state.name = "Current source";
        await reconnect(page, "#fixture-configuration");
        const configuration = page.locator("#fixture-configuration");
        await configuration.getByText("Current source", { exact: true }).waitFor();
        await read.release();
        await settle(page);
        assert.equal(await configuration.getByText("Current source", { exact: true }).count(), 1);
        assert.equal(await configuration.getByText("Initial source", { exact: true }).count(), 0);
        assert.equal(await configuration.getByRole("alert").count(), 0);
        assert.equal(
          await configuration.locator(".addon-configuration").getAttribute("aria-busy"),
          "false",
        );
      } finally {
        await read.release();
      }
    },
  );
}

void test(
  "a pending reconnected wizard accepts new discovery and ignores the old result",
  { timeout: 30_000 },
  async (t) => {
    const { page, state } = await open(t);
    await addWizard(page);
    const read = await holdCoreWrite(page, "/api/admin/addon-github/discover", "headers");
    try {
      await discover(page);
      await read.started();
      state.candidate = "Current package";
      await reconnect(page, "#fixture-wizard");
      assert.equal(await page.locator('#fixture-wizard input[name="repo"]').isEnabled(), true);
      await discover(page);
      await page
        .locator("#fixture-wizard .github-candidates")
        .filter({ hasText: "Current package" })
        .waitFor();
      await read.release();
      await settle(page);
      assert.ok(
        (await page.locator("#fixture-wizard .github-candidates").innerText()).includes(
          "Current package",
        ),
      );
      assert.equal(await page.locator("#fixture-wizard").getByRole("alert").count(), 0);
    } finally {
      await read.release();
    }
  },
);

void test(
  "an idle reconnected wizard obtains new GitHub results",
  { timeout: 30_000 },
  async (t) => {
    const { page, state } = await open(t, true);
    await addWizard(page);
    state.candidate = "Current package";
    await reconnect(page, "#fixture-wizard");
    await discover(page);
    await page
      .locator("#fixture-wizard .github-candidates")
      .filter({ hasText: "Current package" })
      .waitFor();
    assert.equal(await page.locator("#fixture-wizard").getByRole("alert").count(), 0);
  },
);

void test(
  "a cancelled ZIP receipt cannot publish into a replacement staging action",
  { timeout: 30_000 },
  async (t) => {
    const { page, state } = await open(t);
    await page.evaluate(() => {
      const node = document.createElement("codex-addon-install");
      Object.assign(node, { csrfToken: "x".repeat(32) });
      node.id = "fixture-wizard";
      node.addEventListener("addon-package-staged", (event) => {
        node.dataset.staged = (event as CustomEvent<{ addonId: string }>).detail.addonId;
        node.dataset.stageEvents = String(Number(node.dataset.stageEvents ?? "0") + 1);
      });
      document.body.append(node);
    });
    const wizard = page.locator("#fixture-wizard");
    await wizard.locator(".addon-source-choices button").nth(1).click();
    const stage = async () => {
      await wizard.locator('input[type="file"]').setInputFiles({
        name: "fixture.zip",
        mimeType: "application/zip",
        buffer: Buffer.from("synthetic package bytes"),
      });
      await wizard
        .locator(".addon-upload")
        .evaluate((node) => (node as HTMLFormElement).requestSubmit());
    };
    const receipt = await holdCoreWrite(page, "/api/admin/addons/generations", "headers");
    try {
      await stage();
      await receipt.started();
      assert.equal(state.stageCalls, 1);
      await reconnect(page, "#fixture-wizard");
      assert.equal(await wizard.locator('input[type="file"]').isEnabled(), true);
      await stage();
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>("#fixture-wizard")!.dataset.staged === "current",
      );
      await receipt.release();
      await settle(page);
      assert.equal(state.stageCalls, 2);
      assert.equal(await wizard.getAttribute("data-staged"), "current");
      assert.equal(await wizard.getAttribute("data-stage-events"), "1");
      assert.equal(await wizard.getByRole("alert").count(), 0);
    } finally {
      await receipt.release();
    }
  },
);
