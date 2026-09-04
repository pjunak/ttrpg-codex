import { describe, expect, it } from "vitest";
import {
  projectCampaignIdentity,
  projectDashboard,
  projectEntities,
  safeMediaURL,
} from "../src/app/campaign-projection.js";
import { campaignPages } from "../src/app/routes.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

describe("campaign product projection", () => {
  it("builds the campaign title, party, companions, last session, and recent activity", () => {
    const dataset = fixture();
    const model = projectDashboard(dataset);

    expect(model.identity).toEqual({ name: "The Ember Road", tagline: "A chronicle of ash and oaths" });
    expect(model.party.map(({ name }) => name)).toEqual(["Aria"]);
    expect(model.companions.map(({ name }) => name)).toEqual(["Moth"]);
    expect(model.lastSession).toBe(7);
    expect(model.lastSessionEvents.map(({ name }) => name)).toEqual(["Broken Gate", "Quiet Camp"]);
    expect(model.lastSessionEvents[0]).toMatchObject({ characters: 1, locations: 1 });
    expect(model.recent.map(({ name }) => name)).toEqual(["Quiet Camp", "Aria", "Broken Gate"]);
    expect(model.counts["characters"]).toBe(2);
    expect(Object.isFrozen(model)).toBe(true);
  });

  it("uses intentional fallbacks and allows only opaque host media URLs", () => {
    expect(projectCampaignIdentity(emptyDataset())).toEqual({ name: "TTRPG Codex", tagline: "" });
    expect(safeMediaURL("/api/media/b_11111111111111111111111111111111")).toContain("/api/media/");
    expect(safeMediaURL("https://tracker.example/portrait.png")).toBeUndefined();
    expect(safeMediaURL("javascript:alert(1)")).toBeUndefined();

    const characters = campaignPages.find((page) => page.collection === "characters");
    expect(characters).toBeDefined();
    if (characters === undefined) return;
    const summaries = projectEntities(fixture(), characters);
    expect(summaries[0]).toMatchObject({
      name: "Aria",
      title: "Warden",
      visibility: "public",
      portrait: "/api/media/b_11111111111111111111111111111111",
      route: "#/characters/aria",
    });
    expect(summaries[1]?.portrait).toBeUndefined();
  });
});

function fixture(): CampaignDataset {
  const dataset = emptyDataset();
  return replace(dataset, "campaign", [{ key: "main", revision: 1, value: {
    name: "The Ember Road", tagline: "A chronicle of ash and oaths",
  } }], "keyed");
}

function emptyDataset(): CampaignDataset {
  const definitions: Readonly<Record<CampaignCollectionName, CampaignCollection["shape"]>> = {
    characters: "list", relationships: "list", locations: "list", events: "list",
    mysteries: "list", factions: "keyed", deletedDefaults: "keyed", pantheon: "list",
    artifacts: "list", settings: "keyed", historicalEvents: "list", campaign: "keyed", pets: "list",
  };
  const collections = Object.entries(definitions).map(([name, shape]) => ({
    name: name as CampaignCollectionName,
    shape,
    materialized: true,
    revision: 1,
    records: records(name as CampaignCollectionName),
  }));
  return { contractVersion: "campaign-data.v1", collections };
}

function records(name: CampaignCollectionName): CampaignCollection["records"] {
  switch (name) {
    case "characters": return [
      { key: "aria", revision: 2, value: {
        id: "aria", name: "Aria", title: "Warden", faction: "party", status: "alive",
        portrait: "/api/media/b_11111111111111111111111111111111",
        visibility: "public", updatedAt: "2026-09-03T10:00:00Z",
      } },
      { key: "keeper", revision: 1, value: {
        id: "keeper", name: "The Keeper", faction: "neutral", visibility: "dm",
        portrait: "https://tracker.example/keeper.png",
      } },
    ];
    case "pets": return [{ key: "moth", revision: 1, value: {
      id: "moth", name: "Moth", ownerType: "character", ownerId: "aria",
    } }];
    case "events": return [
      { key: "gate", revision: 1, value: {
        id: "gate", name: "Broken Gate", sitting: 7, order: 2,
        characters: ["aria"], locations: ["keep"], updatedAt: "2026-09-02T10:00:00Z",
      } },
      { key: "camp", revision: 1, value: {
        id: "camp", name: "Quiet Camp", sitting: 7, order: 3,
        updatedAt: "2026-09-04T10:00:00Z",
      } },
    ];
    default: return [];
  }
}

function replace(
  dataset: CampaignDataset,
  name: CampaignCollectionName,
  records: CampaignCollection["records"],
  shape: CampaignCollection["shape"],
): CampaignDataset {
  return {
    ...dataset,
    collections: dataset.collections.map((collection) => collection.name === name
      ? { ...collection, shape, records }
      : collection),
  };
}
