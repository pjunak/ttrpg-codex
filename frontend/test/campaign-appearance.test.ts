import { afterEach, describe, expect, it } from "vitest";
import {
  activeTheme,
  applyCampaignTheme,
  applySiteTheme,
  campaignTheme,
  campaignThemes,
  onThemeChange,
  personalTheme,
  prepareCampaignAppearanceSave,
  setPersonalTheme,
  siteTheme,
} from "../src/app/campaign-appearance.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

describe("campaign appearance", () => {
  it("publishes stable classic and moonlit themes", () => {
    expect(campaignThemes.map(({ id }) => id)).toEqual(["classic", "moonlit"]);
    expect(campaignTheme(dataset())).toBe("classic");
  });

  it("prepares an optimistic settings update without dropping extension fields", () => {
    const campaign = dataset([
      {
        key: "appearance",
        revision: 3,
        value: {
          theme: "classic",
          addonDecoration: { corners: true },
        },
      },
    ]);
    expect(
      prepareCampaignAppearanceSave(campaign, {
        expectedRevision: 3,
        theme: "moonlit",
      }),
    ).toEqual({
      operation: "put",
      collection: "settings",
      key: "appearance",
      expectedRevision: 3,
      value: { theme: "moonlit", addonDecoration: { corners: true } },
    });
  });

  it("rejects stale revisions, malformed settings, and unknown themes", () => {
    const campaign = dataset([{ key: "appearance", revision: 2, value: [] }]);
    expect(() =>
      prepareCampaignAppearanceSave(campaign, {
        expectedRevision: 2,
        theme: "classic",
      }),
    ).toThrow("campaign appearance edit is invalid");
    expect(() =>
      prepareCampaignAppearanceSave(dataset(), {
        expectedRevision: 1,
        theme: "classic",
      }),
    ).toThrow("campaign appearance revision is stale");
    expect(() =>
      prepareCampaignAppearanceSave(dataset(), {
        expectedRevision: 0,
        theme: "sepia" as never,
      }),
    ).toThrow("campaign appearance edit is invalid");
  });
});

describe("browser and site themes", () => {
  afterEach(() => {
    setPersonalTheme(undefined);
    applySiteTheme("classic");
  });

  it("follows the site default until the browser picks its own theme", () => {
    expect(activeTheme()).toBe("classic");
    applyCampaignTheme(dataset([{ key: "appearance", revision: 1, value: { theme: "moonlit" } }]));
    expect(siteTheme()).toBe("moonlit");
    expect(activeTheme()).toBe("moonlit");
    setPersonalTheme("classic");
    expect(personalTheme()).toBe("classic");
    expect(activeTheme()).toBe("classic");
    // A site change does not override this browser's own choice.
    applySiteTheme("moonlit");
    applySiteTheme("classic");
    applySiteTheme("moonlit");
    expect(activeTheme()).toBe("classic");
    setPersonalTheme(undefined);
    expect(activeTheme()).toBe("moonlit");
  });

  it("ignores unknown themes and notifies only on change", () => {
    let changes = 0;
    const stop = onThemeChange(() => changes++);
    setPersonalTheme("sepia" as never);
    applySiteTheme("sepia" as never);
    expect(personalTheme()).toBeUndefined();
    expect(siteTheme()).toBe("classic");
    applySiteTheme("classic");
    expect(changes).toBe(0);
    setPersonalTheme("moonlit");
    applySiteTheme("moonlit");
    expect(changes).toBe(2);
    stop();
    setPersonalTheme(undefined);
    expect(changes).toBe(2);
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
