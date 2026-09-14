import { describe, expect, it } from "vitest";
import { cleanupScope, parseCleanupReview, parseCleanupResult } from "../src/core/addon-cleanup.js";
const hash = "a".repeat(64);
function wire() { return { contractVersion: "addon-package-cleanup-review.v1", scope: { keepInactive: 0 }, reviewSha256: hash, removeCount: 1, reclaimableBytes: 120, pendingCleanups: 0, generations: [{ addonId: "example", generationId: hash, version: "1.0.0", bytes: 120, files: 2, remove: true, protection: "", recoveryPointIds: [], activationReviewIds: ["review-1"], historyRecords: 4 }] }; }
describe("saved package cleanup boundaries", () => {
  it("validates exact scope, package totals and preserved history", () => { const review = parseCleanupReview(wire(), { keepInactive: 0 }); expect(review.removeCount).toBe(1); expect(review.generations[0]?.historyRecords).toBe(4); });
  it("rejects protection contradictions and response swaps", () => {
    for (const patch of [{ remove: false }, { protection: "active" }, { recoveryPointIds: [1] }, { bytes: -1 }, { generationId: "../file" }]) { const v = wire(); Object.assign(v.generations[0]!, patch); expect(() => parseCleanupReview(v, { keepInactive: 0 })).toThrow(); }
    expect(() => parseCleanupReview(wire(), { keepInactive: 1 })).toThrow();
    expect(() => parseCleanupReview({ ...wire(), reclaimableBytes: 121 }, { keepInactive: 0 })).toThrow();
    const v = wire(); v.generations.push(v.generations[0]!); expect(() => parseCleanupReview(v, { keepInactive: 0 })).toThrow();
  });
  it("rejects unbounded and ambiguous scopes", () => { for (const v of [{}, { keepInactive: 6 }, { keepInactive: 0.5 }, { addonId: "../x", keepInactive: 0 }, { generationId: hash }, { addonId: "example", generationId: hash, keepInactive: 0 }]) expect(() => cleanupScope(v)).toThrow(); });
  it("accepts an exact pending receipt and rejects a false completion", () => {
    const review = parseCleanupReview(wire(), { keepInactive: 0 }), result = { contractVersion: "addon-package-cleanup-result.v1", reviewSha256: hash, applied: true, complete: false, removedCount: 1, reclaimedBytes: 0, pendingCleanups: 1 };
    expect(parseCleanupResult(result, review).complete).toBe(false);
    for (const patch of [{ complete: true }, { applied: false }, { reviewSha256: "b".repeat(64) }, { removedCount: 0 }, { reclaimedBytes: 120 }]) expect(() => parseCleanupResult({ ...result, ...patch }, review)).toThrow();
    expect(parseCleanupResult({ ...result, complete: true, reclaimedBytes: 120, pendingCleanups: 0 }, review).complete).toBe(true);
  });
});
