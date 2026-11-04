import { isSha256 } from "./validators.js";
import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";
import { waitForSignal } from "./abort-signal.js";

export interface RecoveryPoint {
  readonly id: number;
  readonly createdAt: string;
  readonly reason: "manual" | "save" | "pre-restore" | "download" | "imported";
  readonly bytes: number;
  readonly records: number;
  readonly documents: number;
  readonly media: number;
  /** The add-on build the point needs; empty for the campaign. */
  readonly generationId: string;
  readonly compatible: boolean;
}
export type RecoveryScope =
  { readonly scope: "campaign" } | { readonly scope: "addon"; readonly addonId: string };
/** One part's points, newest first. */
export type RecoveryPart = RecoveryScope & { readonly points: readonly RecoveryPoint[] };
export interface RecoveryListing {
  readonly contractVersion: "recovery-points.v3";
  readonly revision: number;
  /** The campaign first, then add-ons with points by ID. */
  readonly parts: readonly RecoveryPart[];
}
export type RecoveryAction =
  | { readonly kind: "create" }
  | (RecoveryScope &
      (
        | {
            readonly kind: "delete" | "restore";
            readonly id: number;
            readonly expectedRevision: number;
          }
        | { readonly kind: "revert"; readonly count: number; readonly expectedRevision: number }
      ));
export class RecoveryRequestError extends Error {
  constructor(readonly code: "conflict" | "compatibility" | "forbidden" | "missing" | "failed") {
    super(code);
  }
}
const natural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const pointsPerPart = 50;
const reasons: ReadonlySet<unknown> = new Set([
  "manual",
  "save",
  "pre-restore",
  "download",
  "imported",
]);
const pointKeys: ReadonlySet<string> = new Set([
  "id",
  "createdAt",
  "reason",
  "bytes",
  "records",
  "documents",
  "media",
  "generationId",
  "compatible",
]);
function parsePoints(value: unknown): RecoveryPoint[] {
  if (!Array.isArray(value) || value.length > pointsPerPart)
    throw new BoundaryValidationError("recovery points", "invalid part points");
  const points: RecoveryPoint[] = [];
  for (const point of value) {
    if (
      !isRecord(point) ||
      !hasOnlyKeys(point, pointKeys) ||
      !natural(point["id"]) ||
      point["id"] < 1 ||
      points.some((existing) => existing.id <= Number(point["id"])) ||
      typeof point["createdAt"] !== "string" ||
      !Number.isFinite(Date.parse(point["createdAt"])) ||
      !reasons.has(point["reason"]) ||
      !natural(point["bytes"]) ||
      !natural(point["records"]) ||
      !natural(point["documents"]) ||
      !natural(point["media"]) ||
      typeof point["generationId"] !== "string" ||
      (point["generationId"] !== "" && !isSha256(point["generationId"])) ||
      typeof point["compatible"] !== "boolean"
    ) {
      throw new BoundaryValidationError("recovery points", "invalid recovery point");
    }
    points.push({
      id: point["id"],
      createdAt: point["createdAt"],
      reason: point["reason"] as RecoveryPoint["reason"],
      bytes: point["bytes"],
      records: point["records"],
      documents: point["documents"],
      media: point["media"],
      generationId: point["generationId"],
      compatible: point["compatible"],
    });
  }
  return points;
}
export function parseRecoveryListing(value: unknown): RecoveryListing {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["contractVersion", "revision", "parts"])) ||
    value["contractVersion"] !== "recovery-points.v3" ||
    !natural(value["revision"]) ||
    !Array.isArray(value["parts"]) ||
    value["parts"].length < 1 ||
    value["parts"].length > 513
  ) {
    throw new BoundaryValidationError("recovery points", "invalid listing");
  }
  const parts: RecoveryPart[] = [];
  for (const [index, part] of value["parts"].entries()) {
    if (!isRecord(part)) throw new BoundaryValidationError("recovery points", "invalid part");
    if (index === 0) {
      if (!hasOnlyKeys(part, new Set(["scope", "points"])) || part["scope"] !== "campaign")
        throw new BoundaryValidationError("recovery points", "campaign part missing");
      parts.push({ scope: "campaign", points: parsePoints(part["points"]) });
      continue;
    }
    const addonId = part["addonId"];
    if (
      !hasOnlyKeys(part, new Set(["scope", "addonId", "points"])) ||
      part["scope"] !== "addon" ||
      typeof addonId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(addonId) ||
      parts.some((existing) => existing.scope === "addon" && existing.addonId >= addonId)
    )
      throw new BoundaryValidationError("recovery points", "invalid add-on part");
    parts.push({ scope: "addon", addonId, points: parsePoints(part["points"]) });
  }
  return { contractVersion: "recovery-points.v3", revision: value["revision"], parts };
}
export async function recoveryRequest(
  signal: AbortSignal,
  csrfToken?: string,
  action?: RecoveryAction,
): Promise<RecoveryListing> {
  const path =
    action?.kind === "delete"
      ? "/delete"
      : action?.kind === "restore" || action?.kind === "revert"
        ? "/restore"
        : "";
  const body =
    action === undefined || action.kind === "create"
      ? {}
      : {
          ...(action.kind === "revert" ? { count: action.count } : { id: action.id }),
          expectedRevision: action.expectedRevision,
          scope: action.scope,
          ...(action.scope === "addon" ? { addonId: action.addonId } : {}),
        };
  const response = await sessionFetch(`/api/recovery${path}`, {
    signal,
    credentials: "same-origin",
    cache: "no-store",
    ...(action
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Codex-CSRF": csrfToken ?? "" },
          body: JSON.stringify(body),
        }
      : { method: "GET" }),
  });
  signal.throwIfAborted();
  if (!response.ok) {
    const error: unknown = await waitForSignal(
      response.json().catch(() => null),
      signal,
    );
    signal.throwIfAborted();
    const compatibility =
      isRecord(error) &&
      isRecord(error["error"]) &&
      error["error"]["kind"] === "RECOVERY_COMPATIBILITY";
    throw new RecoveryRequestError(
      response.status === 403
        ? "forbidden"
        : response.status === 404
          ? "missing"
          : response.status === 409
            ? compatibility
              ? "compatibility"
              : "conflict"
            : "failed",
    );
  }
  const value: unknown = await waitForSignal(response.json(), signal);
  signal.throwIfAborted();
  return parseRecoveryListing(value);
}

