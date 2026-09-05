import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { campaignPartyIdentity } from "./campaign-party.js";
import { recordValue, stringList, text } from "./campaign-projection.js";

export interface GraphPoint { readonly x: number; readonly y: number }
export interface GraphNode {
  readonly key: string; readonly name: string; readonly route: string;
  readonly faction: string; readonly factionName: string; readonly badge: string; readonly color: string;
  readonly status: string; readonly statusLabel: string; readonly statusIcon: string; readonly statusColor: string;
  readonly count: number; readonly commonTypes: string; readonly search: string;
}
export interface GraphEdge {
  readonly key: string; readonly source: string; readonly target: string; readonly type: string;
  readonly label: string; readonly color: string; readonly style: "solid" | "dashed" | "dotted"; readonly width: number;
}
export interface CampaignGraph { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }
export interface GraphFilter {
  readonly values: readonly string[]; readonly hiddenEdgeTypes: readonly string[];
  readonly focusMode: boolean; readonly focusHops: number;
}
export const graphZoomLevels = [.25, .35, .45, .55, .6, .7, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const emptyGraphFilter = (): GraphFilter => ({ values: [], hiddenEdgeTypes: [], focusMode: false, focusHops: 2 });
export const graphSearch = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
const graphColor = (value: unknown, fallback: string): string => typeof value === "string" && /^#(?:[a-f0-9]{3}|[a-f0-9]{6}|[a-f0-9]{8})$/iu.test(value) ? value : fallback;

/** Consumes only the host's current role projection; no independent data or authority cache. */
export function projectRelationshipGraph(campaign: CampaignDataset): CampaignGraph {
  const definitions = (key: string) => {
    const value = campaignCollection(campaign, "settings").records.find(record => record.key === key)?.value;
    return new Map((Array.isArray(value) ? value : []).filter(isRecord).flatMap(item => typeof item["id"] === "string" ? [[item["id"], item] as const] : []));
  };
  const types = definitions("relationshipTypes"), statuses = definitions("characterStatuses");
  const characters = campaignCollection(campaign, "characters").records, visible = new Set(characters.map(record => record.key));
  const edges = campaignCollection(campaign, "relationships").records.flatMap(record => {
    const value = recordValue(record), source = text(value["source"]), target = text(value["target"]), type = text(value["type"]), definition = types.get(type);
    // This view contains character nodes. A location target with the same key
    // as a character must not become a false character-to-character edge.
    if (!visible.has(source) || !visible.has(target) || definition?.["target"] === "location") return [];
    const rawStyle = definition?.["style"], style = rawStyle === "dashed" || rawStyle === "dotted" ? rawStyle : "solid";
    return [{ key: record.key, source, target, type, label: text(value["label"]) || text(definition?.["label"]) || type,
      color: graphColor(definition?.["color"], "#666666"), style, width: type === "commands" ? 3 : style !== "solid" && type !== "negotiates" ? 1 : 2 } satisfies GraphEdge];
  });
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of edges) for (const key of new Set([edge.source, edge.target])) { const list = adjacency.get(key) ?? []; list.push(edge); adjacency.set(key, list); }
  const factions = new Map(campaignCollection(campaign, "factions").records.map(record => [record.key, recordValue(record)]));
  const party = campaignPartyIdentity(campaign);
  const nodes = characters.map(record => {
    const value = recordValue(record), faction = text(value["faction"]), factionValue = factions.get(faction);
    const factionName = faction === "party" ? party.name : text(factionValue?.["name"]) || faction;
    const status = text(value["status"]), statusValue = statuses.get(status), statusLabel = text(statusValue?.["label"]) || status;
    const connected = adjacency.get(record.key) ?? [], counts = new Map<string, number>();
    for (const edge of connected) counts.set(edge.type, (counts.get(edge.type) ?? 0) + 1);
    return { key: record.key, name: typeof value["knowledge"] === "number" && value["knowledge"] >= 1 ? text(value["name"]) || record.key : "???",
      route: `#/characters/${encodeURIComponent(record.key)}`, faction, factionName,
      badge: faction === "party" ? party.badge : text(factionValue?.["badge"]),
      color: status === "dead" ? "#666666" : faction === "party" ? party.color : graphColor(factionValue?.["color"], "#444444"),
      status, statusLabel, statusIcon: text(statusValue?.["icon"]) || "?", statusColor: graphColor(statusValue?.["color"], "#888888"),
      count: connected.length, commonTypes: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([type, count]) => `${text(types.get(type)?.["label"]) || type}×${count}`).join(", "),
      search: graphSearch([text(value["name"]), text(value["title"]), text(value["species"]), text(value["gender"]),
        typeof value["age"] === "number" ? String(value["age"]) : text(value["age"]), statusLabel, factionName, ...stringList(value["tags"])].join(" ")) } satisfies GraphNode;
  });
  return { nodes, edges };
}

