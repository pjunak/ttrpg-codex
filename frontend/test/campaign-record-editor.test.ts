import { attachCharacterPortrait } from "../src/app/character-portrait.js";
import { MediaClient } from "../src/core/media.js";
import { describe, expect, it } from "vitest";
import {
  CampaignRecordEditError,
  createCampaignRecordKey,
  createRelationshipRecordKey,
  editorFieldsFor,
  editorOptionsFor,
  prepareCampaignRecordDelete,
  prepareCampaignRecordSave,
  prepareCharacterPatch,
  relationshipEditorRowsFor,
  relationshipBaseFor,
} from "../src/app/campaign-record-editor.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";
import type { CampaignMutation } from "../src/core/campaign-mutations.js";

describe("in-place record patches", () => {
  it("edits one field of any collection and moves a re-parented location off its old map", () => {
    const base = {
      key: "gate",
      revision: 3,
      value: { name: "Gate", type: "Town", parentId: "", x: 0.2, y: 0.4, keep: { a: 1 } },
    };
    const campaign = dataset({
      locations: [base, { key: "vale", revision: 1, value: { name: "Vale" } }],
    });
    expect(
      prepareCharacterPatch(
        campaign,
        { collection: "locations", base, fields: { type: "City" } },
        false,
      ).mutations[0],
    ).toEqual({
      operation: "put",
      collection: "locations",
      key: "gate",
      expectedRevision: 3,
      value: { ...base.value, type: "City" },
    });
    const moved = prepareCharacterPatch(
      campaign,
      { collection: "locations", base, fields: { parentId: "vale" } },
      false,
    ).mutations[0];
    expect(moved?.operation === "put" && moved.value).toEqual({
      name: "Gate",
      type: "Town",
      parentId: "vale",
      keep: { a: 1 },
    });
    expect(() =>
      prepareCharacterPatch(
        campaign,
        { collection: "locations", base, fields: { type: "City" }, portrait: null },
        false,
      ),
    ).toThrow();
    expect(() =>
      prepareCharacterPatch(
        campaign,
        { collection: "locations", base, fields: { notes: "Secret" } },
        false,
      ),
    ).toThrow();
  });
});

