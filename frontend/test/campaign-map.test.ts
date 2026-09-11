import { describe, expect, it } from "vitest";
import { mapLocations, mapViews, mapEventPoints, mapZoomScaleRatio, mapMarkerScale, prepareMapSave, prepareLocalMapImage } from "../src/app/campaign-map.js";
import type { CampaignDataset, CampaignCollectionName, CampaignRecord } from "../src/core/campaign-data.js";

const names: CampaignCollectionName[] = ["characters", "relationships", "locations", "events", "mysteries", "factions", "deletedDefaults", "pantheon", "artifacts", "settings", "historicalEvents", "campaign", "pets"];
function dataset(locations: readonly CampaignRecord[], settings: readonly CampaignRecord[] = [], events: readonly CampaignRecord[] = []): CampaignDataset {
  return { contractVersion: "campaign-data.v1", collections: names.map(name => ({ name,
    shape: ["factions", "deletedDefaults", "settings", "campaign"].includes(name) ? "keyed" : "list", materialized: true, revision: 1,
    records: name === "locations" ? locations : name === "settings" ? settings : name === "events" ? events : [] })) };
}
const gate = { key: "gate", revision: 3, value: { id: "gate", name: "Gate", x: .2, y: .7, pinType: "fortress", extra: { keep: true } } };

