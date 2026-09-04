import { describe, expect, it } from "vitest";
import {
  CampaignRecordEditError,
  createCampaignRecordKey,
  editorFieldsFor,
  prepareCampaignRecordDelete,
  prepareCampaignRecordSave,
} from "../src/app/campaign-record-editor.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

describe("campaign record editing", () => {
  it("merges collection fields without dropping unknown or add-on-owned data", () => {
    const fields = formFields("characters", {
      name: "Ryn",
      title: "Pathfinder",
      description: "Returned home",
    });
    const prepared = prepareCampaignRecordSave(dataset({
      characters: [{
        key: "ryn",
        revision: 4,
        value: {
          id: "ryn",
          name: "Ryn",
          title: "Scout",
          stats: { hp: 12 },
          addonData: { unknown: { kept: true } },
        },
      }],
    }), {
      collection: "characters",
      key: "ryn",
      expectedRevision: 4,
      creating: false,
      fields,
      visibility: "public",
    }, true);

    expect(prepared.mutation).toMatchObject({
      operation: "put",
      collection: "characters",
      key: "ryn",
      expectedRevision: 4,
      value: {
        id: "ryn",
        name: "Ryn",
        title: "Pathfinder",
        description: "Returned home",
        stats: { hp: 12 },
        addonData: { unknown: { kept: true } },
        visibility: "public",
      },
    });
  });

  it("parses numeric editor fields and clears only edited numeric values", () => {
    const prepared = prepareCampaignRecordSave(dataset({
      events: [{ key: "gate", revision: 2, value: { id: "gate", name: "Gate", sitting: 5, order: 9 } }],
    }), {
      collection: "events",
      key: "gate",
      expectedRevision: 2,
      creating: false,
      fields: formFields("events", { name: "Gate", sitting: "" }),
    }, false);

    expect(prepared.mutation.operation).toBe("put");
    if (prepared.mutation.operation !== "put") return;
    expect(prepared.mutation.value).toMatchObject({ id: "gate", name: "Gate", order: 9 });
    expect(prepared.mutation.value).not.toHaveProperty("sitting");
  });

  it("rejects stale edits, malformed numbers, extra fields, and unauthorized visibility", () => {
    const campaign = dataset({
      events: [{ key: "gate", revision: 2, value: { id: "gate", name: "Gate" } }],
    });
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "events", key: "gate", expectedRevision: 1, creating: false,
      fields: formFields("events", { name: "Gate" }),
    }, false)).toThrow(CampaignRecordEditError);
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "events", key: "gate", expectedRevision: 2, creating: false,
      fields: formFields("events", { name: "Gate", sitting: "fifth" }),
    }, false)).toThrow("record edit is invalid");
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "events", key: "gate", expectedRevision: 2, creating: false,
      fields: { ...formFields("events", { name: "Gate" }), privatePath: "C:/secret" },
    }, false)).toThrow("record edit is invalid");
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "events", key: "gate", expectedRevision: 2, creating: false,
      fields: formFields("events", { name: "Gate" }), visibility: "dm",
    }, false)).toThrow("record edit is invalid");
  });

  it("prepares stable create and delete operations", () => {
    expect(createCampaignRecordKey("Stráž Žáru", "A1-B2")).toBe("straz-zaru-a1b2");
    const prepared = prepareCampaignRecordSave(dataset({}), {
      collection: "factions",
      key: "lantern-watch-token",
      expectedRevision: 0,
      creating: true,
      fields: formFields("factions", { name: "Lantern Watch", motto: "We keep the flame" }),
    }, false);
    expect(prepared.mutation).toMatchObject({
      operation: "put",
      collection: "factions",
      key: "lantern-watch-token",
      value: { id: "lantern-watch-token", name: "Lantern Watch", motto: "We keep the flame" },
    });

    const campaign = dataset({ pets: [{ key: "owl", revision: 3, value: { id: "owl", name: "Owl" } }] });
    expect(prepareCampaignRecordDelete(campaign, {
      collection: "pets", key: "owl", expectedRevision: 3,
    }).mutation).toEqual({
      operation: "delete", collection: "pets", key: "owl", expectedRevision: 3,
    });
  });
});

function formFields(
  collection: CampaignCollectionName,
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(editorFieldsFor(collection).map(({ key }) => [key, values[key] ?? ""]));
}

function dataset(
  records: Partial<Record<CampaignCollectionName, CampaignCollection["records"]>>,
): CampaignDataset {
  const shapes: Readonly<Record<CampaignCollectionName, CampaignCollection["shape"]>> = {
    characters: "list", relationships: "list", locations: "list", events: "list",
    mysteries: "list", factions: "keyed", deletedDefaults: "keyed", pantheon: "list",
    artifacts: "list", settings: "keyed", historicalEvents: "list", campaign: "keyed", pets: "list",
  };
  return {
    contractVersion: "campaign-data.v1",
    collections: (Object.entries(shapes) as [CampaignCollectionName, CampaignCollection["shape"]][])
      .map(([name, shape]) => ({
        name,
        shape,
        materialized: records[name] !== undefined,
        revision: records[name] === undefined ? 0 : 1,
        records: records[name] ?? [],
      })),
  };
}
