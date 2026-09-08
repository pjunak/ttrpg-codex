import { describe, expect, it, vi } from "vitest";
import { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import {
  IsolatedFrameBridge,
  createIsolatedFrameActivator,
  isolatedFrameDocument,
  isolatedFrameProtocol,
  isolatedSandboxTokens,
  mountIsolatedFrame,
  type IsolatedFrameRuntimeFactory,
  type IsolatedMessagePort,
} from "../src/addons/isolated-frame.js";
import {
  BrowserGenerationManager,
  type BrowserContributionDescriptor,
  type BrowserGenerationDescriptor,
} from "../src/addons/generation-manager.js";
import { GenerationScope } from "../src/addons/generation-scope.js";
import { BrowserAddonDataChanges } from "../src/addons/data-changes.js";
import type {
  AddonDataHandle,
  AddonQueryOptions,
  BrowserDataAPI,
} from "../src/addons/data-client.js";
import type {
  AddonContentQueryOptions,
  AddonContentSet,
  BrowserContentAPI,
} from "../src/addons/content-client.js";
import type {
  BrowserServiceAPI,
  BrowserServiceCallOptions,
  BrowserServiceHandle,
} from "../src/addons/service-client.js";

const generationId = "a".repeat(64);

describe("IsolatedFrameBridge", () => {
  it("forwards scoped data invalidations after readiness and disposes its subscription", () => {
    const descriptor = frameDescriptor(slotContribution()), scope = new GenerationScope("data@test"), changes = new BrowserAddonDataChanges();
    const registry = new BrowserContributionRegistry();
    const context = registry.open(descriptor, scope).context;
    const port = new FakePort();
    const bridge = new IsolatedFrameBridge({ port, context: { ...context, data: { ...context.data, subscribe: changes.scoped(descriptor.addonId, context.signal) } }, contribution: descriptor.contributions[0]!, onResize: vi.fn() });
    changes.handleEvent({ cause: "reset", cursor: 1 }); expect(port.sent).toEqual([]);
    port.receive({ protocol: isolatedFrameProtocol, type: "ready", contributionId: descriptor.contributions[0]!.id });
    changes.handleEvent({ cause: "reset", cursor: 2 });
    expect(port.sent.at(-1)).toEqual({ protocol: isolatedFrameProtocol, type: "data-change", change: { reason: "reset" } });
    bridge.close(); const count = port.sent.length;
    changes.handleEvent({ cause: "reset", cursor: 3 }); expect(port.sent).toHaveLength(count);
  });
  it("accepts only bounded edit flags and clears them when the frame closes", () => {
    const descriptor = frameDescriptor(slotContribution());
    const sdk = new BrowserContributionRegistry().open(descriptor, new GenerationScope("edits@test"));
    const port = new FakePort(), set = vi.fn(), onDiagnostic = vi.fn();
    const bridge = new IsolatedFrameBridge({ port, context: sdk.context, contribution: descriptor.contributions[0]!, onResize: vi.fn(), edits: { set }, onDiagnostic });
    port.receive({ protocol: isolatedFrameProtocol, type: "edit-state", state: { dirty: true, saving: false } });
    expect(set).toHaveBeenLastCalledWith({ dirty: true, saving: false, retainOnQueryChange: false });
    port.receive({ protocol: isolatedFrameProtocol, type: "edit-state", state: { dirty: true, saving: false, body: "must not cross the bridge" } });
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledOnce();
    bridge.close();
    expect(set).toHaveBeenLastCalledWith({ dirty: false, saving: false });
    const count = set.mock.calls.length;
    port.receive({ protocol: isolatedFrameProtocol, type: "edit-state", state: { dirty: true, saving: true } });
    expect(set).toHaveBeenCalledTimes(count);
  });
  it("delivers bounded instance context after readiness and stops updates on disposal", () => {
    const descriptor = frameDescriptor(slotContribution());
    const sdk = new BrowserContributionRegistry().open(descriptor, new GenerationScope("context@test"));
    const port = new FakePort(), onResize = vi.fn();
    const bridge = new IsolatedFrameBridge({ port, context: sdk.context, contribution: descriptor.contributions[0]!, onResize });
    bridge.updateHostContext({ sitting: 1 }); bridge.updateHostContext({ sitting: 2 });
    expect(port.sent).toEqual([]);
    port.receive({ protocol: isolatedFrameProtocol, type: "ready", contributionId: descriptor.contributions[0]!.id });
    expect(port.sent).toEqual([{ protocol: isolatedFrameProtocol, type: "context", host: { sitting: 2 } }]);
    bridge.updateHostContext({ sitting: 3 });
    expect(port.sent.at(-1)).toMatchObject({ host: { sitting: 3 } });
    expect(() => bridge.updateHostContext({ text: "x".repeat(70_000) })).toThrow();
    port.receive({ protocol: isolatedFrameProtocol, type: "resize", height: 32 }); expect(onResize).toHaveBeenCalledWith(32);
    bridge.close(); const count = port.sent.length;
    bridge.updateHostContext({ sitting: 4 }); expect(port.sent).toHaveLength(count);
  });
  it("proxies generation-scoped service handles without exposing browser credentials", async () => {
    const descriptor = frameDescriptor(slotContribution());
    const call = vi.fn(async (
      _method: string,
      _params: unknown,
      _options?: BrowserServiceCallOptions,
    ) => ({ sheet: { level: 3 } }));
    const handle: BrowserServiceHandle = {
      contract: "dnd5e.rules-engine",
      range: "^3.0.0",
      cardinality: "one",
      providers: [{
        addonId: "rules-engine", contractVersion: "3.1.0",
        generation: "b".repeat(64), bindingRevision: 7,
      }],
      available: true,
      call: <TResponse>(method: string, params: unknown, options?: BrowserServiceCallOptions) =>
        call(method, params, options).then((result) => result as TResponse),
    };
    const connect = vi.fn(async () => handle);
    const services: BrowserServiceAPI = { connect };
    const registry = new BrowserContributionRegistry(
      undefined, undefined, undefined, () => services,
    );
    const sdk = registry.open(descriptor, new GenerationScope("isolated@generation"));
    const port = new FakePort();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      readyTimeoutMilliseconds: 60_000,
    });

    port.receive(request("connect-engine", "services.connect", {
      contract: "dnd5e.rules-engine", range: "^3.0.0", cardinality: "one", includeOwn: true,
    }));
    await vi.waitFor(() => expect(response(port, "connect-engine")).toMatchObject({
      ok: true,
      result: { serviceId: "service-1", available: true, providers: handle.providers },
    }));
    expect(connect).toHaveBeenCalledWith("dnd5e.rules-engine", {
      range: "^3.0.0", cardinality: "one", includeOwn: true, signal: expect.any(AbortSignal),
    });

    port.receive(request("bad-own-provider", "services.connect", { contract: "dnd5e.rules-engine", range: "^3.0.0", cardinality: "one", includeOwn: "true" }));
    await vi.waitFor(() => expect(response(port, "bad-own-provider")).toMatchObject({ ok: false }));
    expect(connect).toHaveBeenCalledTimes(1);

    port.receive(request("hydrate", "services.call", {
      serviceId: "service-1",
      method: "hydrate",
      params: { character: { id: "c1" } },
      options: { deadlineMs: 2000 },
    }));
    await vi.waitFor(() => expect(response(port, "hydrate")).toMatchObject({
      ok: true, result: { sheet: { level: 3 } },
    }));
    expect(call).toHaveBeenCalledWith(
      "hydrate",
      { character: { id: "c1" } },
      { deadlineMs: 2000, signal: expect.any(AbortSignal) },
    );
    bridge.close();
  });

  it("proxies generation-scoped data without exposing host fetch or credentials", async () => {
    const descriptor = frameDescriptor(slotContribution());
    const get = vi.fn(async () => ({ key: "note-1", revision: 2, value: { text: "Ruins" } }));
    const query = vi.fn(async () => ({ documents: [], nextCursor: "Mg" }));
    const transact = vi.fn(async () => ({
      contractVersion: "addon-data-commit.v1" as const,
      commitId: 4,
      occurredAt: "2026-09-01T12:00:00Z",
      results: [{
        kind: "collection" as const, dataId: "dm_notes", key: "note-1",
        beforeRevision: 1, afterRevision: 2, deleted: true,
      }],
      dataSets: [{ kind: "collection" as const, dataId: "dm_notes", revision: 2 }],
    }));
    const handle: AddonDataHandle<unknown> = { get, query, put: vi.fn(), delete: vi.fn() };
    const collection = vi.fn();
    const recordExtension = vi.fn();
    const dataAPI: BrowserDataAPI = {
      collection: <T>(id: string) => {
        collection(id);
        return handle as AddonDataHandle<T>;
      },
      recordExtension: <T>(target: string, id: string) => {
        recordExtension(target, id);
        return handle as AddonDataHandle<T>;
      },
      transact,
    };
    const registry = new BrowserContributionRegistry(undefined, () => dataAPI);
    const sdk = registry.open(descriptor, new GenerationScope("isolated@generation"));
    const port = new FakePort();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      readyTimeoutMilliseconds: 60_000,
    });

    // Data is available while activate(context) is still running, before ready.
    port.receive(request("get-note", "data.get", {
      kind: "collection", dataId: "dm_notes", key: "note-1",
    }));
    await vi.waitFor(() => expect(response(port, "get-note")).toMatchObject({
      ok: true,
      result: { key: "note-1", revision: 2, value: { text: "Ruins" } },
    }));
    expect(collection).toHaveBeenCalledWith("dm_notes");
    expect(get).toHaveBeenCalledWith("note-1", { signal: expect.any(AbortSignal) });

    port.receive(request("query-sheet", "data.query", {
      kind: "record-extension",
      dataId: "sheet_state",
      target: "characters",
      options: { limit: 10, where: [{ path: "/level", equals: 3 }], includeDataRevision: true, expectedDataRevision: 0 },
    }));
    await vi.waitFor(() => expect(response(port, "query-sheet")).toMatchObject({
      ok: true, result: { documents: [], nextCursor: "Mg" },
    }));
    expect(recordExtension).toHaveBeenCalledWith("characters", "sheet_state");
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      includeDataRevision: true, expectedDataRevision: 0,
      limit: 10,
      where: [{ path: "/level", equals: 3 }],
      signal: expect.any(AbortSignal),
    } as AddonQueryOptions));

    port.receive(request("delete-note", "data.transact", { mutations: [{
      operation: "delete", kind: "collection", dataId: "dm_notes",
      key: "note-1", expectedRevision: 1,
    }], expectedDataSets: [{ kind: "collection", dataId: "dm_notes", revision: 0 }] }));
    await vi.waitFor(() => expect(response(port, "delete-note")).toMatchObject({
      ok: true, result: { contractVersion: "addon-data-commit.v1", commitId: 4 },
    }));
    expect(transact).toHaveBeenCalledWith(expect.any(Array), {
      expectedDataSets: [{ kind: "collection", dataId: "dm_notes", revision: 0 }],
      signal: expect.any(AbortSignal),
    });
    bridge.close();
  });

  it("cancels an isolated data request without revoking its generation", async () => {
    const descriptor = frameDescriptor(slotContribution());
    const query = vi.fn((_options?: AddonQueryOptions) => new Promise<never>((_resolve, reject) => {
      _options?.signal?.addEventListener("abort", () =>
        reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const handle: AddonDataHandle<unknown> = {
      get: vi.fn(), query, put: vi.fn(), delete: vi.fn(),
    };
    const dataAPI: BrowserDataAPI = {
      collection: <T>() => handle as AddonDataHandle<T>,
      recordExtension: <T>() => handle as AddonDataHandle<T>,
      transact: vi.fn(),
    };
    const sdk = new BrowserContributionRegistry(undefined, () => dataAPI).open(
      descriptor,
      new GenerationScope("isolated@generation"),
    );
    const port = new FakePort();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      readyTimeoutMilliseconds: 60_000,
    });

    port.receive(request("slow-query", "data.query", {
      kind: "collection", dataId: "dm_notes", options: {},
    }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    port.receive({ protocol: isolatedFrameProtocol, type: "cancel-request", id: "slow-query" });
    await vi.waitFor(() => expect(response(port, "slow-query")).toMatchObject({
      ok: false,
      error: { code: "REQUEST_ABORTED" },
    }));
    expect(sdk.context.signal.aborted).toBe(false);
    bridge.close();
  });

  it("proxies immutable content during isolated activation", async () => {
    const descriptor = frameDescriptor(slotContribution());
    const catalog = vi.fn(async () => ({ sets: [] }));
    const get = vi.fn(async () => ({
      kind: "spell", id: "shield", value: { kind: "spell", id: "shield" },
    }));
    const query = vi.fn(async () => ({
      revision: "fixture-1", records: [], nextCursor: "Mg",
    }));
    const setHandle: AddonContentSet<unknown> = { get, query };
    const set = vi.fn();
    const contentAPI: BrowserContentAPI = {
      catalog,
      set: <T>(id: string) => {
        set(id);
        return setHandle as AddonContentSet<T>;
      },
    };
    const sdk = new BrowserContributionRegistry(undefined, undefined, () => contentAPI).open(
      descriptor,
      new GenerationScope("isolated@generation"),
    );
    const port = new FakePort();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      readyTimeoutMilliseconds: 60_000,
    });

    port.receive(request("catalog", "content.catalog", {}));
    await vi.waitFor(() => expect(response(port, "catalog")).toMatchObject({
      ok: true, result: { sets: [] },
    }));
    expect(catalog).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });

    port.receive(request("get-rule", "content.get", {
      setId: "rules", kind: "spell", id: "shield",
    }));
    await vi.waitFor(() => expect(response(port, "get-rule")).toMatchObject({
      ok: true, result: { kind: "spell", id: "shield" },
    }));
    expect(set).toHaveBeenCalledWith("rules");
    expect(get).toHaveBeenCalledWith("spell", "shield", { signal: expect.any(AbortSignal) });

    port.receive(request("query-rules", "content.query", {
      setId: "rules", options: { kind: "spell", limit: 20 },
    }));
    await vi.waitFor(() => expect(response(port, "query-rules")).toMatchObject({
      ok: true, result: { revision: "fixture-1", records: [], nextCursor: "Mg" },
    }));
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      kind: "spell", limit: 20, signal: expect.any(AbortSignal),
    } as AddonContentQueryOptions));
    bridge.close();
  });

  it("exposes the current read-only SDK authority over one bounded port", () => {
    const descriptor = frameDescriptor(slotContribution());
    const registry = new BrowserContributionRegistry();
    const sdk = registry.open(descriptor, new GenerationScope("isolated@generation"));
    const port = new FakePort();
    const diagnostics = vi.fn();
    const resize = vi.fn();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: resize,
      onDiagnostic: diagnostics,
      readyTimeoutMilliseconds: 60_000,
    });

    port.receive({
      protocol: isolatedFrameProtocol,
      type: "ready",
      contributionId: "tools.panel",
    });
    port.receive(request("capability", "capabilities.has", { capability: "ui.contributions" }));
    port.receive(request("permission", "permissions.has", {
      permission: "core.data.read",
      resource: "characters",
    }));
    port.receive(request("resources", "permissions.resources", {
      permission: "core.data.read",
    }));
    port.receive(request("declarations", "ui.declarations", {}));
    port.receive({ protocol: isolatedFrameProtocol, type: "resize", height: 480 });

    expect(port.sent.map((message) => (message as { result: unknown }).result)).toEqual([
      true,
      true,
      ["characters"],
      descriptor.contributions,
    ]);
    expect(resize).toHaveBeenCalledWith(480);
    expect(diagnostics).not.toHaveBeenCalled();
    bridge.close();
    expect(port.closed).toBe(true);
  });

  it("reports malformed or premature messages without invoking the SDK", () => {
    const descriptor = frameDescriptor(slotContribution());
    const registry = new BrowserContributionRegistry();
    const sdk = registry.open(descriptor, new GenerationScope("isolated@generation"));
    const port = new FakePort();
    const diagnostics = vi.fn();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      onDiagnostic: diagnostics,
      readyTimeoutMilliseconds: 60_000,
    });

    port.receive(request("early", "ui.declarations", {}));
    port.receive({ protocol: isolatedFrameProtocol, type: "ready", contributionId: "wrong" });
    port.receive({ protocol: isolatedFrameProtocol, type: "diagnostic", message: "module failed" });

    expect(port.sent).toEqual([]);
    expect(diagnostics).toHaveBeenCalledTimes(3);
    bridge.close();
  });

  it("rejects readiness immediately when module activation fails", async () => {
    const descriptor = frameDescriptor(slotContribution());
    const sdk = new BrowserContributionRegistry().open(
      descriptor,
      new GenerationScope("isolated@generation"),
    );
    const port = new FakePort();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      readyTimeoutMilliseconds: 60_000,
    });
    const ready = bridge.waitUntilReady();

    port.receive({
      protocol: isolatedFrameProtocol,
      type: "failed",
      message: "missing contribution binding",
    });

    await expect(ready).rejects.toThrow("missing contribution binding");
    expect(port.closed).toBe(true);
  });

  it("withdraws a contribution when its frame becomes unavailable", () => {
    const descriptor = frameDescriptor(slotContribution());
    const sdk = new BrowserContributionRegistry().open(
      descriptor,
      new GenerationScope("isolated@generation"),
    );
    const port = new FakePort();
    const unavailable = vi.fn();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      onUnavailable: unavailable,
      readyTimeoutMilliseconds: 60_000,
    });
    port.receive({
      protocol: isolatedFrameProtocol,
      type: "ready",
      contributionId: "tools.panel",
    });

    port.receive({
      protocol: isolatedFrameProtocol,
      type: "unavailable",
      contributionId: "tools.panel",
    });

    expect(unavailable).toHaveBeenCalledOnce();
    expect(port.closed).toBe(true);
  });

  it("revokes a frame that never completes the handshake", async () => {
    vi.useFakeTimers();
    try {
      const descriptor = frameDescriptor(slotContribution());
      const registry = new BrowserContributionRegistry();
      const sdk = registry.open(descriptor, new GenerationScope("isolated@generation"));
      const port = new FakePort();
      const diagnostics = vi.fn();
      const bridge = new IsolatedFrameBridge({
        port,
        context: sdk.context,
        contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
        onResize: vi.fn(),
        onDiagnostic: diagnostics,
        readyTimeoutMilliseconds: 100,
      });
      const ready = bridge.waitUntilReady();

      vi.advanceTimersByTime(100);

      await expect(ready).rejects.toThrow("handshake");
      expect(diagnostics).toHaveBeenCalledOnce();
      expect(port.sent).toContainEqual({
        protocol: isolatedFrameProtocol,
        type: "revoke",
        reason: "handshake-timeout",
      });
      expect(port.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs one bounded callback and resolves its JSON result", async () => {
    const descriptor = frameDescriptor({
      ...slotContribution(),
      id: "tools.action",
      surface: "article-action",
    });
    const sdk = new BrowserContributionRegistry().open(
      descriptor,
      new GenerationScope("isolated@generation"),
    );
    const port = new FakePort();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      readyTimeoutMilliseconds: 60_000,
    });
    port.receive({
      protocol: isolatedFrameProtocol,
      type: "ready",
      contributionId: "tools.action",
    });

    const result = bridge.invoke(
      { recordId: "character-1" },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(
      port.sent.some((message) => (message as { type?: string }).type === "invoke"),
    ).toBe(true));
    const invocation = port.sent.find(
      (message) => (message as { type?: string }).type === "invoke",
    ) as { id: string };
    port.receive({
      protocol: isolatedFrameProtocol,
      type: "result",
      id: invocation.id,
      ok: true,
      result: { opened: true },
    });

    await expect(result).resolves.toEqual({ opened: true });
    bridge.close();
  });

  it("forwards caller cancellation to an active callback", async () => {
    const descriptor = frameDescriptor({
      ...slotContribution(),
      id: "tools.graph",
      surface: "graph-view",
    });
    const sdk = new BrowserContributionRegistry().open(
      descriptor,
      new GenerationScope("isolated@generation"),
    );
    const port = new FakePort();
    const bridge = new IsolatedFrameBridge({
      port,
      context: sdk.context,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      onResize: vi.fn(),
      readyTimeoutMilliseconds: 60_000,
    });
    port.receive({
      protocol: isolatedFrameProtocol,
      type: "ready",
      contributionId: "tools.graph",
    });
    const caller = new AbortController();
    const result = bridge.invoke({ graphId: "story" }, caller.signal);
    await vi.waitFor(() => expect(
      port.sent.some((message) => (message as { type?: string }).type === "invoke"),
    ).toBe(true));
    const invocation = port.sent.find(
      (message) => (message as { type?: string }).type === "invoke",
    ) as { id: string };

    caller.abort("host-cancelled");

    await expect(result).rejects.toBe("host-cancelled");
    expect(port.sent).toContainEqual({
      protocol: isolatedFrameProtocol,
      type: "cancel",
      id: invocation.id,
    });
    bridge.close();
  });

  it("cancels a callback that exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const descriptor = frameDescriptor({
        ...slotContribution(),
        id: "tools.action",
        surface: "article-action",
      });
      const sdk = new BrowserContributionRegistry().open(
        descriptor,
        new GenerationScope("isolated@generation"),
      );
      const port = new FakePort();
      const bridge = new IsolatedFrameBridge({
        port,
        context: sdk.context,
        contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
        onResize: vi.fn(),
        readyTimeoutMilliseconds: 60_000,
        invocationTimeoutMilliseconds: 100,
      });
      port.receive({
        protocol: isolatedFrameProtocol,
        type: "ready",
        contributionId: "tools.action",
      });
      const result = bridge.invoke({}, new AbortController().signal);
      const assertion = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });

      await vi.advanceTimersByTimeAsync(100);

      await assertion;
      const invocation = port.sent.find(
        (message) => (message as { type?: string }).type === "invoke",
      ) as { id: string };
      expect(port.sent).toContainEqual({
        protocol: isolatedFrameProtocol,
        type: "cancel",
        id: invocation.id,
      });
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isolated frame activation", () => {
  it("loads reviewed assets in the host and connects one generated srcdoc", async () => {
    const descriptor = {
      ...frameDescriptor(slotContribution()),
      styleUrls: [
        `/api/addons/isolated-tools/generations/${generationId}/assets/web/frame.css`,
      ],
    };
    const registry = new BrowserContributionRegistry();
    const scope = new GenerationScope("isolated@generation");
    const sdk = registry.open(descriptor, scope);
    const frame = new FakeFrame();
    const host = new FakeFrameHost();
    const fetchAsset = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      const css = url.endsWith(".css");
      const moduleSource = `${" ".repeat(70 * 1024)}export function activate() {}`;
      return new Response(css ? ":root { color: black; }" : moduleSource, {
        status: 200,
        headers: { "Content-Type": css ? "text/css" : "text/javascript" },
      });
    });
    const dispose = mountIsolatedFrame({
      document: { createElement: () => frame } as unknown as Document,
      host: host as unknown as HTMLElement,
      descriptor,
      contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
      context: sdk.context,
      fetchAsset,
    });

    expect(frame.src).toBe("");
    expect(frame.srcdoc).toContain("codex-addon-root");
    expect(frame.attributes.get("sandbox")).toBe("allow-scripts");
    frame.dispatch("load");
    await vi.waitFor(() => expect(frame.windowMessages).toHaveLength(1));

    const connection = frame.windowMessages[0];
    expect(connection?.message).toEqual({
      protocol: isolatedFrameProtocol,
      type: "connect",
    });
    const framePort = connection?.transfer[0] as MessagePort;
    const activation = await new Promise<{
      moduleSource: string;
      styleSources: string[];
    }>((resolve) => {
      framePort.addEventListener("message", (event) => resolve(event.data), { once: true });
      framePort.start();
    });
    expect(activation.moduleSource).toContain("activate");
    expect(activation.styleSources).toEqual([":root { color: black; }"]);
    expect(fetchAsset).toHaveBeenCalledTimes(2);
    expect(fetchAsset.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "force-cache",
    });

    dispose();
    framePort.close();
    expect(frame.removed).toBe(true);
  });

  it("binds visual declarations without importing frame code into the host realm", async () => {
    const descriptor = frameDescriptor(slotContribution());
    const registry = new BrowserContributionRegistry();
    const manager = new BrowserGenerationManager(createIsolatedFrameActivator(
      {} as Document,
      registry,
    ));

    const result = await manager.reconcile({
      contractVersion: 2,
      graphRevision: "b".repeat(64),
      addons: [descriptor],
    });

    expect(result.activationFailures).toEqual([]);
    expect(registry.list("slot", "dm")[0]?.binding.kind).toBe("isolated-frame");
    await manager.dispose("disabled");
    expect(registry.list("slot", "dm")).toEqual([]);
  });

  it("publishes a headless isolated action only after its frame is ready", async () => {
    const descriptor = frameDescriptor({
      ...slotContribution(),
      id: "tools.action",
      surface: "article-action",
    });
    const registry = new BrowserContributionRegistry();
    const invoke = vi.fn(async () => ({ opened: true }));
    const dispose = vi.fn();
    const createRuntime: IsolatedFrameRuntimeFactory = vi.fn(() => ({
      bridge: {
        waitUntilReady: vi.fn(async () => undefined),
        invoke,
      },
      dispose,
    }));
    const backgroundHost = new FakeBackgroundHost();
    const document = {
      body: { append: vi.fn() },
      createElement: vi.fn(() => backgroundHost),
    } as unknown as Document;
    const manager = new BrowserGenerationManager(createIsolatedFrameActivator(
      document,
      registry,
      vi.fn(),
      createRuntime,
    ));

    const result = await manager.reconcile({
      contractVersion: 2,
      graphRevision: "c".repeat(64),
      addons: [descriptor],
    });

    expect(result.activationFailures).toEqual([]);
    const active = registry.list("article-action", "dm")[0]?.binding;
    expect(active?.kind).toBe("action");
    if (active?.kind === "action") {
      await expect(active.run(
        { recordId: "character-1" },
        { signal: new AbortController().signal },
      )).resolves.toEqual({ opened: true });
    }
    expect(invoke).toHaveBeenCalledWith(
      { recordId: "character-1" },
      expect.any(AbortSignal),
    );
    await manager.dispose("disabled");
    expect(dispose).toHaveBeenCalledOnce();
    expect(backgroundHost.removed).toBe(true);
  });

  it("never grants same-origin access through iframe sandbox tokens", () => {
    expect(isolatedSandboxTokens(["forms", "popups", "downloads"])).toEqual([
      "allow-scripts",
      "allow-forms",
      "allow-popups",
      "allow-downloads",
    ]);
    expect(isolatedSandboxTokens(["modals"])).not.toContain("allow-same-origin");
    const document = isolatedFrameDocument([]);
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("data: addonData");
    expect(document).toContain('"data.transact"');
    expect(document).toContain('"content.query"');
    expect(document).toContain('"services.connect"');
    expect(document).toContain('"services.call"');
    expect(document).toContain("content: addonContent");
    expect(document).toContain("services: addonServices");
    expect(document).not.toContain("allow-same-origin");
    const source = document.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(source).toBeDefined();
    expect(() => new Function(source as string)).not.toThrow();
  });
});

