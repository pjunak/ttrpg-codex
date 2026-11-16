import { describe, expect, it } from "vitest";
import { parseMessageCatalog } from "../src/core/message-catalog.js";
import {
  catalogCoverage,
  coveragePercent,
  coverageRows,
  missingCatalog,
  packNotice,
} from "../src/app/language-coverage.js";

const english = parseMessageCatalog(
  {
    contractVersion: "message-catalog.v1",
    locale: "en",
    sections: {
      manifest: { "manifest.name": "Fixture" },
      main: {
        "main.title": "Title",
        "main.count": { one: "{n} spell", other: "{n} spells" },
        "main.extra": "Extra",
      },
      empty: {},
    },
  },
  "test",
);
const czech = parseMessageCatalog(
  {
    contractVersion: "message-catalog.v1",
    locale: "cs",
    sections: { main: { "main.title": "Název", "main.count": "Kouzla: {n}" } },
  },
  "test",
);

describe("language coverage", () => {
  it("counts each language's own translations by section", () => {
    const coverage = catalogCoverage(
      "fixture",
      "Fixture",
      english,
      new Map([
        ["cs", czech],
        ["de", undefined],
      ]),
    );
    expect(coverage.total).toBe(4);
    expect(coverage.translated).toEqual({ cs: 2, de: 0 });
    expect(coverage.sections).toEqual([
      { id: "manifest", total: 1, translated: { cs: 0, de: 0 } },
      { id: "main", total: 3, translated: { cs: 2, de: 0 } },
    ]);
  });

  it("puts English beside the translation and marks what is missing", () => {
    expect(coverageRows(english, czech, "main")).toEqual([
      { key: "main.title", english: "Title", translation: "Název" },
      {
        key: "main.count",
        english: "one: {n} spell · other: {n} spells",
        translation: "Kouzla: {n}",
      },
      { key: "main.extra", english: "Extra", translation: undefined },
    ]);
  });

  it("exports the missing texts as a catalog to translate", () => {
    expect(missingCatalog(english, czech, "cs")).toEqual({
      contractVersion: "message-catalog.v1",
      locale: "cs",
      sections: { manifest: { "manifest.name": "Fixture" }, main: { "main.extra": "Extra" } },
    });
    expect(missingCatalog(english, undefined, "de").sections["main"]).toEqual(
      english.sections["main"],
    );
  });

  it("never rounds an incomplete language up to 100 %", () => {
    expect(coveragePercent(999, 1000)).toBe(99);
    expect(coveragePercent(0, 0)).toBe(100);
  });

  it("describes language packs in use, missing and failed", () => {
    expect(packNotice(undefined)).toBeUndefined();
    expect(packNotice({ locale: "de", status: "installed", version: "3.6.0" })).toEqual({
      key: "settings.packInstalled",
      version: "3.6.0",
      problem: false,
    });
    expect(
      packNotice({ locale: "de", status: "installed", version: "3.6.0", error: "rate-limited" }),
    ).toEqual({
      key: "settings.packInstalledCheckFailed",
      version: "3.6.0",
      reason: "settings.packError.rate-limited",
      problem: true,
    });
    expect(packNotice({ locale: "de", status: "failed", error: "tls" })).toMatchObject({
      key: "settings.packFailed",
      reason: "settings.packError.tls",
      problem: true,
    });
    expect(packNotice({ locale: "de", status: "outdated", version: "2.0.0" })?.problem).toBe(true);
    expect(packNotice({ locale: "de", status: "none" })).toMatchObject({
      key: "settings.packNone",
      problem: false,
    });
    expect(packNotice({ locale: "de", status: "available" })?.key).toBe("settings.packAvailable");
  });
});
