import { describe, expect, it } from "vitest";
import { parseCampaignDataset } from "../src/core/campaign-data.js";
import type { ContextMenuItem } from "../src/ui/context-menu.js";
import { recordContextMenu, type RecordMenuActions } from "../src/app/record-context-menu.js";
import { campaignPages } from "../src/app/routes.js";

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
    patch: (collection, record, fields) => patches.push({ collection, key: record.key, fields }),
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
