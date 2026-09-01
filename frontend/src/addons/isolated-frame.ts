import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";
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

export const isolatedFrameProtocol = "codex.browser-addon/1";

const boundary = "isolated browser add-on bridge";
const maximumMessageBytes = 64 * 1024;
const maximumModuleBytes = 2 * 1024 * 1024;
const maximumStyleBytes = 512 * 1024;
const maximumStyleTotalBytes = 2 * 1024 * 1024;
const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const readyKeys = new Set(["protocol", "type", "contributionId"]);
const requestKeys = new Set(["protocol", "type", "id", "method", "params"]);
const resizeKeys = new Set(["protocol", "type", "height"]);
const diagnosticKeys = new Set(["protocol", "type", "message"]);
const capabilityKeys = new Set(["capability"]);
const permissionKeys = new Set(["permission", "resource"]);
const permissionResourceKeys = new Set(["permission"]);
const noParameterKeys = new Set<string>();

export type IsolatedSDKMethod =
  | "capabilities.has"
  | "permissions.has"
  | "permissions.resources"
  | "ui.declarations";

export interface IsolatedMessagePort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
  start(): void;
  close(): void;
}

export interface IsolatedFrameBridgeOptions {
  readonly port: IsolatedMessagePort;
  readonly context: BrowserAddonContext;
  readonly contribution: BrowserContributionDescriptor;
  readonly onResize: (height: number) => void;
  readonly onDiagnostic?: (cause: unknown) => void;
  readonly readyTimeoutMilliseconds?: number;
}

export interface IsolatedFrameMountOptions {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly descriptor: BrowserGenerationDescriptor;
  readonly contribution: BrowserContributionDescriptor;
  readonly context: BrowserAddonContext;
  readonly onDiagnostic?: (cause: unknown) => void;
  readonly fetchAsset?: typeof fetch;
}

interface IsolatedFrameAssets {
  readonly moduleSource: string;
  readonly styleSources: readonly string[];
}

export function createIsolatedFrameActivator(
  document: Document,
  registry: BrowserContributionRegistry,
  onDiagnostic: (cause: unknown) => void = () => undefined,
): BrowserGenerationActivator {
  return (descriptor, activation) => {
    if (descriptor.mode !== "isolated") {
      throw new TypeError(`browser add-on ${descriptor.addonId} is not an isolated frame`);
    }
    const sdk = registry.open(descriptor, activation.scope);
    for (const contribution of sdk.context.ui.declarations()) {
      if (contribution.surface === "sidebar") {
        sdk.publishDeclarative(contribution.id);
        continue;
      }
      sdk.bindIsolated(contribution.id, {
        kind: "isolated-frame",
        mount: (host) => mountIsolatedFrame({
          document,
          host,
          descriptor,
          contribution,
          context: sdk.context,
          onDiagnostic,
        }),
      });
    }
    return () => sdk.dispose();
  };
}

