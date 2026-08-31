import { describe, expect, it, vi } from "vitest";
import { BrowserAddonSession } from "../src/addons/browser-addon-session.js";
import { BrowserGraphHTTPError } from "../src/addons/browser-graph-client.js";
import type { BrowserAddonRefreshResult } from "../src/addons/browser-addon-runtime.js";
import type { EventStreamCallbacks } from "../src/core/event-stream.js";

describe("BrowserAddonSession", () => {
  it("opens one shared stream, refreshes on graph signals, and revokes on stop", async () => {
    const runtime = new FakeRuntime();
    const events = new FakeEvents();
    const causes: string[] = [];
    const session = new BrowserAddonSession(runtime, events, {
      onRefresh: (cause) => causes.push(cause),
    });

    await session.start();
    events.callbacks?.onRefresh({ cause: "hello", cursor: 0 });
    events.callbacks?.onRefresh({
      cause: "browser-addons-changed",
      cursor: 1,
      revision: "a".repeat(64),
    });
    await vi.waitFor(() => expect(runtime.refreshCalls).toBe(3));
    const failures = await session.stop();

    expect(failures).toEqual([]);
    expect(causes).toEqual(["initial", "hello", "browser-addons-changed"]);
    expect(events.openCalls).toBe(1);
    expect(events.closeCalls).toBe(1);
    expect(runtime.resetCalls).toEqual(["authority-changed"]);
  });

  it("tears down authority when the graph endpoint rejects the session", async () => {
    const runtime = new FakeRuntime();
    runtime.failure = new BrowserGraphHTTPError(403);
    const events = new FakeEvents();
    const authorityLost = vi.fn();
    const session = new BrowserAddonSession(runtime, events, { onAuthorityLost: authorityLost });

    await session.start();
    await vi.waitFor(() => expect(authorityLost).toHaveBeenCalledOnce());

    expect(events.closeCalls).toBe(1);
    expect(runtime.resetCalls).toEqual(["authority-changed"]);
  });
});

class FakeRuntime {
  refreshCalls = 0;
  resetCalls: string[] = [];
  failure: unknown;

  async refresh(_signal: AbortSignal): Promise<BrowserAddonRefreshResult> {
    this.refreshCalls += 1;
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return {
      transport: {
        changed: this.refreshCalls === 1,
        graph: { contractVersion: 2, graphRevision: "b".repeat(64), addons: [] },
      },
      lifecycle: {
        graphRevision: "b".repeat(64),
        active: [],
        activationFailures: [],
        disposalFailures: [],
      },
    };
  }

  async reset(reason: "authority-changed") {
    this.resetCalls.push(reason);
    return [];
  }
}

class FakeEvents {
  callbacks: EventStreamCallbacks | undefined;
  openCalls = 0;
  closeCalls = 0;

  open(callbacks: EventStreamCallbacks): void {
    this.openCalls += 1;
    this.callbacks = callbacks;
  }

  close(): void {
    this.closeCalls += 1;
  }
}
