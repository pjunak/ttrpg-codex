import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";

export interface AddonRecoveryPoint {
  readonly addonId: string;
  readonly generationId: string;
  readonly documents: number;
  readonly media: number;
  readonly compatible: boolean;
}
export interface RecoveryPoint {
  readonly id: number;
  readonly createdAt: string;
  readonly reason: "manual" | "save" | "pre-restore";
  readonly bytes: number;
  readonly records: number;
  readonly documents: number;
  readonly media: number;
  readonly campaignAvailable: boolean;
  readonly campaignMedia: number;
  readonly addons: readonly AddonRecoveryPoint[];
}
export interface RecoveryListing {
  readonly contractVersion: "recovery-points.v2";
  readonly revision: number;
  readonly points: readonly RecoveryPoint[];
}
export type RecoveryScope =
  { readonly scope: "campaign" } | { readonly scope: "addon"; readonly addonId: string };
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
export function parseRecoveryListing(value: unknown): RecoveryListing {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(["contractVersion", "revision", "points"])) ||
    value["contractVersion"] !== "recovery-points.v2" ||
    !natural(value["revision"]) ||
    !Array.isArray(value["points"]) ||
    value["points"].length > 50
  ) {
    throw new BoundaryValidationError("recovery points", "invalid listing");
  }
  const points: RecoveryPoint[] = [];
  for (const point of value["points"]) {
    if (
      !isRecord(point) ||
      !hasOnlyKeys(
        point,
        new Set([
          "id",
          "createdAt",
          "reason",
          "bytes",
          "records",
          "documents",
          "media",
          "campaignAvailable",
          "campaignMedia",
          "addons",
        ]),
      ) ||
      !natural(point["id"]) ||
      point["id"] < 1 ||
      points.some((existing) => existing.id <= Number(point["id"])) ||
      typeof point["createdAt"] !== "string" ||
      !Number.isFinite(Date.parse(point["createdAt"])) ||
      !["manual", "save", "pre-restore"].includes(String(point["reason"])) ||
      !natural(point["bytes"]) ||
      !natural(point["records"]) ||
      !natural(point["documents"]) ||
      !natural(point["media"]) ||
      typeof point["campaignAvailable"] !== "boolean" ||
      !natural(point["campaignMedia"]) ||
      !Array.isArray(point["addons"]) ||
      point["addons"].length > 512
    ) {
      throw new BoundaryValidationError("recovery points", "invalid recovery point");
    }
    const addons: AddonRecoveryPoint[] = [];
    for (const addon of point["addons"]) {
      if (
        !isRecord(addon) ||
        !hasOnlyKeys(
          addon,
          new Set(["addonId", "generationId", "documents", "media", "compatible"]),
        ) ||
        typeof addon["addonId"] !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(addon["addonId"]) ||
        addons.some((existing) => existing.addonId === addon["addonId"]) ||
        typeof addon["generationId"] !== "string" ||
        (addon["generationId"] !== "" && !/^[a-f0-9]{64}$/.test(addon["generationId"])) ||
        !natural(addon["documents"]) ||
        !natural(addon["media"]) ||
        typeof addon["compatible"] !== "boolean"
      )
        throw new BoundaryValidationError("recovery points", "invalid add-on context");
      addons.push({
        addonId: addon["addonId"],
        generationId: addon["generationId"],
        documents: addon["documents"],
        media: addon["media"],
        compatible: addon["compatible"],
      });
    }
    points.push({
      id: point["id"],
      createdAt: point["createdAt"],
      reason: point["reason"] as RecoveryPoint["reason"],
      bytes: point["bytes"],
      records: point["records"],
      documents: point["documents"],
      media: point["media"],
      campaignAvailable: point["campaignAvailable"],
      campaignMedia: point["campaignMedia"],
      addons,
    });
  }
  return { contractVersion: "recovery-points.v2", revision: value["revision"], points };
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
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
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
  return parseRecoveryListing(await response.json());
}
