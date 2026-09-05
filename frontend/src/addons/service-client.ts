import { sessionFetch } from "../core/player-preview.js";
import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";

const maximumResponseBytes = 2 * 1024 * 1024 + 128 * 1024;
const addonIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const contractPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const methodPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const generationPattern = /^[0-9a-f]{64}$/;
const connectionKeys = new Set([
  "contractVersion", "contract", "range", "cardinality", "providers",
]);
const providerKeys = new Set([
  "addonId", "contractVersion", "generation", "bindingRevision",
]);
const resultKeys = new Set([
  "contractVersion", "providerAddonId", "providerGeneration", "result",
]);

export type BrowserServiceCardinality = "one" | "many";

export interface BrowserServiceConnectOptions {
  readonly range: string;
  readonly cardinality: BrowserServiceCardinality;
  readonly includeOwn?: boolean;
  readonly signal?: AbortSignal;
}

export interface BrowserServiceProvider {
  readonly addonId: string;
  readonly contractVersion: string;
  readonly generation: string;
  readonly bindingRevision: number;
}

export interface BrowserServiceCallOptions {
  readonly providerAddonId?: string;
  readonly deadlineMs?: number;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface BrowserServiceHandle {
  readonly contract: string;
  readonly range: string;
  readonly cardinality: BrowserServiceCardinality;
  readonly providers: readonly BrowserServiceProvider[];
  readonly available: boolean;
  call<TResponse = unknown>(
    method: string,
    params: unknown,
    options?: BrowserServiceCallOptions,
  ): Promise<TResponse>;
}

export interface BrowserServiceAPI {
  connect(
    contract: string,
    options: BrowserServiceConnectOptions,
  ): Promise<BrowserServiceHandle>;
}

export type AddonServiceFetch = (input: string, init: RequestInit) => Promise<Response>;

export class AddonServiceHTTPError extends Error {
  override readonly name = "AddonServiceHTTPError";

  constructor(readonly status: number, readonly code: string) {
    super(`add-on service request returned ${status} (${code})`);
  }
}

export class BrowserAddonServiceClient {
  readonly #baseURL: string;
  readonly #csrfToken: string;
  readonly #signal: AbortSignal;
  readonly #fetchService: AddonServiceFetch;

  constructor(options: {
    readonly addonId: string;
    readonly generationId: string;
    readonly csrfToken: string;
    readonly signal: AbortSignal;
    readonly fetchService?: AddonServiceFetch;
  }) {
    if (!addonIdPattern.test(options.addonId) ||
      !generationPattern.test(options.generationId) || options.csrfToken.length < 32) {
      throw new TypeError("add-on service client identity is invalid");
    }
    this.#baseURL = `/api/addons/${encodeURIComponent(options.addonId)}/generations/${options.generationId}/services`;
    this.#csrfToken = options.csrfToken;
    this.#signal = options.signal;
    this.#fetchService = options.fetchService ?? ((input, init) => sessionFetch(input, init));
  }

  api(): BrowserServiceAPI {
    return Object.freeze({
      connect: (
        contract: string,
        options: BrowserServiceConnectOptions,
      ) => this.connect(contract, options),
    });
  }

  async connect(
    contract: string,
    options: BrowserServiceConnectOptions,
  ): Promise<BrowserServiceHandle> {
    if (!contractPattern.test(contract) || options.range.length < 1 || options.range.length > 200 ||
      (options.cardinality !== "one" && options.cardinality !== "many") ||
      (options.includeOwn !== undefined && typeof options.includeOwn !== "boolean")) {
      throw new BoundaryValidationError("add-on service connect", "request is invalid");
    }
    const value = await this.#request("connect", {
      contractVersion: "addon-service-connect.v1",
      contract,
      range: options.range,
      cardinality: options.cardinality,
      ...(options.includeOwn === undefined ? {} : { includeOwn: options.includeOwn }),
    }, options.signal);
    const connection = parseConnection(value, contract, options.range, options.cardinality);
    const providers = Object.freeze([...connection.providers]);
    return Object.freeze({
      contract,
      range: options.range,
      cardinality: options.cardinality,
      providers,
      available: providers.length > 0,
      call: <TResponse = unknown>(
        method: string,
        params: unknown,
        callOptions: BrowserServiceCallOptions = {},
      ) => this.call<TResponse>(connection, method, params, callOptions),
    });
  }

  async call<TResponse>(
    connection: ParsedConnection,
    method: string,
    params: unknown,
    options: BrowserServiceCallOptions,
  ): Promise<TResponse> {
    if (!methodPattern.test(method) || method.length > 100) {
      throw new BoundaryValidationError("add-on service call", "method is invalid");
    }
    assertSerializableContainer(params, "add-on service call parameters");
    const deadlineMs = options.deadlineMs ?? 2_000;
    const idempotencyKey = options.idempotencyKey ?? "";
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000 ||
      idempotencyKey.length > 200) {
      throw new BoundaryValidationError("add-on service call", "options are invalid");
    }
    const provider = selectProvider(connection, options.providerAddonId);
    const value = await this.#request("call", {
      contractVersion: "addon-service-call.v1",
      contract: connection.contract,
      providerAddonId: provider.addonId,
      providerVersion: provider.contractVersion,
      providerGeneration: provider.generation,
      bindingRevision: provider.bindingRevision,
      method,
      params,
      deadlineMs,
      ...(idempotencyKey === "" ? {} : { idempotencyKey }),
    }, options.signal);
    if (!isRecord(value) || !hasOnlyKeys(value, resultKeys) ||
      value["contractVersion"] !== "addon-service-result.v1" ||
      value["providerAddonId"] !== provider.addonId ||
      value["providerGeneration"] !== provider.generation || value["result"] === undefined) {
      throw new BoundaryValidationError("add-on service call", "response must be an exact result");
    }
    return value["result"] as TResponse;
  }

  async #request(operation: "connect" | "call", body: unknown, signal?: AbortSignal): Promise<unknown> {
    this.#signal.throwIfAborted();
    signal?.throwIfAborted();
    const response = await this.#fetchService(`${this.#baseURL}/${operation}`, {
      method: "POST",
      headers: new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Codex-CSRF": this.#csrfToken,
      }),
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
      signal: signal === undefined ? this.#signal : AbortSignal.any([this.#signal, signal]),
    });
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
      throw new BoundaryValidationError(`add-on service ${operation}`, "response exceeds its byte limit");
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new BoundaryValidationError(`add-on service ${operation}`, "response must be valid JSON");
    }
    if (!response.ok) {
      throw new AddonServiceHTTPError(response.status, errorCode(value));
    }
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new BoundaryValidationError(`add-on service ${operation}`, "response must be application/json");
    }
    return value;
  }
}

