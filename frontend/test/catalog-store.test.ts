import { afterEach, describe, expect, it, vi } from "vitest";
import { setUiLocale } from "../src/app/ui-localization.js";
import { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import { BrowserCatalogStore } from "../src/addons/catalog-store.js";
import { activeContributionLabel } from "../src/addons/contribution-label.js";
import type {
  BrowserCatalogIndexEntry,
  BrowserGenerationDescriptor,
} from "../src/addons/generation-manager.js";
import { GenerationScope } from "../src/addons/generation-scope.js";

const generation = "a".repeat(64);
const catalogs: Record<string, unknown> = {
  "sheets/en": catalog("en", {
    manifest: { "manifest.contribution.sheet.label": "Character sheet" },
    main: {
      "main.title": "Sheet",
      "main.only-english": "Only English",
      "main.count": { one: "{n} spell", other: "{n} spells" },
    },
  }),
  "sheets/cs": catalog("cs", {
    manifest: { "manifest.contribution.sheet.label": "Deník postavy" },
    main: {
      "main.title": "Deník",
      "main.count": { one: "{n} kouzlo", few: "{n} kouzla", other: "{n} kouzel" },
    },
  }),
  "engine/en": catalog("en", { messages: { "engine.missing": "{name} is missing." } }),
  "engine/cs": catalog("cs", { messages: { "engine.missing": "{name} chybí." } }),
  "broken/en": catalog("cs", { main: { "main.title": "Wrong language" } }),
};

function catalog(locale: string, sections: Record<string, Record<string, unknown>>) {
  return { contractVersion: "message-catalog.v1", locale, sections };
}

function entry(addonId: string, locales: readonly string[]): BrowserCatalogIndexEntry {
  return {
    addonId,
    addonName: addonId,
    generationId: generation,
    locales: locales.map((locale) => {
      const sha256 = (addonId.length.toString(16) + locale).padEnd(64, "0").slice(0, 64);
      return {
        locale,
        url: `/api/addons/${addonId}/generations/${generation}/locales/${locale}/${sha256}`,
        sha256,
        messages: 1,
        source: "package" as const,
        issues: [],
      };
    }),
  };
}

function fakeFetch(failing = new Set<string>()) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const [, , , addonId, , , , locale] = url.split("/");
    const key = `${addonId}/${locale}`;
    if (failing.has(key)) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify(catalogs[key]), {
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("browser catalog store", () => {
  afterEach(() => setUiLocale("en"));

  it("loads a language with its fallbacks once and resolves messages through them", async () => {
    const fetch = fakeFetch(),
      store = new BrowserCatalogStore({ fetch });
    store.settleIndex([entry("sheets", ["en", "cs"])]);
    await store.prepare("sheets", "cs-CZ");
    await store.prepare("sheets", "cs");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.message("sheets", "main.title", "cs")).toBe("Deník");
    expect(store.message("sheets", "main.only-english", "cs")).toBe("Only English");
    expect(store.message("sheets", "main.only-english", "cs", false)).toBeUndefined();
    expect(store.manifestText("sheets", "manifest.contribution.sheet.label", "cs")).toBe(
      "Deník postavy",
    );
    expect(store.manifestText("sheets", "manifest.contribution.sheet.label", "de")).toBeUndefined();
    expect(store.locales()).toEqual(["en", "cs"]);
    expect((await store.catalog("sheets", "cs"))?.sections["main"]?.["main.title"]).toBe("Deník");
  });

  it("loads a missing language on first use and notifies once it arrives", async () => {
    const store = new BrowserCatalogStore({ fetch: fakeFetch() });
    store.settleIndex([entry("engine", ["en", "cs"])]);
    const notified = new Promise<void>((resolve) => store.subscribe(resolve));
    expect(store.message("engine", "engine.missing", "cs")).toBeUndefined();
    await notified;
    expect(store.message("engine", "engine.missing", "cs")).toBe("{name} chybí.");
  });

  it("reports a failed or mismatched catalog once and falls back to English", async () => {
    const errors: unknown[] = [],
      fetch = fakeFetch(new Set(["sheets/cs"])),
      store = new BrowserCatalogStore({ fetch, onError: (cause) => errors.push(cause) });
    store.settleIndex([entry("sheets", ["en", "cs"]), entry("broken", ["en"])]);
    await store.prepareAll("cs");
    expect(store.message("sheets", "main.title", "cs")).toBe("Sheet");
    expect(store.message("broken", "main.title", "en")).toBeUndefined();
    expect(errors).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(3);
    store.message("sheets", "main.title", "cs");
    await store.prepare("sheets", "cs");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("translates contribution labels through the catalog before deprecated labels", async () => {
    const store = new BrowserCatalogStore({ fetch: fakeFetch() });
    store.settleIndex([entry("sheets", ["en", "cs"])]);
    await store.prepare("sheets", "cs");
    const active = {
      addonId: "sheets",
      descriptor: {
        id: "sheet",
        label: "Character sheet",
        config: { labels: { cs: "Starý popisek" } },
      },
    };
    expect(activeContributionLabel(active, "cs", store)).toBe("Deník postavy");
    expect(activeContributionLabel(active, "en", store)).toBe("Character sheet");
    expect(activeContributionLabel({ ...active, addonId: "other" }, "cs", store)).toBe(
      "Starý popisek",
    );
  });
});

describe("ui.i18n", () => {
  afterEach(() => setUiLocale("en"));

  function open(capabilities: readonly string[]) {
    const store = new BrowserCatalogStore({ fetch: fakeFetch() });
    store.settleIndex([entry("sheets", ["en", "cs"]), entry("engine", ["en", "cs"])]);
    const registry = new BrowserContributionRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );
    const descriptor: BrowserGenerationDescriptor = {
      addonId: "sheets",
      addonVersion: "1.0.0",
      generationId: generation,
      entryUrl: `/api/addons/sheets/generations/${generation}/assets/web/index.js`,
      styleUrls: [],
      dependencies: [],
      capabilities,
      permissions: [],
      contributions: [],
    };
    const scope = new GenerationScope("sheets@test");
    return { store, scope, context: registry.open(descriptor, scope).context };
  }

  it("translates the add-on's own and its provider's messages in the reader's language", async () => {
    const { store, context } = open(["ui.i18n"]);
    setUiLocale("cs");
    await store.prepareAll("cs");
    expect(context.i18n.locale).toBe("cs");
    expect(context.i18n.t("main.title")).toBe("Deník");
    expect(context.i18n.plural("main.count", 3)).toBe("3 kouzla");
    expect(context.i18n.t("missing")).toBe("missing");
    expect(
      context.i18n.message({
        text: "Ward is missing.",
        key: "engine.missing",
        args: { name: "Ward" },
        addon: "engine",
      }),
    ).toBe("Ward chybí.");
    expect(context.i18n.message({ text: "Plain English" })).toBe("Plain English");
    expect(context.i18n.message({ text: "Fallback", key: "engine.unknown", addon: "engine" })).toBe(
      "Fallback",
    );
    expect(() => context.i18n.message({ text: "x", addon: "Not An Id" })).toThrow(TypeError);
    // The host's own services key their texts in the host's catalog.
    expect(
      context.i18n.message({
        text: "Campaign bundle",
        key: "importAdapter.campaignBundle.label",
        addon: "codex-core",
      }),
    ).toBe("Balíček kampaně");
  });

  it("notifies until the generation stops and requires the capability", async () => {
    const { store, scope, context } = open(["ui.i18n"]);
    const listener = vi.fn();
    context.i18n.onChange(listener);
    store.settleIndex([entry("sheets", ["en"])]);
    expect(listener).toHaveBeenCalledTimes(1);
    await scope.dispose("reload");
    store.settleIndex([entry("sheets", ["en", "cs"])]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => open([]).context.i18n.t("main.title")).toThrow("ui.i18n");
  });
});
