import type { CampaignCollectionName } from "../core/campaign-data.js";
import { uiCollectionLabel } from "./ui-localization.js";
import { isBrowserAddonRouteHref } from "../addons/navigation.js";
import { parseAddonGraphHref, type GraphSelection } from "./campaign-addon-graph.js";

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
  page("companions", "companions", "Companion", "Companions", "🐾", "campaign"),
]);

export const contextCreationActions = {
  "character-here": { source: "locations", target: "characters", field: "location" },
  "event-here": { source: "locations", target: "events", field: "locations" },
  "sub-location": { source: "locations", target: "locations", field: "parentId" },
  "faction-member": { source: "factions", target: "characters", field: "faction" },
} as const;
export type ContextCreationAction = keyof typeof contextCreationActions;

export type AppRoute =
  | { readonly kind: "dashboard" }
  | { readonly kind: "dm" }
  | { readonly kind: "search"; readonly query?: string }
  | { readonly kind: "party" }
  | { readonly kind: "timeline" }
  | { readonly kind: "campaign-graph"; readonly mode: GraphSelection }
  | {
      readonly kind: "map";
      readonly parentId: string | null;
      readonly event?: { readonly key: string; readonly mode: "show" | "place" };
      readonly location?: { readonly key: string; readonly mode: "show" | "place" };
    }
  | {
      readonly kind: "create";
      readonly page: CampaignPageDefinition;
      readonly preset: "blank" | "party" | "event" | "context";
      readonly sitting?: number;
      readonly context?: { readonly action: ContextCreationAction; readonly key: string };
    }
  | {
      readonly kind: "settings";
      readonly category?: SettingsSlug;
      readonly mapParentId?: string | null;
      readonly addonId?: string | null;
    }
  | { readonly kind: "collection"; readonly page: CampaignPageDefinition; readonly view?: string }
  | {
      readonly kind: "record";
      readonly page: CampaignPageDefinition;
      readonly key: string;
      readonly editing?: boolean;
      readonly returnTo?: string;
    }
  | { readonly kind: "addon" }
  | { readonly kind: "not-found"; readonly path: string };

/**
 * The app's own spelling of an address: its path and query, as the URL parser
 * writes them. Compare addresses only in this form, because the parser encodes
 * some query characters (such as `'`) that `encodeURIComponent` leaves alone.
 */
export function canonicalAppHref(href: string): string {
  const url = new URL(href || "/", "http://codex.invalid");
  return `${url.pathname}${url.search}`;
}

export function createReturnHref(route: Extract<AppRoute, { kind: "create" }>): string {
  if (route.context)
    return recordHref(
      campaignPages.find(
        (page) => page.collection === contextCreationActions[route.context!.action].source,
      )!,
      route.context.key,
    );
  return route.preset === "party"
    ? "/party"
    : route.preset === "event"
      ? "/timeline"
      : collectionHref(route.page);
}

