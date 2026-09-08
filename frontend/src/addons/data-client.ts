import { sessionFetch } from "../core/player-preview.js";
import type { AddonDataSubscribe } from "./data-changes.js";
import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";

const maximumResponseBytes = 2 * 1024 * 1024;
const localIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const cursorPattern = /^[A-Za-z0-9_-]{1,32}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T/;
const documentKeys = new Set(["key", "revision", "value"]);
const singleDocumentKeys = new Set(["contractVersion", ...documentKeys]);
const queryResultKeys = new Set(["contractVersion", "documents", "nextCursor", "dataRevision"]);
const commitKeys = new Set(["contractVersion", "commitId", "occurredAt", "results", "dataSets"]);
const mutationResultKeys = new Set([
  "kind", "dataId", "key", "beforeRevision", "afterRevision", "deleted",
]);
const dataSetResultKeys = new Set(["kind", "dataId", "revision"]);
const queryConditionKeys = new Set(["path", "equals"]);
const putMutationKeys = new Set([
  "operation", "kind", "dataId", "key", "expectedRevision", "value",
]);
const deleteMutationKeys = new Set([
  "operation", "kind", "dataId", "key", "expectedRevision",
]);

export type AddonDataKind = "collection" | "record-extension";

export interface AddonDocument<T> {
  readonly key: string;
  readonly revision: number;
  readonly value: T;
}

export interface AddonQueryCondition {
  readonly path: string;
  readonly equals: unknown;
}

export interface AddonQueryOptions {
  readonly includeDataRevision?: boolean;
  readonly expectedDataRevision?: number;
  readonly cursor?: string;
  readonly limit?: number;
  readonly where?: readonly AddonQueryCondition[];
  readonly signal?: AbortSignal;
}

export interface AddonQueryResult<T> {
  readonly dataRevision?: number;
  readonly documents: readonly AddonDocument<T>[];
  readonly nextCursor?: string;
}

export type AddonDataMutation<T = unknown> =
  | {
    readonly operation: "put";
    readonly kind: AddonDataKind;
    readonly dataId: string;
    readonly key: string;
    readonly expectedRevision: number;
    readonly value: T;
  }
  | {
    readonly operation: "delete";
    readonly kind: AddonDataKind;
    readonly dataId: string;
    readonly key: string;
    readonly expectedRevision: number;
  };

export interface AddonMutationResult {
  readonly kind: AddonDataKind;
  readonly dataId: string;
  readonly key: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly deleted: boolean;
}

export interface AddonDataSetRevision {
  readonly kind: AddonDataKind;
  readonly dataId: string;
  readonly revision: number;
}

export interface AddonCommitReceipt {
  readonly contractVersion: "addon-data-commit.v1";
  readonly commitId: number;
  readonly occurredAt: string;
  readonly results: readonly AddonMutationResult[];
  readonly dataSets: readonly AddonDataSetRevision[];
}

export interface AddonDataHandle<T> {
  get(key: string, options?: { readonly signal?: AbortSignal }): Promise<AddonDocument<T>>;
  query(options?: AddonQueryOptions): Promise<AddonQueryResult<T>>;
  put(key: string, value: T, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<AddonCommitReceipt>;
  delete(key: string, expectedRevision: number, options?: { readonly signal?: AbortSignal }): Promise<AddonCommitReceipt>;
}

export interface AddonTransactionOptions {
  readonly signal?: AbortSignal;
  readonly expectedDataSets?: readonly AddonDataSetRevision[];
}

export interface BrowserDataAPI {
  readonly subscribe?: AddonDataSubscribe;
  collection<T>(id: string): AddonDataHandle<T>;
  recordExtension<T>(target: string, id: string): AddonDataHandle<T>;
  transact(mutations: readonly AddonDataMutation[], options?: AddonTransactionOptions): Promise<AddonCommitReceipt>;
}

export type AddonDataFetch = (input: string, init: RequestInit) => Promise<Response>;

export class AddonDataHTTPError extends Error {
  override readonly name = "AddonDataHTTPError";

