import { describe, expect, it } from "vitest";
import {
  CampaignRecordEditError,
  prepareCampaignRecordDelete,
  prepareCampaignRecordSave,
} from "../src/app/campaign-record-editor.js";
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

describe("campaign record editing", () => {
  it("merges common edited fields without dropping richer record data", () => {
    const prepared = prepareCampaignRecordSave(fixture({
      characters: [{
        key: "ryn", revision: 4,
        value: { id: "ryn", name: "Ryn", title: "Scout", stats: { hp: 12 }, addonData: { sheet: {} } },
      }],
    }), {
      collection: "characters",
      key: "ryn",
      expectedRevision: 4,
      creating: false,
      fields: { name: "Ryn", title: "Pathfinder", description: "Returned home" },
      visibility: "public",
    }, true);

    expect(prepared.mutation).toEqual({
      operation: "put",
      collection: "characters",
      key: "ryn",
      expectedRevision: 4,
      value: {
        id: "ryn",
        name: "Ryn",
        title: "Pathfinder",
        description: "Returned home",
        visibility: "public",
        stats: { hp: 12 },
        addonData: { sheet: {} },
      },
    });
  });

  it("prepares new keyed records with a stable inner identity", () => {
    const prepared = prepareCampaignRecordSave(fixture({}), {
      collection: "factions",
      key: "lantern-watch-token",
      expectedRevision: 0,
      creating: true,
      fields: { name: "Lantern Watch", motto: "", description: "City guards" },
    }, false);

    expect(prepared.mutation).toMatchObject({
      operation: "put",
      collection: "factions",
      key: "lantern-watch-token",
      value: { id: "lantern-watch-token", name: "Lantern Watch" },
    });
  });

  it("rejects stale edits, extra fields, and unauthorized visibility changes", () => {
    const dataset = fixture({
      locations: [{ key: "town", revision: 2, value: { id: "town", name: "Town" } }],
    });
    expect(() => prepareCampaignRecordSave(dataset, {
      collection: "locations", key: "town", expectedRevision: 1, creating: false,
      fields: { name: "Town", type: "City", description: "" },
    }, false)).toThrow(CampaignRecordEditError);
    expect(() => prepareCampaignRecordSave(dataset, {
      collection: "locations", key: "town", expectedRevision: 2, creating: false,
      fields: { name: "Town", type: "City", description: "", privatePath: "C:/secret" },
    }, false)).toThrow("record edit is invalid");
    expect(() => prepareCampaignRecordSave(dataset, {
      collection: "locations", key: "town", expectedRevision: 2, creating: false,
      fields: { name: "Town", type: "City", description: "" }, visibility: "dm",
    }, false)).toThrow("record edit is invalid");
  });

  it("requires the exact live revision before preparing deletion", () => {
    const dataset = fixture({
      pets: [{ key: "owl", revision: 3, value: { id: "owl", name: "Owl" } }],
    });
    expect(prepareCampaignRecordDelete(dataset, {
      collection: "pets", key: "owl", expectedRevision: 3,
    }).mutation).toEqual({
      operation: "delete", collection: "pets", key: "owl", expectedRevision: 3,
    });
    expect(() => prepareCampaignRecordDelete(dataset, {
      collection: "pets", key: "owl", expectedRevision: 2,
    })).toThrow(CampaignRecordEditError);
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
