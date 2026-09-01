import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";
import type { BrowserAddonContext } from "./browser-sdk.js";
import type { BrowserContributionDescriptor } from "./generation-manager.js";

export const isolatedFrameProtocol = "codex.browser-addon/1";

const boundary = "isolated browser add-on bridge";
const maximumMessageBytes = 64 * 1024;
const maximumActivationBytes = 5 * 1024 * 1024;
const maximumConcurrentInvocations = 32;
const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const readyKeys = new Set(["protocol", "type", "contributionId"]);
const unavailableKeys = new Set(["protocol", "type", "contributionId"]);
const requestKeys = new Set(["protocol", "type", "id", "method", "params"]);
const resizeKeys = new Set(["protocol", "type", "height"]);
const diagnosticKeys = new Set(["protocol", "type", "message"]);
const resultKeys = new Set(["protocol", "type", "id", "ok", "result"]);
const errorResultKeys = new Set(["protocol", "type", "id", "ok", "error"]);
const errorKeys = new Set(["code", "message"]);
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
  readonly onUnavailable?: () => void;
  readonly readyTimeoutMilliseconds?: number;
  readonly invocationTimeoutMilliseconds?: number;
}

export class IsolatedInvocationError extends Error {
  override readonly name = "IsolatedInvocationError";

  constructor(
    readonly code: "BUSY" | "TIMEOUT" | "REVOKED" | "ADDON_ERROR" | "INVALID_RESULT",
    message: string,
  ) {
    super(message);
  }
}

interface PendingInvocation {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

/** Owns one transferred port. The opaque frame never receives a host DOM handle. */
export class IsolatedFrameBridge {
  readonly #port: IsolatedMessagePort;
  readonly #context: BrowserAddonContext;
  readonly #contribution: BrowserContributionDescriptor;
  readonly #onResize: (height: number) => void;
  readonly #onDiagnostic: (cause: unknown) => void;
  readonly #onUnavailable: () => void;
  readonly #invocationTimeoutMilliseconds: number;
  readonly #pending = new Map<string, PendingInvocation>();
  readonly #readyPromise: Promise<void>;
  readonly #resolveReady: () => void;
  readonly #rejectReady: (cause: unknown) => void;
  readonly #message = (event: MessageEvent<unknown>) => this.#receive(event.data);
  readonly #messageError = () => this.#fail(
    new BoundaryValidationError(boundary, "message could not be decoded"),
  );
  readonly #abort = () => this.close("authority-changed");
  readonly #readyTimer: ReturnType<typeof globalThis.setTimeout>;
  #invocationSequence = 0;
  #ready = false;
  #closed = false;

