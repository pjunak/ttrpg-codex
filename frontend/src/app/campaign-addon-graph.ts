import { isRecord } from "../core/boundary.js";
import type { ActiveBrowserContribution, BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole, BrowserPermissionGrant } from "../addons/generation-manager.js";
import { browserAddonRouteHash } from "../addons/navigation.js";
import { graphColor, graphSearch, validCoordinate, type CampaignGraph, type GraphNode, type GraphPoint, type GraphEdge } from "./campaign-graph.js";
import type { GraphMode } from "./campaign-graph-modes.js";

export type GraphSelection = GraphMode | `addon:${string}:${string}`;
export const isCoreGraph = (view: GraphSelection): view is GraphMode => !view.startsWith("addon:");
export const addonGraphId = (active: ActiveBrowserContribution): GraphSelection => `addon:${active.addonId}:${active.descriptor.id}`;
export const addonGraphHash = (view: GraphSelection): string => `#/graph/addons/${view.slice(6).replace(":", "/")}`;
const localId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
export const parseAddonGraphHash = (hash: string): GraphSelection | undefined => {
  const parts = /^#\/graph\/addons\/([^/]+)\/([^/]+)$/u.exec(hash);
  return parts && localId.test(parts[1]!) && localId.test(parts[2]!) ? `addon:${parts[1]}:${parts[2]}` : undefined;
};
export const addonGraphKey = (active: ActiveBrowserContribution, kind: string, id: string): string => JSON.stringify(["addon", active.addonId, active.descriptor.id, kind, id]);

export function graphViews(registry: BrowserContributionRegistry | undefined, role: BrowserRole | undefined) {
  return role ? registry?.list("graph-view", role).filter(active => active.binding.kind === "model-provider" &&
    validConfig(active, undefined)) ?? [] : [];
}

export function graphProviders(registry: BrowserContributionRegistry | undefined, role: BrowserRole | undefined, view: GraphSelection) {
  if (!registry || !role) return [];
  return isCoreGraph(view) ? registry.list("graph-contributor", role).filter(active => active.descriptor.config["view"] === view) :
    graphViews(registry, role).filter(active => addonGraphId(active) === view);
}

function validConfig(active: ActiveBrowserContribution, view: string | undefined): boolean {
  const config = active.descriptor.config;
  return config["contractVersion"] === 1 && Object.keys(config).length === (view ? 2 : 1) &&
    (view === undefined || config["view"] === view);
}

/** Only already-visible core identities are shared, never the campaign or record bodies. */
export function graphModelRequest(base: CampaignGraph, view: GraphSelection, permissions: readonly BrowserPermissionGrant[] = []) {
  const coreNodes: { id: string; kind: string; key: string }[] = [];
  const resources = new Set(permissions.filter(grant => grant.id === "core.data.read").flatMap(grant => grant.resources));
  const collections = { character: "characters", faction: "factions", location: "locations", mystery: "mysteries", addon: "" };
  let bytes = 0;
  for (const node of base.nodes) {
    if (!resources.has(collections[node.kind])) continue;
    const reference = { id: node.key, kind: node.kind, key: node.recordKey ?? node.legacyKey };
    bytes += new TextEncoder().encode(JSON.stringify(reference)).length;
    if (coreNodes.length === 512 || bytes > 24_000) break;
    coreNodes.push(reference);
  }
  return { contractVersion: 1, viewId: view, coreNodes };
}

export interface AddonGraphModel { readonly graph: CampaignGraph; readonly positions: ReadonlyMap<string, GraphPoint> }
export interface AddonGraphResult { readonly active: ActiveBrowserContribution; readonly model?: AddonGraphModel }

