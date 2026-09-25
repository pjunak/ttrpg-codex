import { describe, expect, it } from "vitest";
import { parseSchemaReview } from "../src/core/addon-schema-upgrade.js";

const target = { addonId: "notes", generationId: "a".repeat(64) };
const fixture = () => ({ contractVersion: "addon-schema-review.v1", ...target, reviewId: "review-1",
  reviewSha256: "b".repeat(64), snapshotSha256: "c".repeat(64), expectedStateRevision: 2, status: "prepared",
  createdAt: "2026-09-25T10:00:00Z", expiresAt: "2026-09-25T10:30:00Z", documents: 1, blockers: [],
  changes: [{ kind: "collection", dataId: "notes", fromVersion: "1.0.0", fromSha256: "d".repeat(64), toVersion: "2.0.0", toSha256: "e".repeat(64), documents: 1 }] });
describe("saved-data review boundary", () => {
  it("checks the exact persisted identity when resolving a lost reply", () => {
    const original = parseSchemaReview(fixture(), target);
    const applied = { ...fixture(), status: "applied", appliedAt: "2026-09-25T10:01:00Z" };
    expect(parseSchemaReview(applied, target, original).status).toBe("applied");
    for (const key of ["generationId", "snapshotSha256", "reviewSha256", "reviewId"]) {
      expect(() => parseSchemaReview({ ...applied, [key]: key === "reviewId" ? "other" : "f".repeat(64) }, target, original)).toThrow();
    }
    expect(() => parseSchemaReview(fixture(), target, parseSchemaReview(applied, target))).toThrow();
  });
  it("rejects invalid counts, dates, identities and contradictory receipts", () => {
    for (const patch of [{ documents: -1 }, { expectedStateRevision: 1.5 }, { expiresAt: "yesterday" },
      { contractVersion: "unknown" }, { status: "applied" }, { appliedAt: "2026-09-25T10:00:00Z" },
      { changes: [fixture().changes[0], fixture().changes[0]] }, { documents: 0 }]) {
      expect(() => parseSchemaReview({ ...fixture(), ...patch }, target)).toThrow();
    }
  });
});
