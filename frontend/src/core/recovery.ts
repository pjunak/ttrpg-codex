import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";

export interface RecoveryPoint { readonly id: number; readonly createdAt: string; readonly reason: "manual" | "save" | "pre-restore"; readonly bytes: number; readonly records: number; readonly documents: number; readonly media: number }
export interface RecoveryListing { readonly contractVersion: "recovery-points.v1"; readonly revision: number; readonly points: readonly RecoveryPoint[] }
export type RecoveryAction = { readonly kind: "create" } | { readonly kind: "delete" | "restore"; readonly id: number; readonly expectedRevision: number } | { readonly kind: "revert"; readonly count: number; readonly expectedRevision: number };
export class RecoveryRequestError extends Error { constructor(readonly code: "conflict" | "compatibility" | "forbidden" | "missing" | "failed") { super(code); } }
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseRecoveryListing(value: unknown): RecoveryListing {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["contractVersion", "revision", "points"])) || value["contractVersion"] !== "recovery-points.v1" || !natural(value["revision"]) || !Array.isArray(value["points"]) || value["points"].length > 50) {
    throw new BoundaryValidationError("recovery points", "invalid listing");
  }
  const points: RecoveryPoint[] = [];
  for (const point of value["points"]) {
    if (!isRecord(point) || !hasOnlyKeys(point, new Set(["id", "createdAt", "reason", "bytes", "records", "documents", "media"])) ||
      !natural(point["id"]) || point["id"] < 1 || points.some(existing => existing.id <= Number(point["id"])) ||
      typeof point["createdAt"] !== "string" || !Number.isFinite(Date.parse(point["createdAt"])) ||
      !["manual", "save", "pre-restore"].includes(String(point["reason"])) ||
      !natural(point["bytes"]) || !natural(point["records"]) || !natural(point["documents"]) || !natural(point["media"])) {
      throw new BoundaryValidationError("recovery points", "invalid recovery point");
    }
    points.push({ id: point["id"], createdAt: point["createdAt"], reason: point["reason"] as RecoveryPoint["reason"], bytes: point["bytes"], records: point["records"], documents: point["documents"], media: point["media"] });
  }
  return { contractVersion: "recovery-points.v1", revision: value["revision"], points };
}
export async function recoveryRequest(signal: AbortSignal, csrfToken?: string, action?: RecoveryAction): Promise<RecoveryListing> {
  const path = action?.kind === "delete" ? "/delete" : action?.kind === "restore" || action?.kind === "revert" ? "/restore" : "";
  const body = action === undefined || action.kind === "create" ? {} : action.kind === "revert" ? { count: action.count, expectedRevision: action.expectedRevision } : { id: action.id, expectedRevision: action.expectedRevision };
  const response = await sessionFetch(`/api/recovery${path}`, { signal, credentials: "same-origin", cache: "no-store",
    ...(action ? { method: "POST", headers: { "Content-Type": "application/json", "X-Codex-CSRF": csrfToken ?? "" }, body: JSON.stringify(body) } : { method: "GET" }) });
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    const compatibility = isRecord(error) && isRecord(error["error"]) && error["error"]["kind"] === "RECOVERY_COMPATIBILITY";
    throw new RecoveryRequestError(response.status === 403 ? "forbidden" : response.status === 404 ? "missing" : response.status === 409 ? compatibility ? "compatibility" : "conflict" : "failed");
  }
  return parseRecoveryListing(await response.json());
}
