import { describe, expect, it } from "vitest";
import { BrowserAddonRuntime } from "../src/addons/browser-addon-runtime.js";
import {
  BrowserGraphClient,
  BrowserGraphHTTPError,
  BrowserGraphRefreshInvalidatedError,
  type BrowserGraphFetch,
} from "../src/addons/browser-graph-client.js";
import {
  BrowserGenerationManager,
  type BrowserGenerationSet,
} from "../src/addons/generation-manager.js";

const graphRevision = "d".repeat(64);
const generationId = "e".repeat(64);
const graph: BrowserGenerationSet = {
  contractVersion: 1,
  graphRevision,
  addons: [{
    addonId: "dm-tools",
    addonVersion: "1.0.0",
    generationId,
    mode: "integrated",
    entryUrl: `/api/addons/dm-tools/generations/${generationId}/assets/web/index.js`,
    styleUrls: [],
    sandbox: [],
    dependencies: [],
  }],
};

describe("BrowserAddonRuntime", () => {
  it("reconciles an unchanged graph without duplicating activation", async () => {
    const responses = [jsonGraphResponse(graph), new Response(null, { status: 304 })];
    const fetchGraph = queuedFetch(responses);
    const events: string[] = [];
    const manager = new BrowserGenerationManager((descriptor) => {
      events.push(`start:${descriptor.generationId}`);
      return () => {
        events.push(`stop:${descriptor.generationId}`);
      };
    });
    const runtime = new BrowserAddonRuntime(new BrowserGraphClient(fetchGraph), manager);
    const signal = new AbortController().signal;

    const first = await runtime.refresh(signal);
    const second = await runtime.refresh(signal);

    expect(first.transport.changed).toBe(true);
    expect(second.transport.changed).toBe(false);
    expect(first.lifecycle.activationFailures).toEqual([]);
    expect(second.lifecycle.activationFailures).toEqual([]);
    expect(runtime.activeGenerations()).toEqual(graph.addons);
    expect(events).toEqual([`start:${generationId}`]);
  });

  it("does not fetch the next graph while activation is still running", async () => {
    let fetchCalls = 0;
    let releaseActivation: (() => void) | undefined;
    let markActivationStarted: (() => void) | undefined;
    const activationReleased = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activationStarted = new Promise<void>((resolve) => {
      markActivationStarted = resolve;
    });
    const fetchGraph: BrowserGraphFetch = async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? jsonGraphResponse(graph)
        : new Response(null, { status: 304 });
    };
    const manager = new BrowserGenerationManager(async () => {
      markActivationStarted?.();
      await activationReleased;
      return () => undefined;
    });
    const runtime = new BrowserAddonRuntime(new BrowserGraphClient(fetchGraph), manager);
    const signal = new AbortController().signal;

    const first = runtime.refresh(signal);
    await activationStarted;
    const second = runtime.refresh(signal);
    await Promise.resolve();
    expect(fetchCalls).toBe(1);

    releaseActivation?.();
    await Promise.all([first, second]);
    expect(fetchCalls).toBe(2);
  });

  it("retries a failed activation when the server graph is unchanged", async () => {
    let attempts = 0;
    const manager = new BrowserGenerationManager(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("module was temporarily unavailable");
      }
      return () => undefined;
    });
    const runtime = new BrowserAddonRuntime(
      new BrowserGraphClient(queuedFetch([
        jsonGraphResponse(graph),
        new Response(null, { status: 304 }),
      ])),
      manager,
    );
    const signal = new AbortController().signal;

    const first = await runtime.refresh(signal);
    const second = await runtime.refresh(signal);

    expect(first.lifecycle.activationFailures).toHaveLength(1);
    expect(first.lifecycle.active).toEqual([]);
    expect(second.transport.changed).toBe(false);
    expect(second.lifecycle.activationFailures).toEqual([]);
    expect(second.lifecycle.active).toEqual(graph.addons);
    expect(attempts).toBe(2);
  });

  it("keeps active generations running when a later HTTP refresh fails", async () => {
    const fetchGraph = queuedFetch([
      jsonGraphResponse(graph),
      new Response("private detail", { status: 503 }),
    ]);
    const stopEvents: string[] = [];
    const manager = new BrowserGenerationManager(() => () => {
      stopEvents.push("stop");
    });
    const runtime = new BrowserAddonRuntime(new BrowserGraphClient(fetchGraph), manager);
    const signal = new AbortController().signal;
    await runtime.refresh(signal);

    await expect(runtime.refresh(signal)).rejects.toEqual(new BrowserGraphHTTPError(503));
    expect(runtime.activeGenerations()).toEqual(graph.addons);
    expect(stopEvents).toEqual([]);
  });

  it("clears transport authority and disposes every active generation on reset", async () => {
    const manager = new BrowserGenerationManager(() => () => undefined);
    const client = new BrowserGraphClient(queuedFetch([jsonGraphResponse(graph)]));
    const runtime = new BrowserAddonRuntime(client, manager);
    await runtime.refresh(new AbortController().signal);

    const failures = await runtime.reset("authority-changed");

    expect(failures).toEqual([]);
    expect(client.current()).toBeUndefined();
    expect(runtime.activeGenerations()).toEqual([]);
  });

  it("invalidates an in-flight fetch before reset completes", async () => {
    let fetchCalls = 0;
    let resolveResponse: ((response: Response) => void) | undefined;
    let markFetchStarted: (() => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const stopReasons: unknown[] = [];
    const manager = new BrowserGenerationManager((_descriptor, context) => () => {
      stopReasons.push(context.signal.reason);
    });
    const client = new BrowserGraphClient(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return jsonGraphResponse(graph);
      }
      markFetchStarted?.();
      return pendingResponse;
    });
    const runtime = new BrowserAddonRuntime(client, manager);
    await runtime.refresh(new AbortController().signal);
    const refresh = runtime.refresh(new AbortController().signal);
    await fetchStarted;

    const reset = runtime.reset("authority-changed");
    resolveResponse?.(jsonGraphResponse(graph));

    await expect(refresh).rejects.toBeInstanceOf(BrowserGraphRefreshInvalidatedError);
    await expect(reset).resolves.toEqual([]);
    expect(runtime.activeGenerations()).toEqual([]);
    expect(stopReasons).toEqual(["authority-changed"]);
  });

  it("invalidates queued refreshes when authority changes during activation", async () => {
    let fetchCalls = 0;
    let releaseActivation: (() => void) | undefined;
    let markActivationStarted: (() => void) | undefined;
    const activationReleased = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activationStarted = new Promise<void>((resolve) => {
      markActivationStarted = resolve;
    });
    const fetchGraph: BrowserGraphFetch = async () => {
      fetchCalls += 1;
      return jsonGraphResponse(graph);
    };
    const stopReasons: unknown[] = [];
    const manager = new BrowserGenerationManager(async (_descriptor, context) => {
      markActivationStarted?.();
      await activationReleased;
      return () => {
        stopReasons.push(context.signal.reason);
      };
    });
    const runtime = new BrowserAddonRuntime(new BrowserGraphClient(fetchGraph), manager);
    const signal = new AbortController().signal;
    const first = runtime.refresh(signal);
    await activationStarted;
    const queued = runtime.refresh(signal);

    const reset = runtime.reset("authority-changed");
    releaseActivation?.();

    await expect(first).rejects.toBeInstanceOf(BrowserGraphRefreshInvalidatedError);
    await expect(queued).rejects.toBeInstanceOf(BrowserGraphRefreshInvalidatedError);
    await expect(reset).resolves.toEqual([]);
    expect(fetchCalls).toBe(1);
    expect(runtime.activeGenerations()).toEqual([]);
    expect(stopReasons).toEqual(["authority-changed"]);
  });
});

function queuedFetch(responses: Response[]): BrowserGraphFetch {
  return async () => {
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("unexpected fetch");
    }
    return response;
  };
}

function jsonGraphResponse(value: BrowserGenerationSet): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ETag: `"${value.graphRevision}"`,
    },
  });
}
