import { describe, expect, it } from "vitest";
import { GraphMotion } from "../src/app/campaign-graph-motion.js";
import { graphEdgeControl, graphEdgeGeometry, graphEdgeOffsets, type CampaignGraph, type GraphEdge, type GraphNode, type GraphPoint } from "../src/app/campaign-graph.js";

const node = (key: string): GraphNode => ({ key, legacyKey: key, kind: "character", name: key, route: `#/characters/${key}`,
  faction: "", factionName: "", badge: "", color: "#444444", status: "", statusLabel: "", statusIcon: "", statusColor: "#888888", count: 0, commonTypes: "", search: key });
const edge = (key: string, source: string, target: string): GraphEdge => ({ key, source, target, label: "Connection", type: "ally", color: "#666666", style: "solid", width: 2 });
const initial = () => new Map<string, GraphPoint>([["a", { x: 0, y: 0 }], ["b", { x: 420, y: 0 }], ["c", { x: 900, y: 400 }], ["hidden", { x: 30, y: 50 }]]);
const graph: CampaignGraph = { nodes: [node("a"), node("b"), node("c")], edges: [edge("one", "a", "b"), edge("two", "b", "a")] };
const sizes = new Map(graph.nodes.map(node => [node.key, { width: 168, height: 120 }]));

describe("browser-local elastic graph drafts", () => {
  it("lags curved edge controls during a drag and settles to the exact parallel fan", () => {
    const positions = initial(), before = structuredClone(positions), motion = new GraphMotion(graph, positions, sizes, "a");
    const offsets = graphEdgeOffsets(graph.edges), previous = motion.controls.get("one")!;
    motion.move({ x: 0, y: 160 });
    const target = graphEdgeControl(motion.positions.get("a")!, positions.get("b")!, offsets.get("one")!);
    expect(motion.controls.get("one")).toEqual(previous); motion.step();
    expect(motion.controls.get("one")).not.toEqual(target);
    expect(Math.hypot(motion.controls.get("one")!.x - target.x, motion.controls.get("one")!.y - target.y)).toBeGreaterThan(40);
    motion.settle();
    expect(motion.controls.get("one")).toEqual(target);
    expect(motion.controls.get("two")).not.toEqual(target);
    expect(motion.positions.get("a")).toEqual({ x: 0, y: 160 });
    expect(motion.positions.get("b")).toEqual(positions.get("b")); expect(motion.positions.get("c")).toEqual(positions.get("c"));
    expect(positions).toEqual(before);
  });
  it("pushes an overlapping card aside, pins the dropped center and saves no hidden-node movement", () => {
    const positions = initial(), motion = new GraphMotion(graph, positions, sizes, "a");
    motion.move({ x: 330, y: 0 }); motion.step();
    expect(motion.positions.get("b")!.x).toBeGreaterThan(420);
    motion.settle();
    expect(motion.positions.get("a")).toEqual({ x: 330, y: 0 });
    expect(motion.positions.get("b")!.x - 330).toBeGreaterThanOrEqual(196);
    expect(motion.positions.get("hidden")).toEqual(positions.get("hidden"));
    expect(motion.positions.get("c")).toEqual(positions.get("c"));
  });
  it("returns a briefly displaced card to its saved rest when the pointer moves away", () => {
    const positions = initial(), motion = new GraphMotion(graph, positions, sizes, "a");
    motion.move({ x: 330, y: 0 }); for (let i = 0; i < 8; i++) motion.step();
    motion.move({ x: 50, y: 0 }); motion.settle();
    expect(motion.positions.get("b")).toEqual(positions.get("b"));
    expect(motion.positions.get("a")).toEqual({ x: 50, y: 0 });
  });
  it("bounds settling and resolves coincident cards deterministically", () => {
    const positions = initial(); positions.set("b", { x: 0, y: 0 });
    const first = new GraphMotion(graph, positions, sizes, "a"), second = new GraphMotion(graph, positions, sizes, "a");
    first.move({ x: 0, y: 0 }); second.move({ x: 0, y: 0 });
    let steps = 1; while (first.step()) { steps++; expect(steps).toBeLessThanOrEqual(180); }
    second.settle(); expect(first.positions).toEqual(second.positions);
    const b = first.positions.get("b")!;
    expect(Math.abs(b.x) >= 196 || Math.abs(b.y) >= 148).toBe(true);
    expect(first.step()).toBe(false);
  });
  it("ignores invalid pointer coordinates and bounds collision movement at the coordinate limit", () => {
    const positions = initial(); positions.set("a", { x: 9_999_950, y: 0 }); positions.set("b", { x: 9_999_980, y: 0 });
    const motion = new GraphMotion(graph, positions, sizes, "a");
    motion.move({ x: Infinity, y: NaN }); expect(motion.positions.get("a")).toEqual(positions.get("a"));
    motion.move({ x: 10_000_000, y: 0 }); motion.settle();
    expect([...motion.positions.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 10_000_000 && Math.abs(p.y) <= 10_000_000)).toBe(true);
  });
  it("leaves pre-existing overlaps elsewhere in a large saved layout untouched", () => {
    const nodes = Array.from({ length: 1500 }, (_, i) => node(`n${i}`));
    const positions = new Map(nodes.map((node, index) => [node.key, { x: index < 2 ? 500 : index * 220, y: 0 }]));
    const before = structuredClone(positions), motion = new GraphMotion({ nodes, edges: [] }, positions, new Map(), "n1499");
    motion.move({ x: 400_000, y: 200 }); motion.settle();
    expect([...motion.positions].filter(([key]) => key !== "n1499")).toEqual([...before].filter(([key]) => key !== "n1499"));
  });
  it("routes and centers labels through an animated control point without changing edge identities", () => {
    const a = { x: 0, y: 0, width: 168, height: 120 }, b = { ...a, x: 400 };
    const straight = graphEdgeGeometry(a, b, 0), curved = graphEdgeGeometry(a, b, 0, { x: 200, y: -140 });
    expect(curved.path).not.toEqual(straight.path); expect(curved.path).toContain("Q 200 -140"); expect(curved.label.y).toBeLessThan(-60);
    expect(curved.path).not.toMatch(/NaN|Infinity/);
  });
});
