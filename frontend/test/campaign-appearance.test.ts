import { describe, expect, it } from "vitest";
import {
  campaignTheme,
  campaignThemes,
  prepareCampaignAppearanceSave,
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
    const campaign = dataset([{ key: "appearance", revision: 3, value: {
      theme: "classic", addonDecoration: { corners: true },
    } }]);
    expect(prepareCampaignAppearanceSave(campaign, {
      expectedRevision: 3, theme: "moonlit",
    })).toEqual({
      operation: "put",
      collection: "settings",
      key: "appearance",
      expectedRevision: 3,
      value: { theme: "moonlit", addonDecoration: { corners: true } },
    });
  });

  it("rejects stale revisions, malformed settings, and unknown themes", () => {
    const campaign = dataset([{ key: "appearance", revision: 2, value: [] }]);
    expect(() => prepareCampaignAppearanceSave(campaign, {
      expectedRevision: 2, theme: "classic",
    })).toThrow("campaign appearance edit is invalid");
    expect(() => prepareCampaignAppearanceSave(dataset(), {
      expectedRevision: 1, theme: "classic",
    })).toThrow("campaign appearance revision is stale");
    expect(() => prepareCampaignAppearanceSave(dataset(), {
      expectedRevision: 0, theme: "sepia" as never,
    })).toThrow("campaign appearance edit is invalid");
  });
});

const names: readonly CampaignCollectionName[] = [
  "characters", "relationships", "locations", "events", "mysteries", "factions", "deletedDefaults",
  "pantheon", "artifacts", "settings", "historicalEvents", "campaign", "pets",
];

function dataset(settings: CampaignCollection["records"] = []): CampaignDataset {
  return {
    contractVersion: "campaign-data.v1",
    collections: names.map((name) => ({
      name,
      shape: name === "factions" || name === "deletedDefaults" || name === "settings" || name === "campaign"
        ? "keyed" as const
        : "list" as const,
      materialized: true,
      revision: 1,
      records: name === "settings" ? settings : [],
    })),
  };
}