interface ParsedConnection {
  readonly contract: string;
  readonly range: string;
  readonly cardinality: BrowserServiceCardinality;
  readonly providers: readonly BrowserServiceProvider[];
}

function parseConnection(
  value: unknown,
  contract: string,
  range: string,
  cardinality: BrowserServiceCardinality,
): ParsedConnection {
  if (!isRecord(value) || !hasOnlyKeys(value, connectionKeys) ||
    value["contractVersion"] !== "addon-service-connection.v1" ||
    value["contract"] !== contract || value["range"] !== range ||
    value["cardinality"] !== cardinality || !Array.isArray(value["providers"])) {
    throw new BoundaryValidationError("add-on service connect", "response must be an exact connection");
  }
  const providers = value["providers"].map((candidate, index): BrowserServiceProvider => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, providerKeys) ||
      typeof candidate["addonId"] !== "string" || !addonIdPattern.test(candidate["addonId"]) ||
      typeof candidate["contractVersion"] !== "string" || candidate["contractVersion"].length === 0 ||
      typeof candidate["generation"] !== "string" || !generationPattern.test(candidate["generation"]) ||
      typeof candidate["bindingRevision"] !== "number" ||
      !Number.isSafeInteger(candidate["bindingRevision"]) || candidate["bindingRevision"] < 0) {
      throw new BoundaryValidationError("add-on service connect", `providers[${index}] is invalid`);
    }
    return Object.freeze({
      addonId: candidate["addonId"],
      contractVersion: candidate["contractVersion"],
      generation: candidate["generation"],
      bindingRevision: candidate["bindingRevision"],
    });
  });
  if (cardinality === "one" && providers.length > 1) {
    throw new BoundaryValidationError("add-on service connect", "cardinality-one response is ambiguous");
  }
  return Object.freeze({ contract, range, cardinality, providers: Object.freeze(providers) });
}

function selectProvider(
  connection: ParsedConnection,
  providerAddonId: string | undefined,
): BrowserServiceProvider {
  if (connection.providers.length === 0) {
    throw new AddonServiceHTTPError(503, "SERVICE_UNAVAILABLE");
  }
  if (providerAddonId === undefined) {
    if (connection.cardinality === "many") {
      throw new BoundaryValidationError("add-on service call", "providerAddonId is required for a many-provider service");
    }
    return connection.providers[0] as BrowserServiceProvider;
  }
  const provider = connection.providers.find((candidate) => candidate.addonId === providerAddonId);
  if (provider === undefined) {
    throw new BoundaryValidationError("add-on service call", "providerAddonId is not bound");
  }
  return provider;
}

function assertSerializableContainer(value: unknown, boundary: string): void {
  if (value === null || typeof value !== "object") {
    throw new BoundaryValidationError(boundary, "value must be an object or array");
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    // Handled below.
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maximumResponseBytes) {
    throw new BoundaryValidationError(boundary, "value is not bounded JSON");
  }
}

function errorCode(value: unknown): string {
  if (!isRecord(value) || !isRecord(value["error"]) ||
    typeof value["error"]["kind"] !== "string" || value["error"]["kind"].length > 100) {
    return "HTTP_ERROR";
  }
  return value["error"]["kind"];
}
