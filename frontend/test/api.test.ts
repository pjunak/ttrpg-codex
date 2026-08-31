import { describe, expect, it } from "vitest";
import { BoundaryValidationError, parseHealth } from "../src/core/api.js";

describe("parseHealth", () => {
  it("accepts the reviewed boundary shape", () => {
    expect(parseHealth({ status: "ok", version: "2.0.0-dev" })).toEqual({
      status: "ok",
      version: "2.0.0-dev",
    });
  });

  it.each([null, [], { status: "ok" }, { status: "down", version: "2" }])(
    "rejects malformed input %#",
    (value) => {
      expect(() => parseHealth(value)).toThrow(BoundaryValidationError);
    },
  );
});
