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

const generationId = "a".repeat(64);

describe("IsolatedFrameBridge", () => {
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
