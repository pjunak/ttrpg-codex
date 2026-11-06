import { describe, expect, it } from "vitest";
import cases from "../../contracts/addons/v3/examples/catalogs/cases.json";
import cs from "../../contracts/addons/v3/examples/catalogs/cs.json";
import duplicateAcrossSections from "../../contracts/addons/v3/examples/catalogs/duplicate-across-sections.json";
import enEffective from "../../contracts/addons/v3/examples/catalogs/en-effective.json";
import enWithManifest from "../../contracts/addons/v3/examples/catalogs/en-with-manifest.json";
import en from "../../contracts/addons/v3/examples/catalogs/en.json";
import flatLegacy from "../../contracts/addons/v3/examples/catalogs/flat-legacy.json";
import pluralEnglishString from "../../contracts/addons/v3/examples/catalogs/plural-english-string.json";
import ruleBreaks from "../../contracts/addons/v3/examples/catalogs/rule-breaks.json";
import wrongLocale from "../../contracts/addons/v3/examples/catalogs/wrong-locale.json";
import { BoundaryValidationError } from "../src/core/boundary.js";
import {
  catalogMessageCount,
  checkMessageCatalog,
  flattenCatalog,
  interpolate,
  localeFallbacks,
  messagePlaceholders,
  parseMessageCatalog,
  selectPluralForm,
} from "../src/core/message-catalog.js";

const files: Readonly<Record<string, unknown>> = {
  "cs.json": cs,
  "duplicate-across-sections.json": duplicateAcrossSections,
  "en-effective.json": enEffective,
  "en-with-manifest.json": enWithManifest,
  "en.json": en,
  "flat-legacy.json": flatLegacy,
  "plural-english-string.json": pluralEnglishString,
  "rule-breaks.json": ruleBreaks,
  "wrong-locale.json": wrongLocale,
};

describe("message catalogs", () => {
  for (const fixture of cases.cases.filter((entry) => !("goOnly" in entry))) {
    it(`matches the shared fixture: ${fixture.name}`, () => {
      const english =
        "english" in fixture ? parseMessageCatalog(files[fixture.english], "fixture") : undefined;
      const result = checkMessageCatalog(files[fixture.file], {
        locale: fixture.locale,
        ...(english === undefined ? {} : { english }),
      });
      expect(result.catalog === undefined).toBe(fixture.rejected);
      if (fixture.rejected) {
        expect(result.issues).toHaveLength(1);
        return;
      }
      expect(result.dropped).toEqual(fixture.dropped);
      expect(result.issues).toHaveLength(fixture.dropped?.length ?? 0);
      expect(catalogMessageCount(result.catalog!)).toBe(fixture.messages);
    });
  }

  it("rejects a malformed boundary value", () => {
    expect(() => parseMessageCatalog(flatLegacy, "GET catalog")).toThrow(BoundaryValidationError);
    expect(() =>
      parseMessageCatalog(
        {
          contractVersion: "message-catalog.v1",
          locale: "cs",
          sections: { s: { k: { one: "x" } } },
        },
        "GET catalog",
      ),
    ).toThrow("not a valid message");
  });

  it("flattens, reads placeholders and selects plural forms", () => {
    const catalog = parseMessageCatalog(cs, "fixture");
    const messages = flattenCatalog(catalog);
    expect(messages.get("browse.title")).toBe("Kompendium");
    expect([...messagePlaceholders(messages.get("browse.results")!)]).toEqual(["n"]);
    expect(selectPluralForm(messages.get("browse.results")!, "cs", 3)).toBe("{n} výsledky");
    expect(selectPluralForm(messages.get("browse.results")!, "cs", 5)).toBe("{n} výsledků");
    expect(selectPluralForm({ other: "{n} items" }, "en", 1)).toBe("{n} items");
    expect(interpolate("{n} for {who} {missing} $&", { n: 2, who: "$&" })).toBe(
      "2 for $& {missing} $&",
    );
  });

  it("falls back through base languages to English", () => {
    expect(localeFallbacks("pt-BR")).toEqual(["pt-BR", "pt", "en"]);
    expect(localeFallbacks("sr-Latn-RS")).toEqual(["sr-Latn-RS", "sr-Latn", "sr", "en"]);
    expect(localeFallbacks("en")).toEqual(["en"]);
    expect(localeFallbacks("not a tag")).toEqual(["en"]);
  });
});
