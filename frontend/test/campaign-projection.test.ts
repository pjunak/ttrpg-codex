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
  it("keeps the preserved Czech party order without reordering stored characters", () => {
    const records = ["Zora", "Chára", "Hana", "Aria"].map((name, index) => ({
      key: `party-${index}`, revision: 1, value: { name, faction: "party" },
    }));
    const dataset = replace(fixture(), "characters", records, "list");
    expect(projectDashboard(dataset).party.map(({ name }) => name)).toEqual(["Aria", "Hana", "Chára", "Zora"]);
    expect(records.map(({ value }) => value.name)).toEqual(["Zora", "Chára", "Hana", "Aria"]);
  });

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
      status: "alive",
      statusLabel: "Living",
      visibility: "public",
      portrait: "/api/media/b_11111111111111111111111111111111",
      route: "#/characters/aria",
      attitudes: [{ id: "party", label: "Ember Company", color: "#f5f0e4", strength: 1 }],
    });
    expect(summaries[0]?.attitudeRing).toContain("rgba(245, 240, 228, 1)");
    expect(summaries[1]?.attitudes).toEqual([
      { id: "ally", label: "Ally", color: "#4caf50", strength: 0.6 },
    ]);
    expect(summaries[1]?.portrait).toBeUndefined();
  });

  it("keeps explicit attitude order and shared strengths while limiting inheritance to visible factions", () => {
    const characters = campaignPages.find(page => page.collection === "characters")!;
    const campaign = replace(fixture(), "characters", [
      { key: "explicit", revision: 1, value: { faction: "party", attitudes: ["ally", { id: "party", strength: 0 }, { id: "ally" }, { id: "unsafe" }, { id: "missing" }] } },
      { key: "unknown", revision: 1, value: { faction: "party", attitudes: [{ id: "missing" }] } },
      { key: "hidden-parent", revision: 1, value: { faction: "hidden" } },
      { key: "inherited", revision: 1, value: { faction: "wardens" } },
    ], "list");
    const entities = projectEntities(campaign, characters);
    expect(entities[0]?.attitudes.map(({ id, strength }) => ({ id, strength }))).toEqual([{ id: "ally", strength: .6 }, { id: "party", strength: 1 }]);
    expect(entities[1]?.attitudes).toEqual([]);
    expect(entities[2]?.attitudes).toEqual([]);
    expect(entities[3]?.attitudes.map(({ id }) => id)).toEqual(["ally"]);
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
        id: "keeper", name: "The Keeper", faction: "wardens", visibility: "dm", attitudes: [],
        portrait: "https://tracker.example/keeper.png",
      } },
    ];
    case "factions": return [{ key: "wardens", revision: 1, value: {
      id: "wardens", name: "Wardens", attitudes: [{ id: "ally" }],
    } }];
    case "settings": return [
      { key: "characterStatuses", revision: 1, value: [
        { id: "alive", label: "Living", color: "#4caf50", icon: "●" },
      ] },
      { key: "attitudes", revision: 1, value: [
        { id: "ally", label: "Ally", bg: "#2E7D32", labelColor: "#4CAF50", strength: 0.6 },
        { id: "unsafe", label: "Unsafe", bg: "red; color: transparent" },
      ] },
      { key: "playerParty", revision: 1, value: {
        name: "Ember Company", color: "#F5F0E4", textColor: "#1a1410",
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
