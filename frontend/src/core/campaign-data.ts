import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";

const boundary = "GET /api/campaign";
const maximumDatasetBytes = 64 * 1024 * 1024;
const maximumRecords = 100_000;
const maximumJSONNodes = 1_000_000;
const datasetKeys = new Set(["contractVersion", "collections"]);
const collectionKeys = new Set(["name", "shape", "materialized", "revision", "records"]);
const recordKeys = new Set(["key", "revision", "value"]);

const collectionShapes = {
  characters: "list",
  relationships: "list",
  locations: "list",
  events: "list",
  mysteries: "list",
  factions: "keyed",
  deletedDefaults: "keyed",
  pantheon: "list",
  artifacts: "list",
  settings: "keyed",
  historicalEvents: "list",
  campaign: "keyed",
  pets: "list",
} as const;

export type CampaignCollectionName = keyof typeof collectionShapes;
export type CampaignCollectionShape = (typeof collectionShapes)[CampaignCollectionName];

export interface CampaignRecord {
  readonly key: string;
  readonly revision: number;
  readonly value: unknown;
}

export interface CampaignCollection {
  readonly name: CampaignCollectionName;
  readonly shape: CampaignCollectionShape;
  readonly materialized: boolean;
  readonly revision: number;
  readonly records: readonly CampaignRecord[];
}

export interface CampaignDataset {
  readonly contractVersion: "campaign-data.v1";
  readonly collections: readonly CampaignCollection[];
}

export type CampaignDataFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export class CampaignDataHTTPError extends Error {
  override readonly name = "CampaignDataHTTPError";

  constructor(readonly status: number) {
    super(`${boundary} returned ${status}`);
  }
}

export class CampaignDataRefreshInvalidatedError extends Error {
  override readonly name = "CampaignDataRefreshInvalidatedError";

  constructor() {
    super("campaign data refresh was invalidated");
  }
}

/** Serializes authoritative reads so an older projection can never win a race. */
export class CampaignDataClient {
  readonly #fetchData: CampaignDataFetch;
  #current: CampaignDataset | undefined;
  #epoch = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(fetchData: CampaignDataFetch = (input, init) => fetch(input, init)) {
    this.#fetchData = fetchData;
  }

  current(): CampaignDataset | undefined {
    return this.#current;
  }

  refresh(signal: AbortSignal): Promise<CampaignDataset> {
    const operation = this.#tail.then(() => this.#refresh(signal));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  reset(): void {
    this.#epoch += 1;
    this.#current = undefined;
  }

  async #refresh(signal: AbortSignal): Promise<CampaignDataset> {
    signal.throwIfAborted();
    const epoch = this.#epoch;
    const response = await this.#fetchData("/api/campaign", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (epoch !== this.#epoch) {
      throw new CampaignDataRefreshInvalidatedError();
    }
    if (!response.ok) {
      throw new CampaignDataHTTPError(response.status);
    }
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new BoundaryValidationError(boundary, "response must be application/json");
    }
    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumDatasetBytes)) {
      throw new BoundaryValidationError(boundary, "response exceeds 64 MiB");
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maximumDatasetBytes) {
      throw new BoundaryValidationError(boundary, "response exceeds 64 MiB");
    }
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new BoundaryValidationError(boundary, "response must be valid JSON");
    }
    const dataset = parseCampaignDataset(value);
    if (epoch !== this.#epoch) {
      throw new CampaignDataRefreshInvalidatedError();
    }
    this.#current = dataset;
    return dataset;
  }
}

