import assert from "node:assert/strict";
import { before, after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { preview, type PreviewServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { visualCampaign, visualFixturePlugin } from "./visual-fixture.mts";
import { holdCoreWrite } from "./core-write-lifetime-fixture.mts";
import { trackBrowserContext } from "./browser-diagnostics.mts";

declare global {
  interface Window {
    fixtureLiveSources: Array<{
      closed: boolean;
      emit: (name: string, payload: unknown, cursor: number) => void;
    }>;
  }
}

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

const fixtureModule = `export function activate(context) {
  const root = document.documentElement;
  root.dataset.restoreActivations = String(Number(root.dataset.restoreActivations || 0) + 1);
  if (!customElements.get('visual-fixture-addon')) customElements.define('visual-fixture-addon', class extends HTMLElement {
    set codexContribution(value) { this.contribution = value; this.publish(); }
    connectedCallback() {
      const label = document.createElement('label');
      label.textContent = 'Recovery draft';
      this.input = document.createElement('input');
      this.input.value = 'Saved draft';
      this.input.addEventListener('input', () => this.publish());
      label.append(this.input);
      this.append(label);
      this.publish();
    }
    publish() {
      if (!this.input || !this.contribution) return;
      const saving = document.documentElement.dataset.fixtureSaving === 'true';
      this.contribution.edits.set({ dirty: !saving && this.input.value !== 'Saved draft', saving });
    }
  });
  context.ui.bind('fixture.route', { kind: 'element', tag: 'visual-fixture-addon' });
  return { dispose() {
    root.dataset.restoreDisposals = String(Number(root.dataset.restoreDisposals || 0) + 1);
  } };
}`;

async function open(t: TestContext, mobile = false) {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    extraHTTPHeaders: { "x-fixture-role": "dm", "x-fixture-addon": "true" },
  });
  const errors: string[] = [];
  await trackBrowserContext(t, context, () => assert.deepEqual(errors, []));
  await context.addInitScript(() => {
    localStorage.setItem("codex_lang", "en");
    window.fixtureLiveSources = [];
    class FixtureEventSource extends EventTarget {
      closed = false;
      constructor() {
        super();
        window.fixtureLiveSources.push(this);
      }
      close() {
        this.closed = true;
      }
      emit(name: string, payload: unknown, cursor: number) {
        this.dispatchEvent(
          new MessageEvent(name, {
            data: JSON.stringify(payload),
            lastEventId: String(cursor),
          }),
        );
      }
    }
    Object.defineProperty(window, "EventSource", { value: FixtureEventSource });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/assets/web/index.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: fixtureModule,
    }),
  );
  await page.goto("/#/addons/visual-fixture/tools", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Recovery draft", { exact: true }).waitFor();
  return page;
}

function restoredCampaign(title = "Restored frontier") {
  const campaign = structuredClone(visualCampaign);
  campaign.collections
    .find((collection) => collection.name === "settings")!
    .records.push({
      key: "branding",
      revision: 2,
      value: { title },
    });
  return campaign;
}

async function restore(page: Page, cursor = 1, source = 0) {
  await page.evaluate(
    ({ cursor, source }) => {
      window.fixtureLiveSources[source]!.emit(
        "campaign-restored",
        {
          sequence: cursor,
          topic: "campaign-restored",
          revision: String(cursor),
          occurredAt: "2026-10-01T12:00:00Z",
          metadata: {},
        },
        cursor,
      );
    },
    { cursor, source },
  );
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

for (const state of ["dirty", "saving"] as const) {
  void test(`campaign restore keeps an add-on that becomes ${state} during refresh`, async (t) => {
    const page = await open(t, state === "saving");
    await page.route("**/api/campaign", (route) => route.fulfill({ json: restoredCampaign() }));
    const read = await holdCoreWrite(page, "/api/campaign", "headers");
    try {
      await restore(page);
      await read.started();
      if (state === "saving")
        await page.evaluate(() => {
          document.documentElement.dataset.fixtureSaving = "true";
        });
      await page.getByLabel("Recovery draft", { exact: true }).fill("Started during restore");
      await read.release();
      await page
        .locator(".campaign-brand strong")
        .filter({ hasText: "Restored frontier" })
        .waitFor();
      await settle(page);
      assert.equal(
        await page.getByLabel("Recovery draft", { exact: true }).inputValue(),
        "Started during restore",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.restoreActivations),
        "1",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.restoreDisposals ?? "0"),
        "0",
      );
      await page
        .locator(".application-alert")
        .filter({ hasText: "Your unsaved edits are still open" })
        .waitFor();
    } finally {
      await read.release();
    }
  });
}

