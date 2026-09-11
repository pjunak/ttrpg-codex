import { sessionFetch } from "../core/player-preview.js";
import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";

const maximumResponseBytes = 5 * 1024 * 1024;
const localIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const generationPattern = /^[0-9a-f]{64}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const cursorPattern = /^[A-Za-z0-9_-]{1,32}$/;
const catalogKeys = new Set(["contractVersion", "addonId", "generationId", "sets"]);
const setKeys = new Set([
  "id", "revision", "groups", "schemaSha256", "recordCount", "kinds",
]);
const groupKeys = new Set(["field", "additionalField", "label"]);
const recordEnvelopeKeys = new Set([
  "contractVersion", "addonId", "generationId", "setId", "revision", "record",
]);
const queryEnvelopeKeys = new Set([
  "contractVersion", "addonId", "generationId", "setId", "revision", "records",
  "nextCursor",
]);
const recordKeys = new Set(["kind", "id", "value"]);

export interface AddonContentGroups {
  readonly field: string;
  readonly additionalField?: string;
  readonly label: string;
}

export interface AddonContentSetDescription {
  readonly id: string;
  readonly revision: string;
  readonly groups?: AddonContentGroups;
  readonly schemaSha256: string;
  readonly recordCount: number;
  readonly kinds: Readonly<Record<string, number>>;
}

export interface AddonContentCatalog {
  readonly sets: readonly AddonContentSetDescription[];
}

export interface AddonContentRecord<T> {
  readonly kind: string;
  readonly id: string;
  readonly value: T;
}

export interface AddonContentQueryOptions {
  readonly kind?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface AddonContentQueryResult<T> {
  readonly revision: string;
  readonly records: readonly AddonContentRecord<T>[];
  readonly nextCursor?: string;
}

export interface AddonContentSet<T> {
  get(kind: string, id: string, options?: { readonly signal?: AbortSignal }): Promise<AddonContentRecord<T>>;
  query(options?: AddonContentQueryOptions): Promise<AddonContentQueryResult<T>>;
}

export interface BrowserContentAPI {
  catalog(options?: { readonly signal?: AbortSignal }): Promise<AddonContentCatalog>;
  set<T>(id: string): AddonContentSet<T>;
}

export type AddonContentFetch = (input: string, init: RequestInit) => Promise<Response>;

export class AddonContentHTTPError extends Error {
  override readonly name = "AddonContentHTTPError";

  constructor(readonly status: number, readonly operation: "catalog" | "get" | "query") {
    super(`add-on content ${operation} returned ${status}`);
  }
}

export class BrowserAddonContentClient {
  readonly #addonId: string;
  readonly #generationId: string;
  readonly #baseURL: string;
  readonly #signal: AbortSignal;
  readonly #fetchContent: AddonContentFetch;

  constructor(options: {
    readonly addonId: string;
    readonly generationId: string;
    readonly signal: AbortSignal;
    readonly fetchContent?: AddonContentFetch;
  }) {
    if (!localIdPattern.test(options.addonId) || !generationPattern.test(options.generationId)) {
      throw new TypeError("add-on content client identity is invalid");
    }
    this.#addonId = options.addonId;
    this.#generationId = options.generationId;
    this.#baseURL = `/api/addons/${encodeURIComponent(options.addonId)}/generations/${options.generationId}/content`;
    this.#signal = options.signal;
    this.#fetchContent = options.fetchContent ?? sessionFetch;
  }

  api(): BrowserContentAPI {
    return Object.freeze({
      catalog: (options?: { readonly signal?: AbortSignal }) => this.catalog(options?.signal),
      set: <T>(id: string) => this.#set<T>(id),
    });
  }

  async catalog(signal?: AbortSignal): Promise<AddonContentCatalog> {
    const value = await this.#request("catalog", "", signal);
    if (!this.#validEnvelope(value, catalogKeys, "addon-content-catalog.v1") ||
      !Array.isArray(value["sets"])) {
      throw new BoundaryValidationError("add-on content catalog", "response must be an exact catalog");
    }
    return Object.freeze({
      sets: Object.freeze(value["sets"].map((candidate, index) =>
        parseSet(candidate, `add-on content catalog sets[${index}]`)
      )),
    });
  }

  async get<T>(setId: string, kind: string, id: string, signal?: AbortSignal): Promise<AddonContentRecord<T>> {
    validateSetID(setId);
    validateIdentity(kind, "kind");
    validateIdentity(id, "id");
    const search = new URLSearchParams({ set: setId, kind, id });
    const value = await this.#request("get", `/records?${search.toString()}`, signal);
    if (!this.#validEnvelope(value, recordEnvelopeKeys, "addon-content-record.v1") ||
      value["setId"] !== setId || !validRevision(value["revision"])) {
      throw new BoundaryValidationError("add-on content get", "response must be an exact record envelope");
    }
    return parseRecord<T>(value["record"], "add-on content get record");
  }

