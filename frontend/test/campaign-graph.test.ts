import { describe, expect, it } from "vitest";
import type { CampaignDataset, CampaignRecord } from "../src/core/campaign-data.js";
import { emptyGraphFilter, graphEdgeGeometry, graphNeighborhood, graphNodeStates, graphZoomLevels, initialGraphPositions,
  parseGraphFilter, parseGraphPositions, projectRelationshipGraph, stepGraphZoom, wrapGraphLabel } from "../src/app/campaign-graph.js";

const row = (key: string, value: unknown): CampaignRecord => ({ key, value, revision: 1 });
const campaign = (): CampaignDataset => ({ contractVersion: "campaign-data.v1", collections: [
  { name: "characters", shape: "list", materialized: true, revision: 1, records: [row("a", { name: "Ária", knowledge: 4, faction: "party", status: "alive", tags: ["scout"] }),
    row("b", { name: "Bram", knowledge: 2, faction: "watch", status: "dead" }), row("c", { name: "Unknown identity", knowledge: 0 })] },
  { name: "relationships", shape: "list", materialized: true, revision: 1, records: [row("canonical-1", { source: "a", target: "b", type: "ally" }),
    row("canonical-2", { source: "a", target: "b", type: "commands", label: "Captain" }), row("canonical-3", { source: "b", target: "c", type: "ally" }),
    row("dangling", { source: "a", target: "hidden", type: "enemy" }), row("place", { source: "a", target: "b", type: "lives_at" })] },
  { name: "settings", shape: "keyed", materialized: true, revision: 1, records: [row("playerParty", { name: "The Wayfarers", badge: "☀", color: "#123456" }),
    row("relationshipTypes", [{ id: "ally", label: "Ally", color: "#448844", style: "dashed" }, { id: "commands", label: "Commands", color: "bad;url(test)", style: "evil" },
      { id: "lives_at", label: "Lives at", target: "location" }]), row("characterStatuses", [{ id: "alive", label: "Alive", icon: "●", color: "#4a4" }])] },
  { name: "factions", shape: "keyed", materialized: true, revision: 1, records: [row("watch", { name: "City Watch", badge: "♜", color: "#445566" })] },
] });

describe("relationship graph projection and local arrangement", () => {
  it("keeps canonical edge keys, current-role endpoints and safe authored styles", () => {
    const data = campaign(), before = structuredClone(data), graph = projectRelationshipGraph(data);
    expect(graph.edges.map(edge => edge.key)).toEqual(["canonical-1", "canonical-2", "canonical-3"]);
    expect(graph.edges[0]).toMatchObject({ color: "#448844", style: "dashed", width: 1 });
    expect(graph.edges[1]).toMatchObject({ label: "Captain", color: "#666666", style: "solid", width: 3 });
    expect(graph.nodes[0]).toMatchObject({ name: "Ária", factionName: "The Wayfarers", badge: "☀", color: "#123456", count: 2, statusLabel: "Alive" });
    expect(graph.nodes[1]).toMatchObject({ color: "#666666", count: 3 }); expect(graph.nodes[2]?.name).toBe("Unknown character");
    expect(data).toEqual(before);
  });
  it("keeps encoded detail identities and does not include absent private records", () => {
    const data = campaign(), characters = data.collections[0]!;
    const projected = projectRelationshipGraph({ ...data, collections: [{ ...characters, records: [row("key/with ?#", { name: "Visible", knowledge: 4 })] }, ...data.collections.slice(1)] });
    expect(projected.nodes[0]?.route).toBe("#/characters/key%2Fwith%20%3F%23"); expect(projected.edges).toEqual([]);
  });
  it("retains valid legacy centers and ignores malformed or extreme coordinates", () => {
    const saved = parseGraphPositions({ a: { x: -42.5, y: 100 }, b: { x: "100", y: 0 }, c: { x: Infinity, y: 2 }, d: { x: 1e20, y: 0 }, e: null });
    expect([...saved]).toEqual([["a", { x: -42.5, y: 100 }]]); expect(parseGraphPositions([]).size).toBe(0);
    const graph = projectRelationshipGraph(campaign()), first = initialGraphPositions(graph, saved), second = initialGraphPositions(graph, saved);
    expect(first.get("a")).toEqual(saved.get("a")); expect(first).toEqual(second); expect(saved.size).toBe(1);
    expect([...first.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });
  it("keeps valid filter preferences while bounding malformed values", () => {
    expect(parseGraphFilter(null)).toEqual(emptyGraphFilter());
    expect(parseGraphFilter({ values: [42, "scout"], hiddenEdgeTypes: ["enemy", null], focusMode: true, focusHops: 900 })).toEqual({ values: ["scout"], hiddenEdgeTypes: ["enemy"], focusMode: true, focusHops: 4 });
    expect(parseGraphFilter({ search: "old query" }).values).toEqual(["old query"]);
  });
  it("ANDs accent-insensitive chips, separates dimming from faction hiding and bounds focus depth", () => {
    const graph = projectRelationshipGraph(campaign());
    const states = graphNodeStates(graph, { ...emptyGraphFilter(), values: ["aria", "scout"] }, new Set(["watch"]));
    expect(states.get("a")).toEqual({ dim: false, hidden: false }); expect(states.get("b")).toEqual({ dim: true, hidden: true });
    expect([...graphNeighborhood(graph, "a", 1)]).toEqual(["a", "b"]); expect(graphNeighborhood(graph, "a", 2).has("c")).toBe(true);
    expect(graphNodeStates(graph, { ...emptyGraphFilter(), focusMode: true, focusHops: 1 }, new Set(), "a").get("c")?.dim).toBe(true);
  });
  it("keeps zoom on the original ladder and visits exactly 100 percent", () => {
    let zoom = .25; const levels = [zoom];
    while (zoom < 2) { zoom = stepGraphZoom(zoom, 1); levels.push(zoom); }
    expect(levels).toEqual(graphZoomLevels); expect(stepGraphZoom(2, 1)).toBe(2); expect(stepGraphZoom(.25, -1)).toBe(.25);
    expect(stepGraphZoom(.9, 1)).toBe(1); expect(stepGraphZoom(1.1, -1)).toBe(1);
  });
  it("clips edges to card borders, separates parallel links and renders self loops", () => {
    const a = { x: 0, y: 0, width: 168, height: 120 }, b = { ...a, x: 400 };
    const line = graphEdgeGeometry(a, b, 0);
    expect(Number(line.path.split(" ")[1])).toBeCloseTo(88); expect(line.path).toMatch(/0 Q 200 0 312 0$/u); expect(line.label).toEqual({ x: 200, y: 0 });
    expect(graphEdgeGeometry(a, b, 75).label.y).toBeGreaterThan(0);
    expect(graphEdgeGeometry(a, b, -75).label.y).toBeLessThan(0);
    expect(graphEdgeGeometry(a, a, 0).path).toContain(" C ");
    expect(graphEdgeGeometry(a, a, 0).path).not.toMatch(/NaN|Infinity/);
  });
  it("wraps full edge labels by measured width without losing long words or Unicode", () => {
    const measure = (value: string) => [...value].length;
    expect(wrapGraphLabel("An old alliance", 8, measure)).toEqual(["An old", "alliance"]);
    const label = "secret🙂agreement";
    const lines = wrapGraphLabel(label, 5, measure);
    expect(lines.join("")).toBe(label); expect(lines.every(line => measure(line) <= 5)).toBe(true);
  });
});
