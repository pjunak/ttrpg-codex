import { describe, expect, it } from "vitest";
import type { CampaignCollectionName, CampaignDataset, CampaignRecord } from "../src/core/campaign-data.js";
import { emptyGraphFilter, graphEdgeGeometry, graphNodeStates, initialGraphPositions } from "../src/app/campaign-graph.js";
import { graphNodeKey as key, graphPreferenceKeys, migrateGraphPositions, projectCampaignGraph } from "../src/app/campaign-graph-modes.js";

const row = (key: string, value: unknown): CampaignRecord => ({ key, value, revision: 1 });
function dataset(extra: Partial<Record<CampaignCollectionName, CampaignRecord[]>> = {}): CampaignDataset {
  const records: Partial<Record<CampaignCollectionName, CampaignRecord[]>> = {
    settings: [],
    characters: [row("captain", { name: "Captain", faction: "watch", knowledge: 4, title: "Commander", location: "gate", locationRoles: [{ locationId: "gate" }, { locationId: "outpost" }] }),
      row("scout", { name: "Scout", faction: "watch", knowledge: 1, title: "Hidden title", location: "gate" }),
      row("outsider", { name: "Stranger", faction: "guild", knowledge: 0, location: "gate" }), row("party", { name: "Player", faction: "party", knowledge: 4 }),
      row("neutral", { name: "Traveler", faction: "neutral", knowledge: 4 })],
    factions: [row("watch", { name: "The Watch", color: "#886633", badge: "♜" }), row("guild", { name: "Guild", color: "#225588" }), row("neutral", { name: "Neutral" })],
    locations: [row("gate", { name: "Gate" }), row("outpost", { name: "Outpost" }), row("unused", { name: "Unused" })],
    relationships: [row("command", { source: "captain", target: "scout", type: "commands" }), row("ally", { source: "scout", target: "outsider", type: "ally" }),
      row("excluded", { source: "outsider", target: "party", type: "enemy" }), row("hidden-endpoint", { source: "secret", target: "captain", type: "commands" })],
    mysteries: [row("gate", { name: "Disappearance", priority: "kritická", characters: ["captain", "captain", "outsider", "secret"], questions: [{ text: "Who opened the gate?", answer: "An answer is not a preview" }] }),
      row("empty", { name: "Unresolved", characters: ["secret"] }), row("second", { name: "Tracks", characters: ["captain"], questions: ["Where do they lead?"] })],
  };
  for (const name of Object.keys(extra) as CampaignCollectionName[]) records[name] = [...(records[name] ?? []), ...extra[name]!];
  return { contractVersion: "campaign-data.v1", collections: Object.entries(records).map(([name, records]) => ({ name: name as CampaignCollectionName,
    shape: name === "factions" ? "keyed" : "list", materialized: true, revision: 1, records })) };
}
describe("faction and mystery graph modes", () => {
  it("restores faction hubs, command roots and deduplicated member locations", () => {
    const data = dataset(), before = structuredClone(data), graph = projectCampaignGraph(data, "factions");
    expect(graph.nodes.filter(node => node.kind === "faction").map(node => node.legacyKey)).toEqual(["hub_watch", "hub_guild"]);
    expect(graph.nodes.find(node => node.key === key("faction", "watch"))).toMatchObject({ count: 2, color: "#886633", glow: "#886633" });
    expect(graph.nodes.find(node => node.key === key("character", "captain"))).toMatchObject({ title: "Commander", commandCount: 1, commander: "" });
    expect(graph.nodes.find(node => node.key === key("character", "scout"))).toMatchObject({ title: "", commander: "Captain" });
    expect(graph.edges.filter(edge => edge.type === "member").map(edge => edge.target)).toEqual([key("character", "captain"), key("character", "outsider")]);
    expect(graph.edges.filter(edge => edge.type === "located_at")).toHaveLength(3);
    expect(graph.nodes.filter(node => node.kind === "location").map(node => node.legacyKey)).toEqual(["gate", "outpost"]);
    expect(graph.edges.some(edge => edge.type === "enemy")).toBe(false); expect(JSON.stringify(graph)).not.toContain("secret"); expect(data).toEqual(before);
  });
  it("uses only involved visible characters, preserves question shapes and avoids identity collisions", () => {
    const data = dataset({ characters: [row("gate", { name: "Gatekeeper", knowledge: 4 })], mysteries: [row("collision", { name: "Collision", characters: ["gate"] })] });
    const graph = projectCampaignGraph(data, "mysteries");
    expect(new Set(graph.nodes.map(node => node.key)).size).toBe(graph.nodes.length);
    expect(graph.nodes.find(node => node.key === key("character", "captain"))).toMatchObject({ count: 2, hint: "Who opened the gate?" });
    expect(graph.nodes.find(node => node.key === key("mystery", "gate"))).toMatchObject({ hint: "Who opened the gate?", priorityColor: "#C62828" });
    expect(graph.nodes.find(node => node.key === key("character", "gate"))?.route).toBe("#/characters/gate");
    expect(graph.nodes.find(node => node.key === key("mystery", "gate"))?.route).toBe("#/mysteries/gate");
    expect(graph.edges).toHaveLength(4); expect(graph.nodes.some(node => node.legacyKey === "scout")).toBe(false);
    expect(JSON.stringify(graph)).not.toMatch(/secret|An answer is not a preview|\[object Object\]/);
  });
  it("keeps shared places and mysteries visible until all linked factions are hidden", () => {
    const factions = projectCampaignGraph(dataset(), "factions"), mysteries = projectCampaignGraph(dataset(), "mysteries");
    const watchHidden = graphNodeStates(factions, emptyGraphFilter(), new Set(["watch"]));
    expect(watchHidden.get(key("location", "gate"))?.hidden).toBe(false); expect(watchHidden.get(key("location", "outpost"))?.hidden).toBe(true);
    expect(watchHidden.get(key("character", "scout"))?.hidden).toBe(true);
    const bothHidden = graphNodeStates(mysteries, emptyGraphFilter(), new Set(["watch", "guild"]));
    expect(bothHidden.get(key("mystery", "gate"))?.hidden).toBe(true);
    expect(bothHidden.get(key("mystery", "empty"))?.hidden).toBe(false);
    expect(graphNodeStates(mysteries, emptyGraphFilter(), new Set(["watch"])).get(key("mystery", "gate"))?.hidden).toBe(false);
  });
  it("migrates only unambiguous old coordinates and separates all mode preferences", () => {
    const data = dataset({ characters: [row("hub_watch", { name: "Same ID", knowledge: 4 })] });
    const graph = projectCampaignGraph(data, "factions"), legacy = { hub_watch: { x: 12, y: 34 }, captain: { x: -50, y: 20 }, gate: { x: 250, y: 0 } };
    const migrated = migrateGraphPositions(graph, legacy);
    expect(migrated.has(key("faction", "watch"))).toBe(false); expect(migrated.has(key("character", "hub_watch"))).toBe(false);
    expect(migrated.get(key("character", "captain"))).toEqual(legacy.captain); expect(migrated.get(key("location", "gate"))).toEqual(legacy.gate);
    expect(initialGraphPositions(graph, migrated).get(key("character", "captain"))).toEqual(legacy.captain);
    expect(new Set(["factions", "relationships", "mysteries"].flatMap(mode => {
      const keys = graphPreferenceKeys(mode as "factions" | "relationships" | "mysteries"); return [keys.positions, keys.filters, keys.factions];
    })).size).toBe(9);
    expect(graphPreferenceKeys("relationships").positions).toBe("cm_pos_vztahy");
  });
  it("clips faction connections to their rounded pill border", () => {
    const a = { x: 0, y: 0, width: 210, height: 80, pill: true }, b = { x: 400, y: 240, width: 168, height: 120 };
    const path = graphEdgeGeometry(a, b, 0).path.split(" "), x = Number(path[1]), y = Number(path[2]);
    expect(Math.hypot(Math.max(0, x - 65), y)).toBeCloseTo(44);
    expect(y / x).toBeCloseTo(.6);
    const narrow = graphEdgeGeometry({ ...a, width: 52, height: 80 }, b, 0).path.split(" ");
    expect(Math.hypot(Number(narrow[1]), Math.max(0, Number(narrow[2]) - 14))).toBeCloseTo(30);
  });
});
