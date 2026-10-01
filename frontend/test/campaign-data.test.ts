import { describe, expect, it, vi } from "vitest";
import {
  CampaignDataClient,
  CampaignDataHTTPError,
  CampaignDataRefreshInvalidatedError,
  parseCampaignDataset,
  type CampaignCollectionName,
  type CampaignDataFetch,
  type CampaignDataset,
} from "../src/core/campaign-data.js";
import { BoundaryValidationError } from "../src/core/boundary.js";

const shapes = {
  characters: "list",
  relationships: "list",
  locations: "list",
  events: "list",
  mysteries: "list",
  factions: "keyed",
  deletedDefaults: "keyed",
  pantheon: "list",
  artifacts: "list",
  settings: "keyed",
  historicalEvents: "list",
  campaign: "keyed",
  pets: "list",
} as const;

const dataset: CampaignDataset = {
  contractVersion: "campaign-data.v1",
  collections: (Object.entries(shapes) as Array<[CampaignCollectionName, "list" | "keyed"]>).map(
    ([name, shape]) => ({
      name,
      shape,
      materialized: name === "characters",
      revision: name === "characters" ? 2 : 0,
      records:
        name === "characters"
          ? [{ key: "alice", revision: 2, value: { id: "alice", name: "Alice" } }]
          : [],
    }),
  ),
};

describe("parseCampaignDataset", () => {
  it("accepts and copies the complete v1 dataset", () => {
    const parsed = parseCampaignDataset(dataset);

    expect(parsed).toEqual(dataset);
    expect(parsed).not.toBe(dataset);
    expect(parsed.collections).not.toBe(dataset.collections);
    expect(parsed.collections[0]?.records).not.toBe(dataset.collections[0]?.records);
  });

  it.each([
    { ...dataset, contractVersion: "campaign-data.v2" },
    { ...dataset, extra: true },
    { ...dataset, collections: dataset.collections.slice(1) },
    {
      ...dataset,
      collections: dataset.collections.map((collection, index) =>
        index === 0 ? { ...collection, shape: "keyed" } : collection,
      ),
    },
    {
      ...dataset,
      collections: dataset.collections.map((collection, index) =>
        index === 0
          ? { ...collection, records: [{ key: "bad\nkey", revision: 1, value: {} }] }
          : collection,
      ),
    },
    {
      ...dataset,
      collections: dataset.collections.map((collection, index) =>
        index === 0
          ? { ...collection, records: [{ key: "alice", revision: 0, value: {} }] }
          : collection,
      ),
    },
  ])("rejects a malformed dataset %#", (value) => {
    expect(() => parseCampaignDataset(value)).toThrow(BoundaryValidationError);
  });
});

