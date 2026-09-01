import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";
import type { BrowserAddonContext } from "./browser-sdk.js";
import {
  AddonDataHTTPError,
  type AddonDataHandle,
  type AddonDataMutation,
  type AddonQueryOptions,
} from "./data-client.js";
import type { BrowserContributionDescriptor } from "./generation-manager.js";
import {
  AddonContentHTTPError,
  type AddonContentQueryOptions,
  type AddonContentSet,
} from "./content-client.js";

export const isolatedFrameProtocol = "codex.browser-addon/1";

const boundary = "isolated browser add-on bridge";
const maximumMessageBytes = 64 * 1024;
const maximumDataMessageBytes = 2 * 1024 * 1024 + 128 * 1024;
const maximumContentMessageBytes = 5 * 1024 * 1024 + 128 * 1024;
const maximumActivationBytes = 5 * 1024 * 1024;
const maximumConcurrentInvocations = 32;
const requestIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const readyKeys = new Set(["protocol", "type", "contributionId"]);
const unavailableKeys = new Set(["protocol", "type", "contributionId"]);
const requestKeys = new Set(["protocol", "type", "id", "method", "params"]);
const cancelRequestKeys = new Set(["protocol", "type", "id"]);
const resizeKeys = new Set(["protocol", "type", "height"]);
const diagnosticKeys = new Set(["protocol", "type", "message"]);
const resultKeys = new Set(["protocol", "type", "id", "ok", "result"]);
const errorResultKeys = new Set(["protocol", "type", "id", "ok", "error"]);
const errorKeys = new Set(["code", "message"]);
const capabilityKeys = new Set(["capability"]);
const permissionKeys = new Set(["permission", "resource"]);
const permissionResourceKeys = new Set(["permission"]);
const noParameterKeys = new Set<string>();
const dataGetKeys = new Set(["kind", "dataId", "target", "key"]);
const dataQueryKeys = new Set(["kind", "dataId", "target", "options"]);
const dataTransactionKeys = new Set(["mutations"]);
const contentGetKeys = new Set(["setId", "kind", "id"]);
const contentQueryKeys = new Set(["setId", "options"]);
const contentQueryOptionKeys = new Set(["kind", "cursor", "limit"]);
const queryOptionKeys = new Set(["cursor", "limit", "where"]);
const queryConditionKeys = new Set(["path", "equals"]);
const localIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const cursorPattern = /^[A-Za-z0-9_-]{1,32}$/;