/** Owns one transferred port. The opaque frame never receives a host DOM handle. */
export class IsolatedFrameBridge {
  readonly #port: IsolatedMessagePort;
  readonly #context: BrowserAddonContext;
  readonly #contribution: BrowserContributionDescriptor;
  readonly #onResize: (height: number) => void;
  readonly #onDiagnostic: (cause: unknown) => void;
  readonly #message = (event: MessageEvent<unknown>) => this.#receive(event.data);
  readonly #messageError = () => this.#fail(
    new BoundaryValidationError(boundary, "message could not be decoded"),
  );
  readonly #abort = () => this.close("authority-changed");
  readonly #readyTimer: ReturnType<typeof globalThis.setTimeout>;
  #ready = false;
  #closed = false;

  constructor(options: IsolatedFrameBridgeOptions) {
    this.#port = options.port;
    this.#context = options.context;
    this.#contribution = options.contribution;
    this.#onResize = options.onResize;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#port.addEventListener("message", this.#message);
    this.#port.addEventListener("messageerror", this.#messageError);
    this.#port.start();
    this.#context.signal.addEventListener("abort", this.#abort, { once: true });
    const timeout = options.readyTimeoutMilliseconds ?? 5_000;
    this.#readyTimer = globalThis.setTimeout(() => {
      if (!this.#ready && !this.#closed) {
        this.#fail(new BoundaryValidationError(boundary, "frame did not complete its handshake"));
        this.close("handshake-timeout");
      }
    }, timeout);
  }

  close(reason = "outlet-disposed"): void {
    if (this.#closed) {
      return;
    }
    try {
      this.#port.postMessage({ protocol: isolatedFrameProtocol, type: "revoke", reason });
    } catch (cause: unknown) {
      this.#onDiagnostic(cause);
    }
    this.#closed = true;
    globalThis.clearTimeout(this.#readyTimer);
    this.#context.signal.removeEventListener("abort", this.#abort);
    this.#port.removeEventListener("message", this.#message);
    this.#port.removeEventListener("messageerror", this.#messageError);
    this.#port.close();
  }

  activate(message: unknown): void {
    if (!isRecord(message) || message["protocol"] !== isolatedFrameProtocol ||
      message["type"] !== "activate") {
      throw new BoundaryValidationError(boundary, "activation has an invalid protocol envelope");
    }
    this.#send(message);
  }

  #receive(value: unknown): void {
    if (this.#closed) {
      return;
    }
    try {
      assertBoundedMessage(value);
      if (!isRecord(value) || value["protocol"] !== isolatedFrameProtocol) {
        throw new BoundaryValidationError(boundary, "message has an invalid protocol envelope");
      }
      if (value["type"] === "ready") {
        this.#acceptReady(value);
        return;
      }
      if (value["type"] === "diagnostic") {
        this.#acceptDiagnostic(value);
        return;
      }
      if (!this.#ready) {
        throw new BoundaryValidationError(boundary, "frame sent a message before ready");
      }
      if (value["type"] === "resize") {
        this.#acceptResize(value);
        return;
      }
      if (value["type"] === "request") {
        void this.#answer(value);
        return;
      }
      throw new BoundaryValidationError(boundary, "message type is unsupported");
    } catch (cause: unknown) {
      this.#fail(cause);
    }
  }

  #acceptReady(value: Readonly<Record<string, unknown>>): void {
    if (this.#ready || !hasOnlyKeys(value, readyKeys) ||
      value["contributionId"] !== this.#contribution.id) {
      throw new BoundaryValidationError(boundary, "ready message has an invalid shape");
    }
    this.#ready = true;
    globalThis.clearTimeout(this.#readyTimer);
  }

  #acceptResize(value: Readonly<Record<string, unknown>>): void {
    const height = value["height"];
    if (!hasOnlyKeys(value, resizeKeys) || typeof height !== "number" ||
      !Number.isSafeInteger(height) || height < 120 || height > 2_400) {
      throw new BoundaryValidationError(boundary, "resize message has an invalid height");
    }
    this.#onResize(height);
  }

  #acceptDiagnostic(value: Readonly<Record<string, unknown>>): void {
    const message = value["message"];
    if (!hasOnlyKeys(value, diagnosticKeys) || typeof message !== "string" ||
      message.length === 0 || message.length > 500) {
      throw new BoundaryValidationError(boundary, "diagnostic message has an invalid shape");
    }
    this.#onDiagnostic(new Error(`isolated add-on reported: ${message}`));
  }

  async #answer(value: Readonly<Record<string, unknown>>): Promise<void> {
    const id = value["id"];
    try {
      if (!hasOnlyKeys(value, requestKeys) || typeof id !== "string" ||
        !requestIdPattern.test(id) || typeof value["method"] !== "string" ||
        !isRecord(value["params"])) {
        throw new BoundaryValidationError(boundary, "request has an invalid shape");
      }
      const result = this.#invoke(value["method"], value["params"]);
      this.#send({ protocol: isolatedFrameProtocol, type: "response", id, ok: true, result });
    } catch (cause: unknown) {
      this.#onDiagnostic(cause);
      if (typeof id === "string" && requestIdPattern.test(id)) {
        this.#send({
          protocol: isolatedFrameProtocol,
          type: "response",
          id,
          ok: false,
          error: {
            code: this.#context.signal.aborted ? "AUTHORITY_REVOKED" : "INVALID_REQUEST",
            message: this.#context.signal.aborted
              ? "The add-on generation is no longer active."
              : "The isolated SDK request is invalid.",
          },
        });
      }
    }
  }

  #invoke(method: string, params: Readonly<Record<string, unknown>>): unknown {
    this.#context.signal.throwIfAborted();
    switch (method as IsolatedSDKMethod) {
      case "capabilities.has": {
        const capability = exactStringParameter(params, capabilityKeys, "capability");
        return this.#context.capabilities.has(capability);
      }
      case "permissions.has": {
        if (!hasOnlyKeys(params, permissionKeys)) {
          throw new BoundaryValidationError(boundary, "permissions.has parameters are invalid");
        }
        const permission = boundedString(params["permission"], "permission");
        const resource = params["resource"] === undefined
          ? undefined
          : boundedString(params["resource"], "resource");
        return this.#context.permissions.has(permission, resource);
      }
      case "permissions.resources": {
        const permission = exactStringParameter(params, permissionResourceKeys, "permission");
        return this.#context.permissions.resources(permission);
      }
      case "ui.declarations":
        if (!hasOnlyKeys(params, noParameterKeys)) {
          throw new BoundaryValidationError(boundary, "ui.declarations parameters are invalid");
        }
        // An opaque frame sees only the declaration represented by that frame.
        return [this.#contribution];
      default:
        throw new BoundaryValidationError(boundary, "SDK method is unsupported");
    }
  }

  #send(value: unknown): void {
    if (this.#closed || this.#context.signal.aborted) {
      return;
    }
    assertBoundedMessage(value);
    this.#port.postMessage(value);
  }

  #fail(cause: unknown): void {
    this.#onDiagnostic(cause instanceof Error
      ? cause
      : new BoundaryValidationError(boundary, "message handling failed"));
  }
}

