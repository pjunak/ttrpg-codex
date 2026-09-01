import { describe, expect, it } from "vitest";
import { projectCampaignOverview } from "../src/app/campaign-overview.js";
import type {
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

const shapes = {
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
} as const;

describe("projectCampaignOverview", () => {
  it("projects campaign identity, counts, disclosure, and DM markers", () => {
    const dataset = fixture({
      campaign: [{ key: "main", revision: 1, value: { name: "Aethelara", tagline: "A world in motion" } }],
      characters: [
        { key: "hero", revision: 1, value: { name: "Ryn", title: "Pathfinder", knowledge: 4, faction: "party", status: "alive" } },
        { key: "stranger", revision: 1, value: { name: "Secret name", title: "Spy", knowledge: 0, visibility: "dm", status: "dead" } },
      ],
      locations: [{ key: "city", revision: 1, value: { id: "city" } }],
      events: [{ key: "arrival", revision: 1, value: { id: "arrival" } }],
    });

    expect(projectCampaignOverview(dataset)).toEqual({
      name: "Aethelara",
      tagline: "A world in motion",
      identityRevision: 1,
      characters: [
        { id: "hero", name: "Ryn", title: "Pathfinder", status: "alive", partyMember: true, dmOnly: false },
        { id: "stranger", name: "Unknown figure", title: "Details unknown", status: "dead", partyMember: false, dmOnly: true },
      ],
      locations: 1,
      events: 1,
      mysteries: 0,
    });
  });

  it("uses stable display fallbacks for incomplete legacy records", () => {
    const overview = projectCampaignOverview(fixture({
      campaign: [{ key: "main", revision: 1, value: null }],
      characters: [{ key: "unknown", revision: 1, value: { status: "other" } }],
    }));

    expect(overview.name).toBe("Untitled Campaign");
    expect(overview.characters[0]).toMatchObject({
      id: "unknown",
      name: "Unnamed character",
      title: "",
      status: "unknown",
    });
  });
});

function fixture(
  records: Partial<Record<CampaignCollectionName, CampaignDataset["collections"][number]["records"]>>,
): CampaignDataset {
  return {
    contractVersion: "campaign-data.v1",
    collections: (Object.entries(shapes) as Array<[CampaignCollectionName, "list" | "keyed"]>)
      .map(([name, shape]) => ({
        name,
        shape,
        materialized: records[name] !== undefined,
        revision: records[name] === undefined ? 0 : 1,
        records: records[name] ?? [],
      })),
  };
}
