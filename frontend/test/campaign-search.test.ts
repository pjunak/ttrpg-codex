import { describe, expect, it } from "vitest";
import { searchCampaign } from "../src/app/campaign-search.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
  CampaignRecord,
} from "../src/core/campaign-data.js";

describe("campaign search", () => {
  it("groups matches by campaign type and ranks strong name matches first", () => {
    const campaign = dataset({
      characters: [record("zar", { name: "Žár", title: "Ash warden", tags: ["ember"], description: "Keeps the northern gate." })],
      locations: [
        record("ash-gate", { name: "Ash Gate", region: "North", description: "Watched by the ember warden." }),
        record("far-gate", { name: "Far Gate", description: "An abandoned western arch." }),
      ],
    });

    const groups = searchCampaign(campaign, "ash gate");

    expect(groups.map(({ page }) => page.id)).toEqual(["characters", "locations"]);
    expect(groups[0]?.results.map(({ key }) => key)).toEqual(["zar"]);
    expect(groups[1]?.results.map(({ key }) => key)).toEqual(["ash-gate"]);
    expect(groups[1]?.results[0]?.score).toBeGreaterThan(groups[0]?.results[0]?.score ?? 0);
  });

  it("searches without diacritics, rejects partial token sets, and bounds results", () => {
    const campaign = dataset({
      characters: [record("zar", { name: "Žár", description: "Strážce severu" })],
      locations: [record("north", { name: "Northern Archive" })],
    });

    expect(searchCampaign(campaign, "zar")[0]?.results[0]?.key).toBe("zar");
    expect(searchCampaign(campaign, "zar missing")).toEqual([]);
    expect(searchCampaign(campaign, "north", 1).flatMap(({ results }) => results)).toHaveLength(1);
    expect(searchCampaign(campaign, "   ")).toEqual([]);
  });
});

function record(key: string, value: Readonly<Record<string, unknown>>): CampaignRecord {
  return { key, revision: 1, value: { id: key, visibility: "public", ...value } };
}

function dataset(
  records: Partial<Readonly<Record<CampaignCollectionName, readonly CampaignRecord[]>>>,
): CampaignDataset {
  const shapes: Readonly<Record<CampaignCollectionName, CampaignCollection["shape"]>> = {
    characters: "list",
    relationships: "list",
    locations: "list",
    events: "list",
    mysteries: "list",
    factions: "keyed",
    deletedDefaults: "keyed",
    pantheon: "list",
    artifacts: "list",
    settings: "keyed",
    historicalEvents: "list",
    campaign: "keyed",
    pets: "list",
  };
  return {
    contractVersion: "campaign-data.v1",
    collections: (Object.entries(shapes) as [CampaignCollectionName, CampaignCollection["shape"]][])
      .map(([name, shape]) => ({
        name,
        shape,
        materialized: true,
        revision: 1,
        records: records[name] ?? [],
      })),
  };
}
