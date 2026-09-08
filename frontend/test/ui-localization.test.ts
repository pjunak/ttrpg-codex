import { afterEach, describe, expect, it } from "vitest";
import { sourceEn, sourceCs } from "../src/app/ui-source-messages.js";
import { editorFieldsFor } from "../src/app/campaign-record-editor.js";
import { campaignEnumDescriptor } from "../src/app/campaign-settings.js";
import { campaignPages } from "../src/app/routes.js";
import { uiRequestError } from "../src/app/ui-errors.js";
import { HostRequestError } from "../src/core/api.js";
import { contributionLabel } from "../src/addons/contribution-label.js";
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

  it("covers every source message and preserves literal authored interpolation", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\w+\}/gu)].map(match => match[0]).sort();
    expect(Object.keys(sourceEn)).toEqual(Object.keys(sourceCs));
    for (const key of Object.keys(sourceEn) as (keyof typeof sourceEn)[]) {
      expect(sourceCs[key].trim(), key).not.toBe("");
      expect(placeholders(sourceCs[key]), key).toEqual(placeholders(sourceEn[key]));
    }
    setUiLocale("cs");
    expect(uiText("Edit {0}", { 0: "Title {0} $&" })).toBe("Upravit: Title {0} $&");
  });

  it("updates stable descriptors without replacing editor identities or stored values", () => {
    const fields = editorFieldsFor("characters"), name = fields.find(field => field.key === "name")!;
    const descriptor = campaignEnumDescriptor("relationshipTypes");
    const directions = descriptor.fields.find(field => field.key === "style")!.options!;
    expect(name.label).toBe("Name");
    setUiLocale("cs");
    expect(editorFieldsFor("characters")).toBe(fields);
    expect(name.label).toBe("Název");
    expect(fields.find(field => field.key === "rankAssignment")?.help).toContain("Hodnosti");
    expect(descriptor.label).toBe("Vztahy");
    expect(directions[0]).toMatchObject({ value: "solid", label: "Plná" });
    expect(campaignPages[0]?.plural).toBe("Postavy");
    expect(uiPlural("settings.usedRecords", 3)).toBe("Používají 3 záznamy");
    expect(uiPlural("settings.usedRecords", 8)).toBe("Používá 8 záznamů");
  });

  it("localizes recovery actions while retaining diagnostic errors", () => {
    const error = new HostRequestError(401, "POST /api/login");
    setUiLocale("cs");
    expect(uiRequestError(error)).toBe("Přihlaste se správným heslem a zkuste to znovu.");
    expect(error.message).toBe("POST /api/login returned 401");
    expect(uiRequestError(new HostRequestError(503, "GET /api/health"))).toContain("Server není dostupný");
  });

  it("uses bounded add-on labels with a required-label fallback", () => {
    const descriptor = { label: "Authored fallback", config: { labels: { cs: "Plánovač příběhu" } } };
    expect(contributionLabel(descriptor, "cs")).toBe("Plánovač příběhu");
    for (const locale of ["en", "unknown", undefined]) expect(contributionLabel(descriptor, locale)).toBe("Authored fallback");
    for (const cs of ["", " ", "a".repeat(201), "bad\nlabel", 42]) expect(contributionLabel({ ...descriptor, config: { labels: { cs } } }, "cs")).toBe("Authored fallback");
  });

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
