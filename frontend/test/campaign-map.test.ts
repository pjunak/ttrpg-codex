import { describe, expect, it } from "vitest";
import { mapLocations, mapViews, prepareMapSave, prepareLocalMapImage } from "../src/app/campaign-map.js";
import type { CampaignDataset, CampaignCollectionName, CampaignRecord } from "../src/core/campaign-data.js";

const names: CampaignCollectionName[] = ["characters", "relationships", "locations", "events", "mysteries", "factions", "deletedDefaults", "pantheon", "artifacts", "settings", "historicalEvents", "campaign", "pets"];
function dataset(locations: readonly CampaignRecord[], settings: readonly CampaignRecord[] = []): CampaignDataset {
  return { contractVersion: "campaign-data.v1", collections: names.map(name => ({ name,
    shape: ["factions", "deletedDefaults", "settings", "campaign"].includes(name) ? "keyed" : "list", materialized: true, revision: 1,
    records: name === "locations" ? locations : name === "settings" ? settings : [] })) };
}
const gate = { key: "gate", revision: 3, value: { id: "gate", name: "Gate", x: .2, y: .7, pinType: "fortress", extra: { keep: true } } };

describe("campaign maps", () => {
  it("projects only finite markers in the current map scope and retains original icon sizes", () => {
    const campaign = dataset([gate,
      { key: "inside", revision: 1, value: { name: "Inside", parentId: "gate", x: .4, y: .5 } },
      { key: "unplaced", revision: 1, value: { name: "Unplaced" } },
      { key: "invalid", revision: 1, value: { name: "Invalid", x: NaN, y: .5 } }]);
    expect(mapLocations(campaign, null)).toMatchObject([{ key: "gate", x: .2, y: .7, markerSize: 36, markerIcon: "/icons-defaults/fortress.svg" }]);
    expect(mapLocations(campaign, "gate").map(location => location.key)).toEqual(["inside"]);
  });
  it("moves or unplaces a location without losing unrelated data, and rejects stale edits", () => {
    const campaign = dataset([gate]);
    const detail = { kind: "location" as const, key: "gate", expectedRevision: 3, parentId: null, x: .4, y: .6 };
    expect(prepareMapSave(campaign, detail)).toMatchObject({ expectedRevision: 3, value: { ...gate.value, x: .4, y: .6 } });
    expect(prepareMapSave(campaign, { ...detail, x: null, y: null })).toMatchObject({ value: { name: "Gate", extra: { keep: true } } });
    expect(prepareMapSave(campaign, { ...detail, x: null, y: null })).not.toHaveProperty("value.x");
    expect(() => prepareMapSave(campaign, { ...detail, expectedRevision: 2 })).toThrow("stale");
    expect(prepareMapSave(campaign, { ...detail, x: -.1 })).toMatchObject({ value: { x: -.1 } });
    expect(() => prepareMapSave(campaign, { ...detail, x: Infinity })).toThrow("invalid");
    expect(() => prepareMapSave(campaign, { ...detail, x: null })).toThrow("invalid");
    expect(() => prepareMapSave(campaign, { ...detail, parentId: "gate" })).toThrow("stale");
  });
  it("creates a location on the requested local map with the canonical stored shape", () => {
    expect(prepareMapSave(dataset([gate]), { kind: "location", key: "new-room", name: " Room ", expectedRevision: 0, parentId: "gate", x: .25, y: .75 }))
      .toMatchObject({ collection: "locations", value: { id: "new-room", name: "Room", parentId: "gate", x: .25, y: .75, visibility: "public", pinType: "custom" } });
  });
  it("preserves other scopes and extension fields when appending a saved view", () => {
    const oldView = { id: "old", label: "Local", parentId: "gate", bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, addon: true };
    const campaign = dataset([gate], [{ key: "mapViews", revision: 4, value: [oldView] }]);
    expect(mapViews(campaign, null)).toEqual([]);
    expect(mapViews(campaign, "gate")).toMatchObject([{ id: "old", label: "Local" }]);
    const detail = { kind: "view" as const, expectedRevision: 4, parentId: null, id: "new", label: "World", bounds: { x1: .2, y1: .3, x2: .8, y2: .9 } };
    expect(prepareMapSave(campaign, detail)).toMatchObject({ value: [oldView, { id: "new", label: "World", parentId: null }] });
    expect(() => prepareMapSave(campaign, { ...detail, expectedRevision: 3 })).toThrow("stale");
    expect(() => prepareMapSave(campaign, { ...detail, bounds: { x1: .8, y1: .3, x2: .2, y2: .9 } })).toThrow("invalid");
  });
  it("commits an opaque local image URL only against the reviewed location revision", () => {
    const url = `/api/media/b_${"a".repeat(32)}`;
    expect(prepareLocalMapImage(dataset([gate]), "gate", 3, url)).toMatchObject({ value: { ...gate.value, localMap: url } });
    expect(() => prepareLocalMapImage(dataset([gate]), "gate", 2, url)).toThrow("stale");
    expect(() => prepareLocalMapImage(dataset([gate]), "gate", 3, "javascript:alert(1)")).toThrow("invalid");
  });
});
