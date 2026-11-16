import { describe, expect, it } from "vitest";
import { parseCampaignDataset } from "../src/core/campaign-data.js";
import type { ContextMenuItem } from "../src/ui/context-menu.js";
import {
  factionRankMenu,
  recordContextMenu,
  type RecordMenuActions,
} from "../src/app/record-context-menu.js";
import { campaignPages } from "../src/app/routes.js";
import { prepareCharacterPatch } from "../src/app/campaign-record-editor.js";
import type { CampaignCollectionName } from "../src/core/campaign-data.js";

function dataset(changes: Record<string, { key: string; revision: number; value: unknown }[]>) {
  const keyed = new Set(["factions", "settings", "campaign"]);
  return parseCampaignDataset({
    contractVersion: "campaign-data.v1",
    collections: [
      "characters",
      "relationships",
      "locations",
      "events",
      "mysteries",
      "factions",
      "pantheon",
      "artifacts",
      "settings",
      "historicalEvents",
      "campaign",
      "companions",
    ].map((name) => ({
      name,
      shape: keyed.has(name) ? "keyed" : "list",
      materialized: true,
      revision: 1,
      records: changes[name] ?? [],
    })),
  });
}

const campaign = dataset({
  characters: [{ key: "ryn", revision: 1, value: { name: "Ryn", faction: "watch" } }],
  factions: [{ key: "watch", revision: 1, value: { name: "Watch" } }],
  events: [
    { key: "raid", revision: 2, value: { name: "Raid", characters: [] } },
    { key: "feast", revision: 1, value: { name: "Feast", characters: ["ryn"] } },
  ],
});
const characters = campaignPages.find((page) => page.id === "characters")!;

function actions(overrides: Partial<RecordMenuActions> = {}) {
  const patches: unknown[] = [];
  const value: RecordMenuActions = {
    canEdit: true,
    writeBlocked: "",
    navigate: () => {},
    openInNewTab: () => {},
    copy: () => {},
    patch: (collection, record, fields, _done, extra) =>
      patches.push({ collection, key: record.key, fields, ...(extra ? { extra } : {}) }),
    ...overrides,
  };
  return { value, patches };
}
const find = (items: readonly ContextMenuItem[], label: string) =>
  items.find((item) => item.label === label);
const children = (item: ContextMenuItem | undefined) =>
  typeof item?.children === "function" ? item.children() : (item?.children ?? []);

describe("record context menus", () => {
  it("offers only reading actions to readers", () => {
    const menu = recordContextMenu(campaign, characters, "ryn", actions({ canEdit: false }).value);
    expect(menu?.title).toBe("Ryn");
    expect(menu?.items.map((item) => item.label)).toEqual([
      "Open",
      "Open in new tab",
      "Copy link",
      "Copy wiki link",
    ]);
  });

  it("adds a character to another record's list and removes it again", () => {
    const { value, patches } = actions();
    const menu = recordContextMenu(campaign, characters, "ryn", value)!;
    const events = children(find(menu.items, "Add to event"));
    expect(events.map((item) => [item.label, item.checked])).toEqual([
      ["Feast", true],
      ["Raid", false],
    ]);
    events[1]!.run!();
    events[0]!.run!();
    expect(patches).toEqual([
      { collection: "events", key: "raid", fields: { characters: ["ryn"] } },
      { collection: "events", key: "feast", fields: { characters: [] } },
    ]);
  });

  it("disables writes with a reason while another edit is open", () => {
    const menu = recordContextMenu(
      campaign,
      characters,
      "ryn",
      actions({ writeBlocked: "Finish the edit" }).value,
    )!;
    expect(find(menu.items, "Faction")?.disabled).toBe("Finish the edit");
    expect(find(menu.items, "Copy link")?.disabled).toBeUndefined();
  });

  it("returns nothing for a record outside the current view", () => {
    expect(recordContextMenu(campaign, characters, "missing", actions().value)).toBeUndefined();
  });
});

