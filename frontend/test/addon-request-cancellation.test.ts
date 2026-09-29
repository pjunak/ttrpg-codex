import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.js";
import { BrowserAddonDataClient, type AddonDataFetch } from "../src/addons/data-client.js";
import { BrowserAddonContentClient } from "../src/addons/content-client.js";
import { BrowserAddonServiceClient } from "../src/addons/service-client.js";

const generationId = "a".repeat(64);
const csrfToken = "c".repeat(32);
const connection = {
  contractVersion: "addon-service-connection.v1",
  contract: "example.rules",
  range: "^1.0.0",
  cardinality: "one",
  providers: [
    { addonId: "provider", contractVersion: "1.0.0", generation: generationId, bindingRevision: 0 },
  ],
};
const receipt = {
  contractVersion: "addon-data-commit.v1",
  commitId: 1,
  occurredAt: "2026-09-29T10:00:00Z",
  results: [
    {
      kind: "collection",
      dataId: "notes",
      key: "note",
      beforeRevision: 0,
      afterRevision: 1,
      deleted: false,
    },
  ],
  dataSets: [{ kind: "collection", dataId: "notes", revision: 1 }],
};
type Invoke = (signal: AbortSignal) => Promise<unknown>;
interface Fixture {
  name: string;
  result: unknown;
  open(fetch: AddonDataFetch, signal: AbortSignal): Promise<Invoke>;
}
const fixtures: Fixture[] = [
  {
    name: "data read",
    result: { contractVersion: "addon-data-document.v1", key: "note", revision: 1, value: {} },
    async open(fetchData, signal) {
      const notes = new BrowserAddonDataClient({
        addonId: "notes",
        generationId,
        csrfToken,
        signal,
        fetchData,
      })
        .api()
        .collection("notes");
      return (signal) => notes.get("note", { signal });
    },
  },
  {
    name: "data transaction",
    result: receipt,
    async open(fetchData, signal) {
      const notes = new BrowserAddonDataClient({
        addonId: "notes",
        generationId,
        csrfToken,
        signal,
        fetchData,
      })
        .api()
        .collection("notes");
      return (signal) => notes.put("note", {}, 0, { signal });
    },
  },
  {
    name: "content catalog",
    result: {
      contractVersion: "addon-content-catalog.v1",
      addonId: "notes",
      generationId,
      sets: [],
    },
    async open(fetchContent, signal) {
      const api = new BrowserAddonContentClient({
        addonId: "notes",
        generationId,
        signal,
        fetchContent,
      }).api();
      return (signal) => api.catalog({ signal });
    },
  },
  {
    name: "service connection",
    result: connection,
    async open(fetchService, signal) {
      const api = new BrowserAddonServiceClient({
        addonId: "notes",
        generationId,
        csrfToken,
        signal,
        fetchService,
      }).api();
      return (signal) =>
        api.connect("example.rules", { range: "^1.0.0", cardinality: "one", signal });
    },
  },
  {
    name: "service call",
    result: {
      contractVersion: "addon-service-result.v1",
      providerAddonId: "provider",
      providerGeneration: generationId,
      result: { available: true },
    },
    async open(fetchService, signal) {
      const api = new BrowserAddonServiceClient({
        addonId: "notes",
        generationId,
        csrfToken,
        signal,
        fetchService: (url, init) =>
          url.endsWith("/connect")
            ? Promise.resolve(Response.json(connection))
            : fetchService(url, init),
      }).api();
      const handle = await api.connect("example.rules", { range: "^1.0.0", cardinality: "one" });
      return (signal) => handle.call("load", {}, { signal });
    },
  },
];

describe("generation-scoped add-on requests", () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} still accepts an uncancelled response`, async () => {
      const signal = new AbortController().signal;
      const invoke = await fixture.open(async () => Response.json(fixture.result), signal);
      await expect(invoke(signal)).resolves.toBeDefined();
    });
  }

  for (const fixture of fixtures)
    for (const owner of ["generation", "request"] as const)
      for (const phase of ["headers", "body"] as const)
        for (const outcome of ["response", "failure"] as const)
          it(`${fixture.name} rejects ${owner} cancellation during ${phase} despite a late ${outcome}`, async () => {
            const generation = new AbortController();
            const request = new AbortController();
            const started = deferred();
            const release = deferred();
            const lateError = new Error("obsolete transport failure");
            const fetch = vi.fn<AddonDataFetch>(async () => {
              const response = Response.json(fixture.result);
              const wait = async () => {
                started.resolve();
                await release.promise;
                if (outcome === "failure") throw lateError;
              };
              if (phase === "headers") await wait();
              else
                vi.spyOn(response, "text").mockImplementation(async () => {
                  await wait();
                  return JSON.stringify(fixture.result);
                });
              return response;
            });
            const invoke = await fixture.open(fetch, generation.signal);
            const pending = invoke(request.signal);
            const rejected = expect(pending).rejects.toBe("view-replaced");
            await started.promise;
            (owner === "generation" ? generation : request).abort("view-replaced");
            try {
              await rejected;
            } finally {
              release.resolve();
            }
            expect(fetch).toHaveBeenCalledOnce();
          });

  it("does not dispatch queued transactions after generation disposal or replay an uncertain write", async () => {
    const owner = new AbortController();
    const started = deferred();
    const response = deferred<Response>();
    const fetchData = vi.fn<AddonDataFetch>(() => {
      started.resolve();
      return response.promise;
    });
    const notes = new BrowserAddonDataClient({
      addonId: "notes",
      generationId,
      csrfToken,
      signal: owner.signal,
      fetchData,
    })
      .api()
      .collection("notes");
    const first = notes.put("first", {}, 0);
    await started.promise;
    const queued = notes.put("second", {}, 0);
    const firstRejected = expect(first).rejects.toBe("updated");
    const queuedRejected = expect(queued).rejects.toBe("updated");
    owner.abort("updated");
    try {
      await Promise.all([firstRejected, queuedRejected]);
    } finally {
      response.resolve(Response.json(receipt));
    }
    expect(fetchData).toHaveBeenCalledOnce();
  });
});
