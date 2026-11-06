import { describe, expect, it } from "vitest";
import {
  catalogMessageCount,
  checkMessageCatalog,
  flattenCatalog,
  manifestSection,
} from "../src/core/message-catalog.js";
import { controlMessages, hostCatalogs, hostLocales, hostMessage } from "../src/locales/index.js";

describe("host message catalogs", () => {
  const english = hostCatalogs.find(({ locale }) => locale === "en")!;

  it("ships English first and leaves the manifest section to add-ons", () => {
    expect(hostLocales[0]).toBe("en");
    for (const catalog of hostCatalogs)
      expect(Object.keys(catalog.sections)).not.toContain(manifestSection);
  });

  for (const catalog of hostCatalogs)
    it(`keeps ${catalog.locale} complete and within the catalog rules`, () => {
      const result = checkMessageCatalog(catalog, {
        locale: catalog.locale,
        ...(catalog.locale === "en" ? {} : { english }),
      });
      expect(result.issues).toEqual([]);
      expect(catalogMessageCount(catalog)).toBe(catalogMessageCount(english));
      expect([...flattenCatalog(catalog).keys()].sort()).toEqual(
        [...flattenCatalog(english).keys()].sort(),
      );
    });

  it("falls back to a base language and then English", () => {
    expect(hostMessage("cs-CZ", "shell.settings")).toBe("Nastavení");
    expect(hostMessage("de", "shell.settings")).toBe("Settings");
    expect(hostMessage("cs", "not a key")).toBeUndefined();
  });

  it("gives shared controls their texts by lang attribute", () => {
    expect(controlMessages("cs-cz").remove).toBe("Odebrat {0}");
    expect(controlMessages("EN").clear).toBe("Clear search");
    expect(controlMessages("not a tag").menu).toBe("Actions");
  });
});