export function parseGraphPositions(value: unknown): ReadonlyMap<string, GraphPoint> {
  if (!isRecord(value)) return new Map();
  return new Map(Object.entries(value).slice(0, 20_000).flatMap(([key, point]) => isRecord(point) && validCoordinate(point["x"]) && validCoordinate(point["y"])
    ? [[key, { x: point["x"] as number, y: point["y"] as number }] as const] : []));
}
export const validCoordinate = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
export function parseGraphFilter(value: unknown): GraphFilter {
  if (!isRecord(value)) return emptyGraphFilter();
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= 200).slice(0, 128) : [];
  return { values: strings(value["values"] ?? (typeof value["search"] === "string" ? [value["search"]] : [])), hiddenEdgeTypes: strings(value["hiddenEdgeTypes"]),
    focusMode: value["focusMode"] === true, focusHops: typeof value["focusHops"] === "number" && Number.isInteger(value["focusHops"]) ? Math.max(1, Math.min(4, value["focusHops"])) : 2 };
}
export function graphNeighborhood(graph: CampaignGraph, key: string, hops: number): ReadonlySet<string> {
  const adjacent = new Map<string, Set<string>>();
  for (const edge of graph.edges) for (const [from, to] of [[edge.source, edge.target], [edge.target, edge.source]]) {
    if (from === undefined || to === undefined) continue;
    const neighbors = adjacent.get(from) ?? new Set(); neighbors.add(to); adjacent.set(from, neighbors);
  }
  const reached = new Set([key]); let frontier = [key];
  for (let step = 0; step < Math.max(1, Math.min(4, hops)); step++) {
    const next: string[] = [];
    for (const from of frontier) for (const to of adjacent.get(from) ?? []) if (!reached.has(to)) { reached.add(to); next.push(to); }
    frontier = next;
  }
  return reached;
}
export function graphNodeStates(graph: CampaignGraph, filter: GraphFilter, hiddenFactions: ReadonlySet<string>, focusId?: string) {
  const neighborhood = filter.focusMode && focusId ? graphNeighborhood(graph, focusId, filter.focusHops) : undefined;
  const queries = filter.values.map(graphSearch).filter(Boolean);
  return new Map(graph.nodes.map(node => [node.key, { hidden: hiddenFactions.has(node.faction), dim: queries.some(query => !node.search.includes(query)) || neighborhood !== undefined && !neighborhood.has(node.key) }]));
}

/** Deterministic starting positions; existing browser arrangements always win. */
export function initialGraphPositions(graph: CampaignGraph, saved: ReadonlyMap<string, GraphPoint>): ReadonlyMap<string, GraphPoint> {
  const result = new Map(saved), columns = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
  graph.nodes.forEach((node, index) => { if (!result.has(node.key)) result.set(node.key, { x: (index % columns) * 290, y: Math.floor(index / columns) * 230 }); });
  // Relax only new nodes, with bounded work for unusually large campaigns.
  const iterations = graph.nodes.length <= 200 && graph.nodes.some(node => !saved.has(node.key)) ? 100 : 0;
  for (let step = 0; step < iterations; step++) {
    const forces = new Map(graph.nodes.map(node => [node.key, { x: 0, y: 0 }]));
    for (let i = 0; i < graph.nodes.length; i++) for (let j = i + 1; j < graph.nodes.length; j++) {
      const a = graph.nodes[i]!.key, b = graph.nodes[j]!.key, p = result.get(a)!, q = result.get(b)!;
      const dx = q.x - p.x || .01, dy = q.y - p.y || .01, distance = Math.max(1, Math.hypot(dx, dy)), force = 11000 / (distance * distance);
      forces.get(a)!.x -= dx / distance * force; forces.get(a)!.y -= dy / distance * force;
      forces.get(b)!.x += dx / distance * force; forces.get(b)!.y += dy / distance * force;
    }
    for (const edge of graph.edges) {
      const p = result.get(edge.source)!, q = result.get(edge.target)!, dx = q.x - p.x, dy = q.y - p.y, distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 300) * .02;
      forces.get(edge.source)!.x += dx / distance * force; forces.get(edge.source)!.y += dy / distance * force;
      forces.get(edge.target)!.x -= dx / distance * force; forces.get(edge.target)!.y -= dy / distance * force;
    }
    for (const node of graph.nodes) if (!saved.has(node.key)) { const p = result.get(node.key)!, f = forces.get(node.key)!; result.set(node.key, { x: p.x + Math.max(-8, Math.min(8, f.x)), y: p.y + Math.max(-8, Math.min(8, f.y)) }); }
  }
  return result;
}
export function stepGraphZoom(current: number, direction: number): number {
  const index = graphZoomLevels.reduce((best, level, i) => Math.abs(level - current) < Math.abs(graphZoomLevels[best]! - current) ? i : best, 0);
  return graphZoomLevels[Math.max(0, Math.min(graphZoomLevels.length - 1, index + Math.sign(direction)))]!;
}

export interface GraphBox extends GraphPoint { readonly width: number; readonly height: number }
export function wrapGraphLabel(label: string, width: number, measure: (value: string) => number): readonly string[] {
  const lines: string[] = []; let line = "";
  for (const word of label.trim().split(/\s+/u)) {
    const combined = line ? `${line} ${word}` : word;
    if (measure(combined) <= width) { line = combined; continue; }
    if (line) { lines.push(line); line = ""; }
    for (const character of word) {
      if (line && measure(line + character) > width) { lines.push(line); line = ""; }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}
export function graphEdgeGeometry(a: GraphBox, b: GraphBox, offset: number) {
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.max(1, Math.hypot(dx, dy));
  const control = { x: (a.x + b.x) / 2 - dy / length * offset, y: (a.y + b.y) / 2 + dx / length * offset };
  const intersect = (box: GraphBox, toward: GraphPoint) => {
    const x = toward.x - box.x, y = toward.y - box.y, fraction = 1 / Math.max(Math.abs(x) / (box.width / 2 + 4), Math.abs(y) / (box.height / 2 + 4), .001);
    return { x: box.x + x * fraction, y: box.y + y * fraction };
  };
  if (length < 1.01) {
    const x = a.x + a.width / 2, y = a.y, reach = 55 + Math.abs(offset);
    return { path: `M ${x} ${y - 16} C ${x + reach * 2} ${y - reach}, ${x + reach * 2} ${y + reach}, ${x} ${y + 16}`, label: { x: x + reach * 1.5, y }, length: reach * 2 };
  }
  const start = intersect(a, control), end = intersect(b, control);
  return { path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    label: { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 }, length: Math.hypot(end.x - start.x, end.y - start.y) };
}