describe("campaign record editing", () => {
  it("rebases independent character fields without normalizing unrelated authored data", () => {
    const base = {
      key: "ryn",
      revision: 1,
      value: {
        name: "Ryn",
        title: "Scout",
        description: "Source  ",
        unknown: [{ question: "Old shape", custom: true }],
        extra: { keep: true },
      },
    };
    const current = { ...base, revision: 2, value: { ...base.value, title: "Captain" } };
    const mutation = prepareCharacterPatch(
      dataset({ characters: [current] }),
      { base, fields: { name: "New name" } },
      false,
    ).mutations[0];
    expect(mutation).toEqual({
      operation: "put",
      collection: "characters",
      key: "ryn",
      expectedRevision: 2,
      value: { ...current.value, name: "New name" },
    });
    expect(() =>
      prepareCharacterPatch(
        dataset({ characters: [current] }),
        { base, fields: { title: "Ranger" } },
        false,
      ),
    ).toThrow(/field changed/);
    expect(() =>
      prepareCharacterPatch(
        dataset({ characters: [current] }),
        { base, fields: { extra: {} } },
        false,
      ),
    ).toThrow(CampaignRecordEditError);
    expect(() =>
      prepareCharacterPatch(
        dataset({ characters: [current] }),
        { base, fields: {}, visibility: "dm" },
        false,
      ),
    ).toThrow(CampaignRecordEditError);
  });
  it("checks dependent faction fields and supports undoing a faction and rank together", () => {
    const base = {
      key: "ryn",
      revision: 1,
      value: { name: "Ryn", faction: "watch", rankChain: "command", rank: "Captain" },
    };
    const factions = [
      {
        key: "watch",
        revision: 1,
        value: {
          name: "Watch",
          rankChains: [{ id: "command", name: "Command", ranks: ["Captain"] }],
        },
      },
    ];
    const current = {
      ...base,
      revision: 2,
      value: { ...base.value, faction: "neutral", rankChain: "", rank: "" },
    };
    expect(
      prepareCharacterPatch(
        dataset({ characters: [base], factions }),
        { base, fields: { faction: "neutral" } },
        true,
      ).mutations[0],
    ).toMatchObject({ value: current.value });
    expect(
      prepareCharacterPatch(
        dataset({ characters: [current], factions }),
        {
          base: current,
          fields: { faction: "watch", rankAssignment: { chainId: "command", rank: "Captain" } },
        },
        true,
      ).mutations[0],
    ).toMatchObject({ value: base.value });
    expect(() =>
      prepareCharacterPatch(
        dataset({ characters: [current], factions }),
        { base, fields: { rankAssignment: { chainId: "command", rank: "Captain" } } },
        true,
      ),
    ).toThrow(/field changed/);
  });
  it("preserves portraits by default, removes only on explicit save, and validates upload context before IO", async () => {
    const old = `/api/media/b_${"1".repeat(32)}`;
    const campaign = dataset({
      characters: [
        {
          key: "ryn",
          revision: 4,
          value: {
            id: "ryn",
            name: "Ryn",
            portrait: old,
            extension: { keep: true },
            visibility: "public",
          },
        },
      ],
    });
    const detail = {
      collection: "characters" as const,
      key: "ryn",
      expectedRevision: 4,
      creating: false,
      fields: formFields("characters", { name: "Renamed" }),
    };
    const prepared = prepareCampaignRecordSave(campaign, detail, true);
    const token = "x".repeat(32),
      signal = new AbortController().signal;
    const unused = new MediaClient(async () => {
      throw new Error("unexpected upload");
    });
    expect(await attachCharacterPortrait(prepared, detail, token, signal, unused)).toBe(prepared);
    const removed = await attachCharacterPortrait(
      prepareCampaignRecordSave(campaign, { ...detail, portrait: null }, true),
      { ...detail, portrait: null },
      token,
      signal,
      unused,
    );
    expect(removed.mutations[0]).toMatchObject({
      expectedRevision: 4,
      value: { name: "Renamed", extension: { keep: true } },
    });
    if (removed.mutations[0]?.operation === "put")
      expect(removed.mutations[0].value).not.toHaveProperty("portrait");
    expect(prepared.mutations[0]).toMatchObject({ value: { portrait: old } });
    const file = new File(["image"], "portrait.png", { type: "image/png" });
    expect(() =>
      prepareCampaignRecordSave(campaign, { ...detail, portrait: file, expectedRevision: 3 }, true),
    ).toThrow(CampaignRecordEditError);
    expect(() =>
      prepareCampaignRecordSave(campaign, { ...detail, portrait: file, visibility: "dm" }, true),
    ).toThrow("Save visibility");
    expect(() =>
      prepareCampaignRecordSave(
        dataset({}),
        { ...detail, key: "new", creating: true, expectedRevision: 0, portrait: file },
        true,
      ),
    ).toThrow(CampaignRecordEditError);
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        { ...detail, portrait: new File([], "empty.png", { type: "image/png" }) },
        true,
      ),
    ).toThrow(CampaignRecordEditError);
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        { ...detail, portrait: new File(["text"], "text.txt", { type: "text/plain" }) },
        true,
      ),
    ).toThrow(CampaignRecordEditError);
    const uploaded = {
      contractVersion: "media-blob.v1",
      id: `b_${"2".repeat(32)}`,
      url: `/api/media/b_${"2".repeat(32)}`,
      kind: "character-portrait",
      target: "ryn",
      mediaType: "image/png",
      bytes: 5,
      revision: 1,
      createdAt: "2026-09-09T00:00:00Z",
    };
    const media = new MediaClient(async (url, init) => {
      expect(url).toBe("/api/media/character-portrait/ryn");
      expect(init.body).toBe(file);
      expect(new Headers(init.headers).get("X-Codex-CSRF")).toBe(token);
      return new Response(JSON.stringify(uploaded), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const result = await attachCharacterPortrait(
      prepared,
      { ...detail, portrait: file },
      token,
      signal,
      media,
    );
    expect(result.mutations[0]).toMatchObject({
      expectedRevision: 4,
      value: { portrait: uploaded.url, name: "Renamed", extension: { keep: true } },
    });
    const wrongTarget = new MediaClient(
      async () =>
        new Response(JSON.stringify({ ...uploaded, target: "other" }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      attachCharacterPortrait(prepared, { ...detail, portrait: file }, token, signal, wrongTarget),
    ).rejects.toThrow("Portrait target differs");
  });
  it("edits marker definitions and size without changing coordinates, local images or extensions", () => {
    const value = {
      id: "gate",
      name: "Gate",
      pinType: "retired",
      size: 30,
      x: 0.2,
      y: -0.4,
      localMap: `/api/media/b_${"1".repeat(32)}`,
      extension: { keep: true },
    };
    const campaign = dataset({
      locations: [{ key: "gate", revision: 3, value }],
      settings: [
        { key: "pinTypes", revision: 1, value: [{ id: "town", label: "Town", size: 28 }] },
      ],
    });
    const save = (pinType: string, size: string) =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "locations",
          key: "gate",
          expectedRevision: 3,
          creating: false,
          fields: formFields("locations", { name: "Gate", pinType, size }),
        },
        true,
      ).mutations[0];
    expect(save("town", "42")).toMatchObject({ value: { ...value, pinType: "town", size: 42 } });
    expect(save("retired", "30")).toMatchObject({ value });
    expect(save("town", "")).toMatchObject({
      value: {
        pinType: "town",
        x: 0.2,
        y: -0.4,
        localMap: value.localMap,
        extension: value.extension,
      },
    });
    const inherited = save("town", "");
    if (inherited?.operation === "put") expect(inherited.value).not.toHaveProperty("size");
    expect(() => save("made-up", "30")).toThrow(CampaignRecordEditError);
    expect(() => save("town", "65")).toThrow(CampaignRecordEditError);
    expect(() => save("town", "13")).toThrow(CampaignRecordEditError);
    const field = editorFieldsFor("locations").find((field) => field.key === "pinType")!;
    expect(editorOptionsFor(dataset({}), field, "")).toEqual([
      { value: "custom", label: "Custom" },
    ]);
  });
  it("clears only the old placement when moving between world and local maps", () => {
    for (const [before, after] of [
      [null, "parent"],
      ["parent", ""],
      ["parent", "other"],
    ]) {
      const campaign = dataset({
        locations: [
          {
            key: "gate",
            revision: 3,
            value: {
              id: "gate",
              name: "Gate",
              parentId: before,
              x: 0.4,
              y: 0.8,
              localMap: "kept",
              extension: true,
            },
          },
          { key: "parent", revision: 1, value: { id: "parent", name: "Parent" } },
          { key: "other", revision: 1, value: { id: "other", name: "Other" } },
        ],
      });
      const mutation = prepareCampaignRecordSave(
        campaign,
        {
          collection: "locations",
          key: "gate",
          expectedRevision: 3,
          creating: false,
          fields: formFields("locations", { name: "Gate", parentId: after }),
        },
        true,
      ).mutations[0];
      expect(mutation).toMatchObject({
        expectedRevision: 3,
        value: { parentId: after, localMap: "kept", extension: true },
      });
      if (mutation?.operation !== "put") throw Error("expected put");
      expect(mutation.value).not.toHaveProperty("x");
      expect(mutation.value).not.toHaveProperty("y");
    }
  });
  it("merges collection fields without dropping unknown or add-on-owned data", () => {
    const fields = formFields("characters", {
      name: "Ryn",
      title: "Pathfinder",
      description: "Returned home",
    });
    const prepared = prepareCampaignRecordSave(
      dataset({
        characters: [
          {
            key: "ryn",
            revision: 4,
            value: {
              id: "ryn",
              name: "Ryn",
              title: "Scout",
              stats: { hp: 12 },
              addonData: { unknown: { kept: true } },
            },
          },
        ],
      }),
      {
        collection: "characters",
        key: "ryn",
        expectedRevision: 4,
        creating: false,
        fields,
        visibility: "public",
      },
      true,
    );

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
    const prepared = prepareCampaignRecordSave(
      dataset({
        events: [
          { key: "gate", revision: 2, value: { id: "gate", name: "Gate", sitting: 1, order: 9 } },
        ],
      }),
      {
        collection: "events",
        key: "gate",
        expectedRevision: 2,
        creating: false,
        fields: formFields("events", { name: "Gate", sitting: "" }),
      },
      false,
    );

    expect(prepared.mutations[0]?.operation).toBe("put");
    if (prepared.mutations[0]?.operation !== "put") return;
    expect(prepared.mutations[0].value).toMatchObject({ id: "gate", name: "Gate", order: 9 });
    expect(prepared.mutations[0].value).not.toHaveProperty("sitting");
  });

  it("lists record choices by name after the fixed choices", () => {
    const campaign = dataset({
      characters: [
        { key: "zora", revision: 1, value: { id: "zora", name: "Zora" } },
        { key: "anezka", revision: 1, value: { id: "anezka", name: "Anežka" } },
        { key: "bela", revision: 1, value: { id: "bela", name: "Běla" } },
      ],
      factions: [
        { key: "watch", revision: 1, value: { name: "Watch" } },
        { key: "guild", revision: 1, value: { name: "Guild" } },
      ],
    });
    const faction = editorFieldsFor("characters").find(({ key }) => key === "faction")!;
    expect(editorOptionsFor(campaign, faction, "").map(({ value }) => value)).toEqual([
      "neutral",
      "party",
      "guild",
      "watch",
    ]);
    const owner = editorFieldsFor("companions").find(({ key }) => key === "owner")!;
    expect(editorOptionsFor(campaign, owner, "").map(({ value }) => value)).toEqual([
      "none:",
      "party:",
      "character:anezka",
      "character:bela",
      "character:zora",
      "faction:guild",
      "faction:watch",
    ]);
  });

  it("lists a new event, or one moved to another session, after that session's events", () => {
    const gate = { key: "gate", revision: 2, value: { id: "gate", sitting: 2, order: 1 } };
    const campaign = dataset({
      events: [
        gate,
        { key: "feast", revision: 1, value: { id: "feast", sitting: 2, order: 2 } },
        { key: "ruin", revision: 1, value: { id: "ruin", sitting: 3, order: 7.5 } },
        { key: "oath", revision: 1, value: { id: "oath", sitting: 0, order: 4 } },
      ],
    });
    const stored = (mutation: CampaignMutation | undefined) =>
      mutation?.operation === "put" ? mutation.value : undefined;
    const create = (current: CampaignDataset, sitting: string) =>
      stored(
        prepareCampaignRecordSave(
          current,
          {
            collection: "events",
            key: "raid",
            expectedRevision: 0,
            creating: true,
            fields: formFields("events", { name: "Raid", sitting }),
          },
          false,
        ).mutations[0],
      );
    expect(create(campaign, "2")).toMatchObject({ sitting: 2, order: 3 });
    expect(create(campaign, "4")).toMatchObject({ sitting: 4, order: 1 });
    expect(create(dataset({ events: [] }), "1")).toMatchObject({ sitting: 1, order: 1 });
    const edit = (fields: Readonly<Record<string, unknown>>) =>
      stored(
        prepareCampaignRecordSave(
          campaign,
          { collection: "events", key: "gate", expectedRevision: 2, creating: false, fields },
          false,
        ).mutations[0],
      );
    expect(edit({ short: "Changed" })).toMatchObject({ sitting: 2, order: 1 });
    // A cleared session shows in the first one, after the zero-session event there.
    expect(edit({ sitting: "" })).toMatchObject({ order: 5 });
    expect(edit({ sitting: "3" })).toMatchObject({ sitting: 3, order: 8 });
    expect(
      stored(
        prepareCharacterPatch(
          campaign,
          { collection: "events", base: gate, fields: { sitting: "3" } },
          false,
        ).mutations[0],
      ),
    ).toMatchObject({ sitting: 3, order: 8 });
  });

  it("normalizes structured references, tags, facts, and attitudes without changing their stored shapes", () => {
    const campaign = dataset({
      characters: [{ key: "ryn", revision: 1, value: { id: "ryn", name: "Ryn" } }],
      locations: [{ key: "gate", revision: 1, value: { id: "gate", name: "Gate" } }],
      factions: [{ key: "watch", revision: 1, value: { name: "Watch" } }],
      settings: [
        {
          key: "attitudes",
          revision: 1,
          value: [
            { id: "ally", label: "Ally" },
            { id: "wary", label: "Wary" },
          ],
        },
      ],
    });
    const prepared = prepareCampaignRecordSave(
      campaign,
      {
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
      },
      false,
    );

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
      characters: [
        {
          key: "ryn",
          revision: 3,
          value: {
            id: "ryn",
            name: "Ryn",
            faction: "watch",
            rankChain: "guard",
            rank: "Captain",
            locationRoles: [{ locationId: "gate", role: "Warden", addonNote: "keep" }],
            unknown: [{ text: "Who opened the vault?", answer: "", unknownMark: true }],
          },
        },
      ],
      locations: [
        { key: "gate", revision: 1, value: { id: "gate", name: "Gate" } },
        { key: "harbor", revision: 1, value: { id: "harbor", name: "Harbor" } },
      ],
      factions: [
        {
          key: "watch",
          revision: 2,
          value: {
            name: "Watch",
            rankChains: [
              { id: "guard", name: "Guard", ranks: ["Captain", "Guard"], color: "gold" },
            ],
          },
        },
      ],
    });
    const character = prepareCampaignRecordSave(
      campaign,
      {
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
      },
      false,
    );
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

    const faction = prepareCampaignRecordSave(
      campaign,
      {
        collection: "factions",
        key: "watch",
        expectedRevision: 2,
        creating: false,
        fields: formFields("factions", {
          name: "Watch",
          rankChains: [{ id: "guard", name: "City Guard", ranks: ["Captain", "Guard", "Guard"] }],
        }),
      },
      false,
    );
    expect(faction.mutations[0]).toMatchObject({
      value: {
        rankChains: [
          { id: "guard", name: "City Guard", ranks: ["Captain", "Guard"], color: "gold" },
        ],
      },
    });
  });

  it("uses campaign enum definitions while preserving an unchanged stored orphan", () => {
    const campaign = dataset({
      characters: [
        {
          key: "ryn",
          revision: 2,
          value: { id: "ryn", name: "Ryn", gender: "female", status: "retired" },
        },
      ],
      settings: [
        { key: "genders", revision: 1, value: [{ id: "female", label: "Woman" }] },
        { key: "characterStatuses", revision: 1, value: [{ id: "alive", label: "Alive" }] },
        { key: "eventPriorities", revision: 1, value: [{ id: "urgent", label: "Urgent" }] },
      ],
    });
    const gender = editorFieldsFor("characters").find(({ key }) => key === "gender");
    expect(gender).toBeDefined();
    if (gender === undefined) return;
    expect(editorOptionsFor(campaign, gender, "ryn")).toEqual([
      { value: "female", label: "Woman" },
    ]);

    expect(
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "characters",
          key: "ryn",
          expectedRevision: 2,
          creating: false,
          fields: formFields("characters", { name: "Ryn", gender: "female", status: "retired" }),
        },
        false,
      ).mutations[0],
    ).toMatchObject({ value: { gender: "female", status: "retired" } });
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "characters",
          key: "ryn",
          expectedRevision: 2,
          creating: false,
          fields: formFields("characters", { name: "Ryn", gender: "female", status: "invented" }),
        },
        false,
      ),
    ).toThrow("record edit is invalid");
  });

  it("saves relationship identity changes atomically with the character", () => {
    expect(createRelationshipRecordKey("Žofie", "Město", "ally")).toBe(
      "relationship:WyLFvW9maWUiLCJNxJtzdG8iLCJhbGx5Il0",
    );
    const oldKey = createRelationshipRecordKey("ryn", "bob", "ally");
    const reverseKey = createRelationshipRecordKey("bob", "ryn", "ally");
    const campaign = dataset({
      characters: [
        { key: "ryn", revision: 4, value: { id: "ryn", name: "Ryn" } },
        { key: "bob", revision: 1, value: { id: "bob", name: "Bob" } },
      ],
      relationships: [
        {
          key: oldKey,
          revision: 7,
          value: {
            source: "ryn",
            target: "bob",
            type: "ally",
            label: "Old allies",
            auditNote: "keep",
          },
        },
      ],
      settings: [
        {
          key: "relationshipTypes",
          revision: 1,
          value: [{ id: "ally", label: "Ally", dirs: ["from", "to", "both"], target: "character" }],
        },
      ],
    });
    expect(relationshipEditorRowsFor(campaign, "ryn", true)).toEqual([
      {
        originalKey: oldKey,
        expectedRevision: 7,
        direction: "from",
        target: "bob",
        type: "ally",
        label: "Old allies",
      },
    ]);
    expect(
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "characters",
          key: "ryn",
          expectedRevision: 4,
          creating: false,
          fields: formFields("characters", { name: "Ryn" }),
          relationships: relationshipEditorRowsFor(campaign, "ryn", false),
          relationshipBase: relationshipBaseFor(campaign, "ryn"),
        },
        false,
      ).mutations,
    ).toHaveLength(1);

    const prepared = prepareCampaignRecordSave(
      campaign,
      {
        collection: "characters",
        key: "ryn",
        expectedRevision: 4,
        creating: false,
        fields: formFields("characters", { name: "Ryn" }),
        relationshipBase: relationshipBaseFor(campaign, "ryn"),
        relationships: [
          {
            originalKey: oldKey,
            expectedRevision: 7,
            direction: "both",
            target: "bob",
            type: "ally",
            label: "Trusted allies",
            visibility: "dm",
          },
        ],
      },
      true,
    );

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
      value: {
        source: "bob",
        target: "ryn",
        type: "ally",
        label: "Trusted allies",
        visibility: "dm",
      },
    });
  });

  it("rejects invalid structured references and relationship edits", () => {
    const campaign = dataset({
      characters: [
        { key: "ryn", revision: 1, value: { id: "ryn", name: "Ryn", faction: "watch" } },
        { key: "bob", revision: 1, value: { id: "bob", name: "Bob" } },
      ],
      factions: [
        {
          key: "watch",
          revision: 1,
          value: {
            name: "Watch",
            rankChains: [{ id: "guard", name: "Guard", ranks: ["Captain"] }],
          },
        },
      ],
      settings: [
        {
          key: "relationshipTypes",
          revision: 1,
          value: [{ id: "ally", label: "Ally", dirs: ["from", "to"], target: "character" }],
        },
      ],
    });
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "characters",
          key: "ryn",
          expectedRevision: 1,
          creating: false,
          fields: formFields("characters", {
            name: "Ryn",
            faction: "watch",
            rankAssignment: { chainId: "guard", rank: "Invented" },
          }),
        },
        false,
      ),
    ).toThrow("record edit is invalid");
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "characters",
          key: "ryn",
          expectedRevision: 1,
          creating: false,
          fields: formFields("characters", { name: "Ryn" }),
          relationshipBase: [],
          relationships: [
            {
              originalKey: null,
              expectedRevision: 0,
              direction: "both",
              target: "bob",
              type: "ally",
              label: "",
              visibility: "dm",
            },
          ],
        },
        false,
      ),
    ).toThrow("record edit is invalid");
  });

  it("rejects relationship replacement when its reviewed set changes", () => {
    const characters = [{ key: "ryn", revision: 1, value: { id: "ryn", name: "Ryn" } }];
    const relationship = {
      key: "link",
      revision: 1,
      value: { source: "ryn", target: "bob", type: "ally" },
    };
    const original = dataset({ characters, relationships: [relationship] });
    const edit = {
      collection: "characters" as const,
      key: "ryn",
      expectedRevision: 1,
      creating: false,
      fields: formFields("characters", { name: "Ryn" }),
      relationships: [],
      relationshipBase: relationshipBaseFor(original, "ryn"),
    };
    for (const relationships of [
      [],
      [{ ...relationship, revision: 2 }],
      [relationship, { ...relationship, key: "new-link" }],
    ]) {
      expect(() =>
        prepareCampaignRecordSave(dataset({ characters, relationships }), edit, false),
      ).toThrow("relationship revisions are stale");
    }
    const deletion = prepareCampaignRecordSave(original, edit, false);
    expect(deletion.mutations[1]).toEqual({
      operation: "delete",
      collection: "relationships",
      key: "link",
      expectedRevision: 1,
    });
    expect(() =>
      prepareCampaignRecordSave(
        original,
        {
          ...edit,
          relationshipBase: [
            { key: "link", revision: 1 },
            { key: "link", revision: 1 },
          ],
        },
        false,
      ),
    ).toThrow("record edit is invalid");
  });

  it("rejects references and attitudes outside the role-projected campaign", () => {
    const campaign = dataset({
      events: [{ key: "gate", revision: 2, value: { id: "gate", name: "Gate" } }],
      characters: [{ key: "ryn", revision: 1, value: { id: "ryn", name: "Ryn" } }],
      settings: [{ key: "attitudes", revision: 1, value: [{ id: "ally", label: "Ally" }] }],
    });
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "events",
          key: "gate",
          expectedRevision: 2,
          creating: false,
          fields: formFields("events", { name: "Gate", characters: ["hidden-character"] }),
        },
        false,
      ),
    ).toThrow("record edit is invalid");
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "characters",
          key: "ryn",
          expectedRevision: 1,
          creating: false,
          fields: formFields("characters", { name: "Ryn", attitudes: ["invented"] }),
        },
        false,
      ),
    ).toThrow("record edit is invalid");
  });

  it("uses the canonical campaign field shapes instead of placeholder aliases", () => {
    expect(editorFieldsFor("historicalEvents").map(({ key }) => key)).toEqual([
      "name",
      "start",
      "end",
      "summary",
      "characters",
      "locations",
      "tags",
      "body",
    ]);
    expect(editorFieldsFor("artifacts").map(({ key }) => key)).toEqual([
      "name",
      "ownerCharacterId",
      "locationId",
      "tags",
      "description",
    ]);
    expect(editorFieldsFor("companions").map(({ key }) => key)).toEqual([
      "name",
      "icon",
      "species",
      "owner",
      "note",
    ]);
    expect(editorFieldsFor("characters").map(({ key }) => key)).toEqual([
      "name",
      "title",
      "species",
      "gender",
      "age",
      "status",
      "circumstances",
      "knowledge",
      "faction",
      "rankAssignment",
      "location",
      "locationRoles",
      "attitudes",
      "tags",
      "description",
      "known",
      "unknown",
    ]);
    expect(editorFieldsFor("mysteries").map(({ key }) => key)).toEqual([
      "name",
      "priority",
      "solved",
      "description",
      "clues",
      "characters",
      "locations",
      "questions",
    ]);
    expect(editorFieldsFor("factions").map(({ key }) => key)).toEqual([
      "name",
      "badge",
      "color",
      "textColor",
      "attitudes",
      "rankChains",
      "description",
    ]);
    expect(editorFieldsFor("characters").find(({ key }) => key === "description")?.kind).toBe(
      "markdown",
    );
    expect(editorFieldsFor("historicalEvents").find(({ key }) => key === "body")?.kind).toBe(
      "markdown",
    );
  });

  it("rejects stale edits, malformed numbers, extra fields, and unauthorized visibility", () => {
    const campaign = dataset({
      events: [{ key: "gate", revision: 2, value: { id: "gate", name: "Gate" } }],
    });
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "events",
          key: "gate",
          expectedRevision: 1,
          creating: false,
          fields: formFields("events", { name: "Gate" }),
        },
        false,
      ),
    ).toThrow(CampaignRecordEditError);
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "events",
          key: "gate",
          expectedRevision: 2,
          creating: false,
          fields: formFields("events", { name: "Gate", sitting: "fifth" }),
        },
        false,
      ),
    ).toThrow("record edit is invalid");
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "events",
          key: "gate",
          expectedRevision: 2,
          creating: false,
          fields: { ...formFields("events", { name: "Gate" }), privatePath: "C:/secret" },
        },
        false,
      ),
    ).toThrow("record edit is invalid");
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        {
          collection: "events",
          key: "gate",
          expectedRevision: 2,
          creating: false,
          fields: formFields("events", { name: "Gate" }),
          visibility: "dm",
        },
        false,
      ),
    ).toThrow("record edit is invalid");
  });

  it("prepares stable create and delete operations", () => {
    expect(createCampaignRecordKey("Stráž Žáru", "A1-B2")).toBe("straz-zaru-a1b2");
    const prepared = prepareCampaignRecordSave(
      dataset({}),
      {
        collection: "factions",
        key: "lantern-watch-token",
        expectedRevision: 0,
        creating: true,
        fields: formFields("factions", { name: "Lantern Watch", badge: "Lantern" }),
      },
      false,
    );
    expect(prepared.mutations[0]).toMatchObject({
      operation: "put",
      collection: "factions",
      key: "lantern-watch-token",
      value: { id: "lantern-watch-token", name: "Lantern Watch", badge: "Lantern" },
    });

    const campaign = dataset({
      companions: [{ key: "owl", revision: 3, value: { id: "owl", name: "Owl" } }],
    });
    expect(
      prepareCampaignRecordDelete(campaign, {
        collection: "companions",
        key: "owl",
        expectedRevision: 3,
      }).mutations[0],
    ).toEqual({
      operation: "delete",
      collection: "companions",
      key: "owl",
      expectedRevision: 3,
    });
  });

  it("uses safe canonical defaults for new characters and companions", () => {
    const character = prepareCampaignRecordSave(
      dataset({}),
      {
        collection: "characters",
        key: "new-character",
        expectedRevision: 0,
        creating: true,
        fields: formFields("characters", { name: "New character" }),
      },
      false,
    );
    const companion = prepareCampaignRecordSave(
      dataset({}),
      {
        collection: "companions",
        key: "new-companion",
        expectedRevision: 0,
        creating: true,
        fields: formFields("companions", { name: "New companion" }),
      },
      false,
    );
    expect(character.mutations[0]).toMatchObject({ value: { faction: "neutral" } });
    expect(companion.mutations[0]).toMatchObject({
      value: { icon: "🐾", ownerType: "none", ownerId: "" },
    });
  });

  it("applies only the fields an edit sends and names a field that cannot be saved", () => {
    const stored = {
      id: "ryn",
      name: "Ryn",
      title: "t".repeat(600),
      tags: ["Order, inner circle", "spy", "Spy"],
      known: ["First line\nsecond line"],
      location: "port",
    };
    const campaign = dataset({
      characters: [{ key: "ryn", revision: 2, value: stored }],
      locations: [{ key: "port", revision: 1, value: { id: "port", name: "Port" } }],
    });
    const edit = (fields: Readonly<Record<string, unknown>>) =>
      prepareCampaignRecordSave(
        campaign,
        { collection: "characters", key: "ryn", expectedRevision: 2, creating: false, fields },
        true,
      ).mutations[0];
    expect(edit({ name: "Renamed" })).toMatchObject({ value: { ...stored, name: "Renamed" } });
    expect(() =>
      prepareCampaignRecordSave(
        campaign,
        { collection: "characters", key: "new", expectedRevision: 0, creating: true, fields: {} },
        true,
      ),
    ).toThrow(CampaignRecordEditError);
    let failure: unknown;
    try {
      edit({ name: "Renamed", location: "sunken-city" });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(CampaignRecordEditError);
    expect((failure as CampaignRecordEditError).field?.key).toBe("location");
  });
});

