import { afterEach, describe, expect, it } from "vitest";
import {
  availableUiLocales,
  resolveUiLocale,
  setUiLocale,
  uiCollectionLabel,
  uiPlural,
  uiRelativeDate,
  uiText,
} from "../src/app/ui-localization.js";

describe("UI localization", () => {
  afterEach(() => { setUiLocale("en"); });

  it("defaults unknown stored values to English and honors an explicit Czech choice", () => {
    expect(resolveUiLocale(null)).toBe("en");
    expect(resolveUiLocale("de")).toBe("en");
    expect(resolveUiLocale("cs")).toBe("cs");
    expect(availableUiLocales.map(({ id }) => id)).toEqual(["en", "cs"]);
  });

  it("translates shell and collection labels from the bundled catalogs", () => {
    expect(uiText("shell.settings")).toBe("Settings");
    setUiLocale("cs");
    expect(uiText("shell.settings")).toBe("Nastavení");
    expect(uiCollectionLabel("characters", "other")).toBe("Postavy");
    expect(uiCollectionLabel("unknown", "other")).toBe("unknown");
  });

  it("uses native Czech plural categories and interpolates values", () => {
    setUiLocale("cs");
    expect(uiPlural("dashboard.characterCount", 1)).toBe("1 postava");
    expect(uiPlural("dashboard.characterCount", 3)).toBe("3 postavy");
    expect(uiPlural("dashboard.characterCount", 8)).toBe("8 postav");
    expect(uiPlural("shell.addonGenerationsActive", 3)).toBe("Aktivní jsou 3 generace doplňků");
    expect(uiText("search.empty", { query: "drak" })).toContain("drak");
  });

  it("formats relative dates using the active catalog", () => {
    const now = Date.parse("2026-09-04T12:00:00Z");
    expect(uiRelativeDate("2026-09-04T08:00:00Z", now)).toBe("today");
    setUiLocale("cs");
    expect(uiRelativeDate("2026-09-03T08:00:00Z", now)).toBe("včera");
  });
});