describe("CampaignDataClient", () => {
  for (const stage of ["headers", "body"] as const) {
    it.each(["success", "failure"] as const)(
      `cancelling caller ${stage} releases same-authority reads before late %s`,
      async (outcome) => {
        const started = deferred<void>();
        const release = deferred<void>();
        const finished = deferred<void>();
        const fresh = {
          ...dataset,
          collections: dataset.collections.map((collection) => ({ ...collection, records: [] })),
        };
        let calls = 0;
        const client = new CampaignDataClient(async () => {
          if (++calls > 1) return jsonResponse(fresh);
          const hold = async () => {
            started.resolve();
            await release.promise;
            finished.resolve();
            if (outcome === "failure") throw new Error("obsolete read failed");
          };
          const response = jsonResponse(dataset);
          response.text = async () => {
            if (stage === "body") await hold();
            return JSON.stringify(dataset);
          };
          if (stage === "headers") await hold();
          return response;
        });
        const previous = new AbortController();
        const reason = new Error("stream closed");
        const settlements: unknown[] = [];
        const observe = (operation: Promise<CampaignDataset>) =>
          operation.then(
            (value) => settlements.push(value),
            (cause: unknown) => settlements.push(cause),
          );
        const active = observe(client.refresh(previous.signal));
        await started.promise;
        const queued = observe(client.refresh(previous.signal));
        try {
          previous.abort(reason);
          await vi.waitFor(() => expect(settlements).toEqual([reason, reason]));
          await expect(client.refresh(new AbortController().signal)).resolves.toEqual(fresh);
          expect(client.current()).toEqual(fresh);
          expect(calls).toBe(2);
        } finally {
          release.resolve();
          await finished.promise;
          await Promise.all([active, queued]);
        }
        expect(settlements).toEqual([reason, reason]);
        expect(client.current()).toEqual(fresh);
        expect(calls).toBe(2);
      },
    );
  }

  it("cancels a queued caller without overtaking an independent live read", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const client = new CampaignDataClient(async () => {
      if (++calls === 1) {
        started.resolve();
        await release.promise;
      }
      return jsonResponse(dataset);
    });
    const live = new AbortController().signal;
    const first = client.refresh(live);
    await started.promise;
    const cancelled = new AbortController();
    let cause: unknown;
    const skipped = client.refresh(cancelled.signal).catch((error: unknown) => {
      cause = error;
    });
    const last = client.refresh(live);
    try {
      cancelled.abort("cancelled queued read");
      await vi.waitFor(() => expect(cause).toBe("cancelled queued read"));
      expect(calls).toBe(1);
    } finally {
      release.resolve();
    }
    await Promise.all([first, skipped, last]);
    expect(calls).toBe(2);
    expect(client.current()).toEqual(dataset);
  });

  it("uses a bounded same-origin request and retains the accepted dataset", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchData: CampaignDataFetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(dataset);
    };
    const client = new CampaignDataClient(fetchData);
    const signal = new AbortController().signal;

    await expect(client.refresh(signal)).resolves.toEqual(dataset);
    expect(client.current()).toEqual(dataset);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: "/api/campaign" });
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  });

  it("preserves the last good dataset after malformed data", async () => {
    const responses = [jsonResponse(dataset), jsonResponse({ invalid: true })];
    const client = new CampaignDataClient(async () => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected fetch");
      }
      return response;
    });
    const signal = new AbortController().signal;
    await client.refresh(signal);

    await expect(client.refresh(signal)).rejects.toBeInstanceOf(BoundaryValidationError);
    expect(client.current()).toEqual(dataset);
  });

  it("reports HTTP failures without parsing private details", async () => {
    const client = new CampaignDataClient(async () => new Response("private", { status: 503 }));

    await expect(client.refresh(new AbortController().signal)).rejects.toEqual(
      new CampaignDataHTTPError(503),
    );
  });

  it("does not accept a response invalidated by an authority change", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const client = new CampaignDataClient(async () => response);
    const refresh = client.refresh(new AbortController().signal);
    await Promise.resolve();

    client.reset();
    resolveResponse?.(jsonResponse(dataset));

    await expect(refresh).rejects.toBeInstanceOf(CampaignDataRefreshInvalidatedError);
    expect(client.current()).toBeUndefined();
  });

  it("invalidates reads queued before reset without issuing them under new authority", async () => {
    let calls = 0;
    const client = new CampaignDataClient(async () => {
      calls++;
      return jsonResponse(dataset);
    });
    const refresh = client.refresh(new AbortController().signal);
    client.reset();

    await expect(refresh).rejects.toBeInstanceOf(CampaignDataRefreshInvalidatedError);
    expect(calls).toBe(0);
    expect(client.current()).toBeUndefined();
  });

  it.each(["headers", "body"] as const)(
    "reset releases new reads while old %s remain stalled",
    async (stage) => {
      const held = deferred<Response>();
      const body = deferred<string>();
      const started = deferred<void>();
      const signals: AbortSignal[] = [];
      const currentDataset = {
        ...dataset,
        collections: dataset.collections.map((collection) => ({
          ...collection,
          records: [],
        })),
      };
      const client = new CampaignDataClient(async (_input, init) => {
        signals.push(init.signal as AbortSignal);
        if (signals.length > 1) return jsonResponse(currentDataset);
        if (stage === "headers") {
          started.resolve();
          return held.promise;
        }
        const response = jsonResponse(dataset);
        response.text = () => {
          started.resolve();
          return body.promise;
        };
        return response;
      });
      const signal = new AbortController().signal;
      const old = client.refresh(signal);
      const queued = client.refresh(signal);
      const oldRejected = expect(old).rejects.toBeInstanceOf(CampaignDataRefreshInvalidatedError);
      const queuedRejected = expect(queued).rejects.toBeInstanceOf(
        CampaignDataRefreshInvalidatedError,
      );
      try {
        await started.promise;
        client.reset();
        expect(signals[0]?.aborted).toBe(true);
        expect(signal.aborted).toBe(false);
        await expect(client.refresh(signal)).resolves.toEqual(currentDataset);
        expect(signals).toHaveLength(2);
        expect(signals[1]?.aborted).toBe(false);
      } finally {
        held.resolve(jsonResponse(dataset));
        body.resolve(JSON.stringify(dataset));
        await Promise.all([oldRejected, queuedRejected]);
      }
      expect(client.current()).toEqual(currentDataset);
    },
  );

  it("keeps reads serialized within the current authority", async () => {
    const held = deferred<Response>();
    let calls = 0;
    const client = new CampaignDataClient(async () => {
      calls++;
      return calls === 1 ? held.promise : jsonResponse(dataset);
    });
    const signal = new AbortController().signal;
    const first = client.refresh(signal);
    const second = client.refresh(signal);
    await Promise.resolve();
    expect(calls).toBe(1);
    held.resolve(jsonResponse(dataset));
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(client.current()).toEqual(dataset);
  });

  it.each(["headers", "body"] as const)(
    "reports late %s failures from a replaced authority as invalidated",
    async (stage) => {
      const held = deferred<Response>();
      const body = deferred<string>();
      const started = deferred<void>();
      const client = new CampaignDataClient(async () => {
        if (stage === "headers") {
          started.resolve();
          return held.promise;
        }
        const response = jsonResponse(dataset);
        response.text = () => {
          started.resolve();
          return body.promise;
        };
        return response;
      });
      const refresh = client.refresh(new AbortController().signal);
      await started.promise;
      client.reset();
      if (stage === "headers") held.reject(new TypeError("Network failure"));
      else body.reject(new DOMException("Body stream aborted", "AbortError"));

      await expect(refresh).rejects.toBeInstanceOf(CampaignDataRefreshInvalidatedError);
      expect(client.current()).toBeUndefined();
    },
  );

  it("never publishes a response body after its caller was cancelled", async () => {
    const body = deferred<string>();
    const started = deferred<void>();
    const client = new CampaignDataClient(async () => {
      const response = jsonResponse(dataset);
      response.text = () => {
        started.resolve();
        return body.promise;
      };
      return response;
    });
    const controller = new AbortController();
    const refresh = client.refresh(controller.signal);
    await started.promise;
    controller.abort();
    body.resolve(JSON.stringify(dataset));

    await expect(refresh).rejects.toBe(controller.signal.reason);
    expect(client.current()).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
    },
  });
}
