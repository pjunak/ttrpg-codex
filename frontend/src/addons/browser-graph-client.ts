import { sessionFetch } from "../core/player-preview.js";
import { validContributionLabels } from "./contribution-label.js";
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
  "capabilities",
  "permissions",
  "contributions",
]);
const permissionKeys = new Set(["id", "resources"]);
const contributionKeys = new Set([
  "id",
  "surface",
  "label",
  "roles",
  "order",
  "requires",
  "config",
]);
const sandboxValues = new Set(["downloads", "forms", "modals", "popups"] as const);
const contributionSurfaces = new Set([
  "route",
  "sidebar",
  "settings",
  "article-action",
  "article-section",
  "editor-panel",
  "slot",
  "record-renderer",
  "wiki-kind",
  "graph-node-kind",
  "graph-view",
  "graph-contributor",
] as const);
const browserRoles = new Set(["dm", "player"] as const);
const sha256Pattern = /^[0-9a-f]{64}$/;
const localIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const contractIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const routePathPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

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

  constructor(fetchGraph: BrowserGraphFetch = (input, init) => sessionFetch(input, init)) {
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
  if (value["contractVersion"] !== 2) {
    throw new BoundaryValidationError(boundary, "contractVersion must be 2");
  }
  if (typeof value["graphRevision"] !== "string" || !sha256Pattern.test(value["graphRevision"])) {
    throw new BoundaryValidationError(boundary, "graphRevision must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(value["addons"]) || value["addons"].length > 100) {
    throw new BoundaryValidationError(boundary, "addons must contain at most 100 descriptors");
  }
  return {
    contractVersion: 2,
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
  if (styleUrls.length > 64) {
    throw new BoundaryValidationError(boundary, `${location}.styleUrls exceeds 64 entries`);
  }
  const dependencies = stringArray(value["dependencies"], `${location}.dependencies`);
  const capabilities = stringArray(value["capabilities"], `${location}.capabilities`);
  if (capabilities.some((capability) => !contractIdPattern.test(capability))) {
    throw new BoundaryValidationError(boundary, `${location}.capabilities contains an invalid id`);
  }
  if (!Array.isArray(value["permissions"]) || !Array.isArray(value["contributions"])) {
    throw new BoundaryValidationError(
      boundary,
      `${location}.permissions and ${location}.contributions must be arrays`,
    );
  }
  const permissions = value["permissions"].map((permission, index) =>
    parsePermission(permission, `${location}.permissions[${index}]`)
  );
  const contributions = value["contributions"].map((contribution, index) =>
    parseContribution(contribution, `${location}.contributions[${index}]`)
  );
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
    !hasAssetExtension(entryUrl, ".js", ".mjs") ||
    styleUrls.some((url) =>
      !validProjectedAssetURL(url, assetPrefix) || !hasAssetExtension(url, ".css")
    )
  ) {
    throw new BoundaryValidationError(
      boundary,
      `${location} contains an invalid projected asset URL or file type`,
    );
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
    capabilities,
    permissions,
    contributions,
  };
}

function hasAssetExtension(value: string, ...extensions: readonly string[]): boolean {
  const pathname = new URL(value, "https://codex.invalid").pathname.toLowerCase();
  return extensions.some((extension) => pathname.endsWith(extension));
}

function parsePermission(
  value: unknown,
  location: string,
): BrowserGenerationDescriptor["permissions"][number] {
  if (!isRecord(value) || !hasOnlyKeys(value, permissionKeys)) {
    throw new BoundaryValidationError(boundary, `${location} must be an exact permission object`);
  }
  const id = requiredString(value["id"], `${location}.id`);
  if (!contractIdPattern.test(id)) {
    throw new BoundaryValidationError(boundary, `${location}.id is invalid`);
  }
  return { id, resources: stringArray(value["resources"], `${location}.resources`) };
}

function parseContribution(
  value: unknown,
  location: string,
): BrowserGenerationDescriptor["contributions"][number] {
  if (!isRecord(value) || !hasOnlyKeys(value, contributionKeys)) {
    throw new BoundaryValidationError(boundary, `${location} must be an exact contribution object`);
  }
  const surface = value["surface"];
  if (
    typeof surface !== "string" ||
    !contributionSurfaces.has(surface as BrowserGenerationDescriptor["contributions"][number]["surface"])
  ) {
    throw new BoundaryValidationError(boundary, `${location}.surface is unsupported`);
  }
  const rawRoles = stringArray(value["roles"], `${location}.roles`);
  const roles: Array<BrowserGenerationDescriptor["contributions"][number]["roles"][number]> = [];
  for (const role of rawRoles) {
    if (!browserRoles.has(role as "dm" | "player")) {
      throw new BoundaryValidationError(boundary, `${location}.roles contains an unsupported role`);
    }
    roles.push(role as "dm" | "player");
  }
  const order = value["order"];
  if (typeof order !== "number" || !Number.isInteger(order)) {
    throw new BoundaryValidationError(boundary, `${location}.order must be an integer`);
  }
  const config = value["config"];
  if (!isRecord(config)) {
    throw new BoundaryValidationError(boundary, `${location}.config must be an object`);
  }
  validateContributionConfig(surface, config, `${location}.config`);
  const id = requiredString(value["id"], `${location}.id`);
  if (!localIdPattern.test(id)) {
    throw new BoundaryValidationError(boundary, `${location}.id is invalid`);
  }
  const requires = stringArray(value["requires"], `${location}.requires`);
  if (requires.some((capability) => !contractIdPattern.test(capability))) {
    throw new BoundaryValidationError(boundary, `${location}.requires contains an invalid id`);
  }
  return {
    id,
    surface: surface as BrowserGenerationDescriptor["contributions"][number]["surface"],
    label: requiredString(value["label"], `${location}.label`),
    roles,
    order,
    requires,
    config,
  };
}

function validateContributionConfig(surface: string, config: Record<string, unknown>, location: string): void {
  if (Object.hasOwn(config, "labels") && !validContributionLabels(config["labels"])) {
    throw new BoundaryValidationError(boundary, `${location} has invalid localized labels`);
  }
  if (surface === "route") {
    if (!hasOnlyKeys(config, new Set(["path", "labels"])) ||
      typeof config["path"] !== "string" ||
      config["path"].length > 200 ||
      !routePathPattern.test(config["path"])) {
      throw new BoundaryValidationError(
        boundary,
        `${location} must be exact route metadata with a canonical path`,
      );
    }
    return;
  }
  if (surface === "sidebar" &&
    (!hasOnlyKeys(config, new Set(["route", "labels"])) ||
      typeof config["route"] !== "string" ||
      config["route"].length > 100 ||
      !localIdPattern.test(config["route"]))) {
    throw new BoundaryValidationError(
      boundary,
      `${location} must be exact sidebar metadata naming a local route contribution`,
    );
  }
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
