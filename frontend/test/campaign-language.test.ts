import { afterEach, describe, expect, it } from "vitest";
import {
  campaignSiteLanguages,
  prepareCampaignLanguageSave,
} from "../src/app/campaign-language.js";
import {
  applySiteLanguages,
  currentUiLocale,
  parseSiteLanguages,
  personalUiLocale,
  setPersonalUiLocale,
  siteLanguages,
  uiText,
} from "../src/app/ui-localization.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

describe("site languages", () => {
  afterEach(() => {
    setPersonalUiLocale(undefined);
    applySiteLanguages(undefined);
  });

  it("reads the campaign setting and repairs what it can", () => {
    expect(campaignSiteLanguages(dataset())).toBeUndefined();
    expect(
      campaignSiteLanguages(
        dataset([
          { key: "language", revision: 2, value: { defaultLocale: "cs", enabledLocales: ["cs"] } },
        ]),
      ),
    ).toEqual({ defaultLocale: "cs", enabledLocales: ["en", "cs"] });
    expect(parseSiteLanguages({ defaultLocale: "de", enabledLocales: ["en", "cs", "cs"] })).toEqual(
      {
        defaultLocale: "en",
        enabledLocales: ["en", "cs"],
      },
    );
    expect(parseSiteLanguages({ defaultLocale: "cs", enabledLocales: ["cs-cz"] })).toBeUndefined();
    expect(parseSiteLanguages({ defaultLocale: "cs" })).toBeUndefined();
  });

  it("prepares an optimistic settings update without dropping extension fields", () => {
    const campaign = dataset([
      {
        key: "language",
        revision: 3,
        value: { defaultLocale: "en", enabledLocales: ["en"], note: 1 },
      },
    ]);
    expect(
      prepareCampaignLanguageSave(campaign, {
        expectedRevision: 3,
        defaultLocale: "cs",
        enabledLocales: ["en", "cs"],
      }),
    ).toEqual({
      operation: "put",
      collection: "settings",
      key: "language",
      expectedRevision: 3,
      value: { defaultLocale: "cs", enabledLocales: ["en", "cs"], note: 1 },
    });
    expect(() =>
      prepareCampaignLanguageSave(dataset(), {
        expectedRevision: 1,
        defaultLocale: "en",
        enabledLocales: ["en"],
      }),
    ).toThrow("campaign language revision is stale");
    expect(() =>
      prepareCampaignLanguageSave(dataset(), {
        expectedRevision: 0,
        defaultLocale: "x",
        enabledLocales: [],
      }),
    ).toThrow("campaign language edit is invalid");
  });

  it("follows the site default until the browser picks an enabled language", () => {
    expect(siteLanguages()).toEqual({ defaultLocale: "en", enabledLocales: ["en", "cs"] });
    applySiteLanguages({ defaultLocale: "cs", enabledLocales: ["en", "cs"] });
    expect(currentUiLocale()).toBe("cs");
    expect(uiText("shell.settings")).toBe("Nastavení");
    setPersonalUiLocale("en");
    expect(currentUiLocale()).toBe("en");
    expect(personalUiLocale()).toBe("en");
    // A personal choice the site no longer offers falls back to the site default.
    applySiteLanguages({ defaultLocale: "cs", enabledLocales: ["cs"] });
    expect(currentUiLocale()).toBe("en");
    setPersonalUiLocale("de");
    expect(currentUiLocale()).toBe("cs");
    setPersonalUiLocale(undefined);
    expect(currentUiLocale()).toBe("cs");
    applySiteLanguages(undefined);
    expect(currentUiLocale()).toBe("en");
  });

  it("falls back to English for host texts in a language only add-ons ship", () => {
    applySiteLanguages({ defaultLocale: "de", enabledLocales: ["en", "de"] });
    expect(currentUiLocale()).toBe("de");
    expect(uiText("shell.settings")).toBe("Settings");
  });
});

const names: readonly CampaignCollectionName[] = [
  "characters",
  "relationships",
  "locations",
  "events",
  "mysteries",
  "factions",
  "pantheon",
  "artifacts",
  "settings",
  "historicalEvents",
  "campaign",
  "companions",
];

function dataset(settings: CampaignCollection["records"] = []): CampaignDataset {
  return {
    contractVersion: "campaign-data.v1",
    collections: names.map((name) => ({
      name,
      shape:
        name === "factions" || name === "settings" || name === "campaign"
          ? ("keyed" as const)
          : ("list" as const),
      materialized: true,
      revision: 1,
      records: name === "settings" ? settings : [],
    })),
  };
}