  constructor(readonly status: number, readonly operation: "get" | "query" | "transactions") {
    super(`add-on data ${operation} returned ${status}`);
  }
}

export function parseExpectedDataSets(value: unknown): readonly AddonDataSetRevision[] {
  if (!Array.isArray(value) || value.length > 256) throw new BoundaryValidationError("add-on data transaction", "data set guards are invalid");
  const seen = new Set<string>();
  return Object.freeze(value.map((guard) => {
    if (!isRecord(guard) || !hasOnlyKeys(guard, dataSetResultKeys) ||
      (guard["kind"] !== "collection" && guard["kind"] !== "record-extension") ||
      typeof guard["dataId"] !== "string" || guard["dataId"].length > 100 || !localIdPattern.test(guard["dataId"]) ||
      !nonNegativeInteger(guard["revision"])) throw new BoundaryValidationError("add-on data transaction", "data set guard is invalid");
    const identity = guard["kind"] + ":" + guard["dataId"];
    if (seen.has(identity)) throw new BoundaryValidationError("add-on data transaction", "duplicate data set guard");
    seen.add(identity);
    return Object.freeze({ kind: guard["kind"], dataId: guard["dataId"], revision: guard["revision"] });
  }));
}

export class BrowserAddonDataClient {
  readonly #baseURL: string;
  readonly #csrfToken: string;
  readonly #signal: AbortSignal;
  readonly #fetchData: AddonDataFetch;
  readonly #subscribe: AddonDataSubscribe | undefined;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly addonId: string;
    readonly generationId: string;
    readonly csrfToken: string;
    readonly signal: AbortSignal;
    readonly fetchData?: AddonDataFetch;
    readonly subscribe?: AddonDataSubscribe;
  }) {
    if (!localIdPattern.test(options.addonId) || !/^[0-9a-f]{64}$/.test(options.generationId) ||
      options.csrfToken.length < 32) {
      throw new TypeError("add-on data client identity is invalid");
    }
    this.#baseURL = `/api/addons/${encodeURIComponent(options.addonId)}/generations/${options.generationId}/data`;
    this.#csrfToken = options.csrfToken;
    this.#signal = options.signal;
    this.#subscribe = options.subscribe;
    this.#fetchData = options.fetchData ?? ((input, init) => sessionFetch(input, init));
  }

  api(): BrowserDataAPI {
    const api: BrowserDataAPI = {
      ...(this.#subscribe ? { subscribe: this.#subscribe } : {}),
      collection: <T>(id: string) => this.#handle<T>("collection", id),
      recordExtension: <T>(target: string, id: string) => {
        if (!localIdPattern.test(target)) {
          throw new TypeError("record-extension target is invalid");
        }
        return this.#handle<T>("record-extension", id);
      },
      transact: (mutations: readonly AddonDataMutation[], options?: AddonTransactionOptions) =>
        this.transact(mutations, options?.signal, options?.expectedDataSets),
    };
    return Object.freeze(api);
  }

  async get<T>(kind: AddonDataKind, dataId: string, key: string, signal?: AbortSignal): Promise<AddonDocument<T>> {
    validateTarget(kind, dataId, key);
    const value = await this.#request("get", {
      contractVersion: "addon-data-get.v1", kind, dataId, key,
    }, false, signal);
    if (!isRecord(value) || !hasOnlyKeys(value, singleDocumentKeys) ||
      value["contractVersion"] !== "addon-data-document.v1") {
      throw new BoundaryValidationError("add-on data get", "response must be an exact document");
    }
    return parseDocument<T>(value, "add-on data get", singleDocumentKeys);
  }

  async query<T>(
    kind: AddonDataKind,
    dataId: string,
    options: AddonQueryOptions = {},
  ): Promise<AddonQueryResult<T>> {
    validateTarget(kind, dataId, "query");
    const limit = options.limit ?? 100;
    const where = options.where ?? [];
    if ((options.includeDataRevision !== undefined && typeof options.includeDataRevision !== "boolean") ||
      (options.expectedDataRevision !== undefined && !nonNegativeInteger(options.expectedDataRevision)) ||
      !Number.isInteger(limit) || limit < 1 || limit > 200 || where.length > 8 ||
      (options.cursor !== undefined && !cursorPattern.test(options.cursor)) ||
      where.some((condition) => !isRecord(condition) || !hasOnlyKeys(condition, queryConditionKeys) ||
        typeof condition["path"] !== "string" || !condition["path"].startsWith("/") ||
        condition["path"].length > 300 || condition["equals"] === undefined)) {
      throw new BoundaryValidationError("add-on data query", "request is invalid");
    }
    assertSerializable(where, "add-on data query conditions");
    const request: Record<string, unknown> = {
      contractVersion: "addon-data-query.v1", kind, dataId, limit, where,
    };
    if (options.cursor !== undefined) {
      request["cursor"] = options.cursor;
    }
    if (options.includeDataRevision === true) request["includeDataRevision"] = true;
    if (options.expectedDataRevision !== undefined) request["expectedDataRevision"] = options.expectedDataRevision;
    const value = await this.#request("query", request, false, options.signal);
    if (!isRecord(value) || !hasOnlyKeys(value, queryResultKeys) ||
      value["contractVersion"] !== "addon-data-query-result.v1" ||
      !Array.isArray(value["documents"]) ||
      (value["dataRevision"] !== undefined && !nonNegativeInteger(value["dataRevision"])) ||
      ((options.includeDataRevision === true || options.expectedDataRevision !== undefined) && !nonNegativeInteger(value["dataRevision"])) ||
      (options.expectedDataRevision !== undefined && value["dataRevision"] !== options.expectedDataRevision) ||
      (value["nextCursor"] !== undefined &&
        (typeof value["nextCursor"] !== "string" || !cursorPattern.test(value["nextCursor"])))) {
      throw new BoundaryValidationError("add-on data query", "response must be an exact query result");
    }
    const result: AddonQueryResult<T> = {
      ...(typeof value["dataRevision"] === "number" ? { dataRevision: value["dataRevision"] } : {}),
      documents: value["documents"].map((candidate, index) =>
        parseDocument<T>(candidate, `add-on data query documents[${index}]`)
      ),
      ...(typeof value["nextCursor"] === "string" ? { nextCursor: value["nextCursor"] } : {}),
    };
    return Object.freeze(result);
  }

  transact(
    mutations: readonly AddonDataMutation[],
    signal?: AbortSignal,
    expectedDataSets?: readonly AddonDataSetRevision[],
  ): Promise<AddonCommitReceipt> {
    const guards = expectedDataSets === undefined ? undefined : parseExpectedDataSets(expectedDataSets);
    const operation = this.#writeTail.then(() => this.#transact(mutations, signal, guards));
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #handle<T>(kind: AddonDataKind, dataId: string): AddonDataHandle<T> {
    if (!localIdPattern.test(dataId)) {
      throw new TypeError("add-on data id is invalid");
    }
    const handle: AddonDataHandle<T> = {
      get: (key: string, options?: { readonly signal?: AbortSignal }) =>
        this.get<T>(kind, dataId, key, options?.signal),
      query: (options?: AddonQueryOptions) => this.query<T>(kind, dataId, options),
      put: (key: string, value: T, expectedRevision: number,
        options?: { readonly signal?: AbortSignal }) => this.transact([{
        operation: "put", kind, dataId, key, expectedRevision, value,
      }], options?.signal),
      delete: (key: string, expectedRevision: number,
        options?: { readonly signal?: AbortSignal }) => this.transact([{
        operation: "delete", kind, dataId, key, expectedRevision,
      }], options?.signal),
    };
    return Object.freeze(handle);
  }

  async #transact(
    mutations: readonly AddonDataMutation[],
    signal?: AbortSignal,
    expectedDataSets?: readonly AddonDataSetRevision[],
  ): Promise<AddonCommitReceipt> {
    if (mutations.length < 1 || mutations.length > 256) {
      throw new BoundaryValidationError("add-on data transaction", "mutation count is invalid");
    }
    for (const mutation of mutations) {
      if (!isRecord(mutation) ||
        (mutation["operation"] === "put"
          ? !hasOnlyKeys(mutation, putMutationKeys) || mutation["value"] === undefined
          : mutation["operation"] === "delete"
            ? !hasOnlyKeys(mutation, deleteMutationKeys)
            : true)) {
        throw new BoundaryValidationError("add-on data transaction", "mutation is invalid");
      }
      validateTarget(mutation["kind"] as AddonDataKind, mutation["dataId"] as string,
        mutation["key"] as string);
      if (!nonNegativeInteger(mutation["expectedRevision"])) {
        throw new BoundaryValidationError("add-on data transaction", "mutation is invalid");
      }
    }
    assertSerializable(mutations, "add-on data mutations");
    const value = await this.#request("transactions", {
      contractVersion: "addon-data-transaction.v1", mutations,
      ...(expectedDataSets === undefined ? {} : { expectedDataSets }),
    }, true, signal);
    return parseCommit(value);
  }

  async #request(
    operation: "get" | "query" | "transactions",
    body: unknown,
    write: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.#signal.throwIfAborted();
    signal?.throwIfAborted();
    const combined = combineSignals(this.#signal, signal);
    const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
    if (write) {
      headers.set("X-Codex-CSRF", this.#csrfToken);
    }
    const response = await this.#fetchData(`${this.#baseURL}/${operation}`, {
      method: "POST", headers, credentials: "same-origin", cache: "no-store",
      body: JSON.stringify(body), signal: combined,
    });
    if (!response.ok) {
      throw new AddonDataHTTPError(response.status, operation);
    }
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new BoundaryValidationError(`add-on data ${operation}`, "response must be application/json");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
      throw new BoundaryValidationError(`add-on data ${operation}`, "response exceeds 2 MiB");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BoundaryValidationError(`add-on data ${operation}`, "response must be valid JSON");
    }
  }
}

