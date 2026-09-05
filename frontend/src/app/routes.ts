import type { CampaignCollectionName } from "../core/campaign-data.js";
import { isBrowserAddonRouteHash } from "../addons/navigation.js";

export interface CampaignPageDefinition {
  readonly id: string;
  readonly collection: CampaignCollectionName;
  readonly singular: string;
  readonly plural: string;
  readonly icon: string;
  readonly group: "campaign" | "world";
}

export const campaignPages: readonly CampaignPageDefinition[] = Object.freeze([
  page("characters", "characters", "Character", "Characters", "👤", "campaign"),
  page("locations", "locations", "Location", "Locations", "📍", "world"),
  page("events", "events", "Event", "Events", "⏳", "campaign"),
  page("mysteries", "mysteries", "Mystery", "Mysteries", "❓", "campaign"),
  page("factions", "factions", "Faction", "Factions", "⬡", "world"),
  page("pantheon", "pantheon", "Deity", "Pantheon", "✨", "world"),
  page("artifacts", "artifacts", "Artifact", "Artifacts", "🗝", "world"),
  page("history", "historicalEvents", "Historical event", "History", "📜", "world"),
  page("companions", "pets", "Companion", "Companions", "🐾", "campaign"),
]);

export type AppRoute =
  | { readonly kind: "dashboard" }
  | { readonly kind: "search" }
  | { readonly kind: "party" }
  | { readonly kind: "timeline" }
  | { readonly kind: "map"; readonly parentId: string | null;
      readonly event?: { readonly key: string; readonly mode: "show" | "place" };
      readonly location?: { readonly key: string; readonly mode: "show" | "place" } }
  | { readonly kind: "create"; readonly page: CampaignPageDefinition; readonly preset: "party" | "event"; readonly sitting?: number }
  | { readonly kind: "settings"; readonly mapParentId?: string | null }
  | { readonly kind: "collection"; readonly page: CampaignPageDefinition }
  | { readonly kind: "record"; readonly page: CampaignPageDefinition; readonly key: string; readonly editing?: boolean }
  | { readonly kind: "addon" }
  | { readonly kind: "not-found"; readonly path: string };

export function parseAppRoute(hash: string): AppRoute {
  if (["#/timeline", "#/casova-osa", "#/mapa/casova-osa"].includes(hash)) return { kind: "timeline" };
  const newEvent = /^#\/timeline\/new\/([1-9]\d*)$/u.exec(hash);
  if (newEvent !== null && Number.isSafeInteger(Number(newEvent[1]))) {
    return { kind: "create", preset: "event", sitting: Number(newEvent[1]), page: campaignPages.find(page => page.id === "events")! };
  }
  if (hash === "" || hash === "#" || hash === "#/" || hash === "#/dashboard") {
    return { kind: "dashboard" };
  }
  if (hash === "#/party") {
    return { kind: "party" };
  }
  if (hash === "#/party/new") {
    return { kind: "create", page: campaignPages.find(({ id }) => id === "characters")!, preset: "party" };
  }
  if (hash === "#/search") {
    return { kind: "search" };
  }
  if (hash === "#/settings") {
    return { kind: "settings" };
  }
  if (hash === "#/settings/maps") return { kind: "settings", mapParentId: null };
  const mapSettings = /^#\/settings\/maps\/local\/([^/]+)$/u.exec(hash);
  if (mapSettings !== null) {
    try {
      const mapParentId = decodeURIComponent(mapSettings[1]!);
      if (mapParentId && !/\p{Cc}/u.test(mapParentId)) return { kind: "settings", mapParentId };
    } catch { /* Malformed paths use the ordinary not-found route. */ }
    return { kind: "not-found", path: hash };
  }
  const map = /^#\/(?:map\/world|mapa\/svet|(?:map|mapa)\/local\/([^/]+))(?:\/(event|location)\/([^/]+)\/(show|place))?$/u.exec(hash);
  if (map !== null) {
    try {
      const parentId = map[1] === undefined ? null : decodeURIComponent(map[1]);
      const key = map[3] === undefined ? undefined : decodeURIComponent(map[3]);
      if ((parentId === null || (parentId !== "" && !/\p{Cc}/u.test(parentId))) &&
        (key === undefined || (key !== "" && !/\p{Cc}/u.test(key)))) {
        if (key === undefined) return { kind: "map", parentId };
        const target = { key, mode: map[4] === "place" ? "place" as const : "show" as const };
        return map[2] === "event" ? { kind: "map", parentId, event: target } : { kind: "map", parentId, location: target };
      }
    } catch { /* Malformed paths use the ordinary not-found route. */ }
    return { kind: "not-found", path: hash };
  }
  if (isBrowserAddonRouteHash(hash)) {
    return { kind: "addon" };
  }
  const path = hash.startsWith("#/") ? hash.slice(2) : hash;
  const [pageID, encodedKey, ...rest] = path.split("/");
  const definition = campaignPages.find((candidate) => candidate.id === pageID);
  const editing = pageID === "events" && rest.length === 1 && rest[0] === "edit";
  if (definition === undefined || rest.length > 0 && (!editing || !encodedKey)) {
    return { kind: "not-found", path };
  }
  if (encodedKey === undefined || encodedKey === "") {
    return { kind: "collection", page: definition };
  }
  try {
    const key = decodeURIComponent(encodedKey);
    return key === "" || /\p{Cc}/u.test(key)
      ? { kind: "not-found", path }
      : { kind: "record", page: definition, key, ...(editing ? { editing: true } : {}) };
  } catch {
    return { kind: "not-found", path };
  }
}

export function collectionHash(page: CampaignPageDefinition): string {
  return `#/${page.id}`;
}

export function mapHash(parentId: string | null): string {
  return parentId === null ? "#/map/world" : `#/map/local/${encodeURIComponent(parentId)}`;
}
export function eventMapHash(parentId: string | null, key: string, mode: "show" | "place"): string {
  return `${mapHash(parentId)}/event/${encodeURIComponent(key)}/${mode}`;
}
export function locationMapHash(parentId: string | null, key: string, mode: "show" | "place"): string {
  return `${mapHash(parentId)}/location/${encodeURIComponent(key)}/${mode}`;
}
export function mapSettingsHash(parentId: string | null): string {
  return parentId === null ? "#/settings/maps" : `#/settings/maps/local/${encodeURIComponent(parentId)}`;
}

export function recordHash(page: CampaignPageDefinition, key: string): string {
  return `${collectionHash(page)}/${encodeURIComponent(key)}`;
}

function page(
  id: string,
  collection: CampaignCollectionName,
  singular: string,
  plural: string,
  icon: string,
  group: CampaignPageDefinition["group"],
): CampaignPageDefinition {
  return Object.freeze({ id, collection, singular, plural, icon, group });
}