export interface ImportedBackup {
  readonly createdAt: string;
  readonly parts: number;
}
export type BackupImportErrorCode = "invalid" | "too-large" | "forbidden" | "failed";
export class BackupImportError extends Error {
  constructor(
    readonly code: BackupImportErrorCode,
    readonly detail = "",
  ) {
    super(code);
  }
}

export function parseImportedBackup(value: unknown): ImportedBackup {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["contractVersion", "createdAt", "parts"])) ||
    value["contractVersion"] !== "backup-import.v1" ||
    typeof value["createdAt"] !== "string" ||
    Number.isNaN(Date.parse(value["createdAt"])) ||
    !natural(value["parts"]) ||
    value["parts"] < 1
  )
    throw new BoundaryValidationError("POST /api/backup/import", "response must be an import");
  return { createdAt: value["createdAt"], parts: value["parts"] };
}

/**
 * Uploads a downloaded backup. The host checks it and adds each part as an
 * imported recovery point; current data stays as it is until one is restored.
 */
export async function importBackup(
  signal: AbortSignal,
  csrfToken: string,
  archive: Blob,
): Promise<ImportedBackup> {
  const response = await sessionFetch("/api/backup/import", {
    signal,
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/zip",
      "X-Codex-CSRF": csrfToken,
    },
    body: archive,
  });
  signal.throwIfAborted();
  const value: unknown = await waitForSignal(
    response.json().catch(() => null),
    signal,
  );
  signal.throwIfAborted();
  if (response.ok) return parseImportedBackup(value);
  const error = isRecord(value) && isRecord(value["error"]) ? value["error"] : {};
  const kind = error["kind"];
  const codes: Readonly<Record<string, BackupImportErrorCode>> = {
    INVALID_BACKUP: "invalid",
    PAYLOAD_TOO_LARGE: "too-large",
    FORBIDDEN: "forbidden",
  };
  throw new BackupImportError(
    (typeof kind === "string" ? codes[kind] : undefined) ?? "failed",
    kind === "INVALID_BACKUP" && typeof error["message"] === "string"
      ? error["message"].slice(0, 500)
      : "",
  );
}