  async query<T>(
    setId: string,
    options: AddonContentQueryOptions = {},
  ): Promise<AddonContentQueryResult<T>> {
    validateSetID(setId);
    if (options.kind !== undefined) {
      validateIdentity(options.kind, "kind");
    }
    if (options.cursor !== undefined && !cursorPattern.test(options.cursor)) {
      throw new BoundaryValidationError("add-on content query", "cursor is invalid");
    }
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new BoundaryValidationError("add-on content query", "limit is invalid");
    }
    const search = new URLSearchParams({ set: setId, limit: String(limit) });
    if (options.kind !== undefined) {
      search.set("kind", options.kind);
    }
    if (options.cursor !== undefined) {
      search.set("cursor", options.cursor);
    }
    const value = await this.#request("query", `/query?${search.toString()}`, options.signal);
    if (!this.#validEnvelope(value, queryEnvelopeKeys, "addon-content-query-result.v1") ||
      value["setId"] !== setId || !validRevision(value["revision"]) ||
      !Array.isArray(value["records"]) ||
      (value["nextCursor"] !== undefined &&
        (typeof value["nextCursor"] !== "string" || !cursorPattern.test(value["nextCursor"])))) {
      throw new BoundaryValidationError("add-on content query", "response must be an exact query envelope");
    }
    return Object.freeze({
      revision: value["revision"],
      records: Object.freeze(value["records"].map((candidate, index) =>
        parseRecord<T>(candidate, `add-on content query records[${index}]`)
      )),
      ...(typeof value["nextCursor"] === "string" ? { nextCursor: value["nextCursor"] } : {}),
    });
  }

  #set<T>(id: string): AddonContentSet<T> {
    validateSetID(id);
    return Object.freeze({
      get: (kind: string, recordId: string, options?: { readonly signal?: AbortSignal }) =>
        this.get<T>(id, kind, recordId, options?.signal),
      query: (options?: AddonContentQueryOptions) => this.query<T>(id, options),
    });
  }

  async #request(
    operation: "catalog" | "get" | "query",
    suffix: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#signal.throwIfAborted();
    signal?.throwIfAborted();
    const response = await this.#fetchContent(this.#baseURL + suffix, {
      method: "GET",
      headers: new Headers({ Accept: "application/json" }),
      credentials: "same-origin",
      cache: "no-store",
      signal: signal === undefined ? this.#signal : AbortSignal.any([this.#signal, signal]),
    });
    if (!response.ok) {
      throw new AddonContentHTTPError(response.status, operation);
    }
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new BoundaryValidationError(`add-on content ${operation}`, "response must be application/json");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
      throw new BoundaryValidationError(`add-on content ${operation}`, "response exceeds 5 MiB");
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new BoundaryValidationError(`add-on content ${operation}`, "response must be valid JSON");
    }
    if (!isRecord(value)) {
      throw new BoundaryValidationError(`add-on content ${operation}`, "response must be an object");
    }
    return value;
  }

  #validEnvelope(
    value: Readonly<Record<string, unknown>>,
    keys: ReadonlySet<string>,
    version: string,
  ): boolean {
    return hasOnlyKeys(value, keys) && value["contractVersion"] === version &&
      value["addonId"] === this.#addonId && value["generationId"] === this.#generationId;
  }
}

function parseSet(value: unknown, boundary: string): AddonContentSetDescription {
  if (!isRecord(value) || !hasOnlyKeys(value, setKeys) || !localID(value["id"]) ||
    !validRevision(value["revision"]) || typeof value["schemaSha256"] !== "string" ||
    !digestPattern.test(value["schemaSha256"]) || !contentCount(value["recordCount"]) ||
    !isRecord(value["kinds"])) {
    throw new BoundaryValidationError(boundary, "content set is invalid");
  }
  const kinds: Record<string, number> = {};
  let total = 0;
  for (const [kind, count] of Object.entries(value["kinds"])) {
    validateIdentity(kind, "kind");
    if (!positiveInteger(count)) {
      throw new BoundaryValidationError(boundary, "content kind count is invalid");
    }
    kinds[kind] = count;
    total += count;
  }
  if (total !== value["recordCount"]) {
    throw new BoundaryValidationError(boundary, "content kind counts do not match the set");
  }
  const groups = value["groups"] === undefined ? undefined : parseGroups(value["groups"], boundary);
  return Object.freeze({
    id: value["id"], revision: value["revision"],
    ...(groups === undefined ? {} : { groups }),
    schemaSha256: value["schemaSha256"], recordCount: value["recordCount"],
    kinds: Object.freeze(kinds),
  });
}

function parseGroups(value: unknown, boundary: string): AddonContentGroups {
  if (!isRecord(value) || !hasOnlyKeys(value, groupKeys) ||
    !boundedString(value["field"], 300) || !boundedString(value["label"], 300) ||
    (value["additionalField"] !== undefined && !boundedString(value["additionalField"], 300))) {
    throw new BoundaryValidationError(boundary, "content groups are invalid");
  }
  return Object.freeze({
    field: value["field"], label: value["label"],
    ...(typeof value["additionalField"] === "string"
      ? { additionalField: value["additionalField"] }
      : {}),
  });
}

function parseRecord<T>(value: unknown, boundary: string): AddonContentRecord<T> {
  if (!isRecord(value) || !hasOnlyKeys(value, recordKeys) ||
    !boundedString(value["kind"], 200) || !boundedString(value["id"], 200) ||
    !isRecord(value["value"]) || value["value"]["kind"] !== value["kind"] ||
    value["value"]["id"] !== value["id"]) {
    throw new BoundaryValidationError(boundary, "content record is invalid");
  }
  return Object.freeze({ kind: value["kind"], id: value["id"], value: value["value"] as T });
}

function validateSetID(value: string): void {
  if (!localIdPattern.test(value)) {
    throw new BoundaryValidationError("add-on content", "set id is invalid");
  }
}

function validateIdentity(value: string, name: string): void {
  if (!boundedString(value, 200) || new TextEncoder().encode(value).byteLength > 200 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code >= 127 && code <= 159;
    })) {
    throw new BoundaryValidationError("add-on content", `${name} is invalid`);
  }
}

function localID(value: unknown): value is string {
  return typeof value === "string" && localIdPattern.test(value);
}

function validRevision(value: unknown): value is string {
  return boundedString(value, 200);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function contentCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100000;
}