export function parseCampaignDataset(value: unknown): CampaignDataset {
  if (!isRecord(value) || !hasOnlyKeys(value, datasetKeys)) {
    throw new BoundaryValidationError(boundary, "response must be an exact dataset object");
  }
  if (value["contractVersion"] !== "campaign-data.v1" || !Array.isArray(value["collections"])) {
    throw new BoundaryValidationError(boundary, "dataset contract is unsupported");
  }
  const expectedNames = Object.keys(collectionShapes) as CampaignCollectionName[];
  if (value["collections"].length !== expectedNames.length) {
    throw new BoundaryValidationError(boundary, "dataset must contain every core collection exactly once");
  }
  let totalRecords = 0;
  const seen = new Set<CampaignCollectionName>();
  const collections = value["collections"].map((candidate, index) => {
    const collection = parseCollection(candidate, index);
    if (seen.has(collection.name)) {
      throw new BoundaryValidationError(boundary, `collection ${collection.name} is duplicated`);
    }
    seen.add(collection.name);
    totalRecords += collection.records.length;
    if (totalRecords > maximumRecords) {
      throw new BoundaryValidationError(boundary, "dataset exceeds 100000 records");
    }
    return collection;
  });
  if (expectedNames.some((name) => !seen.has(name))) {
    throw new BoundaryValidationError(boundary, "dataset is missing a core collection");
  }
  return { contractVersion: "campaign-data.v1", collections };
}

export function campaignCollection(
  dataset: CampaignDataset,
  name: CampaignCollectionName,
): CampaignCollection {
  const collection = dataset.collections.find((candidate) => candidate.name === name);
  if (collection === undefined) {
    throw new Error(`validated campaign dataset is missing ${name}`);
  }
  return collection;
}

export function isCampaignCollectionName(value: unknown): value is CampaignCollectionName {
  return typeof value === "string" && Object.hasOwn(collectionShapes, value);
}

function parseCollection(value: unknown, index: number): CampaignCollection {
  const location = `collections[${index}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, collectionKeys)) {
    throw new BoundaryValidationError(boundary, `${location} must be an exact collection object`);
  }
  const name = value["name"];
  if (!isCampaignCollectionName(name)) {
    throw new BoundaryValidationError(boundary, `${location}.name is unsupported`);
  }
  const typedName = name;
  if (value["shape"] !== collectionShapes[typedName]) {
    throw new BoundaryValidationError(boundary, `${location}.shape does not match ${name}`);
  }
  if (typeof value["materialized"] !== "boolean" || !validRevision(value["revision"], false) ||
    !Array.isArray(value["records"])) {
    throw new BoundaryValidationError(boundary, `${location} contains invalid collection state`);
  }
  const recordKeysSeen = new Set<string>();
  const records = value["records"].map((record, recordIndex) => {
    const parsed = parseRecord(record, `${location}.records[${recordIndex}]`);
    if (recordKeysSeen.has(parsed.key)) {
      throw new BoundaryValidationError(boundary, `${location} contains duplicate record keys`);
    }
    recordKeysSeen.add(parsed.key);
    return parsed;
  });
  if (!value["materialized"] && records.length > 0) {
    throw new BoundaryValidationError(boundary, `${location} has records while not materialized`);
  }
  return {
    name: typedName,
    shape: collectionShapes[typedName],
    materialized: value["materialized"],
    revision: value["revision"] as number,
    records,
  };
}

function parseRecord(value: unknown, location: string): CampaignRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, recordKeys) ||
    typeof value["key"] !== "string" || !validRecordKey(value["key"]) ||
    !validRevision(value["revision"], true) || !isJSONValue(value["value"])) {
    throw new BoundaryValidationError(boundary, `${location} is invalid`);
  }
  return { key: value["key"], revision: value["revision"] as number, value: value["value"] };
}

function validRevision(value: unknown, positive: boolean): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

function validRecordKey(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= 1024 &&
    !/\p{Cc}/u.test(value);
}

function isJSONValue(value: unknown): boolean {
  const pending: unknown[] = [value];
  let nodes = 0;
  while (pending.length > 0) {
    const candidate = pending.pop();
    nodes += 1;
    if (nodes > maximumJSONNodes) {
      return false;
    }
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        return false;
      }
      continue;
    }
    if (Array.isArray(candidate)) {
      pending.push(...candidate);
      continue;
    }
    if (isRecord(candidate)) {
      const prototype = Object.getPrototypeOf(candidate) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }
      pending.push(...Object.values(candidate));
      continue;
    }
    return false;
  }
  return true;
}
