import { BoundaryValidationError } from "../core/boundary.js";
import type {
  BrowserAddonContext,
  BrowserContributionRegistry,
  BrowserIsolatedFrameBinding,
} from "./browser-sdk.js";
import type {
  BrowserContributionDescriptor,
  BrowserGenerationActivator,
  BrowserGenerationDescriptor,
} from "./generation-manager.js";
import type { Disposer } from "./generation-scope.js";
import {
  IsolatedFrameBridge,
  IsolatedInvocationError,
  isolatedFrameProtocol,
  waitForSignal,
  type IsolatedSDKMethod,
} from "./isolated-bridge.js";
import { isolatedFrameBootstrap } from "./isolated-frame-bootstrap.js";
export {
  IsolatedFrameBridge,
  IsolatedInvocationError,
  isolatedFrameProtocol,
} from "./isolated-bridge.js";
export type { IsolatedMessagePort, IsolatedSDKMethod } from "./isolated-bridge.js";

const boundary = "isolated browser add-on bridge";
const maximumModuleBytes = 2 * 1024 * 1024;
const maximumStyleBytes = 512 * 1024;
const maximumStyleTotalBytes = 2 * 1024 * 1024;

export interface IsolatedFrameMountOptions {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly descriptor: BrowserGenerationDescriptor;
  readonly contribution: BrowserContributionDescriptor;
  readonly context: BrowserAddonContext;
  readonly hostContext?: unknown;
  readonly onDiagnostic?: (cause: unknown) => void;
  readonly onUnavailable?: () => void;
  readonly fetchAsset?: typeof fetch;
}

