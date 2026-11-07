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
      runtime: { ui: { mode: "integrated", entry: "web/index.js", styles: ["web/index.css"] } },
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
    "web/index.css": `.lang-fixture { padding: var(--space-2) 6px; }
.lang-fixture button { color: var(--accent-gold); }
@media (min-width: 40rem) { .lang-fixture select { gap: var(--space-2); } }
`,
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
  await page.goto("/addons/lang-ui/language-page");
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

for (const mobile of [false, true])
  void test(`the DM sees what each add-on translates, compares and exports it (${mobile ? "phone" : "desktop"})`, async (t) => {
    await setSiteLanguage("en");
    const page = await open(t, "dm", mobile);
    await page.goto("/settings/language");
    const coverage = page.locator("codex-language-coverage");
    const fixture = coverage.locator('[data-source="lang-ui"]');
    await fixture.locator(".language-coverage-figure").waitFor();
    assert.equal(
      await coverage.locator('[data-source="codex"] .language-coverage-figure').textContent(),
      "100%",
    );
    // English names the add-on, two contributions and two messages; Czech translates three.
    assert.equal(await fixture.locator(".language-coverage-figure").textContent(), "60%");
    assert.match(
      await fixture.locator("summary").textContent().then(String),
      /3 of 5 · in the add-on package/u,
    );
    assert.equal(
      await coverage.locator('[data-source="lang-engine"] .language-coverage-figure').textContent(),
      "50%",
    );

    await fixture.locator("summary").click();
    const exported = await fixture
      .locator(".language-coverage-export")
      .evaluate((link: HTMLAnchorElement) => ({
        name: link.download,
        catalog: JSON.parse(decodeURIComponent(link.href.slice(link.href.indexOf(",") + 1))),
      }));
    assert.equal(exported.name, "lang-ui-cs-missing.json");
    assert.deepEqual(exported.catalog, {
      contractVersion: "message-catalog.v1",
      locale: "cs",
      sections: {
        manifest: {
          "manifest.name": "Language fixture",
          "manifest.contribution.page.label": "Language page",
        },
      },
    });

    await fixture
      .getByRole("button", { name: "Compare main of Language fixture", exact: true })
      .click();
    const comparison = page.locator(".language-comparison");
    await comparison.locator("tbody tr").first().waitFor();
    assert.deepEqual(await comparison.locator("tbody th").allTextContents(), [
      "main.title",
      "main.count",
    ]);
    assert.equal(
      await comparison.locator("tbody tr").nth(1).locator("td").nth(1).textContent(),
      "one: {n} kouzlo · few: {n} kouzla · other: {n} kouzel",
    );
    await fixture
      .getByRole("button", { name: "Compare manifest of Language fixture", exact: true })
      .click();
    await comparison.getByLabel("Missing only").check();
    assert.deepEqual(await comparison.locator("tbody th").allTextContents(), [
      "manifest.name",
      "manifest.contribution.page.label",
    ]);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: `test-results/addon-languages/coverage-${mobile ? "phone" : "desktop"}.png`,
      fullPage: true,
    });
  });

void test("the DM sees which add-on styles restyle shared controls", async (t) => {
  const page = await open(t, "dm");
  await page.goto("/settings/appearance");
  const map = page.locator("codex-interface-consistency");
  const addon = map.locator('[data-addon="lang-ui"]');
  await addon
    .locator('[data-figure="overrides"]')
    .filter({ hasText: "Restyled shared controls: 2" })
    .waitFor();
  assert.match(
    await addon.locator("summary").textContent().then(String),
    /Style rules: 3 · Own parts: 1 · Fixed spacing: 1/u,
  );
  await addon.locator("summary").click();
  assert.deepEqual(await addon.locator('[data-kind="buttons"] li').allTextContents(), [
    ".lang-fixture button",
  ]);
  assert.deepEqual(await addon.locator('[data-kind="selects"] li').allTextContents(), [
    ".lang-fixture select",
  ]);
  assert.deepEqual(await addon.locator('[data-kind="spacing"] li').allTextContents(), [
    ".lang-fixture padding: var(--space-2) 6px",
  ]);
  assert.equal(
    await map.locator('[data-addon="lang-engine"]').count(),
    0,
    "headless add-ons have no styles",
  );
});