describe("rank and relationship menus", () => {
  const ranked = dataset({
    characters: [
      {
        key: "ryn",
        revision: 3,
        value: { name: "Ryn", faction: "watch", rankChain: "c", rank: "Guard" },
      },
      { key: "ada", revision: 1, value: { name: "Ada", faction: "watch" } },
      { key: "bo", revision: 1, value: { name: "Bo", faction: "neutral" } },
    ],
    factions: [
      {
        key: "watch",
        revision: 4,
        value: {
          name: "Watch",
          rankChains: [
            { id: "c", name: "Command", ranks: ["Captain", "Sergeant", "Guard"], note: "kept" },
          ],
        },
      },
    ],
    relationships: [
      { key: "r1", revision: 2, value: { source: "ryn", target: "ada", type: "ally" } },
    ],
    settings: [
      {
        key: "relationshipTypes",
        revision: 1,
        value: [
          { id: "ally", label: "Ally" },
          { id: "rival", label: "Rival" },
        ],
      },
    ],
  });

  it("sets a character's rank from its faction's chain", () => {
    const { value, patches } = actions();
    const menu = recordContextMenu(ranked, characters, "ryn", value)!;
    const rank = find(menu.items, "Rank");
    expect(rank?.detail).toBe("Guard");
    const options = children(rank);
    expect(options.map((item) => [item.label, item.checked])).toEqual([
      ["None", false],
      ["Captain", false],
      ["Sergeant", false],
      ["Guard", true],
    ]);
    options[2]!.run!();
    options[0]!.run!();
    expect(patches).toEqual([
      {
        collection: "characters",
        key: "ryn",
        fields: { rankAssignment: { chainId: "c", rank: "Sergeant" } },
      },
      {
        collection: "characters",
        key: "ryn",
        fields: { rankAssignment: { chainId: "", rank: "" } },
      },
    ]);
  });

  it("has no rank item for a faction without ranks", () => {
    const menu = recordContextMenu(ranked, characters, "bo", actions().value)!;
    expect(find(menu.items, "Rank")).toBeUndefined();
  });

  it("adds and removes a relationship while keeping the others", () => {
    const { value, patches } = actions();
    const menu = recordContextMenu(ranked, characters, "ryn", value)!;
    const types = children(find(menu.items, "Relationship"));
    expect(types.map((item) => item.label)).toEqual(["Ally", "Rival"]);
    const allies = children(types[0]);
    expect(allies.map((item) => [item.label, item.checked])).toEqual([
      ["Ada", true],
      ["Bo", false],
    ]);
    children(types[1])[0]!.run!();
    allies[0]!.run!();
    const base = [{ key: "r1", revision: 2 }];
    expect(patches).toEqual([
      {
        collection: "characters",
        key: "ryn",
        fields: {},
        extra: {
          relationships: [
            expect.objectContaining({ originalKey: "r1", target: "ada", type: "ally" }),
            {
              originalKey: null,
              expectedRevision: 0,
              direction: "from",
              target: "ada",
              type: "rival",
              label: "",
            },
          ],
          relationshipBase: base,
        },
      },
      {
        collection: "characters",
        key: "ryn",
        fields: {},
        extra: { relationships: [], relationshipBase: base },
      },
    ]);
  });

  it("assigns faction members to a rank and toggles them off", () => {
    const { value, patches } = actions();
    const menu = factionRankMenu(ranked, "watch", "c", "Guard", value)!;
    expect(menu.title).toBe("Command — Guard");
    const members = children(find(menu.items, "Members with this rank"));
    expect(members.map((item) => [item.label, item.checked])).toEqual([
      ["Ada", false],
      ["Ryn", true],
    ]);
    members[0]!.run!();
    members[1]!.run!();
    expect(patches).toEqual([
      {
        collection: "characters",
        key: "ada",
        fields: { rankAssignment: { chainId: "c", rank: "Guard" } },
      },
      {
        collection: "characters",
        key: "ryn",
        fields: { rankAssignment: { chainId: "", rank: "" } },
      },
    ]);
  });

  it("reorders a rank and keeps the chain's other fields", () => {
    const { value, patches } = actions();
    const menu = factionRankMenu(ranked, "watch", "c", "Sergeant", value)!;
    expect(find(menu.items, "Move rank up")?.disabled).toBe(false);
    find(menu.items, "Move rank up")!.run!();
    expect(patches).toEqual([
      {
        collection: "factions",
        key: "watch",
        fields: {
          rankChains: [
            { id: "c", name: "Command", ranks: ["Sergeant", "Captain", "Guard"], note: "kept" },
          ],
        },
      },
    ]);
    const bottom = factionRankMenu(ranked, "watch", "c", "Guard", value)!;
    expect(find(bottom.items, "Move rank down")?.disabled).toBe(true);
  });

  it("only sends writes the editor's patch rules accept", () => {
    const sent: {
      collection: CampaignCollectionName;
      base: unknown;
      fields: object;
      extra?: object;
    }[] = [];
    const value: RecordMenuActions = {
      ...actions().value,
      canManageVisibility: true,
      patch: (collection, base, fields, _done, extra) =>
        sent.push({ collection, base, fields, ...(extra ? { extra } : {}) }),
    };
    const menu = recordContextMenu(ranked, characters, "ryn", value)!;
    children(find(menu.items, "Rank"))[1]!.run!();
    children(children(find(menu.items, "Relationship"))[1])[0]!.run!();
    const rank = factionRankMenu(ranked, "watch", "c", "Guard", value)!;
    children(find(rank.items, "Members with this rank"))[0]!.run!();
    find(rank.items, "Move rank up")!.run!();
    expect(sent).toHaveLength(4);
    for (const write of sent)
      expect(() =>
        prepareCharacterPatch(
          ranked,
          {
            collection: write.collection,
            base: write.base as never,
            fields: write.fields as Record<string, unknown>,
            ...write.extra,
          },
          true,
        ),
      ).not.toThrow();
  });

  it("offers readers no rank menu", () => {
    expect(
      factionRankMenu(ranked, "watch", "c", "Guard", actions({ canEdit: false }).value),
    ).toBeUndefined();
  });
});
