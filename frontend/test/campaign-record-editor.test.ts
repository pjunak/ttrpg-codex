import { describe, expect, it } from "vitest";
import {
  CampaignRecordEditError,
  createCampaignRecordKey,
  createRelationshipRecordKey,
  editorFieldsFor,
  editorOptionsFor,
  prepareCampaignRecordDelete,
  prepareCampaignRecordSave,
  relationshipEditorRowsFor,
  relationshipBaseFor,
} from "../src/app/campaign-record-editor.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

describe("campaign record editing", () => {
  it("edits marker definitions and size without changing coordinates, local images or extensions", () => {
    const value = { id: "gate", name: "Gate", pinType: "retired", size: 30, x: .2, y: -.4,
      localMap: `/api/media/b_${"1".repeat(32)}`, extension: { keep: true } };
    const campaign = dataset({ locations: [{ key: "gate", revision: 3, value }],
      settings: [{ key: "pinTypes", revision: 1, value: [{ id: "town", label: "Town", size: 28 }] }] });
    const save = (pinType: string, size: string) => prepareCampaignRecordSave(campaign, {
      collection: "locations", key: "gate", expectedRevision: 3, creating: false,
      fields: formFields("locations", { name: "Gate", pinType, size }),
    }, true).mutations[0];
    expect(save("town", "42")).toMatchObject({ value: { ...value, pinType: "town", size: 42 } });
    expect(save("retired", "30")).toMatchObject({ value });
    expect(save("town", "")).toMatchObject({ value: { pinType: "town", x: .2, y: -.4, localMap: value.localMap, extension: value.extension } });
    const inherited = save("town", "");
    if (inherited?.operation === "put") expect(inherited.value).not.toHaveProperty("size");
    expect(() => save("made-up", "30")).toThrow(CampaignRecordEditError);
    expect(() => save("town", "65")).toThrow(CampaignRecordEditError);
    expect(() => save("town", "13")).toThrow(CampaignRecordEditError);
    const field = editorFieldsFor("locations").find(field => field.key === "pinType")!;
    expect(editorOptionsFor(dataset({}), field, "")).toEqual([{ value: "custom", label: "Custom" }]);
  });
  it("clears only the old placement when moving between world and local maps", () => {
    for (const [before, after] of [[null, "parent"], ["parent", ""], ["parent", "other"]]) {
      const campaign = dataset({ locations: [
        { key: "gate", revision: 3, value: { id: "gate", name: "Gate", parentId: before, x: .4, y: .8, localMap: "kept", extension: true } },
        { key: "parent", revision: 1, value: { id: "parent", name: "Parent" } },
        { key: "other", revision: 1, value: { id: "other", name: "Other" } },
      ] });
      const mutation = prepareCampaignRecordSave(campaign, { collection: "locations", key: "gate", expectedRevision: 3,
        creating: false, fields: formFields("locations", { name: "Gate", parentId: after }) }, true).mutations[0];
      expect(mutation).toMatchObject({ expectedRevision: 3, value: { parentId: after, localMap: "kept", extension: true } });
      if (mutation?.operation !== "put") throw Error("expected put");
      expect(mutation.value).not.toHaveProperty("x"); expect(mutation.value).not.toHaveProperty("y");
    }
  });
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

    expect(prepared.mutations[0]).toMatchObject({
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

    expect(prepared.mutations[0]?.operation).toBe("put");
    if (prepared.mutations[0]?.operation !== "put") return;
    expect(prepared.mutations[0].value).toMatchObject({ id: "gate", name: "Gate", order: 9 });
    expect(prepared.mutations[0].value).not.toHaveProperty("sitting");
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

    expect(prepared.mutations[0]?.operation).toBe("put");
    if (prepared.mutations[0]?.operation !== "put") return;
    expect(prepared.mutations[0].value).toMatchObject({
      faction: "watch",
      location: "gate",
      knowledge: 3,
      tags: ["Scout", "Guide"],
      known: ["Found the pass", "Knows the old road"],
      attitudes: [{ id: "ally" }, { id: "wary" }],
    });
  });

  it("round-trips questions, location roles, faction ranks, and nested extension data", () => {
    const campaign = dataset({
      characters: [{
        key: "ryn",
        revision: 3,
        value: {
          id: "ryn",
          name: "Ryn",
          faction: "watch",
          rankChain: "guard",
          rank: "Captain",
          locationRoles: [{ locationId: "gate", role: "Warden", addonNote: "keep" }],
          unknown: [{ text: "Who opened the vault?", answer: "", legacyMark: true }],
        },
      }],
      locations: [
        { key: "gate", revision: 1, value: { id: "gate", name: "Gate" } },
        { key: "harbor", revision: 1, value: { id: "harbor", name: "Harbor" } },
      ],
      factions: [{
        key: "watch",
        revision: 2,
        value: {
          name: "Watch",
          rankChains: [{ id: "guard", name: "Guard", ranks: ["Captain", "Guard"], color: "gold" }],
        },
      }],
    });
    const character = prepareCampaignRecordSave(campaign, {
      collection: "characters",
      key: "ryn",
      expectedRevision: 3,
      creating: false,
      fields: formFields("characters", {
        name: "Ryn",
        faction: "watch",
        rankAssignment: { chainId: "guard", rank: "Guard" },
        locationRoles: [
          { locationId: "gate", role: "Former warden" },
          { locationId: "harbor", role: "Envoy" },
        ],
        unknown: [
          { text: " Who opened the vault? ", answer: " The archivist " },
          { text: "Where is the key?", answer: "" },
        ],
      }),
    }, false);
    expect(character.mutations[0]).toMatchObject({
      value: {
        rankChain: "guard",
        rank: "Guard",
        locationRoles: [
          { locationId: "gate", role: "Former warden", addonNote: "keep" },
          { locationId: "harbor", role: "Envoy" },
        ],
        unknown: [
          { text: "Who opened the vault?", answer: "The archivist" },
          { text: "Where is the key?", answer: "" },
        ],
      },
    });

    const faction = prepareCampaignRecordSave(campaign, {
      collection: "factions",
      key: "watch",
      expectedRevision: 2,
      creating: false,
      fields: formFields("factions", {
        name: "Watch",
        rankChains: [{ id: "guard", name: "City Guard", ranks: ["Captain", "Guard", "Guard"] }],
      }),
    }, false);
    expect(faction.mutations[0]).toMatchObject({
      value: {
        rankChains: [{ id: "guard", name: "City Guard", ranks: ["Captain", "Guard"], color: "gold" }],
      },
    });
  });

  it("uses campaign enum definitions while preserving an unchanged stored orphan", () => {
    const campaign = dataset({
      characters: [{
        key: "ryn", revision: 2,
        value: { id: "ryn", name: "Ryn", gender: "female", status: "retired" },
      }],
      settings: [
        { key: "genders", revision: 1, value: [{ id: "female", label: "Woman" }] },
        { key: "characterStatuses", revision: 1, value: [{ id: "alive", label: "Alive" }] },
        { key: "eventPriorities", revision: 1, value: [{ id: "urgent", label: "Urgent" }] },
      ],
    });
    const gender = editorFieldsFor("characters").find(({ key }) => key === "gender");
    expect(gender).toBeDefined();
    if (gender === undefined) return;
    expect(editorOptionsFor(campaign, gender, "ryn")).toEqual([{ value: "female", label: "Woman" }]);

    expect(prepareCampaignRecordSave(campaign, {
      collection: "characters", key: "ryn", expectedRevision: 2, creating: false,
      fields: formFields("characters", { name: "Ryn", gender: "female", status: "retired" }),
    }, false).mutations[0]).toMatchObject({ value: { gender: "female", status: "retired" } });
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "characters", key: "ryn", expectedRevision: 2, creating: false,
      fields: formFields("characters", { name: "Ryn", gender: "female", status: "invented" }),
    }, false)).toThrow("record edit is invalid");
  });

  it("saves relationship identity changes atomically with the character", () => {
    expect(createRelationshipRecordKey("Žofie", "Město", "ally"))
      .toBe("relationship:WyLFvW9maWUiLCJNxJtzdG8iLCJhbGx5Il0");
    const oldKey = createRelationshipRecordKey("ryn", "bob", "ally");
    const reverseKey = createRelationshipRecordKey("bob", "ryn", "ally");
    const campaign = dataset({
      characters: [
        { key: "ryn", revision: 4, value: { id: "ryn", name: "Ryn" } },
        { key: "bob", revision: 1, value: { id: "bob", name: "Bob" } },
      ],
      relationships: [{
        key: oldKey,
        revision: 7,
        value: { source: "ryn", target: "bob", type: "ally", label: "Old allies", auditNote: "keep" },
      }],
      settings: [{
        key: "relationshipTypes",
        revision: 1,
        value: [{ id: "ally", label: "Ally", dirs: ["from", "to", "both"], target: "character" }],
      }],
    });
    expect(relationshipEditorRowsFor(campaign, "ryn", true)).toEqual([{
      originalKey: oldKey,
      expectedRevision: 7,
      direction: "from",
      target: "bob",
      type: "ally",
      label: "Old allies",
    }]);
    expect(prepareCampaignRecordSave(campaign, {
      collection: "characters",
      key: "ryn",
      expectedRevision: 4,
      creating: false,
      fields: formFields("characters", { name: "Ryn" }),
      relationships: relationshipEditorRowsFor(campaign, "ryn", false),
      relationshipBase: relationshipBaseFor(campaign, "ryn"),
    }, false).mutations).toHaveLength(1);

    const prepared = prepareCampaignRecordSave(campaign, {
      collection: "characters",
      key: "ryn",
      expectedRevision: 4,
      creating: false,
      fields: formFields("characters", { name: "Ryn" }),
      relationshipBase: relationshipBaseFor(campaign, "ryn"),
      relationships: [{
        originalKey: oldKey,
        expectedRevision: 7,
        direction: "both",
        target: "bob",
        type: "ally",
        label: "Trusted allies",
        visibility: "dm",
      }],
    }, true);

    expect(prepared.mutations).toHaveLength(3);
    expect(prepared.mutations[1]).toMatchObject({
      operation: "put",
      collection: "relationships",
      key: oldKey,
      expectedRevision: 7,
      value: { label: "Trusted allies", visibility: "dm", auditNote: "keep" },
    });
    expect(prepared.mutations[2]).toMatchObject({
      operation: "put",
      collection: "relationships",
      key: reverseKey,
      expectedRevision: 0,
      value: { source: "bob", target: "ryn", type: "ally", label: "Trusted allies", visibility: "dm" },
    });
  });

  it("rejects invalid structured references and relationship edits", () => {
    const campaign = dataset({
      characters: [
        { key: "ryn", revision: 1, value: { id: "ryn", name: "Ryn", faction: "watch" } },
        { key: "bob", revision: 1, value: { id: "bob", name: "Bob" } },
      ],
      factions: [{
        key: "watch", revision: 1,
        value: { name: "Watch", rankChains: [{ id: "guard", name: "Guard", ranks: ["Captain"] }] },
      }],
      settings: [{
        key: "relationshipTypes", revision: 1,
        value: [{ id: "ally", label: "Ally", dirs: ["from", "to"], target: "character" }],
      }],
    });
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "characters", key: "ryn", expectedRevision: 1, creating: false,
      fields: formFields("characters", {
        name: "Ryn", faction: "watch", rankAssignment: { chainId: "guard", rank: "Invented" },
      }),
    }, false)).toThrow("record edit is invalid");
    expect(() => prepareCampaignRecordSave(campaign, {
      collection: "characters", key: "ryn", expectedRevision: 1, creating: false,
      fields: formFields("characters", { name: "Ryn" }),
      relationshipBase: [],
      relationships: [{
        originalKey: null, expectedRevision: 0, direction: "both", target: "bob",
        type: "ally", label: "", visibility: "dm",
      }],
    }, false)).toThrow("record edit is invalid");
  });

  it("rejects relationship replacement when its reviewed set changes", () => {
    const characters = [{ key: "ryn", revision: 1, value: { id: "ryn", name: "Ryn" } }];
    const relationship = { key: "link", revision: 1, value: { source: "ryn", target: "bob", type: "ally" } };
    const original = dataset({ characters, relationships: [relationship] });
    const edit = {
      collection: "characters" as const, key: "ryn", expectedRevision: 1, creating: false,
      fields: formFields("characters", { name: "Ryn" }),
      relationships: [], relationshipBase: relationshipBaseFor(original, "ryn"),
    };
    for (const relationships of [
      [],
      [{ ...relationship, revision: 2 }],
      [relationship, { ...relationship, key: "new-link" }],
    ]) {
      expect(() => prepareCampaignRecordSave(dataset({ characters, relationships }), edit, false))
        .toThrow("relationship revisions are stale");
    }
    const deletion = prepareCampaignRecordSave(original, edit, false);
    expect(deletion.mutations[1]).toEqual({
      operation: "delete", collection: "relationships", key: "link", expectedRevision: 1,
    });
    expect(() => prepareCampaignRecordSave(original, { ...edit, relationshipBase: [
      { key: "link", revision: 1 }, { key: "link", revision: 1 },
    ] }, false)).toThrow("record edit is invalid");
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
    expect(editorFieldsFor("characters").map(({ key }) => key)).toEqual([
      "name", "title", "species", "gender", "age", "status", "circumstances", "knowledge",
      "faction", "rankAssignment", "location", "locationRoles", "attitudes", "tags", "description",
      "known", "unknown",
    ]);
    expect(editorFieldsFor("mysteries").map(({ key }) => key)).toEqual([
      "name", "priority", "solved", "description", "clues", "characters", "locations", "questions",
    ]);
    expect(editorFieldsFor("factions").map(({ key }) => key)).toEqual([
      "name", "badge", "color", "textColor", "attitudes", "rankChains", "description",
    ]);
    expect(editorFieldsFor("characters").find(({ key }) => key === "description")?.kind).toBe("markdown");
    expect(editorFieldsFor("historicalEvents").find(({ key }) => key === "body")?.kind).toBe("markdown");
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
    expect(prepared.mutations[0]).toMatchObject({
      operation: "put",
      collection: "factions",
      key: "lantern-watch-token",
      value: { id: "lantern-watch-token", name: "Lantern Watch", badge: "Lantern" },
    });

    const campaign = dataset({ pets: [{ key: "owl", revision: 3, value: { id: "owl", name: "Owl" } }] });
    expect(prepareCampaignRecordDelete(campaign, {
      collection: "pets", key: "owl", expectedRevision: 3,
    }).mutations[0]).toEqual({
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
    expect(character.mutations[0]).toMatchObject({ value: { faction: "neutral" } });
    expect(pet.mutations[0]).toMatchObject({ value: { icon: "🐾", ownerType: "none", ownerId: "" } });
  });
});

function formFields(
  collection: CampaignCollectionName,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(editorFieldsFor(collection).map((field) => [
    field.key,
    values[field.key] ?? (field.kind === "boolean" ? false :
      ["tags", "string-list", "references", "attitudes", "questions", "rank-chains", "location-roles"].includes(field.kind) ? [] :
      field.kind === "rank-assignment" ? { chainId: "", rank: "" } :
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