function parseDocument<T>(
  value: unknown,
  boundary: string,
  keys: ReadonlySet<string> = documentKeys,
): AddonDocument<T> {
  if (!isRecord(value) || !hasOnlyKeys(value, keys) ||
    typeof value["key"] !== "string" || value["key"].length === 0 ||
    !positiveInteger(value["revision"]) || value["value"] === undefined) {
    throw new BoundaryValidationError(boundary, "document is invalid");
  }
  return Object.freeze({ key: value["key"], revision: value["revision"], value: value["value"] as T });
}

function parseCommit(value: unknown): AddonCommitReceipt {
  const boundary = "add-on data transaction";
  if (!isRecord(value) || !hasOnlyKeys(value, commitKeys) ||
    value["contractVersion"] !== "addon-data-commit.v1" || !positiveInteger(value["commitId"]) ||
    typeof value["occurredAt"] !== "string" || !timestampPattern.test(value["occurredAt"]) ||
    !Number.isFinite(Date.parse(value["occurredAt"])) || !Array.isArray(value["results"]) ||
    value["results"].length === 0 || !Array.isArray(value["dataSets"]) || value["dataSets"].length === 0) {
    throw new BoundaryValidationError(boundary, "response must be an exact commit receipt");
  }
  const results = value["results"].map((candidate, index): AddonMutationResult => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, mutationResultKeys) ||
      !dataKind(candidate["kind"]) || !localID(candidate["dataId"]) ||
      typeof candidate["key"] !== "string" || candidate["key"].length === 0 ||
      !nonNegativeInteger(candidate["beforeRevision"]) || !positiveInteger(candidate["afterRevision"]) ||
      candidate["afterRevision"] !== candidate["beforeRevision"] + 1 || typeof candidate["deleted"] !== "boolean") {
      throw new BoundaryValidationError(boundary, `results[${index}] is invalid`);
    }
    return Object.freeze({
      kind: candidate["kind"], dataId: candidate["dataId"], key: candidate["key"],
      beforeRevision: candidate["beforeRevision"], afterRevision: candidate["afterRevision"],
      deleted: candidate["deleted"],
    });
  });
  const dataSets = value["dataSets"].map((candidate, index): AddonDataSetRevision => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, dataSetResultKeys) ||
      !dataKind(candidate["kind"]) || !localID(candidate["dataId"]) || !positiveInteger(candidate["revision"])) {
      throw new BoundaryValidationError(boundary, `dataSets[${index}] is invalid`);
    }
    return Object.freeze({ kind: candidate["kind"], dataId: candidate["dataId"], revision: candidate["revision"] });
  });
  return Object.freeze({
    contractVersion: "addon-data-commit.v1", commitId: value["commitId"],
    occurredAt: value["occurredAt"], results, dataSets,
  });
}

function validateTarget(kind: AddonDataKind, dataId: string, key: string): void {
  if (!dataKind(kind) || !localID(dataId) || typeof key !== "string" ||
    key.length < 1 || key.length > 1024) {
    throw new BoundaryValidationError("add-on data", "target is invalid");
  }
}

function dataKind(value: unknown): value is AddonDataKind {
  return value === "collection" || value === "record-extension";
}

function localID(value: unknown): value is string {
  return typeof value === "string" && localIdPattern.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function assertSerializable(value: unknown, boundary: string): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    // handled below
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maximumResponseBytes) {
    throw new BoundaryValidationError(boundary, "value is not bounded JSON");
  }
}

function combineSignals(owner: AbortSignal, request: AbortSignal | undefined): AbortSignal {
  return request === undefined ? owner : AbortSignal.any([owner, request]);
}