export function mountIsolatedFrame(options: IsolatedFrameMountOptions): Disposer {
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
  let disposed = false;
  const connect = async () => {
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
      });
      bridge = connectedBridge;
      target.postMessage({ protocol: isolatedFrameProtocol, type: "connect" }, "*", [channel.port2]);
      const loaded = await assets;
      if (disposed || options.context.signal.aborted) {
        return;
      }
      if (!loaded.ok) {
        throw loaded.cause;
      }
      connectedBridge.activate(activationMessage(options, loaded.value));
    } catch (cause: unknown) {
      if (!disposed && !options.context.signal.aborted) {
        options.onDiagnostic?.(cause);
        bridge?.close("activation-failed");
      }
    }
  };
  const loaded = () => void connect();
  const failed = () => options.onDiagnostic?.(
    new BoundaryValidationError(boundary, "frame document failed to load"),
  );
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
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
  options.host.replaceChildren(frame);
  return dispose;
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

const isolatedFrameBootstrap = String.raw`
(() => {
  "use strict";
  const protocol = "codex.browser-addon/1";
  const tagPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
  let connected = false;

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (connected || event.source !== window.parent || event.ports.length !== 1 ||
      typeof data !== "object" || data === null || data.protocol !== protocol ||
      data.type !== "connect" || Object.keys(data).length !== 2) {
      return;
    }
    connected = true;
    waitForActivation(event.ports[0]);
  });

  function waitForActivation(port) {
    const receive = (event) => {
      const data = event.data;
      if (typeof data === "object" && data !== null && data.protocol === protocol &&
        data.type === "revoke") {
        port.removeEventListener("message", receive);
        port.close();
        return;
      }
      if (typeof data !== "object" || data === null || data.protocol !== protocol ||
        data.type !== "activate" || typeof data.moduleSource !== "string" ||
        !Array.isArray(data.styleSources) ||
        !data.styleSources.every((value) => typeof value === "string") ||
        !Array.isArray(data.declarations) || typeof data.contribution !== "object" ||
        data.contribution === null || typeof data.contribution.id !== "string") {
        return;
      }
      port.removeEventListener("message", receive);
      void activate(data, port);
    };
    port.addEventListener("message", receive);
    port.start();
  }

  async function activate(data, port) {
    const controller = new AbortController();
    const capabilitySet = new Set(data.capabilities);
    const permissionMap = new Map(data.permissions.map((grant) => [grant.id, [...grant.resources]]));
    const declarations = Object.freeze([...data.declarations]);
    const handles = new Map();
    const root = document.getElementById("codex-addon-root");
    let moduleDisposable;
    let observer;
    let revoked = false;

    const post = (message) => {
      if (!revoked) {
        port.postMessage({ protocol, ...message });
      }
    };
    const report = (cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      post({ type: "diagnostic", message: message.slice(0, 500) || "isolated activation failed" });
    };
    const requireActive = () => {
      if (revoked || controller.signal.aborted) {
        throw new DOMException("The add-on generation is no longer active.", "AbortError");
      }
    };
    const capabilities = Object.freeze({
      has: (capability) => !revoked && capabilitySet.has(capability),
      require: (capability) => {
        requireActive();
        if (!capabilitySet.has(capability)) {
          throw new Error("Browser capability " + capability + " is unavailable.");
        }
      },
    });
    const permissions = Object.freeze({
      has: (permission, resource) => {
        if (revoked) return false;
        const resources = permissionMap.get(permission);
        return resources !== undefined && (resource === undefined || resources.includes(resource));
      },
      resources: (permission) => revoked ? [] : Object.freeze([...(permissionMap.get(permission) || [])]),
      require: (permission, resource) => {
        requireActive();
        if (!permissions.has(permission, resource)) {
          throw new Error("Browser permission " + permission + " is unavailable.");
        }
      },
    });
    const ui = Object.freeze({
      declarations: () => {
        requireActive();
        return declarations;
      },
      bind: (contributionId, binding) => {
        requireActive();
        const declaration = declarations.find((candidate) => candidate.id === contributionId);
        if (declaration === undefined || handles.has(contributionId) ||
          typeof binding !== "object" || binding === null || binding.kind !== "element" ||
          typeof binding.tag !== "string" || !tagPattern.test(binding.tag)) {
          throw new Error("The isolated UI binding is invalid.");
        }
        let element;
        if (contributionId === data.contribution.id) {
          element = document.createElement(binding.tag);
          element.codexContribution = Object.freeze({
            addon: data.addon,
            contribution: declaration,
            signal: controller.signal,
          });
          root.replaceChildren(element);
        }
        let disposed = false;
        const handle = Object.freeze({
          descriptor: declaration,
          dispose: () => {
            if (disposed) return;
            disposed = true;
            handles.delete(contributionId);
            if (element && element.parentNode === root) element.remove();
          },
        });
        handles.set(contributionId, handle);
        return handle;
      },
    });
    const context = Object.freeze({
      addon: Object.freeze(data.addon),
      signal: controller.signal,
      capabilities,
      permissions,
      ui,
    });

    const revoke = async (reason) => {
      if (revoked) return;
      revoked = true;
      controller.abort(reason);
      observer?.disconnect();
      for (const handle of [...handles.values()]) handle.dispose();
      try {
        await moduleDisposable?.dispose?.();
      } catch (_) {
        // The host already revoked authority; cleanup remains best effort here.
      }
      port.close();
    };
    port.addEventListener("message", (event) => {
      const message = event.data;
      if (typeof message === "object" && message !== null &&
        message.protocol === protocol && message.type === "revoke") {
        void revoke(typeof message.reason === "string" ? message.reason : "authority-changed");
      }
    });
    port.start();

    try {
      for (const source of data.styleSources) {
        const style = document.createElement("style");
        style.textContent = source;
        document.head.append(style);
      }
      const moduleURL = URL.createObjectURL(new Blob([data.moduleSource], { type: "text/javascript" }));
      let loaded;
      try {
        loaded = await import(moduleURL);
      } finally {
        URL.revokeObjectURL(moduleURL);
      }
      if (typeof loaded !== "object" || loaded === null || typeof loaded.activate !== "function") {
        throw new TypeError("The isolated module must export activate(context).");
      }
      moduleDisposable = await loaded.activate(context);
      if (moduleDisposable !== undefined &&
        (typeof moduleDisposable !== "object" || moduleDisposable === null ||
          typeof moduleDisposable.dispose !== "function")) {
        throw new TypeError("activate(context) must return { dispose() } or undefined.");
      }
      const resize = () => {
        const height = Math.max(120, Math.min(2400, Math.ceil(document.documentElement.scrollHeight)));
        post({ type: "resize", height });
      };
      observer = new ResizeObserver(resize);
      observer.observe(document.documentElement);
      resize();
      post({ type: "ready", contributionId: data.contribution.id });
    } catch (cause) {
      report(cause);
    }
  }
})();
`;

function exactStringParameter(
  params: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
  name: string,
): string {
  if (!hasOnlyKeys(params, keys)) {
    throw new BoundaryValidationError(boundary, `${name} parameters are invalid`);
  }
  return boundedString(params[name], name);
}

function boundedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) {
    throw new BoundaryValidationError(boundary, `${name} must be a bounded string`);
  }
  return value;
}

function assertBoundedMessage(value: unknown): void {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new BoundaryValidationError(boundary, "message must be JSON-compatible");
  }
  if (new TextEncoder().encode(body).byteLength > maximumMessageBytes) {
    throw new BoundaryValidationError(boundary, "message exceeds 64 KiB");
  }
}
