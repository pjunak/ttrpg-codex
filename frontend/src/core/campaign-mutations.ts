import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import {
  isCampaignCollectionName,
  type CampaignCollectionName,
} from "./campaign-data.js";

const boundary = "POST /api/campaign/transactions";
const maximumReceiptBytes = 1024 * 1024;
const receiptKeys = new Set([
  "contractVersion",
  "commitId",
  "occurredAt",
  "results",
  "collectionRevisions",
]);
const resultKeys = new Set([
  "collection",
  "key",
  "beforeRevision",
  "afterRevision",
  "deleted",
]);

export type CampaignMutation =
  | {
    readonly operation: "put";
    readonly collection: CampaignCollectionName;
    readonly key: string;
    readonly expectedRevision: number;
    readonly value: unknown;
  }
  | {
    readonly operation: "delete";
    readonly collection: CampaignCollectionName;
    readonly key: string;
    readonly expectedRevision: number;
  };

export interface CampaignMutationResult {
  readonly collection: CampaignCollectionName;
  readonly key: string;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly deleted: boolean;
}

export interface CampaignCommitReceipt {
  readonly contractVersion: "campaign-commit.v1";
  readonly commitId: number;
  readonly occurredAt: string;
  readonly results: readonly CampaignMutationResult[];
  readonly collectionRevisions: Readonly<Partial<Record<CampaignCollectionName, number>>>;
}

export type CampaignMutationFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export class CampaignMutationHTTPError extends Error {
  override readonly name = "CampaignMutationHTTPError";

  constructor(readonly status: number) {
    super(`${boundary} returned ${status}`);
  }
}

/** Serializes writes so the browser never sends two edits from one stale base. */
export class CampaignMutationClient {
  readonly #fetchMutation: CampaignMutationFetch;
  #tail: Promise<void> = Promise.resolve();

  constructor(fetchMutation: CampaignMutationFetch = (input, init) => fetch(input, init)) {
    this.#fetchMutation = fetchMutation;
  }

  commit(
    mutations: readonly CampaignMutation[],
    csrfToken: string,
    signal: AbortSignal,
  ): Promise<CampaignCommitReceipt> {
    const operation = this.#tail.then(() => this.#commit(mutations, csrfToken, signal));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #commit(
    mutations: readonly CampaignMutation[],
    csrfToken: string,
    signal: AbortSignal,
  ): Promise<CampaignCommitReceipt> {
    signal.throwIfAborted();
    if (mutations.length === 0 || mutations.length > 500 || csrfToken.length < 32) {
      throw new BoundaryValidationError(boundary, "mutation request is invalid");
    }
    const response = await this.#fetchMutation("/api/campaign/transactions", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Codex-CSRF": csrfToken,
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ contractVersion: "campaign-mutation.v1", mutations }),
      signal,
    });
    if (!response.ok) {
      throw new CampaignMutationHTTPError(response.status);
    }
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new BoundaryValidationError(boundary, "response must be application/json");
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maximumReceiptBytes) {
      throw new BoundaryValidationError(boundary, "response exceeds 1 MiB");
    }
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new BoundaryValidationError(boundary, "response must be valid JSON");
    }
    return parseCampaignCommitReceipt(value);
  }
}

export function parseCampaignCommitReceipt(value: unknown): CampaignCommitReceipt {
  if (!isRecord(value) || !hasOnlyKeys(value, receiptKeys) ||
    value["contractVersion"] !== "campaign-commit.v1" ||
    !positiveInteger(value["commitId"]) ||
    typeof value["occurredAt"] !== "string" || !validTimestamp(value["occurredAt"]) ||
    !Array.isArray(value["results"]) || value["results"].length === 0 ||
    !isRecord(value["collectionRevisions"])) {
    throw new BoundaryValidationError(boundary, "response must be an exact commit receipt");
  }
  const results = value["results"].map((candidate, index) => parseResult(candidate, index));
  const collectionRevisions: Partial<Record<CampaignCollectionName, number>> = {};
  for (const [name, revision] of Object.entries(value["collectionRevisions"])) {
    if (!isCampaignCollectionName(name) || !positiveInteger(revision)) {
      throw new BoundaryValidationError(boundary, "collection revisions are invalid");
    }
    collectionRevisions[name] = revision;
  }
  if (Object.keys(collectionRevisions).length === 0) {
    throw new BoundaryValidationError(boundary, "collection revisions must not be empty");
  }
  return {
    contractVersion: "campaign-commit.v1",
    commitId: value["commitId"],
    occurredAt: value["occurredAt"],
    results,
    collectionRevisions,
  };
}

function parseResult(value: unknown, index: number): CampaignMutationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, resultKeys) ||
    !isCampaignCollectionName(value["collection"]) ||
    typeof value["key"] !== "string" || value["key"].length === 0 ||
    !nonNegativeInteger(value["beforeRevision"]) ||
    !positiveInteger(value["afterRevision"]) ||
    value["afterRevision"] <= value["beforeRevision"] ||
    typeof value["deleted"] !== "boolean") {
    throw new BoundaryValidationError(boundary, `results[${index}] is invalid`);
  }
  return {
    collection: value["collection"],
    key: value["key"],
    beforeRevision: value["beforeRevision"],
    afterRevision: value["afterRevision"],
    deleted: value["deleted"],
  };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