  constructor(options: IsolatedFrameBridgeOptions) {
    this.#port = options.port;
    this.#context = options.context;
    this.#contribution = options.contribution;
    this.#onResize = options.onResize;
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#onUnavailable = options.onUnavailable ?? (() => undefined);
    this.#invocationTimeoutMilliseconds = options.invocationTimeoutMilliseconds ?? 10_000;
    let resolveReady: () => void = () => undefined;
    let rejectReady: (cause: unknown) => void = () => undefined;
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#resolveReady = resolveReady;
    this.#rejectReady = rejectReady;
    void this.#readyPromise.catch(() => undefined);
    this.#port.addEventListener("message", this.#message);
    this.#port.addEventListener("messageerror", this.#messageError);
    this.#port.start();
    this.#context.signal.addEventListener("abort", this.#abort, { once: true });
    const timeout = options.readyTimeoutMilliseconds ?? 5_000;
    this.#readyTimer = globalThis.setTimeout(() => {
      if (!this.#ready && !this.#closed) {
        const cause = new BoundaryValidationError(boundary, "frame did not complete its handshake");
        this.#fail(cause);
        this.#rejectReady(cause);
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
    const cause = new IsolatedInvocationError(
      "REVOKED",
      "The isolated add-on contribution is no longer active.",
    );
    if (!this.#ready) {
      this.#rejectReady(cause);
    }
    for (const pending of this.#pending.values()) {
      pending.reject(cause);
    }
    this.#pending.clear();
    globalThis.clearTimeout(this.#readyTimer);
    this.#context.signal.removeEventListener("abort", this.#abort);
    this.#port.removeEventListener("message", this.#message);
    this.#port.removeEventListener("messageerror", this.#messageError);
    this.#port.close();
  }

  waitUntilReady(signal?: AbortSignal): Promise<void> {
    return signal === undefined
      ? this.#readyPromise
      : waitForSignal(this.#readyPromise, signal);
  }

  async invoke(request: unknown, signal: AbortSignal): Promise<unknown> {
    await this.waitUntilReady(signal);
    signal.throwIfAborted();
    this.#context.signal.throwIfAborted();
    if (this.#closed) {
      throw new IsolatedInvocationError(
        "REVOKED",
        "The isolated add-on contribution is no longer active.",
      );
    }
    if (this.#pending.size >= maximumConcurrentInvocations) {
      throw new IsolatedInvocationError(
        "BUSY",
        "The isolated add-on contribution has too many active requests.",
      );
    }
    assertJSONValue(request, "invocation request");
    const id = `invoke-${++this.#invocationSequence}`;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.#pending.delete(id);
        callback();
      };
      const abort = () => {
        this.#send({ protocol: isolatedFrameProtocol, type: "cancel", id });
        finish(() => reject(signal.reason));
      };
      const timer = globalThis.setTimeout(() => {
        this.#send({ protocol: isolatedFrameProtocol, type: "cancel", id });
        finish(() => reject(new IsolatedInvocationError(
          "TIMEOUT",
          "The isolated add-on contribution did not respond before its deadline.",
        )));
      }, this.#invocationTimeoutMilliseconds);
      this.#pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (cause) => finish(() => reject(cause)),
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.#send({
          protocol: isolatedFrameProtocol,
          type: "invoke",
          id,
          contributionId: this.#contribution.id,
          request,
        });
      } catch (cause: unknown) {
        this.#pending.get(id)?.reject(cause);
      }
    });
  }

  activate(message: unknown): void {
    if (!isRecord(message) || message["protocol"] !== isolatedFrameProtocol ||
      message["type"] !== "activate") {
      throw new BoundaryValidationError(boundary, "activation has an invalid protocol envelope");
    }
    this.#send(message, maximumActivationBytes);
  }

  failActivation(cause: unknown): void {
    if (this.#closed) {
      return;
    }
    const failure = cause instanceof Error
      ? cause
      : new BoundaryValidationError(boundary, "frame activation failed");
    if (!this.#ready) {
      this.#rejectReady(failure);
    }
    for (const pending of this.#pending.values()) {
      pending.reject(failure);
    }
    this.#pending.clear();
    this.close("activation-failed");
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
      if (value["type"] === "failed") {
        this.#acceptFailed(value);
        return;
      }
      if (value["type"] === "unavailable") {
        this.#acceptUnavailable(value);
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
      if (value["type"] === "result") {
        this.#acceptResult(value);
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
    this.#resolveReady();
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

  #acceptFailed(value: Readonly<Record<string, unknown>>): void {
    const message = value["message"];
    if (!hasOnlyKeys(value, diagnosticKeys) || typeof message !== "string" ||
      message.length === 0 || message.length > 500) {
      throw new BoundaryValidationError(boundary, "failure message has an invalid shape");
    }
    const cause = new BoundaryValidationError(boundary, `frame activation failed: ${message}`);
    this.failActivation(cause);
  }

  #acceptUnavailable(value: Readonly<Record<string, unknown>>): void {
    if (!hasOnlyKeys(value, unavailableKeys) ||
      value["contributionId"] !== this.#contribution.id) {
      throw new BoundaryValidationError(boundary, "unavailable message has an invalid shape");
    }
    const cause = new BoundaryValidationError(boundary, "isolated contribution became unavailable");
    this.#onDiagnostic(cause);
    if (!this.#ready) {
      this.#rejectReady(cause);
    }
    try {
      this.#onUnavailable();
    } catch (callbackCause: unknown) {
      this.#onDiagnostic(callbackCause);
    } finally {
      this.close("contribution-unavailable");
    }
  }

  #acceptResult(value: Readonly<Record<string, unknown>>): void {
    const id = value["id"];
    if (typeof id !== "string" || !requestIdPattern.test(id) || typeof value["ok"] !== "boolean") {
      throw new BoundaryValidationError(boundary, "invocation result has an invalid envelope");
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return;
    }
    if (value["ok"] === true) {
      if (!hasOnlyKeys(value, resultKeys)) {
        pending.reject(new IsolatedInvocationError(
          "INVALID_RESULT",
          "The isolated add-on returned an invalid success result.",
        ));
        return;
      }
      try {
        assertJSONValue(value["result"], "invocation result");
      } catch (cause: unknown) {
        this.#onDiagnostic(cause);
        pending.reject(new IsolatedInvocationError(
          "INVALID_RESULT",
          "The isolated add-on returned a non-JSON result.",
        ));
        return;
      }
      pending.resolve(value["result"]);
      return;
    }
    const error = value["error"];
    if (!hasOnlyKeys(value, errorResultKeys) || !isRecord(error) ||
      !hasOnlyKeys(error, errorKeys) || error["code"] !== "ADDON_ERROR" ||
      typeof error["message"] !== "string" || error["message"].length === 0 ||
      error["message"].length > 500) {
      pending.reject(new IsolatedInvocationError(
        "INVALID_RESULT",
        "The isolated add-on returned an invalid error result.",
      ));
      return;
    }
    pending.reject(new IsolatedInvocationError("ADDON_ERROR", error["message"]));
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

  #send(value: unknown, maximumBytes = maximumMessageBytes): void {
    if (this.#closed || this.#context.signal.aborted) {
      return;
    }
    assertBoundedMessage(value, maximumBytes);
    this.#port.postMessage(value);
  }

  #fail(cause: unknown): void {
    this.#onDiagnostic(cause instanceof Error
      ? cause
      : new BoundaryValidationError(boundary, "message handling failed"));
  }
}

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

