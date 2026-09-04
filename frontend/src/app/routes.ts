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
  | { readonly kind: "map"; readonly parentId: string | null }
  | { readonly kind: "create"; readonly page: CampaignPageDefinition; readonly preset: "party" }
  | { readonly kind: "settings" }
  | { readonly kind: "collection"; readonly page: CampaignPageDefinition }
  | { readonly kind: "record"; readonly page: CampaignPageDefinition; readonly key: string }
  | { readonly kind: "addon" }
  | { readonly kind: "not-found"; readonly path: string };

export function parseAppRoute(hash: string): AppRoute {
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
  if (hash === "#/map/world" || hash === "#/mapa/svet") return { kind: "map", parentId: null };
  const localMap = /^#\/(?:map|mapa)\/local\/([^/]+)$/u.exec(hash);
  if (localMap !== null) {
    try {
      const parentId = decodeURIComponent(localMap[1]!);
      if (parentId !== "" && !/\p{Cc}/u.test(parentId)) return { kind: "map", parentId };
    } catch { /* Malformed paths use the ordinary not-found route. */ }
    return { kind: "not-found", path: hash };
  }
  if (isBrowserAddonRouteHash(hash)) {
    return { kind: "addon" };
  }
  const path = hash.startsWith("#/") ? hash.slice(2) : hash;
  const [pageID, encodedKey, ...rest] = path.split("/");
  const definition = campaignPages.find((candidate) => candidate.id === pageID);
  if (definition === undefined || rest.length > 0) {
    return { kind: "not-found", path };
  }
  if (encodedKey === undefined || encodedKey === "") {
    return { kind: "collection", page: definition };
  }
  try {
    const key = decodeURIComponent(encodedKey);
    return key === "" || /\p{Cc}/u.test(key)
      ? { kind: "not-found", path }
      : { kind: "record", page: definition, key };
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
