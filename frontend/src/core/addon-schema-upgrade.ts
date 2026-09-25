import { BoundaryValidationError, isRecord } from "./boundary.js";

export interface SchemaChange {
  kind: "collection" | "record-extension"; dataId: string;
  fromVersion: string; fromSha256: string; toVersion: string; toSha256: string; documents: number;
}
export interface SchemaReview {
  reviewId: string; addonId: string; generationId: string; expectedStateRevision: number;
  snapshotSha256: string; reviewSha256: string; status: "prepared" | "applied";
  createdAt: string; expiresAt: string; appliedAt?: string;
  documents: number; changes: SchemaChange[]; blockers: { code: string; kind: string; dataId: string; message: string }[];
}
const fail = (): never => { throw new BoundaryValidationError("Saved-data review", "invalid server response"); };
const object = (v: unknown) => isRecord(v) ? v : fail();
const text = (v: unknown): string => typeof v === "string" && v.length <= 1024 ? v : fail();
const count = (v: unknown): number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail();
const hash = (v: unknown): string => /^[a-f0-9]{64}$/u.test(text(v)) ? text(v) : fail();
const date = (v: unknown): string => Number.isFinite(Date.parse(text(v))) ? text(v) : fail();
const list = (v: unknown, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : fail();
const kind = (v: unknown): SchemaChange["kind"] => v === "collection" || v === "record-extension" ? v : fail();
const localId = (v: unknown): string => /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(text(v)) ? text(v) : fail();
export function parseSchemaReview(value: unknown, target: { addonId: string; generationId: string }, previous?: SchemaReview): SchemaReview {
  const r = object(value);
  if (r["contractVersion"] !== "addon-schema-review.v1" || r["addonId"] !== target.addonId || r["generationId"] !== target.generationId ||
    !/^[a-zA-Z0-9._-]{1,128}$/u.test(text(r["reviewId"])) ||
    (r["status"] !== "prepared" && r["status"] !== "applied")) fail();
  const result: SchemaReview = {
    reviewId: text(r["reviewId"]), addonId: text(r["addonId"]), generationId: hash(r["generationId"]),
    expectedStateRevision: count(r["expectedStateRevision"]), snapshotSha256: hash(r["snapshotSha256"]),
    reviewSha256: hash(r["reviewSha256"]), status: r["status"] as SchemaReview["status"],
    createdAt: date(r["createdAt"]), expiresAt: date(r["expiresAt"]), documents: count(r["documents"]),
    changes: list(r["changes"], 256).map(v => { const c = object(v); return { kind: kind(c["kind"]), dataId: localId(c["dataId"]),
      fromVersion: text(c["fromVersion"]), fromSha256: hash(c["fromSha256"]), toVersion: text(c["toVersion"]), toSha256: hash(c["toSha256"]), documents: count(c["documents"]) }; }),
    blockers: list(r["blockers"], 100).map(v => { const b = object(v); return { code: text(b["code"]), kind: kind(b["kind"]), dataId: localId(b["dataId"]), message: text(b["message"]) }; }),
    ...(r["appliedAt"] === undefined ? {} : { appliedAt: date(r["appliedAt"]) }),
  };
  if ((result.status === "applied") !== (result.appliedAt !== undefined) ||
    Date.parse(result.expiresAt) <= Date.parse(result.createdAt) ||
    new Set(result.changes.map(c => c.kind + "/" + c.dataId)).size !== result.changes.length ||
    result.changes.reduce((n, c) => n + c.documents, 0) > result.documents ||
    (result.status === "applied" && (result.blockers.length || !result.changes.length))) fail();
  if (previous && (result.reviewId !== previous.reviewId || result.reviewSha256 !== previous.reviewSha256 ||
    result.snapshotSha256 !== previous.snapshotSha256 || (previous.status === "applied" && result.status !== "applied"))) fail();
  return result;
}
