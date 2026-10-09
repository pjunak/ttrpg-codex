import { describe, expect, it } from "vitest";
import { BoundaryValidationError } from "../src/core/boundary.js";
import { isAddonId, isSha256, responseReaders } from "../src/core/validators.js";

describe("shared response validators", () => {
  it("accepts only canonical add-on IDs and SHA-256 addresses", () => {
    expect(["notes", "dm-tools", "dnd-2024-compendium"].every(isAddonId)).toBe(true);
    expect(["", "Notes", "dm--tools", "-dm", "dm-", "a".repeat(81), 3].some(isAddonId)).toBe(false);
    expect(isSha256("a".repeat(64))).toBe(true);
    expect(["A".repeat(64), "a".repeat(63), undefined].some(isSha256)).toBe(false);
  });

  it("fails with the boundary's validation error", () => {
    const read = responseReaders("Example");
    expect(read.count(3)).toBe(3);
    expect(read.optionalText(undefined)).toBe("");
    for (const attempt of [
      () => read.count(-1),
      () => read.text("long", 3),
      () => read.list([1, 2], 1),
    ])
      expect(attempt).toThrow(BoundaryValidationError);
  });
});
