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

  it("normalizes structured references, tags, facts, and attitudes without changing their stored shapes", () => {
    const campaign = dataset({
      characters: [{ key: "ryn", revision: 1, value: { id: "ryn", name: "Ryn" } }],
      locations: [{ key: "gate", revision: 1, value: { id: "gate", name: "Gate" } }],
      factions: [{ key: "watch", revision: 1, value: { name: "Watch" } }],
      settings: [{
        key: "attitudes",
        revision: 1,
        value: [{ id: "ally", label: "Ally" }, { id: "wary", label: "Wary" }],
      }],
    });
    const prepared = prepareCampaignRecordSave(campaign, {
      collection: "characters",
      key: "ryn",
      expectedRevision: 1,
      creating: false,
      fields: formFields("characters", {
        name: "Ryn",
        faction: "watch",
        location: "gate",
        knowledge: "3",
        tags: ["Scout", " scout ", "Guide"],
        known: ["Found the pass", "  Knows the old road  "],
        attitudes: ["ally", "wary"],
      }),
    }, false);

    expect(prepared.mutation.operation).toBe("put");
    if (prepared.mutation.operation !== "put") return;
    expect(prepared.mutation.value).toMatchObject({
      faction: "watch",
      location: "gate",
      knowledge: 3,
      tags: ["Scout", "Guide"],
      known: ["Found the pass", "Knows the old road"],
      attitudes: [{ id: "ally" }, { id: "wary" }],
    });
  });

  it("rejects references and attitudes outside the role-projected campaign", () => {
    const campaign = dataset({
      events: [{ key: "gate", revision: 2, value: { id: "gate", name: "Gate" } }],
      characters: [{ key: "ryn", revision: 1, value: { id: "ryn", name: "Ryn" } }],
      settings: [{ key: "attitudes", revision: 1, value: [{ id: "ally", label: "Ally" }] }],
    });
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "events",
      key: "gate",
      expectedRevision: 2,
      creating: false,
      fields: formFields("events", { name: "Gate", characters: ["hidden-character"] }),
    }, false)).toThrow("record edit is invalid");
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "characters",
      key: "ryn",
      expectedRevision: 1,
      creating: false,
      fields: formFields("characters", { name: "Ryn", attitudes: ["invented"] }),
    }, false)).toThrow("record edit is invalid");
  });

  it("uses the canonical campaign field shapes instead of placeholder aliases", () => {
    expect(editorFieldsFor("historicalEvents").map(({ key }) => key)).toEqual([
      "name", "start", "end", "summary", "characters", "locations", "tags", "body",
    ]);
    expect(editorFieldsFor("artifacts").map(({ key }) => key)).toEqual([
      "name", "ownerCharacterId", "locationId", "tags", "description",
    ]);
    expect(editorFieldsFor("pets").map(({ key }) => key)).toEqual([
      "name", "icon", "species", "owner", "note",
    ]);
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
      fields: formFields("factions", { name: "Lantern Watch", badge: "Lantern" }),
    }, false);
    expect(prepared.mutation).toMatchObject({
      operation: "put",
      collection: "factions",
      key: "lantern-watch-token",
      value: { id: "lantern-watch-token", name: "Lantern Watch", badge: "Lantern" },
    });

    const campaign = dataset({ pets: [{ key: "owl", revision: 3, value: { id: "owl", name: "Owl" } }] });
    expect(prepareCampaignRecordDelete(campaign, {
      collection: "pets", key: "owl", expectedRevision: 3,
    }).mutation).toEqual({
      operation: "delete", collection: "pets", key: "owl", expectedRevision: 3,
    });
  });

  it("uses safe canonical defaults for new characters and companions", () => {
    const character = prepareCampaignRecordSave(dataset({}), {
      collection: "characters",
      key: "new-character",
      expectedRevision: 0,
      creating: true,
      fields: formFields("characters", { name: "New character" }),
    }, false);
    const pet = prepareCampaignRecordSave(dataset({}), {
      collection: "pets",
      key: "new-pet",
      expectedRevision: 0,
      creating: true,
      fields: formFields("pets", { name: "New pet" }),
    }, false);
    expect(character.mutation).toMatchObject({ value: { faction: "neutral" } });
    expect(pet.mutation).toMatchObject({ value: { icon: "🐾", ownerType: "none", ownerId: "" } });
  });
});

function formFields(
  collection: CampaignCollectionName,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(editorFieldsFor(collection).map((field) => [
    field.key,
    values[field.key] ?? (field.kind === "boolean" ? false :
      ["tags", "string-list", "references", "attitudes"].includes(field.kind) ? [] :
      field.kind === "owner" ? "none:" : ""),
  ]));
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
