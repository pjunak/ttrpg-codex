import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";
import {
  validateBrowserGenerationSet,
  type BrowserGenerationDescriptor,
  type BrowserGenerationSet,
} from "./generation-manager.js";

const boundary = "GET /api/addons/browser-graph";
const maximumGraphBytes = 512 * 1024;
const graphKeys = new Set(["contractVersion", "graphRevision", "addons"]);
const descriptorKeys = new Set([
  "addonId",
  "addonVersion",
  "generationId",
  "mode",
  "entryUrl",
  "styleUrls",
  "sandbox",
  "dependencies",
]);
const sandboxValues = new Set(["downloads", "forms", "modals", "popups"] as const);
const sha256Pattern = /^[0-9a-f]{64}$/;

export type BrowserGraphFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface BrowserGraphRefresh {
  readonly graph: BrowserGenerationSet;
  readonly changed: boolean;
}

export class BrowserGraphHTTPError extends Error {
  override readonly name = "BrowserGraphHTTPError";

  constructor(readonly status: number) {
    super(`${boundary} returned ${status}`);
  }
}

export class BrowserGraphRefreshInvalidatedError extends Error {
  override readonly name = "BrowserGraphRefreshInvalidatedError";

  constructor() {
    super("browser graph refresh was invalidated");
  }
}

/**
 * Owns the private conditional HTTP cache for the server-authoritative graph.
 * Refreshes are serialized so a slower response cannot replace a newer graph.
 */
export class BrowserGraphClient {
  readonly #fetchGraph: BrowserGraphFetch;
  #current: BrowserGenerationSet | undefined;
  #etag: string | undefined;
  #epoch = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(fetchGraph: BrowserGraphFetch = (input, init) => fetch(input, init)) {
    this.#fetchGraph = fetchGraph;
  }

  current(): BrowserGenerationSet | undefined {
    return this.#current;
  }

  refresh(signal: AbortSignal): Promise<BrowserGraphRefresh> {
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
    this.#etag = undefined;
  }

  async #refresh(signal: AbortSignal): Promise<BrowserGraphRefresh> {
    signal.throwIfAborted();
    const epoch = this.#epoch;
    const headers = new Headers({ Accept: "application/json" });
    if (this.#etag !== undefined) {
      headers.set("If-None-Match", this.#etag);
    }
    const response = await this.#fetchGraph("/api/addons/browser-graph", {
      method: "GET",
      headers,
      credentials: "same-origin",
      cache: "no-cache",
      signal,
    });
    if (epoch !== this.#epoch) {
      throw new BrowserGraphRefreshInvalidatedError();
    }
    if (response.status === 304) {
      if (this.#current === undefined || this.#etag === undefined) {
        throw new BoundaryValidationError(boundary, "received 304 without a cached graph");
      }
      return { graph: this.#current, changed: false };
    }
    if (!response.ok) {
      throw new BrowserGraphHTTPError(response.status);
    }
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new BoundaryValidationError(boundary, "response must be application/json");
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maximumGraphBytes) {
      throw new BoundaryValidationError(boundary, "response exceeds 512 KiB");
    }
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new BoundaryValidationError(boundary, "response must be valid JSON");
    }
    const graph = validateBrowserGenerationSet(parseBrowserGenerationSet(value));
    const etag = response.headers.get("ETag");
    if (etag !== `"${graph.graphRevision}"`) {
      throw new BoundaryValidationError(boundary, "ETag must match graphRevision");
    }
    if (
      this.#current?.graphRevision === graph.graphRevision &&
      JSON.stringify(this.#current) !== JSON.stringify(graph)
    ) {
      throw new BoundaryValidationError(boundary, "one graph revision described different content");
    }
    if (epoch !== this.#epoch) {
      throw new BrowserGraphRefreshInvalidatedError();
    }
    const changed = this.#current?.graphRevision !== graph.graphRevision;
    this.#current = graph;
    this.#etag = etag;
    return { graph, changed };
  }
}

export function parseBrowserGenerationSet(value: unknown): BrowserGenerationSet {
  if (!isRecord(value) || !hasOnlyKeys(value, graphKeys)) {
    throw new BoundaryValidationError(boundary, "response must be an exact graph object");
  }
  if (value["contractVersion"] !== 1) {
    throw new BoundaryValidationError(boundary, "contractVersion must be 1");
  }
  if (typeof value["graphRevision"] !== "string" || !sha256Pattern.test(value["graphRevision"])) {
    throw new BoundaryValidationError(boundary, "graphRevision must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(value["addons"]) || value["addons"].length > 100) {
    throw new BoundaryValidationError(boundary, "addons must contain at most 100 descriptors");
  }
  return {
    contractVersion: 1,
    graphRevision: value["graphRevision"],
    addons: value["addons"].map((descriptor, index) => parseDescriptor(descriptor, index)),
  };
}

function parseDescriptor(value: unknown, index: number): BrowserGenerationDescriptor {
  const location = `addons[${index}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, descriptorKeys)) {
    throw new BoundaryValidationError(boundary, `${location} must be an exact descriptor object`);
  }
  const addonId = requiredString(value["addonId"], `${location}.addonId`);
  const addonVersion = requiredString(value["addonVersion"], `${location}.addonVersion`);
  const generationId = requiredString(value["generationId"], `${location}.generationId`);
  if (!sha256Pattern.test(generationId)) {
    throw new BoundaryValidationError(boundary, `${location}.generationId must be a lowercase SHA-256 digest`);
  }
  const mode = value["mode"];
  if (mode !== "integrated" && mode !== "isolated") {
    throw new BoundaryValidationError(boundary, `${location}.mode is unsupported`);
  }
  const entryUrl = requiredString(value["entryUrl"], `${location}.entryUrl`);
  const styleUrls = stringArray(value["styleUrls"], `${location}.styleUrls`);
  const dependencies = stringArray(value["dependencies"], `${location}.dependencies`);
  const rawSandbox = stringArray(value["sandbox"], `${location}.sandbox`);
  const sandbox: Array<BrowserGenerationDescriptor["sandbox"][number]> = [];
  for (const grant of rawSandbox) {
    if (!sandboxValues.has(grant as BrowserGenerationDescriptor["sandbox"][number])) {
      throw new BoundaryValidationError(boundary, `${location}.sandbox contains an unsupported grant`);
    }
    sandbox.push(grant as BrowserGenerationDescriptor["sandbox"][number]);
  }
  const assetPrefix = `/api/addons/${encodeURIComponent(addonId)}/generations/${encodeURIComponent(generationId)}/assets/web/`;
  if (
    !validProjectedAssetURL(entryUrl, assetPrefix) ||
    styleUrls.some((url) => !validProjectedAssetURL(url, assetPrefix))
  ) {
    throw new BoundaryValidationError(boundary, `${location} contains an asset URL for another generation`);
  }
  return {
    addonId,
    addonVersion,
    generationId,
    mode,
    entryUrl,
    styleUrls,
    sandbox,
    dependencies,
  };
}

function validProjectedAssetURL(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://codex.invalid");
    return parsed.origin === "https://codex.invalid" && parsed.pathname === value &&
      parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function requiredString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BoundaryValidationError(boundary, `${location} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BoundaryValidationError(boundary, `${location} must be an array of strings`);
  }
  return [...value] as string[];
}