/** Treat integrated callbacks and isolated port responses as the same JSON boundary. */
export function parseAddonGraphModel(value: unknown, active: ActiveBrowserContribution, base: CampaignGraph,
  request: ReturnType<typeof graphModelRequest>, routes: readonly ActiveBrowserContribution[]): AddonGraphModel {
  const json = JSON.stringify(value);
  if (!json || new TextEncoder().encode(json).length > 48_000) throw new TypeError("Graph model exceeds 48000 bytes");
  const model = object(JSON.parse(json), ["contractVersion", "nodes", "edges"]);
  if (model["contractVersion"] !== 1 || !Array.isArray(model["nodes"]) || !Array.isArray(model["edges"]) ||
    model["nodes"].length > 250 || model["edges"].length > 500) throw new TypeError("Invalid graph model version or size");
  const positions = new Map<string, GraphPoint>(), ids = new Map<string, string>(), baseIds = new Set(base.nodes.map(node => node.key));
  const coreIds = new Set(request.coreNodes.map(node => node.id));
  const nodes = model["nodes"].map((raw): GraphNode => {
    const node = object(raw, ["id", "label", "summary", "color", "badge", "position", "detail"]);
    const id = identifier(node["id"]), key = addonGraphKey(active, "node", id);
    if (ids.has(id) || baseIds.has(key)) throw new TypeError("Duplicate graph node");
    ids.set(id, key);
    const name = boundedText(node["label"], 200, true), summary = boundedText(node["summary"], 1000);
    let route = "";
    if (node["detail"] !== undefined) {
      const detail = object(node["detail"], ["route"]), routeId = identifier(detail["route"]);
      const target = routes.find(item => item.addonId === active.addonId && item.generationId === active.generationId && item.descriptor.id === routeId);
      if (!target) throw new TypeError("Graph detail requires an active route in the same generation");
      route = browserAddonRouteHash(target);
    }
    if (node["position"] !== undefined) {
      const point = object(node["position"], ["x", "y"]);
      if (typeof point["x"] !== "number" || typeof point["y"] !== "number" || !validCoordinate(point["x"]) || !validCoordinate(point["y"])) throw new TypeError("Invalid graph position");
      positions.set(key, { x: point["x"], y: point["y"] });
    }
    return { kind: "addon", key, legacyKey: "", name, route, hint: summary, title: active.descriptor.label,
      color: color(node["color"]), badge: node["badge"] === undefined ? "◇" : boundedText(node["badge"], 32),
      faction: "", factionName: "", status: "", statusLabel: "", statusColor: "", statusIcon: "", count: 0, commonTypes: "",
      search: graphSearch(`${name} ${summary} ${active.descriptor.label}`) };
  });
  const endpoint = (raw: unknown): string => {
    const value = object(raw, ["node", "core"]);
    if (Object.keys(value).length !== 1) throw new TypeError("Graph endpoint needs exactly one identity");
    const key = typeof value["node"] === "string" ? ids.get(value["node"]) :
      typeof value["core"] === "string" && coreIds.has(value["core"]) ? value["core"] : undefined;
    if (key === undefined) throw new TypeError("Unknown graph endpoint");
    return key;
  };
  const edgeIds = new Set<string>();
  const edges = model["edges"].map((raw): GraphEdge => {
    const edge = object(raw, ["id", "source", "target", "type", "label", "color", "style"]), id = identifier(edge["id"]);
    const key = addonGraphKey(active, "edge", id);
    if (edgeIds.has(id) || base.edges.some(item => item.key === key)) throw new TypeError("Duplicate graph edge");
    edgeIds.add(id);
    const type = boundedText(edge["type"], 100, true), style = edge["style"] ?? "solid";
    if (style !== "solid" && style !== "dashed" && style !== "dotted") throw new TypeError("Invalid graph edge style");
    return { key, source: endpoint(edge["source"]), target: endpoint(edge["target"]), type: addonGraphKey(active, "type", type),
      typeLabel: type, label: boundedText(edge["label"], 200), color: color(edge["color"]), style, width: 1.5 };
  });
  return { graph: { nodes, edges }, positions };
}

/** The canvas owns cancellation and the deadline even when a trusted provider ignores its signal. */
export async function loadAddonGraphs(providers: readonly ActiveBrowserContribution[], base: CampaignGraph, view: GraphSelection,
  routes: readonly ActiveBrowserContribution[], signal: AbortSignal, timeoutMs = 10_000): Promise<readonly AddonGraphResult[]> {
  // Aggregate graph work is bounded as well as each individual response.
  return Promise.all(providers.map(async (active, index): Promise<AddonGraphResult> => {
    const request = graphModelRequest(base, view, active.permissions);
    if (index >= 8 || active.binding.kind !== "model-provider" || !validConfig(active, isCoreGraph(view) ? view : undefined)) return { active };
    const deadline = new AbortController(), combined = AbortSignal.any([signal, active.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    let cancelled: (() => void) | undefined;
    try {
      combined.throwIfAborted();
      const aborted = new Promise<never>((_resolve, reject) => {
        cancelled = () => reject(new DOMException("Graph request cancelled", "AbortError"));
        combined.addEventListener("abort", cancelled, { once: true });
      });
      const value = await Promise.race([aborted, active.binding.provide(structuredClone(request), { signal: combined })]);
      combined.throwIfAborted();
      return { active, model: parseAddonGraphModel(value, active, base, request, routes) };
    } catch { return { active }; }
    finally { clearTimeout(timer); if (cancelled) combined.removeEventListener("abort", cancelled); }
  }));
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError("Unexpected graph model fields");
  return value;
}
function boundedText(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || required && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new TypeError("Invalid graph text");
  return value;
}
function identifier(value: unknown): string {
  const id = boundedText(value, 160, true);
  if (!localId.test(id)) throw new TypeError("Invalid graph identity");
  return id;
}
function color(value: unknown): string {
  if (value === undefined) return "#9b7b4b";
  if (typeof value !== "string" || graphColor(value, "") === "") throw new TypeError("Invalid graph color");
  return value;
}
