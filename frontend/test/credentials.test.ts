import { describe, expect, it } from "vitest";
import { parseCredentialStatus } from "../src/core/credentials.js";

describe("credential status boundary", () => {
  it("accepts only bounded status, never password material", () => {
    const status = { contractVersion: "credential-status.v1", revision: 3, playerEnabled: false };
    expect(parseCredentialStatus(status)).toEqual(status);
    for (const value of [{ ...status, revision: 0 }, { ...status, revision: 1.5 }, { ...status, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...status, playerEnabled: "false" }, { ...status, password: "must not cross this boundary" }, null]) {
      expect(() => parseCredentialStatus(value)).toThrow();
    }
  });
});
