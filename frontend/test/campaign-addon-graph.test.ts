import { describe, expect, it, vi } from "vitest";
import type { ActiveBrowserContribution } from "../src/addons/browser-sdk.js";
import { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import { GenerationScope } from "../src/addons/generation-scope.js";
import { addonGraphId, addonGraphHash, addonGraphKey, graphModelRequest, graphProviders, graphViews, loadAddonGraphs, parseAddonGraphModel } from "../src/app/campaign-addon-graph.js";
import { graphPreferenceKeys } from "../src/app/campaign-graph-modes.js";
import { parseAppRoute } from "../src/app/routes.js";
import type { CampaignGraph, GraphNode } from "../src/app/campaign-graph.js";

const core = { key: "captain", legacyKey: "captain", kind: "character", name: "Hidden from the provider request", search: "Private body" } as GraphNode;
const permissions = [{ id: "core.data.read", resources: ["characters"] }];
const base: CampaignGraph = { nodes: [core], edges: [] };
const active = (provide: (request: unknown, context: { signal: AbortSignal }) => unknown = () => model()): ActiveBrowserContribution => ({
  permissions, addonId: "graph-example", generationId: "a".repeat(64), signal: new AbortController().signal,
  descriptor: { id: "notes", surface: "graph-contributor", label: "Notes", roles: ["dm"], requires: ["ui.contributions"], order: 1,
    config: { contractVersion: 1, view: "relationships" } }, binding: { kind: "model-provider", provide },
});
const model = () => ({ contractVersion: 1,
  nodes: [{ id: "note", label: "A note", summary: "An accessible summary", position: { x: 10, y: 20 } }],
  edges: [{ id: "link", source: { node: "note" }, target: { core: "captain" }, type: "Clue", label: "Related" }],
});
const parse = (value: unknown, owner = active()) => parseAddonGraphModel(value, owner, base, graphModelRequest(base, "relationships", permissions), []);

describe("campaign add-on graphs", () => {
  it("namespaces nodes, edges and filter types without exposing record bodies", () => {
    expect(graphModelRequest(base, "relationships").coreNodes).toEqual([]);
    const factions = { nodes: [{ ...core, kind: "faction" as const, recordKey: "watch", legacyKey: "hub_watch" }], edges: [] };
    expect(graphModelRequest(factions, "factions", permissions).coreNodes).toEqual([]);
    expect(graphModelRequest(factions, "factions", [{ id: "core.data.read", resources: ["factions"] }]).coreNodes[0]!.key).toBe("watch");
    const request = graphModelRequest(base, "relationships", permissions);
    expect(request).toEqual({ contractVersion: 1, viewId: "relationships", coreNodes: [{ id: "captain", kind: "character", key: "captain" }] });
    const result = parse(model());
    expect(result.graph.nodes[0]).toMatchObject({ kind: "addon", name: "A note", hint: "An accessible summary", route: "" });
    expect(result.graph.edges[0]).toMatchObject({ source: addonGraphKey(active(), "node", "note"), target: "captain", typeLabel: "Clue" });
    expect(result.positions.get(result.graph.nodes[0]!.key)).toEqual({ x: 10, y: 20 });
    expect(parse(model(), { ...active(), addonId: "other" }).graph.nodes[0]!.key).not.toBe(result.graph.nodes[0]!.key);
  });
  it("rejects entire models containing unknown endpoints, duplicate IDs or executable presentation", () => {
    const mutations = [
      (value: any) => { value.nodes.push({ ...value.nodes[0] }); },
      (value: any) => { value.edges.push({ ...value.edges[0] }); },
      (value: any) => { value.edges[0].target = { core: "secret" }; },
      (value: any) => { value.edges[0].target = { core: "captain", node: "note" }; },
      (value: any) => { value.nodes[0].html = "<script>"; },
      (value: any) => { value.nodes[0].color = "url(https://example.com)"; },
      (value: any) => { value.nodes[0].position.x = Infinity; },
      (value: any) => { value.nodes[0].detail = { route: "unknown" }; },
      (value: any) => { value.contractVersion = 2; },
      (value: any) => { value.nodes[0].summary = "x".repeat(48_001); },
      (value: any) => { value.edges[0].style = "unknown"; },
    ];
    for (const mutate of mutations) { const value = model(); mutate(value); expect(() => parse(value)).toThrow(); }
    const collision = { nodes: [core, { ...core, key: addonGraphKey(active(), "node", "note") }], edges: [] };
    expect(() => parseAddonGraphModel(model(), active(), collision, graphModelRequest(base, "relationships", permissions), [])).toThrow();
  });
  it("links only to this provider generation's active, role-visible routes", () => {
    const route: ActiveBrowserContribution = { ...active(), descriptor: { ...active().descriptor, id: "detail", surface: "route", config: { path: "notes" } }, binding: { kind: "element", tag: "example-notes" } };
    const value = model(); Object.assign(value.nodes[0]!, { detail: { route: "detail" } });
    const parseWith = (routes: ActiveBrowserContribution[]) => parseAddonGraphModel(value, active(), base, graphModelRequest(base, "relationships", permissions), routes);
    expect(parseWith([route]).graph.nodes[0]!.route).toBe("#/addons/graph-example/notes");
    expect(() => parseWith([{ ...route, generationId: "b".repeat(64) }])).toThrow();
    expect(() => parseWith([{ ...route, addonId: "other" }])).toThrow();
  });
  it("bounds references and independent providers without passing mutable shared requests", async () => {
    expect(graphModelRequest({ nodes: Array.from({ length: 2000 }, (_, i) => ({ ...core, key: String(i) })), edges: [] }, "relationships", permissions).coreNodes.length).toBeLessThanOrEqual(512);
    const long = graphModelRequest({ nodes: Array.from({ length: 200 }, () => ({ ...core, key: "é".repeat(500) })), edges: [] }, "relationships", permissions);
    expect(new TextEncoder().encode(JSON.stringify(long)).length).toBeLessThan(25_000);
    const spy = vi.fn(() => model()), mutator = active(request => { (request as any).coreNodes.length = 0; return model(); });
    const results = await loadAddonGraphs([mutator, ...Array.from({ length: 9 }, () => active(spy))], base, "relationships", [], new AbortController().signal);
    expect(spy).toHaveBeenCalledTimes(7); expect(results.filter(result => result.model)).toHaveLength(8);
    expect(spy.mock.calls[0]).toBeDefined();
  });
  it("cancels pending work and rejects late successes after a deadline or generation shutdown", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: unknown) => void, invocation!: AbortSignal;
      const owner = active((_request, context) => { invocation = context.signal; return new Promise(resolve => { finish = resolve; }); });
      const task = loadAddonGraphs([owner, active()], base, "relationships", [], new AbortController().signal, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(invocation.aborted).toBe(true); expect((await task).map(result => Boolean(result.model))).toEqual([false, true]);
      finish(model()); await Promise.resolve(); expect((await task)[0]!.model).toBeUndefined();
      const scope = new AbortController();
      const pending = loadAddonGraphs([{ ...owner, signal: scope.signal }], base, "relationships", [], new AbortController().signal);
      scope.abort(); expect((await pending)[0]!.model).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
      const navigation = new AbortController();
      const ignored = loadAddonGraphs([owner], base, "relationships", [], navigation.signal);
      navigation.abort(); expect((await ignored)[0]!.model).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("selects active providers by role and view and removes them with their session", () => {
    const registry = new BrowserContributionRegistry(), scope = new GenerationScope("test");
    const view = { ...active().descriptor, id: "board", surface: "graph-view" as const, config: { contractVersion: 1 } };
    const session = registry.open({ addonId: "graph-example", addonVersion: "1.0.0", generationId: active().generationId, mode: "integrated",
      entryUrl: "/index.js", styleUrls: [], sandbox: [], dependencies: [], capabilities: ["ui.contributions"], permissions: [], contributions: [active().descriptor, view] }, scope);
    session.context.ui.bind("notes", active().binding as any); session.context.ui.bind("board", active().binding as any);
    expect(graphProviders(registry, "player", "relationships")).toHaveLength(0);
    expect(graphProviders(registry, "dm", "factions")).toHaveLength(0);
    expect(graphProviders(registry, "dm", "relationships")).toHaveLength(1);
    const selected = graphViews(registry, "dm")[0]!;
    expect(parseAppRoute(addonGraphHash(addonGraphId(selected)))).toEqual({ kind: "campaign-graph", mode: "addon:graph-example:board" });
    expect(graphPreferenceKeys(addonGraphId(selected)).positions).not.toBe(graphPreferenceKeys("relationships").positions);
    session.dispose(); expect(graphViews(registry, "dm")).toHaveLength(0);
  });
});
