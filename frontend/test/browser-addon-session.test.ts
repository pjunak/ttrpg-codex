import { describe, expect, it, vi } from "vitest";
import { BrowserAddonSession } from "../src/addons/browser-addon-session.js";
import { BrowserGraphHTTPError } from "../src/addons/browser-graph-client.js";
import type { BrowserAddonRefreshResult } from "../src/addons/browser-addon-runtime.js";

describe("BrowserAddonSession", () => {
  it("opens one shared stream, refreshes on graph signals, and revokes on stop", async () => {
    const runtime = new FakeRuntime();
    const causes: string[] = [];
    const session = new BrowserAddonSession(runtime, {
      onRefresh: (cause) => causes.push(cause),
    });

    await session.start();
    await session.handleEvent({ cause: "hello", cursor: 0 });
    await session.handleEvent({
      cause: "browser-addons-changed",
      cursor: 1,
      revision: "a".repeat(64),
    });
    await session.handleEvent({
      cause: "campaign-data-changed",
      cursor: 2,
      collection: "characters",
      revision: 4,
    });
    expect(runtime.refreshCalls).toBe(3);
    const failures = await session.stop();

    expect(failures).toEqual([]);
    expect(causes).toEqual(["initial", "hello", "browser-addons-changed"]);
    expect(runtime.resetCalls).toEqual(["authority-changed"]);
  });

  it("retains mounted generations during recovery and refreshes them only after resume", async () => {
    const runtime = new FakeRuntime(), authorityLost = vi.fn();
    const session = new BrowserAddonSession(runtime, {
      onRecoveryRequested: async () => true, onAuthorityLost: authorityLost,
    });
    await session.start();
    runtime.failure = new BrowserGraphHTTPError(401);
    await session.handleEvent({ cause: "hello", cursor: 1 });
    expect(runtime.resetCalls).toEqual([]);
    expect(authorityLost).not.toHaveBeenCalled();
    const calls = runtime.refreshCalls;
    await session.handleEvent({ cause: "hello", cursor: 2 });
    expect(runtime.refreshCalls).toBe(calls);
    runtime.failure = undefined;
    await session.start();
    expect(runtime.refreshCalls).toBe(calls + 1);
    expect(runtime.resetCalls).toEqual([]);
    await session.stop();
    expect(runtime.resetCalls).toEqual(["authority-changed"]);
  });

  it("explicit stop disposes retained generations even while the recovery decision is pending", async () => {
    const runtime = new FakeRuntime();
    let release!: (retain: boolean) => void;
    const decision = new Promise<boolean>(resolve => { release = resolve; });
    const requested = vi.fn(() => decision);
    const session = new BrowserAddonSession(runtime, { onRecoveryRequested: requested });
    await session.start();
    runtime.failure = new BrowserGraphHTTPError(403);
    const rejected = session.handleEvent({ cause: "hello", cursor: 1 });
    await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce());
    const stopping = session.stop();
    release(true);
    await Promise.all([rejected, stopping]);
    expect(runtime.resetCalls).toEqual(["authority-changed"]);
    await session.stop();
    expect(runtime.resetCalls).toHaveLength(1);
  });

  it("revokes generations when recovery is declined or its decision fails", async () => {
    for (const fails of [false, true]) {
      const runtime = new FakeRuntime(), authorityLost = vi.fn(), diagnostic = vi.fn();
      const session = new BrowserAddonSession(runtime, {
        onRecoveryRequested: async () => { if (fails) throw new Error("recovery unavailable"); return false; },
        onAuthorityLost: authorityLost, onDiagnostic: diagnostic,
      });
      runtime.failure = new BrowserGraphHTTPError(401);
      await session.start();
      expect(runtime.resetCalls).toEqual(["authority-changed"]);
      expect(authorityLost).toHaveBeenCalledOnce();
      expect(diagnostic).toHaveBeenCalledTimes(fails ? 1 : 0);
    }
  });

  it("tears down authority when the graph endpoint rejects the session", async () => {
    const runtime = new FakeRuntime();
    runtime.failure = new BrowserGraphHTTPError(403);
    const authorityLost = vi.fn();
    const session = new BrowserAddonSession(runtime, { onAuthorityLost: authorityLost });

    await session.start();
    await vi.waitFor(() => expect(authorityLost).toHaveBeenCalledOnce());

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