function assertBoundedMessage(value: unknown, maximumBytes = maximumMessageBytes): void {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new BoundaryValidationError(boundary, "message must be JSON-compatible");
  }
  if (new TextEncoder().encode(body).byteLength > maximumBytes) {
    throw new BoundaryValidationError(boundary, "message exceeds its byte limit");
  }
}

function assertJSONValue(
  value: unknown,
  label: string,
  depth = 0,
  ancestors: ReadonlySet<object> = new Set(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }
    throw new BoundaryValidationError(boundary, `${label} contains a non-finite number`);
  }
  if (typeof value !== "object" || depth > 20) {
    throw new BoundaryValidationError(boundary, `${label} is not bounded JSON`);
  }
  if (ancestors.has(value)) {
    throw new BoundaryValidationError(boundary, `${label} contains a cycle`);
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      throw new BoundaryValidationError(boundary, `${label} contains an oversized array`);
    }
    for (const item of value) {
      assertJSONValue(item, label, depth + 1, nextAncestors);
    }
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BoundaryValidationError(boundary, `${label} contains a non-plain object`);
  }
  const keys = Object.keys(value);
  if (keys.length > 1_000 || Reflect.ownKeys(value).length !== keys.length) {
    throw new BoundaryValidationError(boundary, `${label} contains invalid object keys`);
  }
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new BoundaryValidationError(boundary, `${label} contains a forbidden object key`);
    }
    assertJSONValue((value as Record<string, unknown>)[key], label, depth + 1, nextAncestors);
  }
}

export function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}
