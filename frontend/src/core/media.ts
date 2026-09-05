import { sessionFetch } from "./player-preview.js";
import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";

const uploadBoundary = "POST /api/media/{kind}/{target}";
const latestBoundary = "GET /api/media/latest/{kind}/{target}";
const deleteBoundary = "DELETE /api/media/{id}";
const maximumResponseBytes = 64 * 1024;
const blobIDPattern = /^b_[0-9a-f]{32}$/;
const mediaKinds = new Set<MediaKind>([
  "character-portrait",
  "pet-portrait",
  "location-map",
  "world-map",
  "marker-icon",
  "branding-logo",
]);
const blobKeys = new Set([
  "contractVersion",
  "id",
  "url",
  "kind",
  "target",
  "mediaType",
  "bytes",
  "revision",
  "createdAt",
]);
const deleteKeys = new Set(["contractVersion", "id", "revision", "deleted"]);

export type MediaKind =
  | "character-portrait"
  | "pet-portrait"
  | "location-map"
  | "world-map"
  | "marker-icon"
  | "branding-logo";

export interface MediaBlob {
  readonly contractVersion: "media-blob.v1";
  readonly id: string;
  readonly url: string;
  readonly kind: MediaKind;
  readonly target: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly revision: number;
  readonly createdAt: string;
}

export interface MediaDeleteResult {
  readonly contractVersion: "media-delete-result.v1";
  readonly id: string;
  readonly revision: number;
  readonly deleted: true;
}

export interface MapTileManifest {
  readonly contractVersion: "map-tiles.v1";
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly tileSize: 256;
  readonly depth: number;
}
const mapTileBoundary = "GET /api/media/{id}/tiles/v1/manifest";
const mapTileKeys = new Set(["contractVersion", "id", "width", "height", "tileSize", "depth"]);

export function parseMapTileManifest(value: unknown): MapTileManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, mapTileKeys) || value["contractVersion"] !== "map-tiles.v1" ||
    typeof value["id"] !== "string" || !blobIDPattern.test(value["id"]) ||
    !positiveInteger(value["width"]) || !positiveInteger(value["height"]) || value["width"] > 32768 || value["height"] > 32768 ||
    value["width"] * value["height"] > 32 * 1024 * 1024 || value["tileSize"] !== 256 ||
    !nonNegativeInteger(value["depth"]) || value["depth"] !== Math.max(0, Math.ceil(Math.log2(Math.max(value["width"], value["height"]) / 256)))) {
    throw new BoundaryValidationError(mapTileBoundary, "response must be an exact bounded map pyramid");
  }
  return { contractVersion: "map-tiles.v1", id: value["id"], width: value["width"], height: value["height"], tileSize: 256, depth: value["depth"] };
}

export type MediaFetch = (input: string, init: RequestInit) => Promise<Response>;

export class MediaHTTPError extends Error {
  override readonly name = "MediaHTTPError";

  constructor(readonly status: number, readonly endpoint: string) {
    super(`${endpoint} returned ${status}`);
  }
}

export class MediaClient {
  readonly #fetchMedia: MediaFetch;

  constructor(fetchMedia: MediaFetch = (input, init) => sessionFetch(input, init)) {
    this.#fetchMedia = fetchMedia;
  }

