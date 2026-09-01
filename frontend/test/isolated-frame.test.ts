import { describe, expect, it, vi } from "vitest";
import { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import {
  IsolatedFrameBridge,
  createIsolatedFrameActivator,
  isolatedFrameDocument,
  isolatedFrameProtocol,
  isolatedSandboxTokens,
  mountIsolatedFrame,
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

  it("revokes a frame that never completes the handshake", () => {
    vi.useFakeTimers();
    try {
      const descriptor = frameDescriptor(slotContribution());
      const registry = new BrowserContributionRegistry();
      const sdk = registry.open(descriptor, new GenerationScope("isolated@generation"));
      const port = new FakePort();
      const diagnostics = vi.fn();
      new IsolatedFrameBridge({
        port,
        context: sdk.context,
        contribution: descriptor.contributions[0] as BrowserContributionDescriptor,
        onResize: vi.fn(),
        onDiagnostic: diagnostics,
        readyTimeoutMilliseconds: 100,
      });

      vi.advanceTimersByTime(100);

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
      return new Response(css ? ":root { color: black; }" : "export function activate() {}", {
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

  it("rejects isolated declarations that require non-visual host callbacks", async () => {
    const descriptor = frameDescriptor({
      ...slotContribution(),
      id: "tools.action",
      surface: "article-action",
    });
    const registry = new BrowserContributionRegistry();
    const manager = new BrowserGenerationManager(createIsolatedFrameActivator(
      {} as Document,
      registry,
    ));

    const result = await manager.reconcile({
      contractVersion: 2,
      graphRevision: "c".repeat(64),
      addons: [descriptor],
    });

    expect(result.activationFailures).toHaveLength(1);
    expect(registry.list("article-action", "dm")).toEqual([]);
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
