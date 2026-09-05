import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";
import { campaignPages } from "./routes.js";
import { uiCollectionLabel, uiText } from "./ui-localization.js";
import type { BrowserNavigationEntry } from "../addons/navigation.js";

export interface SidebarSection extends Readonly<Record<string, unknown>> {
  readonly id: string; readonly label: string; readonly icon: string;
  readonly collapsible: boolean; readonly defaultOpen: boolean; readonly role: "" | "dm";
  readonly pages: readonly string[];
}
export interface SidebarLayout extends Readonly<Record<string, unknown>> {
  readonly sections: readonly SidebarSection[]; readonly hidden: readonly string[];
}
export interface SidebarSaveDetail { readonly expectedRevision: number; readonly layout: SidebarLayout;
  readonly addonVisibility?: { readonly expectedRevision: number; readonly modes: Readonly<Record<string, SidebarAddonMode>> } }
export type SidebarAddonMode = "everyone" | "dm" | "hidden";
export function addonSidebarKey(entry: BrowserNavigationEntry): string { return `${entry.addonId}:${entry.hash.slice(1)}`; }
export function addonSidebarRecord(campaign: CampaignDataset) { return campaignCollection(campaign, "settings").records.find(({ key }) => key === "addonSidebarVisibility"); }
export function addonSidebarMode(campaign: CampaignDataset | undefined, key: string): SidebarAddonMode {
  const value = campaign === undefined ? undefined : addonSidebarRecord(campaign)?.value;
  const mode = isRecord(value) ? value[key] : undefined;
  return mode === "everyone" || mode === "dm" ? mode : "hidden";
}
export function prepareAddonSidebarSave(campaign: CampaignDataset, detail: NonNullable<SidebarSaveDetail["addonVisibility"]>): CampaignMutation {
  const record = addonSidebarRecord(campaign), value = record?.value ?? {};
  if (!Number.isSafeInteger(detail.expectedRevision) || detail.expectedRevision < 0 || !isRecord(value) || !isRecord(detail.modes)) throw new SidebarEditError("invalid");
  if (detail.expectedRevision !== (record?.revision ?? 0)) throw new SidebarEditError("stale");
  for (const [key, mode] of Object.entries(detail.modes)) if (key.length > 512 || !/^[a-z0-9][a-z0-9-]*:\/addons\//u.test(key) ||
    (mode !== "everyone" && mode !== "dm" && mode !== "hidden")) throw new SidebarEditError("invalid");
  return { operation: "put", collection: "settings", key: "addonSidebarVisibility", expectedRevision: detail.expectedRevision, value: { ...value, ...detail.modes } };
}
export class SidebarEditError extends Error {
  override readonly name = "SidebarEditError";
  constructor(readonly kind: "invalid" | "stale") { super(`sidebar layout is ${kind}`); }
}
const aliases: Readonly<Record<string, string>> = Object.freeze({
  "/casova-osa": "/timeline",
  "/mapa/svet": "/map/world", "/mista": "/locations", "/postavy": "/characters", "/frakce": "/factions",
  "/mazlicci": "/companions", "/zahady": "/mysteries", "/panteon": "/pantheon", "/artefakty": "/artifacts", "/historie": "/history",
});
export function sidebarPage(route: string) {
  const canonical = aliases[route] ?? route;
  if (canonical === "/") return { id: "dashboard", route: canonical, label: uiText("shell.overview"), icon: "🏠" };
  if (canonical === "/party") return { id: "party", route: canonical, label: uiText("shell.party"), icon: "🛡" };
  if (canonical === "/timeline") return { id: "timeline", route: canonical, label: uiText("timeline.title"), icon: "⏳" };
  if (canonical === "/map/world") return { id: "map", route: canonical, label: uiText("map.world"), icon: "🗺" };
  const page = campaignPages.find(page => `/${page.id}` === canonical);
  return page === undefined ? undefined : { id: page.id, route: canonical, label: uiCollectionLabel(page.id, "other"), icon: page.icon };
}
export function defaultSidebarLayout(): SidebarLayout {
  return { sections: [
    section("overview", uiText("shell.overview"), ["/", "/party"]),
    section("campaign", uiText("shell.campaign"), ["/timeline", "/mysteries"]),
    section("world", uiText("shell.world"), ["/map/world", "/locations", "/characters", "/factions", "/companions"]),
    section("compendium", uiText("shell.compendium"), ["/pantheon", "/artifacts", "/history"]),
  ], hidden: ["/events"] };
}
function section(id: string, label: string, pages: readonly string[]): SidebarSection {
  return { id, label, icon: "", collapsible: false, defaultOpen: true, role: "", pages };
}
export function sidebarRecord(campaign: CampaignDataset) { return campaignCollection(campaign, "settings").records.find(({ key }) => key === "sidebarLayout"); }
export function campaignSidebar(campaign?: CampaignDataset): SidebarLayout {
  if (campaign === undefined) return defaultSidebarLayout();
  const record = sidebarRecord(campaign);
  if (record === undefined) return defaultSidebarLayout();
  return parseSidebarLayout(record.value);
}
export function parseSidebarLayout(value: unknown): SidebarLayout {
  if (!isRecord(value) || !Array.isArray(value["sections"]) || value["sections"].length > 32 ||
    (value["hidden"] !== undefined && !Array.isArray(value["hidden"]))) throw new SidebarEditError("invalid");
  const ids = new Set<string>(), routes = new Set<string>();
  const pages = (value: unknown): readonly string[] => {
    if (!Array.isArray(value) || value.length > 128) throw new SidebarEditError("invalid");
    return value.map(route => {
      if (typeof route !== "string" || !/^\/(?!\/)[^\p{Cc}]*$/u.test(route) || route.length > 256) throw new SidebarEditError("invalid");
      const canonical = sidebarPage(route)?.route ?? route;
      if (routes.has(canonical)) throw new SidebarEditError("invalid");
      routes.add(canonical); return route;
    });
  };
  const sections = value["sections"].map(raw => {
    if (!isRecord(raw) || typeof raw["id"] !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/u.test(raw["id"]) || raw["id"] === "__hidden__" || ids.has(raw["id"]) ||
      !optionalLine(raw["label"], 200) || !optionalLine(raw["icon"], 100) ||
      (raw["role"] !== undefined && raw["role"] !== "" && raw["role"] !== "dm") ||
      (raw["collapsible"] !== undefined && typeof raw["collapsible"] !== "boolean") || (raw["defaultOpen"] !== undefined && typeof raw["defaultOpen"] !== "boolean")) throw new SidebarEditError("invalid");
    ids.add(raw["id"]);
    return { ...raw, id: raw["id"], label: typeof raw["label"] === "string" ? raw["label"] : "", icon: typeof raw["icon"] === "string" ? raw["icon"] : "",
      collapsible: raw["collapsible"] === true, defaultOpen: raw["defaultOpen"] !== false, role: raw["role"] === "dm" ? "dm" as const : "" as const, pages: pages(raw["pages"]) };
  });
  const hidden = [...pages(value["hidden"] ?? [])];
  // Pages added by the rewrite start hidden in a curated layout. Unknown saved
  // routes survive editing and can become available when their workflow returns.
  for (const route of allSidebarRoutes(defaultSidebarLayout())) if (!routes.has(route)) hidden.push(route);
  return { ...value, sections, hidden };
}
export function prepareSidebarSave(campaign: CampaignDataset, detail: SidebarSaveDetail): CampaignMutation {
  const record = sidebarRecord(campaign);
  if (!Number.isSafeInteger(detail.expectedRevision) || detail.expectedRevision < 0) throw new SidebarEditError("invalid");
  if (detail.expectedRevision !== (record?.revision ?? 0)) throw new SidebarEditError("stale");
  if (record !== undefined) parseSidebarLayout(record.value);
  return { operation: "put", collection: "settings", key: "sidebarLayout", expectedRevision: detail.expectedRevision,
    value: { ...(record?.value as Record<string, unknown> | undefined), ...parseSidebarLayout(detail.layout) } };
}
export function moveSidebarPage(layout: SidebarLayout, route: string, target: string, index: number): SidebarLayout {
  if (!allSidebarRoutes(layout).includes(route) || (target !== "__hidden__" && !layout.sections.some(section => section.id === target))) return layout;
  const clean = { ...layout, sections: layout.sections.map(section => ({ ...section, pages: section.pages.filter(page => page !== route) })), hidden: layout.hidden.filter(page => page !== route) };
  if (target === "__hidden__") return { ...clean, hidden: insert(clean.hidden, route, index) };
  return { ...clean, sections: clean.sections.map(section => section.id === target ? { ...section, pages: insert(section.pages, route, index) } : section) };
}
export function allSidebarRoutes(layout: SidebarLayout): readonly string[] { return [...layout.sections.flatMap(section => section.pages), ...layout.hidden]; }
function insert<T>(items: readonly T[], item: T, index: number): readonly T[] { const next = [...items]; next.splice(Math.max(0, Math.min(index, next.length)), 0, item); return next; }
function optionalLine(value: unknown, limit: number): boolean { return value === undefined || typeof value === "string" && value.length <= limit && !/[\p{Cc}]/u.test(value); }