export interface IsolatedRuntimeBridge {
  waitUntilReady(signal?: AbortSignal): Promise<void>;
  invoke(request: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface IsolatedFrameRuntime {
  readonly bridge: IsolatedRuntimeBridge;
  updateHostContext?(value: unknown): void;
  dispose(): void;
}

export type IsolatedFrameRuntimeFactory = (
  options: IsolatedFrameMountOptions,
) => IsolatedFrameRuntime;

interface IsolatedFrameAssets {
  readonly moduleSource: string;
  readonly styleSources: readonly string[];
}

export function createIsolatedFrameActivator(
  document: Document,
  registry: BrowserContributionRegistry,
  onDiagnostic: (cause: unknown) => void = () => undefined,
  createRuntime: IsolatedFrameRuntimeFactory = createIsolatedFrameRuntime,
): BrowserGenerationActivator {
  return async (descriptor, activation) => {
    if (descriptor.mode !== "isolated") {
      throw new TypeError(`browser add-on ${descriptor.addonId} is not an isolated frame`);
    }
    const sdk = registry.open(descriptor, activation.scope);
    for (const contribution of sdk.context.ui.declarations()) {
      if (contribution.surface === "sidebar") {
        sdk.publishDeclarative(contribution.id);
        continue;
      }
      if (contribution.surface === "article-action" ||
        contribution.surface === "graph-view" ||
        contribution.surface === "graph-contributor") {
        let unavailable = false;
        let registration: { dispose(): void } | undefined;
        const host = document.createElement("div");
        host.hidden = true;
        host.setAttribute("aria-hidden", "true");
        host.dataset["isolatedAddon"] = descriptor.addonId;
        host.dataset["isolatedContribution"] = contribution.id;
        document.body.append(host);
        let runtime: IsolatedFrameRuntime;
        try {
          runtime = createRuntime({
            document,
            host,
            descriptor,
            contribution,
            context: sdk.context,
            onDiagnostic,
            onUnavailable: () => {
              unavailable = true;
              registration?.dispose();
            },
          });
        } catch (cause: unknown) {
          host.remove();
          throw cause;
        }
        const disposeRuntime = () => {
          runtime.dispose();
          host.remove();
        };
        activation.scope.add(`isolated callback ${contribution.id}`, disposeRuntime);
        await runtime.bridge.waitUntilReady(activation.signal);
        if (contribution.surface === "article-action") {
          registration = sdk.bindIsolatedCallback(contribution.id, {
            kind: "action",
            run: (request, invocation) => runtime.bridge.invoke(request, invocation.signal),
          });
        } else {
          registration = sdk.bindIsolatedCallback(contribution.id, {
            kind: "model-provider",
            provide: (request, invocation) => runtime.bridge.invoke(request, invocation.signal),
          });
        }
        if (unavailable) {
          registration.dispose();
          throw new BoundaryValidationError(boundary, "isolated callback became unavailable during activation");
        }
        continue;
      }
      let unavailable = false;
      let registration: { dispose(): void } | undefined;
      registration = sdk.bindIsolated(contribution.id, {
        kind: "isolated-frame",
        mount: (host, hostContext) => {
          const runtime = createRuntime({
          document,
          host,
          descriptor,
          contribution,
          context: sdk.context,
          hostContext,
          onDiagnostic,
          onUnavailable: () => {
            unavailable = true;
            registration?.dispose();
          },
          });
          return { dispose: () => runtime.dispose(), updateHostContext: (value: unknown) => runtime.updateHostContext?.(value) };
        },
      });
      if (unavailable) {
        registration.dispose();
      }
    }
    return () => sdk.dispose();
  };
}

export function mountIsolatedFrame(options: IsolatedFrameMountOptions): Disposer {
  return createIsolatedFrameRuntime(options).dispose;
}

export function createIsolatedFrameRuntime(
  options: IsolatedFrameMountOptions,
): IsolatedFrameRuntime {
  let hostContext: unknown = options.hostContext ?? null;
  options.context.signal.throwIfAborted();
  const frame = options.document.createElement("iframe");
  frame.className = "codex-isolated-addon-frame";
  frame.title = options.contribution.label;
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("sandbox", isolatedSandboxTokens(options.descriptor.sandbox).join(" "));
  frame.setAttribute("loading", "eager");
  frame.srcdoc = isolatedFrameDocument(options.descriptor.sandbox);
  const assetController = new AbortController();
  const assets = loadIsolatedFrameAssets(
    options.descriptor,
    assetController.signal,
    options.fetchAsset ?? fetch,
  ).then(
    (value) => ({ ok: true as const, value }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );
  let bridge: IsolatedFrameBridge | undefined;
  let resolveBridge: (bridge: IsolatedFrameBridge) => void = () => undefined;
  let rejectBridge: (cause: unknown) => void = () => undefined;
  const bridgePromise = new Promise<IsolatedFrameBridge>((resolve, reject) => {
    resolveBridge = resolve;
    rejectBridge = reject;
  });
  void bridgePromise.catch(() => undefined);
  let disposed = false;
  let loadTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const connect = async () => {
    if (disposed) {
      return;
    }
    if (loadTimer !== undefined) {
      globalThis.clearTimeout(loadTimer);
      loadTimer = undefined;
    }
    try {
      const target = frame.contentWindow;
      if (target === null) {
        throw new BoundaryValidationError(boundary, "frame window is unavailable");
      }
      const channel = new MessageChannel();
      const connectedBridge = new IsolatedFrameBridge({
        port: channel.port1,
        context: options.context,
        contribution: options.contribution,
        onResize: (height) => {
          frame.style.height = `${height}px`;
        },
        onDiagnostic: options.onDiagnostic ?? (() => undefined),
        ...(options.onUnavailable === undefined
          ? {}
          : { onUnavailable: options.onUnavailable }),
      });
      bridge = connectedBridge;
      resolveBridge(connectedBridge);
      target.postMessage({ protocol: isolatedFrameProtocol, type: "connect" }, "*", [channel.port2]);
      const loaded = await assets;
      if (disposed || options.context.signal.aborted) {
        return;
      }
      if (!loaded.ok) {
        throw loaded.cause;
      }
      connectedBridge.activate(activationMessage({ ...options, hostContext }, loaded.value));
    } catch (cause: unknown) {
      if (!disposed && !options.context.signal.aborted) {
        options.onDiagnostic?.(cause);
        bridge?.failActivation(cause);
        rejectBridge(cause);
        dispose();
      }
    }
  };
  const loaded = () => void connect();
  const failed = () => {
    if (disposed) {
      return;
    }
    const cause = new BoundaryValidationError(boundary, "frame document failed to load");
    options.onDiagnostic?.(cause);
    rejectBridge(cause);
    dispose();
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (loadTimer !== undefined) {
      globalThis.clearTimeout(loadTimer);
      loadTimer = undefined;
    }
    const cause = new IsolatedInvocationError(
      "REVOKED",
      "The isolated add-on contribution is no longer active.",
    );
    rejectBridge(cause);
    options.context.signal.removeEventListener("abort", dispose);
    frame.removeEventListener("load", loaded);
    frame.removeEventListener("error", failed);
    assetController.abort("frame-disposed");
    bridge?.close(options.context.signal.aborted ? "authority-changed" : "outlet-disposed");
    bridge = undefined;
    frame.remove();
  };
  frame.addEventListener("load", loaded, { once: true });
  frame.addEventListener("error", failed);
  options.context.signal.addEventListener("abort", dispose, { once: true });
  loadTimer = globalThis.setTimeout(failed, 5_000);
  try {
    options.host.replaceChildren(frame);
  } catch (cause: unknown) {
    dispose();
    throw cause;
  }
  const runtimeBridge: IsolatedRuntimeBridge = Object.freeze({
    waitUntilReady: async (signal?: AbortSignal) => {
      const connected = signal === undefined
        ? await bridgePromise
        : await waitForSignal(bridgePromise, signal);
      await connected.waitUntilReady(signal);
    },
    invoke: async (request: unknown, signal: AbortSignal) => {
      const connected = await waitForSignal(bridgePromise, signal);
      return connected.invoke(request, signal);
    },
  });
  return Object.freeze({ bridge: runtimeBridge, dispose, updateHostContext: (value: unknown) => {
    if (disposed) return;
    hostContext = value;
    bridge?.updateHostContext(value);
  } });
}

export function isolatedSandboxTokens(
  grants: BrowserGenerationDescriptor["sandbox"],
): readonly string[] {
  const tokens = ["allow-scripts"];
  const mapping: Readonly<Record<BrowserGenerationDescriptor["sandbox"][number], string>> = {
    downloads: "allow-downloads",
    forms: "allow-forms",
    modals: "allow-modals",
    popups: "allow-popups",
  };
  for (const grant of grants) {
    tokens.push(mapping[grant]);
  }
  return tokens;
}

function activationMessage(
  options: IsolatedFrameMountOptions,
  assets: IsolatedFrameAssets,
): unknown {
  return {
    protocol: isolatedFrameProtocol,
    type: "activate",
    addon: options.context.addon,
    contribution: options.contribution,
    hostContext: options.hostContext ?? null,
    declarations: [options.contribution],
    capabilities: [...options.descriptor.capabilities],
    permissions: options.descriptor.permissions.map((permission) => ({
      id: permission.id,
      resources: [...permission.resources],
    })),
    moduleSource: assets.moduleSource,
    styleSources: [...assets.styleSources],
    methods: [
      "capabilities.has",
      "permissions.has",
      "permissions.resources",
      "ui.declarations",
    ] satisfies IsolatedSDKMethod[],
  };
}

async function loadIsolatedFrameAssets(
  descriptor: BrowserGenerationDescriptor,
  signal: AbortSignal,
  fetchAsset: typeof fetch,
): Promise<IsolatedFrameAssets> {
  const moduleSource = await readIsolatedAsset(
    descriptor.entryUrl,
    "text/javascript",
    maximumModuleBytes,
    signal,
    fetchAsset,
  );
  const styleSources = await Promise.all(descriptor.styleUrls.map((url) =>
    readIsolatedAsset(url, "text/css", maximumStyleBytes, signal, fetchAsset)
  ));
  const totalStyleBytes = styleSources.reduce(
    (total, source) => total + new TextEncoder().encode(source).byteLength,
    0,
  );
  if (totalStyleBytes > maximumStyleTotalBytes) {
    throw new BoundaryValidationError(boundary, "isolated styles exceed 2 MiB");
  }
  return { moduleSource, styleSources };
}

async function readIsolatedAsset(
  url: string,
  expectedContentType: "text/javascript" | "text/css",
  maximumBytes: number,
  signal: AbortSignal,
  fetchAsset: typeof fetch,
): Promise<string> {
  const response = await fetchAsset(url, {
    method: "GET",
    headers: { Accept: expectedContentType },
    credentials: "same-origin",
    cache: "force-cache",
    signal,
  });
  if (!response.ok) {
    throw new BoundaryValidationError(boundary, `asset request returned ${response.status}`);
  }
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== expectedContentType) {
    throw new BoundaryValidationError(boundary, `asset must be ${expectedContentType}`);
  }
  const source = await response.text();
  if (new TextEncoder().encode(source).byteLength > maximumBytes) {
    throw new BoundaryValidationError(boundary, "isolated asset exceeds its browser limit");
  }
  return source;
}

export function isolatedFrameDocument(
  grants: BrowserGenerationDescriptor["sandbox"],
): string {
  const formAction = grants.includes("forms") ? "http: https:" : "'none'";
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${formAction}`,
  ].join("; ");
  return "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    "</head><body><div id=\"codex-addon-root\"></div><script>" +
    isolatedFrameBootstrap +
    "</script></body></html>";
}