class FakePort implements IsolatedMessagePort {
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent<unknown>) => void>>();
  closed = false;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  addEventListener(type: "message" | "messageerror", listener: (event: MessageEvent<unknown>) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "message" | "messageerror", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  receive(data: unknown): void {
    const event = { data } as MessageEvent<unknown>;
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event);
    }
  }
}

class FakeFrameHost {
  child: FakeFrame | undefined;

  replaceChildren(frame?: FakeFrame): void {
    this.child = frame;
  }
}

class FakeBackgroundHost extends FakeFrameHost {
  readonly dataset: Record<string, string> = {};
  hidden = false;
  removed = false;

  setAttribute(): void {}

  remove(): void {
    this.removed = true;
  }
}

class FakeFrame {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<{ listener: () => void; once: boolean }>>();
  readonly style: Record<string, string> = {};
  readonly windowMessages: Array<{ message: unknown; transfer: Transferable[] }> = [];
  readonly contentWindow = {
    postMessage: (message: unknown, _target: string, transfer: Transferable[]) => {
      this.windowMessages.push({ message, transfer });
    },
  };
  className = "";
  referrerPolicy = "";
  src = "";
  srcdoc = "";
  title = "";
  removed = false;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: options?.once === true });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener),
    );
  }

  dispatch(type: string): void {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const entry of listeners) {
      entry.listener();
      if (entry.once) {
        this.removeEventListener(type, entry.listener);
      }
    }
  }

  remove(): void {
    this.removed = true;
  }
}

function request(id: string, method: string, params: Record<string, unknown>): unknown {
  return { protocol: isolatedFrameProtocol, type: "request", id, method, params };
}

function response(port: FakePort, id: string): unknown {
  return port.sent.find((message) =>
    (message as { type?: string; id?: string }).type === "response" &&
    (message as { id?: string }).id === id);
}

function frameDescriptor(contribution: BrowserContributionDescriptor): BrowserGenerationDescriptor {
  return {
    addonId: "isolated-tools",
    addonVersion: "1.0.0",
    generationId,
    mode: "isolated",
    entryUrl: `/api/addons/isolated-tools/generations/${generationId}/assets/web/frame.js`,
    styleUrls: [],
    sandbox: [],
    dependencies: [],
    capabilities: ["ui.contributions"],
    permissions: [{ id: "core.data.read", resources: ["characters"] }],
    contributions: [contribution],
  };
}

function slotContribution(): BrowserContributionDescriptor {
  return {
    id: "tools.panel",
    surface: "slot",
    label: "Isolated tools",
    roles: ["dm"],
    order: 10,
    requires: ["ui.contributions"],
    config: {},
  };
}
