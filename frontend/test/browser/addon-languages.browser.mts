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
.lang-fixture button + button { margin-inline-start: auto; }
@media (min-width: 40rem) { .lang-fixture select { border-color: var(--accent-gold); } }
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

/** A headless add-on that asks for a permission and an add-on, translated into Czech. */
function reviewedPackage(): Buffer {
  return packageArchive({
    "addon.json": JSON.stringify({
      packageFormat: 1,
      id: "lang-review",
      name: "Language review",
      description: "Checks translations.",
      version: "1.0.0",
      compatibility,
      capabilities: { required: [], optional: [] },
      permissions: [
        { id: "core.data.read", resources: ["characters"], reason: "Reads characters." },
      ],
      dependencies: [
        {
          id: "lang-engine",
          range: "^1.0.0",
          required: true,
          reason: "Translates engine messages.",
        },
      ],
      locales: { en: "locales/en.json", cs: "locales/cs.json" },
    }),
    "locales/en.json": catalog("en", { main: { "main.title": "Review" } }),
    "locales/cs.json": catalog("cs", {
      manifest: {
        "manifest.name": "Kontrola jazyka",
        "manifest.description": "Kontroluje překlady.",
        "manifest.permission.core.data.read.reason": "Čte postavy.",
        "manifest.dependency.lang-engine.reason": "Překládá zprávy jádra.",
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
    /Style rules: 4 · Own parts: 1 · Fixed spacing: 1/u,
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

void test("the add-on manager and its activation review read the package's translations", async (t) => {
  const staged = await jsonResponse(
    await host.admin.post("/api/admin/addons/generations", {
      headers: { "X-Codex-CSRF": host.csrf, "Content-Type": "application/zip" },
      data: reviewedPackage(),
    }),
  );
  assert.equal(staged.addonId, "lang-review");
  await setSiteLanguage("cs");
  t.after(() => setSiteLanguage("en"));
  const page = await open(t, "dm");
  await page.goto("/settings/addons");
  const row = page.locator('.addon-row[data-addon-id="lang-review"]');
  // Not active yet: the inventory carries the staged package's translations.
  await row.locator("h3").filter({ hasText: "Kontrola jazyka" }).waitFor();
  await row.getByRole("button", { name: "Zapnout", exact: true }).click();

  const review = page.locator(".addon-review");
  await review
    .locator("#addon-review-title")
    .filter({ hasText: "Zkontrolovat aktivaci: Kontrola jazyka" })
    .waitFor();
  await review.getByText("Kontroluje překlady.", { exact: true }).waitFor();
  const permission = review.getByRole("checkbox", { name: /core\.data\.read/u });
  assert.match(String(await review.locator(".addon-permission").textContent()), /Čte postavy\./u);
  assert.equal(await permission.isChecked(), true);
  assert.equal(
    await review.locator('[data-dependency="lang-engine"]').textContent(),
    "Language engine ^1.0.0 · PovinnéPřekládá zprávy jádra.",
  );
  await review.screenshot({ path: "test-results/addon-languages/review-cs.png" });
  await review.getByRole("button", { name: "Schválit a aktivovat", exact: true }).click();

  await page.locator(".addon-install-dialog").waitFor({ state: "detached" });
  await row.locator('.addon-chip[data-tone="ok"]').waitFor();
  assert.equal(await row.locator("h3").textContent(), "Kontrola jazyka");
  assert.equal(await row.locator(".addon-row-description").textContent(), "Kontroluje překlady.");
});

/** A small headless package named in English and Czech. */
function namedPackage(
  id: string,
  english: string,
  czech: string,
  manifest: Record<string, unknown> = {},
): Buffer {
  return packageArchive({
    "addon.json": JSON.stringify({
      packageFormat: 1,
      id,
      name: english,
      description: `${english} fixture.`,
      version: "1.0.0",
      compatibility,
      capabilities: { required: [], optional: [] },
      permissions: [],
      locales: { en: "locales/en.json", cs: "locales/cs.json" },
      ...manifest,
    }),
    "locales/en.json": catalog("en", { main: { "main.title": english } }),
    "locales/cs.json": catalog("cs", {
      manifest: { "manifest.name": czech, "manifest.description": `Ukázka: ${czech}.` },
    }),
  });
}

void test("disabled add-ons and the configuration panel read installed packages' translations", async (t) => {
  const headers = { "X-Codex-CSRF": host.csrf };
  await installReviewedPackage(
    host.admin,
    host.csrf,
    "lang-switch",
    namedPackage("lang-switch", "Language switch", "Jazykový přepínač"),
    [],
  );
  const installed = await jsonResponse(await host.admin.get("/api/admin/addons/lang-switch"));
  await jsonResponse(
    await host.admin.post("/api/admin/addons/lang-switch/disable", {
      headers,
      data: { expectedStateRevision: installed.state.revision },
    }),
  );
  // A staged consumer of a service nobody provides needs the DM's configuration.
  await jsonResponse(
    await host.admin.post("/api/admin/addons/generations", {
      headers: { ...headers, "Content-Type": "application/zip" },
      data: namedPackage("lang-config", "Language configuration", "Nastavení jazyka", {
        services: {
          consumes: [
            {
              contract: "lang.missing",
              range: "^1.0.0",
              cardinality: "one",
              selection: "operator",
              required: true,
            },
          ],
        },
      }),
    }),
  );
  await setSiteLanguage("cs");
  t.after(() => setSiteLanguage("en"));
  const page = await open(t, "dm");
  await page.goto("/settings/addons");

  const disabled = page.locator('.addon-row[data-addon-id="lang-switch"]');
  await disabled.locator('.addon-chip[data-tone="off"]').waitFor();
  assert.equal(await disabled.locator("h3").textContent(), "Jazykový přepínač");
  assert.equal(
    await disabled.locator(".addon-row-description").textContent(),
    "Ukázka: Jazykový přepínač.",
  );

  const tab = page.locator('[role="tab"][data-addon-tab="lang-config"]');
  await tab.filter({ hasText: "Nastavení jazyka" }).waitFor();
  await tab.click();
  await page
    .locator(".configuration-service legend")
    .filter({ hasText: "Nastavení jazyka · 1.0.0 · Připravený balíček" })
    .waitFor();
  assert.equal(await page.locator("#addon-settings-panel > h3").textContent(), "Nastavení jazyka");
});
