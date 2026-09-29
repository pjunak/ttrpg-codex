import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.js";
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
  contributions: [
    {
      id: "planner.route",
      surface: "route",
      label: "Story Planner",
      roles: ["dm"],
      order: 200,
      requires: ["ui.contributions"],
      config: { path: "planner" },
    },
  ],
};
const graph: BrowserGenerationSet = {
  contractVersion: 2,
  graphRevision,
  addons: [descriptor],
};

describe("parseBrowserGenerationSet", () => {
  it("accepts reviewed localized labels without weakening canonical route metadata", () => {
    const localized = (labels: unknown) => ({
      ...graph,
      addons: [
        {
          ...descriptor,
          contributions: [
            {
              ...descriptor.contributions[0],
              config: { path: "planner", labels },
            },
          ],
        },
      ],
    });
    expect(
      parseBrowserGenerationSet(localized({ cs: "Plánovač příběhu" })).addons[0]?.contributions[0]
        ?.config,
    ).toEqual({ path: "planner", labels: { cs: "Plánovač příběhu" } });
    for (const labels of [
      null,
      [],
      { cs: "" },
      { cs: "   " },
      { cs: "bad\nlabel" },
      { cs: "a".repeat(201) },
      { path: "changed" },
    ]) {
      expect(() => parseBrowserGenerationSet(localized(labels))).toThrow(
        "invalid localized labels",
      );
    }
  });
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
    {
      ...graph,
      addons: [{ ...graph.addons[0], entryUrl: descriptor.entryUrl.replace(".js", ".html") }],
    },
    { ...graph, addons: [{ ...graph.addons[0], styleUrls: [descriptor.entryUrl] }] },
    {
      ...graph,
      addons: [{ ...graph.addons[0], styleUrls: Array(65).fill(descriptor.styleUrls[0]) }],
    },
    { ...graph, addons: [{ ...graph.addons[0], permissions: [{ id: "read", resources: [] }] }] },
    {
      ...graph,
      addons: [
        {
          ...graph.addons[0],
          contributions: [{ ...descriptor.contributions[0], surface: "raw-html" }],
        },
      ],
    },
    {
      ...graph,
      addons: [
        {
          ...graph.addons[0],
          contributions: [{ ...descriptor.contributions[0], config: { path: "/planner" } }],
        },
      ],
    },
    {
      ...graph,
      addons: [
        {
          ...graph.addons[0],
          contributions: [
            {
              ...descriptor.contributions[0],
              config: { path: "planner", href: "https://invalid" },
            },
          ],
        },
      ],
    },
    {
      ...graph,
      addons: [
        {
          ...graph.addons[0],
          entryUrl: `/api/addons/other-addon/generations/${generationId}/assets/web/index.js`,
        },
      ],
    },
    {
      ...graph,
      addons: [
        {
          ...graph.addons[0],
          entryUrl: `/api/addons/dm-tools/generations/${generationId}/assets/web/../worker/addon.js`,
        },
      ],
    },
  ])("rejects malformed or cross-generation input %#", (value) => {
    expect(() => parseBrowserGenerationSet(value)).toThrow(BoundaryValidationError);
  });
});

describe("BrowserGraphClient", () => {
  it("invalidates queued reads at reset without fetching under the next authority", async () => {
    const started = deferred();
    const pending = deferred<Response>();
    const fetchGraph = vi.fn<BrowserGraphFetch>(async () => {
      started.resolve();
      return pending.promise;
    });
    const client = new BrowserGraphClient(fetchGraph);
    const signal = new AbortController().signal;
    const first = client.refresh(signal);
    await started.promise;
    const queued = client.refresh(signal);
    const firstRejected = expect(first).rejects.toBeInstanceOf(BrowserGraphRefreshInvalidatedError);
    const queuedRejected = expect(queued).rejects.toBeInstanceOf(
      BrowserGraphRefreshInvalidatedError,
    );
    client.reset();
    pending.resolve(jsonGraphResponse(graph));
    await Promise.all([firstRejected, queuedRejected]);
    expect(fetchGraph).toHaveBeenCalledOnce();
    expect(client.current()).toBeUndefined();
  });

  for (const phase of ["headers", "body"] as const)
    it(`starts a fresh graph before obsolete ${phase} finish and retains its ETag`, async () => {
      const started = deferred();
      const release = deferred();
      const newer = { ...graph, graphRevision: "c".repeat(64), addons: [] };
      let calls = 0;
      let oldSignal: AbortSignal | null | undefined;
      const headers: Headers[] = [];
      const client = new BrowserGraphClient(async (_url, init) => {
        headers.push(new Headers(init.headers));
        if (++calls > 1)
          return calls === 2 ? jsonGraphResponse(newer) : new Response(null, { status: 304 });
        oldSignal = init.signal;
        const response = jsonGraphResponse(graph);
        if (phase === "headers") {
          started.resolve();
          await release.promise;
        } else {
          vi.spyOn(response, "text").mockImplementation(async () => {
            started.resolve();
            await release.promise;
            return JSON.stringify(graph);
          });
        }
        return response;
      });
      const signal = new AbortController().signal;
      const old = client.refresh(signal);
      const rejected = expect(old).rejects.toBeInstanceOf(BrowserGraphRefreshInvalidatedError);
      await started.promise;
      client.reset();
      const fresh = client.refresh(signal);
      try {
        await vi.waitFor(() => expect(calls).toBe(2));
        expect(oldSignal?.aborted).toBe(true);
        await expect(fresh).resolves.toEqual({ graph: newer, changed: true });
        expect(headers[1]?.has("If-None-Match")).toBe(false);
      } finally {
        release.resolve();
        await Promise.allSettled([old, rejected, fresh]);
      }
      await rejected;
      expect(client.current()).toEqual(newer);
      await expect(client.refresh(signal)).resolves.toEqual({ graph: newer, changed: false });
      expect(headers[2]?.get("If-None-Match")).toBe(`"${newer.graphRevision}"`);
    });

  for (const phase of ["headers", "body"] as const)
    for (const outcome of ["invalid response", "failure"] as const)
      it(`keeps the last graph when a cancelled ${phase} read ends with a late ${outcome}`, async () => {
        const started = deferred();
        const release = deferred();
        let reads = 0;
        const client = new BrowserGraphClient(async () => {
          if (++reads === 1) return jsonGraphResponse(graph);
          if (reads > 2) return new Response(null, { status: 304 });
          const wait = async () => {
            started.resolve();
            await release.promise;
            if (outcome === "failure") throw new Error("obsolete transport failure");
          };
          if (phase === "headers") {
            await wait();
            return new Response(null, { status: 401 });
          }
          const response = jsonGraphResponse(graph);
          vi.spyOn(response, "text").mockImplementation(async () => {
            await wait();
            return "invalid JSON";
          });
          return response;
        });
        const signal = new AbortController().signal;
        await client.refresh(signal);
        const request = new AbortController();
        const old = client.refresh(request.signal);
        const rejected = expect(old).rejects.toBe("left-page");
        await started.promise;
        request.abort("left-page");
        try {
          await rejected;
          await expect(client.refresh(signal)).resolves.toEqual({ graph, changed: false });
        } finally {
          release.resolve();
        }
        expect(client.current()).toEqual(graph);
        expect(reads).toBe(3);
      });

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
    const client = new BrowserGraphClient(
      async () => new Response("private detail", { status: 403 }),
    );

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
