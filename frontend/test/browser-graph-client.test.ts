import { describe, expect, it } from "vitest";
import {
  BrowserGraphClient,
  BrowserGraphHTTPError,
  BrowserGraphRefreshInvalidatedError,
  parseBrowserGenerationSet,
  type BrowserGraphFetch,
} from "../src/addons/browser-graph-client.js";
import type {
  BrowserGenerationDescriptor,
  BrowserGenerationSet,
} from "../src/addons/generation-manager.js";
import { BoundaryValidationError } from "../src/core/boundary.js";

const graphRevision = "a".repeat(64);
const generationId = "b".repeat(64);
const descriptor: BrowserGenerationDescriptor = {
  addonId: "dm-tools",
  addonVersion: "1.0.0",
  generationId,
  mode: "integrated",
  entryUrl: `/api/addons/dm-tools/generations/${generationId}/assets/web/index.js`,
  styleUrls: [`/api/addons/dm-tools/generations/${generationId}/assets/web/index.css`],
  sandbox: [],
  dependencies: [],
  capabilities: ["ui.contributions"],
  permissions: [{ id: "core.data.read", resources: ["characters"] }],
  contributions: [{
    id: "planner.route",
    surface: "route",
    label: "Story Planner",
    roles: ["dm"],
    order: 200,
    requires: ["ui.contributions"],
    config: { path: "planner" },
  }],
};
const graph: BrowserGenerationSet = {
  contractVersion: 2,
  graphRevision,
  addons: [descriptor],
};

describe("parseBrowserGenerationSet", () => {
  it("accepts and copies the exact v2 wire shape", () => {
    const parsed = parseBrowserGenerationSet(graph);

    expect(parsed).toEqual(graph);
    expect(parsed).not.toBe(graph);
    expect(parsed.addons).not.toBe(graph.addons);
  });

  it.each([
    { ...graph, contractVersion: 1 },
    { ...graph, graphRevision: "not-a-digest" },
    { ...graph, unexpected: true },
    { ...graph, addons: "not-an-array" },
    { ...graph, addons: [{ ...graph.addons[0], unexpected: true }] },
    { ...graph, addons: [{ ...graph.addons[0], sandbox: ["same-origin"] }] },
    { ...graph, addons: [{ ...graph.addons[0], dependencies: [1] }] },
    { ...graph, addons: [{ ...graph.addons[0], capabilities: ["invalid"] }] },
    { ...graph, addons: [{ ...graph.addons[0], entryUrl: descriptor.entryUrl.replace(".js", ".html") }] },
    { ...graph, addons: [{ ...graph.addons[0], styleUrls: [descriptor.entryUrl] }] },
    { ...graph, addons: [{ ...graph.addons[0], styleUrls: Array(65).fill(descriptor.styleUrls[0]) }] },
    { ...graph, addons: [{ ...graph.addons[0], permissions: [{ id: "read", resources: [] }] }] },
    {
      ...graph,
      addons: [{
        ...graph.addons[0],
        contributions: [{ ...descriptor.contributions[0], surface: "raw-html" }],
      }],
    },
    {
      ...graph,
      addons: [{
        ...graph.addons[0],
        contributions: [{ ...descriptor.contributions[0], config: { path: "/planner" } }],
      }],
    },
    {
      ...graph,
      addons: [{
        ...graph.addons[0],
        contributions: [{ ...descriptor.contributions[0], config: { path: "planner", href: "https://invalid" } }],
      }],
    },
    {
      ...graph,
      addons: [{
        ...graph.addons[0],
        entryUrl: `/api/addons/other-addon/generations/${generationId}/assets/web/index.js`,
      }],
    },
    {
      ...graph,
      addons: [{
        ...graph.addons[0],
        entryUrl: `/api/addons/dm-tools/generations/${generationId}/assets/web/../worker/addon.js`,
      }],
    },
  ])("rejects malformed or cross-generation input %#", (value) => {
    expect(() => parseBrowserGenerationSet(value)).toThrow(BoundaryValidationError);
  });
});

describe("BrowserGraphClient", () => {
  it("conditionally refreshes and returns the cached graph on 304", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const responses = [jsonGraphResponse(graph), new Response(null, { status: 304 })];
    const fetchGraph: BrowserGraphFetch = async (input, init) => {
      calls.push({ input, init });
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected fetch");
      }
      return response;
    };
    const client = new BrowserGraphClient(fetchGraph);
    const signal = new AbortController().signal;

    const first = await client.refresh(signal);
    const second = await client.refresh(signal);

    expect(first).toEqual({ graph, changed: true });
    expect(second).toEqual({ graph, changed: false });
    expect(client.current()).toEqual(graph);
    expect(calls.map((call) => call.input)).toEqual([
      "/api/addons/browser-graph",
      "/api/addons/browser-graph",
    ]);
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-cache",
      signal,
    });
    expect(new Headers(calls[0]?.init.headers).get("If-None-Match")).toBeNull();
    expect(new Headers(calls[1]?.init.headers).get("If-None-Match")).toBe(`"${graphRevision}"`);
  });

  it("preserves the last good graph after a malformed response", async () => {
    const responses = [
      jsonGraphResponse(graph),
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: `"${"c".repeat(64)}"` },
      }),
    ];
    const client = new BrowserGraphClient(async () => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected fetch");
      }
      return response;
    });
    const signal = new AbortController().signal;
    await client.refresh(signal);

    await expect(client.refresh(signal)).rejects.toBeInstanceOf(BoundaryValidationError);
    expect(client.current()).toEqual(graph);
  });

  it("does not cache a structurally valid graph with invalid dependency semantics", async () => {
    const nextRevision = "c".repeat(64);
    const cyclic = {
      ...graph,
      graphRevision: nextRevision,
      addons: [{ ...descriptor, dependencies: ["dm-tools"] }],
    } satisfies BrowserGenerationSet;
    const responses = [jsonGraphResponse(graph), jsonGraphResponse(cyclic)];
    const client = new BrowserGraphClient(async () => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected fetch");
      }
      return response;
    });
    const signal = new AbortController().signal;
    await client.refresh(signal);

    await expect(client.refresh(signal)).rejects.toThrow("invalid dependency list");
    expect(client.current()).toEqual(graph);
  });

  it("reports HTTP status without parsing an error body", async () => {
    const client = new BrowserGraphClient(async () => new Response("private detail", { status: 403 }));

    await expect(client.refresh(new AbortController().signal)).rejects.toEqual(
      new BrowserGraphHTTPError(403),
    );
    expect(client.current()).toBeUndefined();
  });

  it("does not repopulate its cache when reset invalidates an in-flight refresh", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const client = new BrowserGraphClient(async () => pendingResponse);
    const refresh = client.refresh(new AbortController().signal);
    await Promise.resolve();

    client.reset();
    resolveResponse?.(jsonGraphResponse(graph));

    await expect(refresh).rejects.toBeInstanceOf(BrowserGraphRefreshInvalidatedError);
    expect(client.current()).toBeUndefined();
  });
});

function jsonGraphResponse(value: BrowserGenerationSet): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ETag: `"${value.graphRevision}"`,
    },
  });
}
