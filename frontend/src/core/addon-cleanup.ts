import { BoundaryValidationError, isRecord } from "./boundary.js";

export interface CleanupScope { addonId?: string; generationId?: string; keepInactive?: number }
export interface CleanupGeneration {
  addonId: string; generationId: string; version: string; bytes: number; files: number;
  remove: boolean; protection: "" | "active" | "recovery" | "last-installed" | "retention";
  recoveryPointIds: number[]; activationReviewIds: string[]; historyRecords: number;
}
export interface CleanupReview { scope: CleanupScope; generations: CleanupGeneration[]; removeCount: number; reclaimableBytes: number; pendingCleanups: number; reviewSha256: string }
export interface CleanupResult { complete: boolean; removedCount: number; reclaimedBytes: number; pendingCleanups: number }
const fail = (): never => { throw new BoundaryValidationError("Saved package cleanup", "invalid server response"); };
const object = (v: unknown): Record<string, unknown> => isRecord(v) ? v : fail();
const text = (v: unknown): string => typeof v === "string" ? v : fail();
const count = (v: unknown): number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail();
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : fail();
const hash = (v: unknown): string => /^[a-f0-9]{64}$/u.test(text(v)) ? text(v) : fail();
const id = (v: unknown): string => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(text(v)) && text(v).length <= 80 ? text(v) : fail();
export function cleanupScope(v: unknown): CleanupScope {
  const r = object(v), addonId = r["addonId"] === undefined ? undefined : id(r["addonId"]);
  if (r["generationId"] !== undefined) {
    if (!addonId || r["keepInactive"] !== undefined) fail();
    return { addonId: addonId!, generationId: hash(r["generationId"]) };
  }
  const keepInactive = count(r["keepInactive"]); if (keepInactive > 5) fail();
  return { ...(addonId ? { addonId } : {}), keepInactive };
}
export function parseCleanupReview(v: unknown, expected: CleanupScope): CleanupReview {
  const r = object(v), scope = cleanupScope(r["scope"]);
  if (r["contractVersion"] !== "addon-package-cleanup-review.v1" || JSON.stringify(scope) !== JSON.stringify(cleanupScope(expected))) fail();
  const generations = list(r["generations"]).map(v => {
    const g = object(v), protection = text(g["protection"]), remove = g["remove"];
    if (!["", "active", "recovery", "last-installed", "retention"].includes(protection) || typeof remove !== "boolean" || remove !== (protection === "")) fail();
    const result: CleanupGeneration = { addonId: id(g["addonId"]), generationId: hash(g["generationId"]), version: text(g["version"]), bytes: count(g["bytes"]), files: count(g["files"]), remove: remove as boolean, protection: protection as CleanupGeneration["protection"], recoveryPointIds: list(g["recoveryPointIds"]).map(count), activationReviewIds: list(g["activationReviewIds"]).map(text), historyRecords: count(g["historyRecords"]) };
    if (result.remove && result.recoveryPointIds.length || scope.addonId && result.addonId !== scope.addonId || scope.generationId && result.generationId !== scope.generationId) fail();
    return result;
  });
  const removeCount = count(r["removeCount"]), reclaimableBytes = count(r["reclaimableBytes"]), removing = generations.filter(g => g.remove);
  if (generations.length > 512 || new Set(generations.map(g => `${g.addonId}:${g.generationId}`)).size !== generations.length || removeCount !== removing.length || reclaimableBytes !== removing.reduce((n, g) => n + g.bytes, 0) || scope.generationId && generations.length !== 1) fail();
  return { scope, generations, removeCount, reclaimableBytes, pendingCleanups: count(r["pendingCleanups"]), reviewSha256: hash(r["reviewSha256"]) };
}
export function parseCleanupResult(v: unknown, review?: CleanupReview): CleanupResult {
  const r = object(v), pendingCleanups = count(r["pendingCleanups"]), complete = r["complete"];
  if (r["contractVersion"] !== "addon-package-cleanup-result.v1" || r["applied"] !== true || typeof complete !== "boolean" || complete !== (pendingCleanups === 0) || review && r["reviewSha256"] !== review.reviewSha256) fail();
  const removedCount = count(r["removedCount"]), reclaimedBytes = count(r["reclaimedBytes"]);
  if (review && (removedCount !== review.removeCount || reclaimedBytes !== (complete ? review.reclaimableBytes : 0))) fail();
  return { complete: complete as boolean, removedCount, reclaimedBytes, pendingCleanups };
}