function formFields(
  collection: CampaignCollectionName,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    editorFieldsFor(collection).map((field) => [
      field.key,
      values[field.key] ??
        (field.kind === "boolean"
          ? false
          : [
                "tags",
                "string-list",
                "references",
                "attitudes",
                "questions",
                "rank-chains",
                "location-roles",
              ].includes(field.kind)
            ? []
            : field.kind === "rank-assignment"
              ? { chainId: "", rank: "" }
              : field.kind === "owner"
                ? "none:"
                : ""),
    ]),
  );
}

function dataset(
  records: Partial<Record<CampaignCollectionName, CampaignCollection["records"]>>,
): CampaignDataset {
  const shapes: Readonly<Record<CampaignCollectionName, CampaignCollection["shape"]>> = {
    characters: "list",
    relationships: "list",
    locations: "list",
    events: "list",
    mysteries: "list",
    factions: "keyed",
    pantheon: "list",
    artifacts: "list",
    settings: "keyed",
    historicalEvents: "list",
    campaign: "keyed",
    companions: "list",
  };
  return {
    contractVersion: "campaign-data.v1",
    collections: (
      Object.entries(shapes) as [CampaignCollectionName, CampaignCollection["shape"]][]
    ).map(([name, shape]) => ({
      name,
      shape,
      materialized: records[name] !== undefined,
      revision: records[name] === undefined ? 0 : 1,
      records: records[name] ?? [],
    })),
  };
}