  async mapTiles(url: string, signal: AbortSignal): Promise<MapTileManifest> {
    signal.throwIfAborted();
    const match = /^\/api\/media\/(b_[0-9a-f]{32})$/u.exec(url);
    if (match === null) throw new BoundaryValidationError(mapTileBoundary, "map must use an opaque media URL");
    const response = await this.#fetchMedia(`${url}/tiles/v1/manifest`, {
      method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal,
    });
    const manifest = await parseJSONResponse(response, mapTileBoundary, parseMapTileManifest);
    if (manifest.id !== match[1]) throw new BoundaryValidationError(mapTileBoundary, "map pyramid belongs to another image");
    return manifest;
  }

  async upload(
    kind: MediaKind,
    target: string,
    content: Blob,
    filename: string,
    csrfToken: string,
    signal: AbortSignal,
  ): Promise<MediaBlob> {
    signal.throwIfAborted();
    validateTarget(kind, target, uploadBoundary);
    if (content.size <= 0 || content.type === "" || csrfToken.length < 32 ||
      filename.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(filename)) {
      throw new BoundaryValidationError(uploadBoundary, "media upload is invalid");
    }
    const endpoint = `/api/media/${encodeURIComponent(kind)}/${encodeURIComponent(target)}`;
    const response = await this.#fetchMedia(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": content.type,
        "X-Codex-CSRF": csrfToken,
        "X-Codex-Filename": encodeURIComponent(filename),
      },
      credentials: "same-origin",
      cache: "no-store",
      body: content,
      signal,
    });
    return parseJSONResponse(response, uploadBoundary, parseMediaBlob);
  }

  async latest(
    kind: MediaKind,
    target: string,
    signal: AbortSignal,
  ): Promise<MediaBlob> {
    signal.throwIfAborted();
    validateTarget(kind, target, latestBoundary);
    const endpoint = `/api/media/latest/${encodeURIComponent(kind)}/${encodeURIComponent(target)}`;
    const response = await this.#fetchMedia(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    return parseJSONResponse(response, latestBoundary, parseMediaBlob);
  }

  async delete(
    id: string,
    expectedRevision: number,
    csrfToken: string,
    signal: AbortSignal,
  ): Promise<MediaDeleteResult> {
    signal.throwIfAborted();
    if (!blobIDPattern.test(id) || !positiveInteger(expectedRevision) || csrfToken.length < 32) {
      throw new BoundaryValidationError(deleteBoundary, "media deletion is invalid");
    }
    const endpoint = `/api/media/${encodeURIComponent(id)}`;
    const response = await this.#fetchMedia(endpoint, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Codex-CSRF": csrfToken,
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        contractVersion: "media-delete.v1",
        expectedRevision,
      }),
      signal,
    });
    return parseJSONResponse(response, deleteBoundary, parseMediaDeleteResult);
  }
}

export function parseMediaBlob(value: unknown): MediaBlob {
  if (!isRecord(value) || !hasOnlyKeys(value, blobKeys) ||
    value["contractVersion"] !== "media-blob.v1" ||
    typeof value["id"] !== "string" || !blobIDPattern.test(value["id"]) ||
    value["url"] !== `/api/media/${value["id"]}` ||
    !isMediaKind(value["kind"]) ||
    typeof value["target"] !== "string" || value["target"].length === 0 ||
    value["target"].length > 1024 ||
    typeof value["mediaType"] !== "string" || !value["mediaType"].startsWith("image/") ||
    !nonNegativeInteger(value["bytes"]) || !positiveInteger(value["revision"]) ||
    typeof value["createdAt"] !== "string" || !validTimestamp(value["createdAt"])) {
    throw new BoundaryValidationError(uploadBoundary, "response must be an exact media blob");
  }
  return {
    contractVersion: "media-blob.v1",
    id: value["id"],
    url: value["url"],
    kind: value["kind"],
    target: value["target"],
    mediaType: value["mediaType"],
    bytes: value["bytes"],
    revision: value["revision"],
    createdAt: value["createdAt"],
  };
}

export function parseMediaDeleteResult(value: unknown): MediaDeleteResult {
  if (!isRecord(value) || !hasOnlyKeys(value, deleteKeys) ||
    value["contractVersion"] !== "media-delete-result.v1" ||
    typeof value["id"] !== "string" || !blobIDPattern.test(value["id"]) ||
    !positiveInteger(value["revision"]) || value["deleted"] !== true) {
    throw new BoundaryValidationError(deleteBoundary, "response must be an exact deletion result");
  }
  return {
    contractVersion: "media-delete-result.v1",
    id: value["id"],
    revision: value["revision"],
    deleted: true,
  };
}

async function parseJSONResponse<T>(
  response: Response,
  boundary: string,
  parse: (value: unknown) => T,
): Promise<T> {
  if (!response.ok) {
    throw new MediaHTTPError(response.status, boundary);
  }
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BoundaryValidationError(boundary, "response must be application/json");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > maximumResponseBytes) {
    throw new BoundaryValidationError(boundary, "response exceeds 64 KiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new BoundaryValidationError(boundary, "response must be valid JSON");
  }
  return parse(value);
}

function validateTarget(kind: MediaKind, target: string, boundary: string): void {
  if (!isMediaKind(kind) || target.length === 0 || target.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(target) ||
    ((kind === "world-map" || kind === "branding-logo") && target !== "main")) {
    throw new BoundaryValidationError(boundary, "media target is invalid");
  }
}

function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === "string" && mediaKinds.has(value as MediaKind);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
}
