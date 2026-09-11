import { describe, expect, it } from "vitest";
import { parseAddonUninstallReview } from "../src/core/addon-uninstall.js";

const review = { contractVersion: "addon-uninstall-review.v1", addonId: "notes", name: "Notes", version: "1.0.0", reviewSha256: "a".repeat(64),
  rulesetName: "", unlinksSource: false, generations: ["b".repeat(64)], stoppedAddonIds: ["notes"], effects: [], retainedData: [{ kind: "collection", id: "notes", documents: 3 }] };

describe("uninstall review boundary", () => {
  it("rejects mismatched targets and malformed removal authority", () => {
    expect(parseAddonUninstallReview(review, "notes").retainedData[0]?.documents).toBe(3);
    expect(() => parseAddonUninstallReview(review, "another-addon")).toThrow();
    for (const changed of [{ reviewSha256: "invalid" }, { unlinksSource: "false" }, { stoppedAddonIds: ["../notes"] }, { effects: [{ addonId: "notes", name: "Notes", disabled: "false", reasons: [] }] }, { retainedData: [{ kind: "collection", id: "notes", documents: -1 }] }]) {
      expect(() => parseAddonUninstallReview({ ...review, ...changed }, "notes")).toThrow();
    }
  });
});