export type IsolatedSDKMethod =
  | "capabilities.has"
  | "permissions.has"
  | "permissions.resources"
  | "ui.declarations"
  | "data.get"
  | "data.query"
  | "data.transact"
  | "content.catalog"
  | "content.get"
  | "content.query";

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
  readonly #sdkRequests = new Map<string, AbortController>();
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
    for (const request of this.#sdkRequests.values()) {
      request.abort(reason);
    }
    this.#sdkRequests.clear();
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
      assertBoundedMessage(value, inboundMessageLimit(value));
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
      // SDK calls are valid during module activation, before the contribution
      // completes its ready handshake.
      if (value["type"] === "request") {
        const method = value["method"];
        if (!this.#ready && (typeof method !== "string" ||
          !method.startsWith("data.") && !method.startsWith("content."))) {
          throw new BoundaryValidationError(boundary, "frame sent a message before ready");
        }
        void this.#answer(value);
        return;
      }
      if (value["type"] === "cancel-request") {
        this.#cancelSDKRequest(value);
        return;
      }
      if (!this.#ready) {
        throw new BoundaryValidationError(boundary, "frame sent a message before ready");
      }
      if (value["type"] === "resize") {
        this.#acceptResize(value);
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
    let request: AbortController | undefined;
    try {
      if (!hasOnlyKeys(value, requestKeys) || typeof id !== "string" ||
        !requestIdPattern.test(id) || typeof value["method"] !== "string" ||
        !isRecord(value["params"])) {
        throw new BoundaryValidationError(boundary, "request has an invalid shape");
      }
      if (this.#sdkRequests.has(id) || this.#sdkRequests.size >= maximumConcurrentInvocations) {
        throw new BoundaryValidationError(boundary, "too many active SDK requests");
      }
      request = new AbortController();
      this.#sdkRequests.set(id, request);
      const candidate = this.#invoke(value["method"], value["params"], request.signal);
      const result = candidate instanceof Promise ? await candidate : candidate;
      const limit = value["method"].startsWith("data.")
        ? maximumDataMessageBytes
        : value["method"].startsWith("content.")
          ? maximumContentMessageBytes
          : maximumMessageBytes;
      this.#send({ protocol: isolatedFrameProtocol, type: "response", id, ok: true, result }, limit);
    } catch (cause: unknown) {
      this.#onDiagnostic(cause);
      if (typeof id === "string" && requestIdPattern.test(id)) {
        const error = isolatedSDKError(cause, this.#context.signal);
        this.#send({
          protocol: isolatedFrameProtocol,
          type: "response",
          id,
          ok: false,
          error,
        });
      }
    } finally {
      if (request !== undefined && this.#sdkRequests.get(String(id)) === request) {
        this.#sdkRequests.delete(String(id));
      }
    }
  }

  #cancelSDKRequest(value: Readonly<Record<string, unknown>>): void {
    const id = value["id"];
    if (!hasOnlyKeys(value, cancelRequestKeys) || typeof id !== "string" ||
      !requestIdPattern.test(id)) {
      throw new BoundaryValidationError(boundary, "request cancellation is invalid");
    }
    this.#sdkRequests.get(id)?.abort("frame-cancelled");
  }

  #invoke(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): unknown | Promise<unknown> {
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
      case "data.get": {
        if (!hasOnlyKeys(params, dataGetKeys)) {
          throw new BoundaryValidationError(boundary, "data.get parameters are invalid");
        }
        const handle = this.#dataHandle(params);
        const key = boundedDataKey(params["key"]);
        return handle.get(key, { signal });
      }
      case "data.query": {
        if (!hasOnlyKeys(params, dataQueryKeys) || !isRecord(params["options"])) {
          throw new BoundaryValidationError(boundary, "data.query parameters are invalid");
        }
        const handle = this.#dataHandle(params);
        return handle.query(isolatedQueryOptions(params["options"], signal));
      }
      case "data.transact": {
        const mutations = params["mutations"];
        if (!hasOnlyKeys(params, dataTransactionKeys) || !Array.isArray(mutations) ||
          mutations.length < 1 || mutations.length > 256) {
          throw new BoundaryValidationError(boundary, "data.transact parameters are invalid");
        }
        assertJSONValue(mutations, "data transaction");
        return this.#context.data.transact(mutations as readonly AddonDataMutation[], { signal });
      }
      case "content.catalog":
        if (!hasOnlyKeys(params, noParameterKeys)) {
          throw new BoundaryValidationError(boundary, "content.catalog parameters are invalid");
        }
        return this.#context.content.catalog({ signal });
      case "content.get": {
        if (!hasOnlyKeys(params, contentGetKeys)) {
          throw new BoundaryValidationError(boundary, "content.get parameters are invalid");
        }
        const handle = this.#contentHandle(params);
        return handle.get(
          contentIdentity(params["kind"], "kind"),
          contentIdentity(params["id"], "id"),
          { signal },
        );
      }
      case "content.query": {
        if (!hasOnlyKeys(params, contentQueryKeys) || !isRecord(params["options"])) {
          throw new BoundaryValidationError(boundary, "content.query parameters are invalid");
        }
        return this.#contentHandle(params).query(isolatedContentQueryOptions(params["options"], signal));
      }
      default:
        throw new BoundaryValidationError(boundary, "SDK method is unsupported");
    }
  }

  #dataHandle(params: Readonly<Record<string, unknown>>): AddonDataHandle<unknown> {
    const kind = params["kind"];
    const dataID = localID(params["dataId"], "dataId");
    if (kind === "collection" && params["target"] === undefined) {
      return this.#context.data.collection(dataID);
    }
    if (kind === "record-extension") {
      const target = localID(params["target"], "target");
      return this.#context.data.recordExtension(target, dataID);
    }
    throw new BoundaryValidationError(boundary, "data reference is invalid");
  }

  #contentHandle(params: Readonly<Record<string, unknown>>): AddonContentSet<unknown> {
    return this.#context.content.set(localID(params["setId"], "setId"));
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

