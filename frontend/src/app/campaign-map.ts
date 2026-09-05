import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";
import { projectEntities, recordValue, safeMediaURL, text, type EntitySummary } from "./campaign-projection.js";
import { campaignPages } from "./routes.js";

export interface MapBounds { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
export interface MapView { readonly id: string; readonly label: string; readonly icon: string; readonly bounds: MapBounds }
export interface MapLocation extends EntitySummary { readonly x: number; readonly y: number; readonly markerSize: number; readonly markerIcon: string; readonly markerGlyph: string }
export interface MapEventPoint {
  readonly key: string; readonly name: string; readonly sitting: number; readonly x: number; readonly y: number;
}
export const eventPathColors = Object.freeze({ path: "#C8A040", sitting: "#8B6914", past: "#5A3A5A" });
export type MapSaveDetail =
  | { readonly kind: "location"; readonly key: string; readonly expectedRevision: number; readonly parentId: string | null;
      readonly x: number | null; readonly y: number | null; readonly name?: string }
  | { readonly kind: "event"; readonly key: string; readonly expectedRevision: number; readonly parentId: string | null;
      readonly x: number | null; readonly y: number | null }
  | { readonly kind: "view"; readonly action: "create" | "update"; readonly expectedRevision: number; readonly parentId: string | null;
      readonly id: string; readonly label: string; readonly icon: string; readonly bounds: MapBounds }
  | { readonly kind: "view"; readonly action: "delete"; readonly expectedRevision: number; readonly parentId: string | null; readonly id: string };
export interface MapUploadDetail {
  readonly parentId: string | null;
  readonly expectedRevision: number;
  readonly file: File;
}
export class CampaignMapEditError extends Error {
  constructor(readonly kind: "invalid" | "stale") { super(`map edit is ${kind}`); }
}

export const locationPage = campaignPages.find(({ collection }) => collection === "locations")!;
export const eventPage = campaignPages.find(({ collection }) => collection === "events")!;
const defaultSizes: Readonly<Record<string, number>> = Object.freeze({ major_city: 38, city: 32, town: 28, village: 26,
  fortress: 36, castle: 36, tower: 26, temple: 28, shrine: 26, tavern: 24, market: 24, academy: 30, port: 30,
  bridge: 24, camp: 24, dungeon: 28, cave: 24, ruin: 26, landmark: 26, graveyard: 24, battlefield: 28,
  forest: 26, mountain: 30, lake: 28, curiosity: 24, region: 32, enemy: 28, custom: 26 });

export function mapLocationRecord(campaign: CampaignDataset, key: string): CampaignRecord | undefined {
  return campaignCollection(campaign, "locations").records.find(record => record.key === key);
}
export function mapEventRecord(campaign: CampaignDataset, key: string): CampaignRecord | undefined {
  return campaignCollection(campaign, "events").records.find(record => record.key === key);
}
export function eventMapParent(value: Readonly<Record<string, unknown>>): string | null { return text(value["mapParentId"]) || null; }
export function hasEventPin(value: Readonly<Record<string, unknown>>): boolean { return mapCoordinate(value["mapX"]) && mapCoordinate(value["mapY"]); }
export function mapParent(value: Readonly<Record<string, unknown>>): string | null { return text(value["parentId"]) || null; }
export function mapViewRecord(campaign: CampaignDataset): CampaignRecord | undefined {
  return campaignCollection(campaign, "settings").records.find(({ key }) => key === "mapViews");
}
export function mapLocations(campaign: CampaignDataset, parentId: string | null): readonly MapLocation[] {
  const definitions = campaignCollection(campaign, "settings").records.find(({ key }) => key === "pinTypes")?.value;
  return projectEntities(campaign, locationPage).flatMap(entity => {
    const value = entity.raw;
    if (mapParent(value) !== parentId || !mapCoordinate(value["x"]) || !mapCoordinate(value["y"])) return [];
    const type = text(value["pinType"]) || "custom";
    const definition = Array.isArray(definitions) ? definitions.find(item => isRecord(item) && item["id"] === type) : undefined;
    const size = value["size"] ?? definition?.size ?? defaultSizes[type] ?? 28;
    let icon = "";
    if (isRecord(definition?.iconConfig) && Array.isArray(definition.iconConfig["files"])) {
      const files = definition.iconConfig["files"].filter(isRecord);
      const selected = files[definition.iconConfig["strategy"] === "random" ? hash(entity.key) % files.length : 0];
      icon = safeMediaURL(selected?.["url"]) ?? "";
    }
    const bundled = text(definition?.defaultIconId) || type;
    if (icon === "" && Object.hasOwn(defaultSizes, bundled)) icon = `/icons-defaults/${bundled}.svg`;
    return [{ ...entity, x: value["x"], y: value["y"], markerIcon: icon, markerGlyph: text(definition?.icon) || "📍",
      markerSize: typeof size === "number" && Number.isFinite(size) ? Math.min(64, Math.max(14, size)) : 28 }];
  });
}
export function mapViews(campaign: CampaignDataset, parentId: string | null): readonly MapView[] {
  const value = mapViewRecord(campaign)?.value;
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => isRecord(item) && mapParent(item) === parentId && validBounds(item["bounds"]) && text(item["id"]) !== ""
    ? [{ id: text(item["id"]), label: text(item["label"]), icon: text(item["icon"]) || "📍", bounds: item["bounds"] }] : []);
}
export function mapEventPoints(campaign: CampaignDataset, parentId: string | null): readonly MapEventPoint[] {
  const locations = new Map(mapLocations(campaign, parentId).map(location => [location.key, location]));
  return campaignCollection(campaign, "events").records.map(record => ({ record, value: recordValue(record) }))
    .sort((a, b) => eventNumber(a.value["sitting"]) - eventNumber(b.value["sitting"]) || eventNumber(a.value["order"]) - eventNumber(b.value["order"]))
    .flatMap(({ record, value }) => {
      const event = { key: record.key, name: text(value["name"]) || record.key, sitting: eventNumber(value["sitting"]) };
      if (mapCoordinate(value["mapX"]) && mapCoordinate(value["mapY"]) && eventMapParent(value) === parentId) {
        return [{ ...event, x: value["mapX"], y: value["mapY"] }];
      }
      const ids = Array.isArray(value["locations"]) ? value["locations"] : [];
      return ids.flatMap(id => {
        const location = typeof id === "string" ? locations.get(id) : undefined;
        return location === undefined ? [] : [{ ...event, x: location.x, y: location.y }];
      });
    });
}
function eventNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
export function prepareMapSave(campaign: CampaignDataset, detail: MapSaveDetail): CampaignMutation {
  if (!Number.isSafeInteger(detail.expectedRevision) || detail.expectedRevision < 0) throw new CampaignMapEditError("invalid");
  if (detail.parentId !== null && mapLocationRecord(campaign, detail.parentId) === undefined) throw new CampaignMapEditError("stale");
  if (detail.kind === "event") {
    const record = mapEventRecord(campaign, detail.key);
    if (record === undefined || record.revision !== detail.expectedRevision) throw new CampaignMapEditError("stale");
    const value = { ...recordValue(record) };
    if (hasEventPin(value) && eventMapParent(value) !== detail.parentId) throw new CampaignMapEditError("stale");
    if (mapCoordinate(detail.x) && mapCoordinate(detail.y)) {
      value["mapX"] = detail.x; value["mapY"] = detail.y; value["mapParentId"] = detail.parentId;
    } else if (detail.x === null && detail.y === null && hasEventPin(value)) {
      delete value["mapX"]; delete value["mapY"]; delete value["mapParentId"];
    } else throw new CampaignMapEditError("invalid");
    return { operation: "put", collection: "events", key: record.key, expectedRevision: detail.expectedRevision, value };
  }
  if (detail.kind === "location") {
    const record = mapLocationRecord(campaign, detail.key);
    if ((record?.revision ?? 0) !== detail.expectedRevision || (record !== undefined && mapParent(recordValue(record)) !== detail.parentId)) {
      throw new CampaignMapEditError("stale");
    }
    const placing = mapCoordinate(detail.x) && mapCoordinate(detail.y);
    if (!placing && (detail.x !== null || detail.y !== null || record === undefined)) throw new CampaignMapEditError("invalid");
    if (record === undefined && (typeof detail.name !== "string" || text(detail.name) === "" || detail.name.length > 200)) throw new CampaignMapEditError("invalid");
    const value: Record<string, unknown> = record === undefined
      ? { id: detail.key, name: text(detail.name), parentId: detail.parentId, pinType: "custom", attitudes: [], visibility: "public" }
      : { ...recordValue(record) };
    if (placing) { value["x"] = detail.x; value["y"] = detail.y; }
    else { delete value["x"]; delete value["y"]; }
    return { operation: "put", collection: "locations", key: detail.key, expectedRevision: detail.expectedRevision, value };
  }
  const record = mapViewRecord(campaign);
  if ((record?.revision ?? 0) !== detail.expectedRevision) throw new CampaignMapEditError("stale");
  if (!detail.id || (record !== undefined && !Array.isArray(record.value))) throw new CampaignMapEditError("invalid");
  const views: unknown[] = record === undefined ? [] : [...record.value as unknown[]];
  const matches = views.flatMap((item, index) => isRecord(item) && item["id"] === detail.id ? [index] : []);
  if (detail.action === "create" ? matches.length !== 0 : matches.length !== 1) throw new CampaignMapEditError("stale");
  const index = matches[0] ?? -1;
  const existing = views[index];
  if (detail.action !== "create" && (!isRecord(existing) || mapParent(existing) !== detail.parentId)) throw new CampaignMapEditError("stale");
  if (detail.action === "delete") views.splice(index, 1);
  else {
    if (!validBounds(detail.bounds) || text(detail.label) === "" || detail.label.length > 200 || detail.icon.length > 32) throw new CampaignMapEditError("invalid");
    const view = { ...(isRecord(existing) ? existing : {}), id: detail.id, label: text(detail.label), icon: text(detail.icon) || "📍",
      parentId: detail.parentId, bounds: { ...(isRecord(existing) && isRecord(existing["bounds"]) ? existing["bounds"] : {}), ...detail.bounds } };
    if (detail.action === "create") views.push(view); else views[index] = view;
  }
  return { operation: "put", collection: "settings", key: "mapViews", expectedRevision: detail.expectedRevision, value: views };
}
export function prepareLocalMapImage(campaign: CampaignDataset, key: string, expectedRevision: number, url: string): CampaignMutation {
  const record = mapLocationRecord(campaign, key);
  if (record === undefined || record.revision !== expectedRevision) throw new CampaignMapEditError("stale");
  if (safeMediaURL(url) === undefined) throw new CampaignMapEditError("invalid");
  return { operation: "put", collection: "locations", key, expectedRevision, value: { ...recordValue(record), localMap: url } };
}
export function fraction(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
// V1 allowed pins beyond the image edge. Fractions are a coordinate frame, not a clipping rule.
export function mapCoordinate(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
export function validBounds(value: unknown): value is MapBounds {
  return isRecord(value) && fraction(value["x1"]) && fraction(value["y1"]) && fraction(value["x2"]) && fraction(value["y2"]) &&
    value["x1"] < value["x2"] && value["y1"] < value["y2"];
}
function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) { result ^= value.charCodeAt(index); result = (result * 16777619) >>> 0; }
  return result;
}