describe("campaign maps", () => {
  it("saves reviewed map details and coordinates through shared field validation", () => {
    const campaign = dataset([gate], [
      { key: "pinTypes", revision: 1, value: [{ id: "town", label: "Town" }] },
      { key: "attitudes", revision: 1, value: [{ id: "ally", label: "Ally" }] },
    ]);
    const detail = { kind: "location" as const, key: "gate", expectedRevision: 3, parentId: null, x: .4, y: .6,
      fields: { pinType: "town", attitudes: ["ally"], size: "40", mapNotes: "Watch the eastern road." } };
    expect(prepareMapSave(campaign, detail)).toMatchObject({ expectedRevision: 3, value: {
      ...gate.value, x: .4, y: .6, pinType: "town", size: 40, attitudes: [{ id: "ally" }], mapNotes: "Watch the eastern road.",
    } });
    expect(gate.value).not.toHaveProperty("size");
    for (const fields of [{ size: "100" }, { pinType: "invented" }, { attitudes: ["invented"] }, { parentId: "gate" }, { name: "Unexpected rename" }]) {
      expect(() => prepareMapSave(campaign, { ...detail, fields })).toThrow("invalid");
    }
    expect(() => prepareMapSave(campaign, { ...detail, expectedRevision: 2 })).toThrow("stale");
    expect(() => prepareMapSave(dataset([]), detail)).toThrow("stale");
    expect(prepareMapSave(campaign, { ...detail, fields: { size: "" } })).not.toHaveProperty("value.size");
  });
  it("preserves separate map configurations and rejects stale or malformed settings", () => {
    const value = { world: { zoomScaleRatio: .3, extension: true }, "local-gate": { zoomScaleRatio: .8, extra: { keep: true } } };
    const config = { key: "mapConfigs", revision: 5, value };
    const campaign = dataset([gate], [config]);
    const detail = { kind: "config" as const, parentId: "gate", expectedRevision: 5, zoomScaleRatio: .5 };
    expect(prepareMapSave(campaign, detail)).toEqual({ operation: "put", collection: "settings", key: "mapConfigs", expectedRevision: 5,
      value: { ...value, "local-gate": { ...value["local-gate"], zoomScaleRatio: .5 } } });
    expect(() => prepareMapSave(campaign, { ...detail, expectedRevision: 4 })).toThrow("stale");
    expect(() => prepareMapSave(dataset([], [config]), detail)).toThrow("stale");
    for (const zoomScaleRatio of [NaN, Infinity, -.1, 1.1]) expect(() => prepareMapSave(campaign, { ...detail, zoomScaleRatio })).toThrow("invalid");
    for (const value of [null, [], false, { "local-gate": null }, { "local-gate": [] }]) {
      expect(() => prepareMapSave(dataset([gate], [{ ...config, value }]), detail)).toThrow("invalid");
    }
    expect(prepareMapSave(dataset([]), { ...detail, parentId: null, expectedRevision: 0 })).toMatchObject({ value: { world: { zoomScaleRatio: .5 } } });
  });
  it("uses the preserved marker scaling formula with bounded per-map ratios", () => {
    const campaign = dataset([gate], [{ key: "mapConfigs", revision: 1, value: { world: { zoomScaleRatio: .5 }, "local-gate": { zoomScaleRatio: 2 } } }]);
    expect(mapZoomScaleRatio(campaign, null)).toBe(.5);
    expect(mapZoomScaleRatio(campaign, "gate")).toBe(1);
    expect(mapZoomScaleRatio(campaign, "missing")).toBe(0);
    expect(mapMarkerScale(-2, 0)).toBe(1);
    expect(mapMarkerScale(-2, .5)).toBe(.5);
    expect(mapMarkerScale(2, 1)).toBe(4);
    expect(mapMarkerScale(0, 1)).toBe(1);
    expect(mapMarkerScale(NaN, .5)).toBe(1);
  });
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
    const detail = { kind: "view" as const, action: "create" as const, icon: "📍", expectedRevision: 4, parentId: null, id: "new", label: "World", bounds: { x1: .2, y1: .3, x2: .8, y2: .9 } };
    expect(prepareMapSave(campaign, detail)).toMatchObject({ value: [oldView, { id: "new", label: "World", parentId: null }] });
    expect(() => prepareMapSave(campaign, { ...detail, expectedRevision: 3 })).toThrow("stale");
    expect(() => prepareMapSave(campaign, { ...detail, bounds: { x1: .8, y1: .3, x2: .2, y2: .9 } })).toThrow("invalid");
  });
  it("edits and deletes only the reviewed preset while preserving its identity and unknown fields", () => {
    const oldView = { id: "local", label: "Local", parentId: "gate", icon: "🏰", bounds: { x1: 0, y1: 0, x2: 1, y2: 1, extra: true }, addon: { keep: true } };
    const otherView = { ...oldView, id: "world", parentId: null };
    const record = { key: "mapViews", revision: 4, value: [oldView, otherView] };
    const campaign = dataset([gate], [record]);
    const detail = { ...oldView, kind: "view" as const, action: "update" as const, expectedRevision: 4, label: "Interior", icon: "🗺",
      bounds: { x1: .2, y1: .3, x2: .8, y2: .9 } };
    expect(prepareMapSave(campaign, detail)).toMatchObject({ value: [{ ...oldView, label: "Interior", icon: "🗺", bounds: { ...detail.bounds, extra: true } }, otherView] });
    const deletion = { kind: "view" as const, action: "delete" as const, id: "local", parentId: "gate", expectedRevision: 4 };
    expect(prepareMapSave(campaign, deletion)).toMatchObject({ value: [otherView] });
    for (const change of [detail, deletion]) {
      expect(() => prepareMapSave(campaign, { ...change, expectedRevision: 3 })).toThrow("stale");
      expect(() => prepareMapSave(campaign, { ...change, parentId: null })).toThrow("stale");
      expect(() => prepareMapSave(campaign, { ...change, id: "missing" })).toThrow("stale");
      expect(() => prepareMapSave(dataset([gate], [{ ...record, value: [oldView, oldView] }]), change)).toThrow("stale");
    }
  });
  it("projects event paths in original session/order sequence with explicit pins taking precedence in their own map", () => {
    const event = (key: string, value: Record<string, unknown>): CampaignRecord => ({ key, revision: 1, value: { name: key, ...value } });
    const campaign = dataset([gate,
      { key: "inn", revision: 1, value: { x: .8, y: .6 } },
      { key: "room", revision: 1, value: { parentId: "gate", x: .4, y: .5 } },
      { key: "unplaced", revision: 1, value: { name: "Unplaced" } }], [], [
      event("travel", { sitting: 2, order: 2, locations: ["inn", "gate", "missing", "unplaced", "room"] }),
      event("own-pin", { sitting: 2, order: 1, locations: ["gate"], mapX: -.1, mapY: .3 }),
      event("past", { locations: ["gate"] }),
      event("local", { sitting: 3, mapX: .6, mapY: .7, mapParentId: "gate", locations: ["inn", "room"] }),
      event("invalid", { sitting: 4, mapX: Infinity, mapY: .4, locations: ["inn"] }),
    ]);
    expect(mapEventPoints(campaign, null)).toEqual([
      { key: "past", name: "past", sitting: 0, x: .2, y: .7 },
      { key: "own-pin", name: "own-pin", sitting: 2, x: -.1, y: .3 },
      { key: "travel", name: "travel", sitting: 2, x: .8, y: .6 },
      { key: "travel", name: "travel", sitting: 2, x: .2, y: .7 },
      { key: "local", name: "local", sitting: 3, x: .8, y: .6 },
      { key: "invalid", name: "invalid", sitting: 4, x: .8, y: .6 },
    ]);
    expect(mapEventPoints(campaign, "gate")).toEqual([
      { key: "travel", name: "travel", sitting: 2, x: .4, y: .5 },
      { key: "local", name: "local", sitting: 3, x: .6, y: .7 },
    ]);
  });
  it("commits an opaque local image URL only against the reviewed location revision", () => {
    const url = `/api/media/b_${"a".repeat(32)}`;
    expect(prepareLocalMapImage(dataset([gate]), "gate", 3, url)).toMatchObject({ value: { ...gate.value, localMap: url } });
    expect(() => prepareLocalMapImage(dataset([gate]), "gate", 2, url)).toThrow("stale");
    expect(() => prepareLocalMapImage(dataset([gate]), "gate", 3, "javascript:alert(1)")).toThrow("invalid");
  });
  it("places, moves and unplaces an existing event without changing its links or extension fields", () => {
    const event = { key: "arrival", revision: 7, value: { id: "arrival", name: "Arrival", locations: ["gate"], characters: ["hero"], sitting: 3, addonData: { keep: true } } };
    const detail = { kind: "event" as const, key: "arrival", expectedRevision: 7, parentId: "gate", x: -.2, y: .3 };
    expect(prepareMapSave(dataset([gate], [], [event]), detail)).toEqual({ operation: "put", collection: "events", key: "arrival", expectedRevision: 7,
      value: { ...event.value, mapX: -.2, mapY: .3, mapParentId: "gate" } });
    const placed = { ...event, value: { ...event.value, mapX: .4, mapY: .5, mapParentId: "gate" } };
    const campaign = dataset([gate], [], [placed]);
    expect(prepareMapSave(campaign, detail)).toMatchObject({ value: { ...placed.value, mapX: -.2, mapY: .3 } });
    expect(prepareMapSave(campaign, { ...detail, x: null, y: null })).toMatchObject({ value: event.value });
    expect(prepareMapSave(campaign, { ...detail, x: null, y: null })).not.toHaveProperty("value.mapParentId");
    expect(() => prepareMapSave(campaign, { ...detail, parentId: null })).toThrow("stale");
    expect(() => prepareMapSave(campaign, { ...detail, expectedRevision: 6 })).toThrow("stale");
    expect(() => prepareMapSave(campaign, { ...detail, key: "missing" })).toThrow("stale");
    expect(() => prepareMapSave(dataset([], [], [placed]), detail)).toThrow("stale");
    expect(() => prepareMapSave(campaign, { ...detail, x: NaN })).toThrow("invalid");
    expect(() => prepareMapSave(campaign, { ...detail, y: null })).toThrow("invalid");
    expect(() => prepareMapSave(dataset([gate], [], [event]), { ...detail, x: null, y: null })).toThrow("invalid");
  });
});