function localID(value: unknown, name: string): string {
  if (typeof value !== "string" || !localIdPattern.test(value)) {
    throw new BoundaryValidationError(boundary, `${name} must be a local identifier`);
  }
  return value;
}

function boundedDataKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) {
    throw new BoundaryValidationError(boundary, "data key must be a bounded string");
  }
  return value;
}

function contentIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 ||
    new TextEncoder().encode(value).byteLength > 200 || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code >= 127 && code <= 159;
    })) {
    throw new BoundaryValidationError(boundary, `content ${name} is invalid`);
  }
  return value;
}

function isolatedQueryOptions(
  value: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): AddonQueryOptions {
  if (!hasOnlyKeys(value, queryOptionKeys)) {
    throw new BoundaryValidationError(boundary, "data query options are invalid");
  }
  const cursor = value["cursor"];
  const limit = value["limit"];
  const where = value["where"];
  if (cursor !== undefined && (typeof cursor !== "string" || !cursorPattern.test(cursor))) {
    throw new BoundaryValidationError(boundary, "data query cursor is invalid");
  }
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > 200)) {
    throw new BoundaryValidationError(boundary, "data query limit is invalid");
  }
  if (where !== undefined && (!Array.isArray(where) || where.length > 8)) {
    throw new BoundaryValidationError(boundary, "data query conditions are invalid");
  }
  const conditions = where?.map((condition) => {
    if (!isRecord(condition) || !hasOnlyKeys(condition, queryConditionKeys) ||
      typeof condition["path"] !== "string" || !condition["path"].startsWith("/") ||
      condition["path"].length > 300 || condition["equals"] === undefined) {
      throw new BoundaryValidationError(boundary, "data query condition is invalid");
    }
    assertJSONValue(condition["equals"], "data query condition");
    return Object.freeze({ path: condition["path"], equals: condition["equals"] });
  });
  return {
    signal,
    ...(typeof cursor === "string" ? { cursor } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(conditions !== undefined ? { where: conditions } : {}),
  };
}

function isolatedContentQueryOptions(
  value: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): AddonContentQueryOptions {
  if (!hasOnlyKeys(value, contentQueryOptionKeys)) {
    throw new BoundaryValidationError(boundary, "content query options are invalid");
  }
  const kind = value["kind"];
  const cursor = value["cursor"];
  const limit = value["limit"];
  if (kind !== undefined) {
    contentIdentity(kind, "kind");
  }
  if (cursor !== undefined && (typeof cursor !== "string" || !cursorPattern.test(cursor))) {
    throw new BoundaryValidationError(boundary, "content query cursor is invalid");
  }
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > 200)) {
    throw new BoundaryValidationError(boundary, "content query limit is invalid");
  }
  return {
    signal,
    ...(typeof kind === "string" ? { kind } : {}),
    ...(typeof cursor === "string" ? { cursor } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
  };
}

function inboundMessageLimit(value: unknown): number {
  return isRecord(value) && value["type"] === "request" && value["method"] === "data.transact"
    ? maximumDataMessageBytes
    : maximumMessageBytes;
}

function isolatedSDKError(
  cause: unknown,
  generationSignal: AbortSignal,
): Readonly<{ code: string; message: string }> {
  if (generationSignal.aborted) {
    return Object.freeze({
      code: "AUTHORITY_REVOKED",
      message: "The add-on generation is no longer active.",
    });
  }
  if (cause instanceof AddonDataHTTPError) {
    return Object.freeze({
      code: `ADDON_DATA_${cause.status}`,
      message: `The add-on data request failed with status ${cause.status}.`,
    });
  }
  if (cause instanceof AddonContentHTTPError) {
    return Object.freeze({
      code: `ADDON_CONTENT_${cause.status}`,
      message: `The add-on content request failed with status ${cause.status}.`,
    });
  }
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return Object.freeze({
      code: "REQUEST_ABORTED",
      message: "The isolated SDK request was cancelled.",
    });
  }
  return Object.freeze({
    code: "INVALID_REQUEST",
    message: "The isolated SDK request is invalid.",
  });
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
