import type { Browser, Page } from "playwright";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, after, test } from "node:test";
import { chromium } from "playwright";
import { trackBrowserContext } from "./browser-diagnostics.mts";
import { installReviewedPackage, jsonResponse, zip } from "./installed-graph-fixture.mts";
import { buildRealHost, startRealHost, type RealHost, type RealHostBuild } from "./real-host.mts";

let build: RealHostBuild, host: RealHost, browser: Browser;

before(async () => {
  build = await buildRealHost("addon-languages");
  host = await startRealHost(build);
  browser = await chromium.launch({ headless: true });
  await installReviewedPackage(host.admin, host.csrf, "lang-engine", enginePackage(), []);
  await installReviewedPackage(host.admin, host.csrf, "lang-ui", interfacePackage(), []);
});
after(async () => {
  await browser?.close();
  await host?.stop();
  await build?.remove();
});

const compatibility = { host: ">=2.0.0 <3.0.0", addonApi: "^3.0.0" };

function catalog(locale: string, sections: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({ contractVersion: "message-catalog.v1", locale, sections });
}

function packageArchive(files: Record<string, string>): Buffer {
  const checksums = Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      createHash("sha256").update(body).digest("hex"),
    ]),
  );
  return zip({
    ...files,
    "checksums.json": JSON.stringify({ algorithm: "sha256", files: checksums }),
  });
}

/** A headless add-on whose catalog translates the messages its worker would send. */
function enginePackage(): Buffer {
  return packageArchive({
    "addon.json": JSON.stringify({
      packageFormat: 1,
      id: "lang-engine",
      name: "Language engine",
      version: "1.0.0",
      compatibility,
      capabilities: { required: [], optional: [] },
      permissions: [],
      locales: { en: "locales/en.json", cs: "locales/cs.json" },
    }),
    "locales/en.json": catalog("en", {
      messages: { "engine.unknownSpell": "The spell {name} is unknown." },
    }),
    "locales/cs.json": catalog("cs", {
      messages: { "engine.unknownSpell": "Kouzlo {name} neznám." },
    }),
  });
}

function interfacePackage(): Buffer {
  const entry = `export function activate(context) {
    const tag = 'lang-ui-' + context.addon.generation;
    if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
      connectedCallback() {
        this.stop = context.i18n.onChange(() => this.render());
        this.render();
      }
      disconnectedCallback() { this.stop?.(); }
      render() {
        const i18n = context.i18n;
        this.textContent = [
          i18n.locale,
          i18n.t('main.title'),
          i18n.plural('main.count', 3),
          i18n.message({ text: 'The spell Ward is unknown.', key: 'engine.unknownSpell', args: { name: 'Ward' }, addon: 'lang-engine' }),
          i18n.t('missing.key'),
        ].join(' | ');
      }
    });
    context.ui.bind('page', { kind: 'element', tag });
  }`;
  return packageArchive({
    "addon.json": JSON.stringify({
      packageFormat: 1,
      id: "lang-ui",
      name: "Language fixture",
      version: "1.0.0",
      compatibility,
      capabilities: { required: ["ui.contributions", "ui.i18n"], optional: [] },
      runtime: { ui: { mode: "integrated", entry: "web/index.js" } },
      permissions: [],
      contributions: [
        {
          id: "page",
          surface: "route",
          label: "Language page",
          roles: ["dm", "player"],
          config: { path: "language-page" },
        },
        {
          id: "nav",
          surface: "sidebar",
          label: "Language page",
          roles: ["dm", "player"],
          config: { route: "page" },
        },
      ],
      locales: { en: "locales/en.json", cs: "locales/cs.json" },
    }),
    "web/index.js": entry,
    "locales/en.json": catalog("en", {
      main: {
        "main.title": "Fixture title",
        "main.count": { one: "{n} spell", other: "{n} spells" },
      },
    }),
    "locales/cs.json": catalog("cs", {
      manifest: { "manifest.contribution.nav.label": "Jazyková stránka" },
      main: {
        "main.title": "Název ukázky",
        "main.count": { one: "{n} kouzlo", few: "{n} kouzla", other: "{n} kouzel" },
      },
    }),
  });
}

async function open(t: TestContext, role: "dm" | "player", mobile = false): Promise<Page> {
  const context = await browser.newContext({
    baseURL: host.origin,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: "reduce",
  });
  await trackBrowserContext(t, context);
  await jsonResponse(
    await context.request.post("/api/login", { data: { password: host.password(role) } }),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

async function setSiteLanguage(defaultLocale: string): Promise<void> {
  const current = await jsonResponse(await host.admin.get("/api/campaign"));
  const settings = (
    current.collections as { name: string; records: { key: string; revision: number }[] }[]
  ).find((collection) => collection.name === "settings")!;
  const revision = settings.records.find((record) => record.key === "language")?.revision ?? 0;
  await jsonResponse(
    await host.admin.post("/api/campaign/transactions", {
      headers: { "X-Codex-CSRF": host.csrf },
      data: {
        contractVersion: "campaign-mutation.v1",
        mutations: [
          {
            operation: "put",
            collection: "settings",
            key: "language",
            expectedRevision: revision,
            value: { defaultLocale, enabledLocales: ["en", "cs"] },
          },
        ],
      },
    }),
  );
}

void test("add-on texts, labels and provider messages follow the site language live", async (t) => {
  await setSiteLanguage("en");
  const page = await open(t, "player");
  await page.goto("/#/addons/lang-ui/language-page");
  const view = page.locator('[data-codex-addon="lang-ui"]');
  await view
    .filter({
      hasText: "en | Fixture title | 3 spells | The spell Ward is unknown. | missing.key",
    })
    .waitFor();
  const link = page.locator('.addon-navigation-link[data-addon-id="lang-ui"]');
  assert.equal(await link.textContent(), "Language page");

  await setSiteLanguage("cs");
  await page.waitForFunction(() => document.documentElement.lang === "cs");
  await view
    .filter({
      hasText: "cs | Název ukázky | 3 kouzla | Kouzlo Ward neznám. | missing.key",
    })
    .waitFor();
  await link.filter({ hasText: "Jazyková stránka" }).waitFor();
  await setSiteLanguage("en");
});

void test("catalogs are served immutably by exact generation and digest", async (t) => {
  const page = await open(t, "dm");
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const graph = await (await fetch("/api/addons/browser-graph")).json();
    const engine = graph.catalogs.find(
      (entry: { addonId: string }) => entry.addonId === "lang-engine",
    );
    const czech = engine.locales.find((locale: { locale: string }) => locale.locale === "cs");
    const served = await fetch(czech.url);
    const stale = await fetch(czech.url.replace(/[0-9a-f]{64}$/u, "0".repeat(64)));
    return {
      addons: graph.addons.map((addon: { addonId: string }) => addon.addonId),
      cacheControl: served.headers.get("Cache-Control"),
      etag: served.headers.get("ETag"),
      sha256: czech.sha256,
      body: await served.json(),
      stale: stale.status,
    };
  });
  assert.deepEqual(
    result.addons,
    ["lang-ui"],
    "headless add-ons are indexed without a UI generation",
  );
  assert.equal(result.cacheControl, "private, max-age=31536000, immutable");
  assert.equal(result.etag, `"${result.sha256}"`);
  assert.equal(result.body.sections.messages["engine.unknownSpell"], "Kouzlo {name} neznám.");
  assert.equal(result.stale, 404);
});