export function parseAppRoute(href: string): AppRoute {
  href = canonicalAppHref(href);
  const contextual = /^\/create\/([a-z-]+)\/([^/?]+)$/u.exec(href);
  if (contextual && Object.hasOwn(contextCreationActions, contextual[1]!)) {
    try {
      const key = decodeURIComponent(contextual[2]!);
      if (key && !/\p{Cc}/u.test(key)) {
        const action = contextual[1] as ContextCreationAction;
        return {
          kind: "create",
          preset: "context",
          context: { action, key },
          page: campaignPages.find(
            (page) => page.collection === contextCreationActions[action].target,
          )!,
        };
      }
    } catch {
      /* Malformed links remain unavailable. */
    }
    return { kind: "not-found", path: href };
  }
  const edit = /^\/([^/?]+)\/([^/?]+)\/edit(?:\?(.*))?$/u.exec(href);
  if (edit) {
    try {
      const page = campaignPages.find((page) => page.id === edit[1]),
        key = decodeURIComponent(edit[2]!);
      const params = new URLSearchParams(edit[3]),
        returnTo = params.get("return") ?? undefined;
      if (
        page &&
        key &&
        !/\p{Cc}/u.test(key) &&
        [...params.keys()].every((key) => key === "return") &&
        params.getAll("return").length <= 1 &&
        (returnTo === undefined || validEditorReturnHref(returnTo))
      ) {
        return { kind: "record", page, key, editing: true, ...(returnTo ? { returnTo } : {}) };
      }
    } catch {
      /* Malformed links remain unavailable. */
    }
    return { kind: "not-found", path: href };
  }
  const create = /^\/create\/([^/]+)$/u.exec(href);
  if (create) {
    const page = campaignPages.find((page) => page.id === create[1]);
    if (page) return { kind: "create", page, preset: "blank" };
  }
  if (href === "/dm") return { kind: "dm" };
  const addonGraph = parseAddonGraphHref(href);
  if (addonGraph) return { kind: "campaign-graph", mode: addonGraph };
  if (href === "/graph/relationships") return { kind: "campaign-graph", mode: "relationships" };
  if (href === "/graph/factions") return { kind: "campaign-graph", mode: "factions" };
  if (href === "/graph/mysteries") return { kind: "campaign-graph", mode: "mysteries" };
  if (href === "/timeline") return { kind: "timeline" };
  const newEvent = /^\/timeline\/new\/([1-9]\d*)$/u.exec(href);
  if (newEvent !== null && Number.isSafeInteger(Number(newEvent[1]))) {
    return {
      kind: "create",
      preset: "event",
      sitting: Number(newEvent[1]),
      page: campaignPages.find((page) => page.id === "events")!,
    };
  }
  if (href === "/" || href === "/dashboard") {
    return { kind: "dashboard" };
  }
  if (href === "/party") {
    return { kind: "party" };
  }
  if (href === "/party/new") {
    return {
      kind: "create",
      page: campaignPages.find(({ id }) => id === "characters")!,
      preset: "party",
    };
  }
  if (href === "/search") {
    return { kind: "search" };
  }
  if (href.startsWith("/search?") && href.length <= 4_096) {
    return {
      kind: "search",
      query: (new URLSearchParams(href.slice("/search?".length)).get("q") ?? "").slice(0, 200),
    };
  }
  if (href === "/settings") {
    return { kind: "settings" };
  }
  const settingsCategory = /^\/settings\/([a-z-]+)$/u.exec(href)?.[1];
  if (isSettingsSlug(settingsCategory)) return { kind: "settings", category: settingsCategory };
  if (href === "/settings/addons") return { kind: "settings", addonId: null };
  const addonSettings = /^\/settings\/addons\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u.exec(href);
  if (addonSettings && addonSettings[1]!.length <= 100)
    return { kind: "settings", addonId: addonSettings[1]! };
  if (href === "/settings/maps") return { kind: "settings", mapParentId: null };
  const mapSettings = /^\/settings\/maps\/local\/([^/]+)$/u.exec(href);
  if (mapSettings !== null) {
    try {
      const mapParentId = decodeURIComponent(mapSettings[1]!);
      if (mapParentId && !/\p{Cc}/u.test(mapParentId)) return { kind: "settings", mapParentId };
    } catch {
      /* Malformed paths use the ordinary not-found route. */
    }
    return { kind: "not-found", path: href };
  }
  const map =
    /^\/map\/(?:world|local\/([^/]+))(?:\/(event|location)\/([^/]+)\/(show|place))?$/u.exec(href);
  if (map !== null) {
    try {
      const parentId = map[1] === undefined ? null : decodeURIComponent(map[1]);
      const key = map[3] === undefined ? undefined : decodeURIComponent(map[3]);
      if (
        (parentId === null || (parentId !== "" && !/\p{Cc}/u.test(parentId))) &&
        (key === undefined || (key !== "" && !/\p{Cc}/u.test(key)))
      ) {
        if (key === undefined) return { kind: "map", parentId };
        const target = { key, mode: map[4] === "place" ? ("place" as const) : ("show" as const) };
        return map[2] === "event"
          ? { kind: "map", parentId, event: target }
          : { kind: "map", parentId, location: target };
      }
    } catch {
      /* Malformed paths use the ordinary not-found route. */
    }
    return { kind: "not-found", path: href };
  }
  if (isBrowserAddonRouteHref(href)) {
    return { kind: "addon" };
  }
  const collectionView = /^\/([^/?]+)\?(.*)$/u.exec(href);
  if (collectionView && collectionView[2]!.length <= 64_000) {
    const page = campaignPages.find((page) => page.id === collectionView[1]);
    if (page) return { kind: "collection", page, view: collectionView[2]! };
  }
  const path = href.slice(1);
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

/** URL names of the settings categories that have no route of their own. */
export const settingsSlugs = [
  "language",
  "appearance",
  "party",
  "sidebar",
  "relationships",
  "genders",
  "map-markers",
  "character-statuses",
  "event-priorities",
  "attitudes",
  "access",
  "backup",
] as const;
export type SettingsSlug = (typeof settingsSlugs)[number];
function isSettingsSlug(value: string | undefined): value is SettingsSlug {
  return settingsSlugs.includes(value as SettingsSlug);
}
export function settingsHref(category: SettingsSlug): string {
  return `/settings/${category}`;
}

export function addonSettingsHref(addonId: string): string {
  return `/settings/addons/${encodeURIComponent(addonId)}`;
}

export function collectionHref(page: CampaignPageDefinition): string {
  return `/${page.id}`;
}

export function mapHref(parentId: string | null): string {
  return parentId === null ? "/map/world" : `/map/local/${encodeURIComponent(parentId)}`;
}
export function eventMapHref(parentId: string | null, key: string, mode: "show" | "place"): string {
  return `${mapHref(parentId)}/event/${encodeURIComponent(key)}/${mode}`;
}
export function locationMapHref(
  parentId: string | null,
  key: string,
  mode: "show" | "place",
): string {
  return `${mapHref(parentId)}/location/${encodeURIComponent(key)}/${mode}`;
}
export function mapSettingsHref(parentId: string | null): string {
  return parentId === null
    ? "/settings/maps"
    : `/settings/maps/local/${encodeURIComponent(parentId)}`;
}

export function contextualCreateHref(action: ContextCreationAction, key: string): string {
  return `/create/${action}/${encodeURIComponent(key)}`;
}
export function recordEditHref(
  page: CampaignPageDefinition,
  key: string,
  returnTo?: string,
): string {
  return `${recordHref(page, key)}/edit${returnTo && validEditorReturnHref(returnTo) ? "?return=" + encodeURIComponent(returnTo) : ""}`;
}
function validEditorReturnHref(href: string): boolean {
  if (["/", "/party", "/timeline"].includes(href)) return true;
  if (href.length > 64_000) return false;
  const match = /^\/([^/?]+)(?:\?.*)?$/u.exec(href);
  return !!match && campaignPages.some((page) => page.id === match[1]);
}

export function recordHref(page: CampaignPageDefinition, key: string): string {
  return `${collectionHref(page)}/${encodeURIComponent(key)}`;
}

function page(
  id: string,
  collection: CampaignCollectionName,
  singular: string,
  plural: string,
  icon: string,
  group: CampaignPageDefinition["group"],
): CampaignPageDefinition {
  return Object.freeze({
    id,
    collection,
    get singular() {
      return uiCollectionLabel(id, "one") || singular;
    },
    get plural() {
      return uiCollectionLabel(id, "other") || plural;
    },
    icon,
    group,
  });
}
