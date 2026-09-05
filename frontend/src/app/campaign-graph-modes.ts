import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { graphColor, graphSearch, parseGraphPositions, projectRelationshipGraph, type CampaignGraph, type GraphEdge, type GraphNode } from "./campaign-graph.js";
import { recordValue, stringList, text } from "./campaign-projection.js";

export type GraphMode = "factions" | "relationships" | "mysteries";
export const graphModes: readonly GraphMode[] = ["factions", "relationships", "mysteries"];
export const graphNodeKey = (kind: GraphNode["kind"], key: string): string => JSON.stringify([kind, key]);
const firstQuestion = (value: Record<string, unknown>): string => {
  const question: unknown = Array.isArray(value["questions"]) ? value["questions"][0] : undefined;
  return text(isRecord(question) ? question["text"] : question);
};
const card = (kind: GraphNode["kind"], key: string, value: Record<string, unknown>, route: string, nodeColor: string): GraphNode => ({
  kind, key: graphNodeKey(kind, key), legacyKey: kind === "faction" ? `hub_${key}` : key, name: text(value["name"]) || key,
  route: `#/${route}/${encodeURIComponent(key)}`, color: nodeColor, faction: "", factionName: "", badge: "", status: "", statusLabel: "", statusIcon: "", statusColor: "",
  count: 0, commonTypes: "", search: graphSearch([text(value["name"]), text(value["description"]), text(value["priority"]), firstQuestion(value), ...stringList(value["tags"])].join(" ")),
});
const link = (type: string, source: string, target: string, color: string, style: GraphEdge["style"], width: number): GraphEdge => ({
  key: JSON.stringify([type, source, target]), source, target, type, label: "", color, style, width,
});

/** All joins use the role-projected snapshot and collection-qualified identities. */
export function projectCampaignGraph(campaign: CampaignDataset, mode: GraphMode): CampaignGraph {
  const relationships = projectRelationshipGraph(campaign);
  if (mode === "relationships") return relationships;
  const characters = relationships.nodes.map(node => ({ ...node, key: graphNodeKey("character", node.key) }));
  const characterById = new Map(characters.map(node => [node.legacyKey, node]));
  if (mode === "mysteries") {
    const edges: GraphEdge[] = [], involved = new Map<string, GraphNode>();
    const mysteries = campaignCollection(campaign, "mysteries").records.map(record => {
      const value = recordValue(record), hint = firstQuestion(value), priority = text(value["priority"]);
      const mystery = { ...card("mystery", record.key, value, "mysteries", "#6A1B9A"), hint, priority,
        priorityColor: priority === "kritická" ? "#C62828" : priority === "vysoká" ? "#E65100" : "#8A5CC8" };
      for (const id of new Set(stringList(value["characters"]))) {
        const character = characterById.get(id); if (!character) continue;
        edges.push(link("mysteryLink", mystery.key, character.key, "#7B2FA0", "dotted", 1.5));
        const previous = involved.get(id);
        involved.set(id, { ...character, count: (previous?.count ?? 0) + 1, hint: previous?.hint ?? (hint || mystery.name) });
      }
      return mystery;
    });
    return { nodes: [...mysteries, ...characters.flatMap(node => involved.get(node.legacyKey) ?? [])], edges };
  }
  const factions = campaignCollection(campaign, "factions").records;
  const factionColors = new Map(factions.map(record => [record.key, graphColor(recordValue(record)["color"], "#444444")]));
  const hubs = factions.filter(record => record.key !== "neutral" && record.key !== "party").map(record => {
    const value = recordValue(record), nodeColor = factionColors.get(record.key)!;
    return { ...card("faction", record.key, value, "factions", nodeColor), faction: record.key, factionName: text(value["name"]) || record.key,
      badge: text(value["badge"]), count: characters.filter(node => node.faction === record.key).length, glow: nodeColor };
  });
  const hubByFaction = new Map(hubs.map(node => [node.faction, node]));
  const locations = new Map(campaignCollection(campaign, "locations").records.map(record => [record.key, recordValue(record)]));
  const usedLocations = new Map<string, GraphNode>(), factionLocations = new Map<string, Set<string>>();
  const commands = relationships.edges.filter(edge => edge.type === "commands");
  const edges = relationships.edges.filter(edge => ["commands", "negotiates", "ally"].includes(edge.type)).map(edge => ({ ...edge,
    key: JSON.stringify(["relationship", edge.key]), source: graphNodeKey("character", edge.source), target: graphNodeKey("character", edge.target) }));
  const records = new Map(campaignCollection(campaign, "characters").records.map(record => [record.key, recordValue(record)]));
  const nodes = characters.map(character => {
    const value = records.get(character.legacyKey)!, hub = hubByFaction.get(character.faction);
    const incoming = commands.filter(edge => edge.target === character.legacyKey);
    if (hub && !incoming.some(edge => characterById.get(edge.source)?.faction === character.faction)) edges.push(link("member", hub.key, character.key, hub.color, "dashed", 1.5));
    const roles = Array.isArray(value["locationRoles"]) ? value["locationRoles"].filter(isRecord).map(role => text(role["locationId"])) : [];
    if (character.faction) for (const id of new Set([text(value["location"]), ...roles])) {
      const location = locations.get(id); if (!location) continue;
      usedLocations.set(id, card("location", id, location, "locations", "#5D7A3A"));
      const ids = factionLocations.get(character.faction) ?? new Set<string>(); ids.add(id); factionLocations.set(character.faction, ids);
    }
    return { ...character, title: typeof value["knowledge"] === "number" && value["knowledge"] >= 2 ? text(value["title"]) : "",
      commandCount: commands.filter(edge => edge.source === character.legacyKey).length,
      commander: characterById.get(incoming[0]?.source ?? "")?.name ?? "", glow: factionColors.get(character.faction) ?? "" };
  });
  for (const [faction, ids] of factionLocations) {
    const hub = hubByFaction.get(faction); if (!hub) continue;
    for (const id of ids) edges.push(link("located_at", hub.key, graphNodeKey("location", id), "#5D7A3A", "dotted", 2));
  }
  return { nodes: [...hubs, ...nodes, ...usedLocations.values()], edges };
}

export function graphPreferenceKeys(mode: GraphMode) {
  const suffix = mode === "factions" ? "frakce" : mode === "mysteries" ? "tajemstvi" : "vztahy";
  return { positions: mode === "relationships" ? `cm_pos_${suffix}` : `cm_pos_v2_${suffix}`, legacyPositions: `cm_pos_${suffix}`,
    filters: `cm_vf_${suffix}`, factions: `cm_filter_${suffix}` };
}

/** Ambiguous v1 IDs cannot identify a card; never copy one position to two records. */
export function migrateGraphPositions(graph: CampaignGraph, legacy: unknown) {
  const positions = parseGraphPositions(legacy), counts = new Map<string, number>();
  for (const node of graph.nodes) counts.set(node.legacyKey, (counts.get(node.legacyKey) ?? 0) + 1);
  return new Map(graph.nodes.flatMap(node => {
    const point = positions.get(node.legacyKey);
    return point && counts.get(node.legacyKey) === 1 ? [[node.key, point] as const] : [];
  }));
}
