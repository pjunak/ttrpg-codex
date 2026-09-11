import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCampaign } from "../src/app/campaign-search.js";
import { recentSearchResults, rememberRecentRecord } from "../src/app/recent-records.js";
import { parseAppRoute } from "../src/app/routes.js";
import { projectDashboard } from "../src/app/campaign-projection.js";
import { describeActivity } from "../src/app/campaign-activity.js";
import { recordActivity } from "../src/core/campaign-activity.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
  CampaignRecord,
} from "../src/core/campaign-data.js";

describe("campaign search", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses projected activity time and resolves readable current field labels", () => {
    const campaign = dataset({ characters: [record("alice", { name: "Alice", location: "town", updatedAt: 9000,
      lastChange: { contractVersion: "activity.v1", change: { kind: "updated", fields: ["location", "description", "relationships"], at: 2000 } } })],
      locations: [record("town", { name: "Visible town" })] });
    const entity = projectDashboard(campaign).recent[0]!;
    expect(entity.updatedAt).toBe(new Date(2000).toISOString());
    expect(describeActivity(campaign, entity)).toContain("Visible town");
    expect(describeActivity(campaign, entity)).toContain("more changes");
  });
  it("does not invent activity for private-only changes or malformed metadata", () => {
    const campaign = dataset({ characters: [record("alice", { name: "Alice", updatedAt: 9000,
      lastChange: { contractVersion: "activity.v1", change: null } })] });
    expect(projectDashboard(campaign).recent).toEqual([]);
    expect(recordActivity({ lastChange: { contractVersion: "activity.v1", change: { kind: "updated", at: -1, fields: [] } } })).toBeUndefined();
  });
  it("resolves recent identities from current visibility and keeps role histories separate", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    const campaign = dataset({ characters: [record("secret", { name: "Private name" }), record("public", { name: "Visible name" })] });
    rememberRecentRecord(campaign, parseAppRoute("#/characters/secret"), "dm");
    rememberRecentRecord(campaign, parseAppRoute("#/characters/public"), "player");
    expect([...values.values()].join()).not.toContain("Private name");
    expect(recentSearchResults(campaign, "dm").map(entity => entity.key)).toEqual(["secret"]);
    expect(recentSearchResults(campaign, "player").map(entity => entity.key)).toEqual(["public"]);
    const visible = dataset({ characters: [record("public", { name: "Renamed", updatedAt: 2_000 })] });
    expect(recentSearchResults(visible, "dm").map(entity => entity.name)).toEqual(["Renamed"]);
  });
  it("falls back to bounded recent activity when session storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
    const campaign = dataset({ characters: Array.from({ length: 20 }, (_, index) => record(String(index), { name: `Entry ${index}`, updatedAt: 1_000 + index })) });
    rememberRecentRecord(campaign, parseAppRoute("#/characters/1"), "dm");
    expect(recentSearchResults(campaign, "dm")).toHaveLength(12);
    expect(recentSearchResults(campaign, "dm")[0]?.key).toBe("19");
  });
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