void test("campaign restore honors a pending core edit flag while refreshing", async (t) => {
  const page = await open(t);
  await page.goto("/#/characters/ryn", { waitUntil: "domcontentloaded" });
  await page.locator("#record-title").waitFor();
  await page.route("**/api/campaign", (route) => route.fulfill({ json: restoredCampaign() }));
  const read = await holdCoreWrite(page, "/api/campaign", "headers");
  try {
    await restore(page);
    await read.started();
    await page
      .locator("codex-record-page")
      .evaluate((node) =>
        node.dispatchEvent(
          new CustomEvent("campaign-edit-dirty", { detail: { dirty: false, saving: true } }),
        ),
      );
    await read.release();
    await page.locator(".campaign-brand strong").filter({ hasText: "Restored frontier" }).waitFor();
    await settle(page);
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.restoreActivations),
      "1",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.restoreDisposals ?? "0"),
      "0",
    );
    await page
      .locator(".application-alert")
      .filter({ hasText: "Your unsaved edits are still open" })
      .waitFor();
  } finally {
    await read.release();
  }
});

for (const outcome of ["success", "failure"] as const) {
  void test(`a late restore ${outcome} cannot restart a reconnected add-on`, async (t) => {
    const page = await open(t);
    const read = await holdCoreWrite(page, "/api/campaign", "headers", outcome);
    try {
      await restore(page);
      await read.started();
      const app = await page.$("codex-app");
      assert.ok(app);
      await app.evaluate((node) => node.remove());
      await app.evaluate((node) => document.body.append(node));
      await page.getByLabel("Recovery draft", { exact: true }).waitFor();
      await page.getByLabel("Recovery draft", { exact: true }).fill("New connection draft");
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.restoreActivations),
        "2",
      );
      await read.release();
      await settle(page);
      assert.equal(
        await page.getByLabel("Recovery draft", { exact: true }).inputValue(),
        "New connection draft",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.restoreActivations),
        "2",
      );
      assert.equal(await page.locator(".application-alert").count(), 0);
    } finally {
      await read.release();
    }
  });
}

void test("an old restore cannot restart add-ons belonging to a fresh sign-in", async (t) => {
  const page = await open(t);
  let authenticated = true;
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
  await page.route("**/api/logout", (route) => {
    authenticated = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/login", (route) => {
    authenticated = true;
    return route.fulfill({ json: auth() });
  });
  const read = await holdCoreWrite(page, "/api/campaign", "headers");
  try {
    await restore(page);
    await read.started();
    await page.locator(".account-menu > summary").click();
    await page
      .locator(".account-panel")
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await page
      .locator(".account-panel")
      .getByRole("button", { name: "Sign in", exact: true })
      .waitFor();
    await page.locator('.account-panel input[name="password"]').fill("synthetic-password");
    await page
      .locator(".account-panel")
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await page.getByRole("link", { name: "Fixture tools", exact: true }).click();
    await page.getByLabel("Recovery draft", { exact: true }).waitFor();
    await page.getByLabel("Recovery draft", { exact: true }).fill("New session draft");
    await read.release();
    await settle(page);
    assert.equal(
      await page.getByLabel("Recovery draft", { exact: true }).inputValue(),
      "New session draft",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.restoreActivations),
      "2",
    );
    assert.equal(await page.locator(".application-alert").count(), 0);
    assert.equal(await page.evaluate(() => window.fixtureLiveSources[0]?.closed), true);
  } finally {
    await read.release();
  }
});

void test("overlapping campaign restores restart clean add-ons only after the latest read", async (t) => {
  const page = await open(t);
  const first = await holdCoreWrite(page, "/api/campaign", "headers");
  const secondRelease = Promise.withResolvers<void>();
  try {
    await restore(page);
    await first.started();
    await page.route("**/api/campaign", async (route) => {
      await secondRelease.promise;
      await route.fulfill({ json: restoredCampaign("Latest restored frontier") });
    });
    const secondStarted = page.waitForRequest((request) => request.url().endsWith("/api/campaign"));
    await restore(page, 2);
    await secondStarted;
    await first.release();
    await settle(page);
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.restoreActivations),
      "1",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.restoreDisposals ?? "0"),
      "0",
    );
    secondRelease.resolve();
    await page
      .locator(".campaign-brand strong")
      .filter({ hasText: "Latest restored frontier" })
      .waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.restoreActivations === "2");
    await page.getByLabel("Recovery draft", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.restoreDisposals), "1");
    assert.equal(await page.locator(".application-alert").count(), 0);
  } finally {
    secondRelease.resolve();
    await first.release();
  }
});

void test("a clean campaign restore still restarts add-ons after same-role token renewal", async (t) => {
  const page = await open(t);
  await page.route("**/api/auth", (route) =>
    route.fulfill({
      json: {
        ok: true,
        role: "dm",
        realRole: "dm",
        csrfToken: "n".repeat(32),
        expiresAt: "2099-01-01T00:00:00Z",
      },
    }),
  );
  await page.route("**/api/campaign", (route) => route.fulfill({ json: restoredCampaign() }));
  await restore(page);
  await page.waitForFunction(() => document.documentElement.dataset.restoreActivations === "2");
  await page.getByLabel("Recovery draft", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Recovery draft", { exact: true }).inputValue(),
    "Saved draft",
  );
  assert.equal(await page.evaluate(() => window.fixtureLiveSources[0]?.closed), false);
  assert.equal(await page.locator(".application-alert").count(), 0);
});
