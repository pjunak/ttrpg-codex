import { describe, expect, it } from "vitest";
import { BoundaryValidationError, parseAuthState, parseHealth } from "../src/core/api.js";

describe("parseHealth", () => {
  it("accepts the reviewed boundary shape", () => {
    expect(parseHealth({ status: "ok", version: "2.0.0" })).toEqual({
      status: "ok",
      version: "2.0.0",
    });
  });

  it.each([null, [], { status: "ok" }, { status: "down", version: "2" }])(
    "rejects malformed input %#",
    (value) => {
      expect(() => parseHealth(value)).toThrow(BoundaryValidationError);
    },
  );
});

describe("parseAuthState", () => {
  it("accepts anonymous and signed-in authority", () => {
    expect(parseAuthState({ role: null })).toEqual({ authenticated: false, role: null });
    expect(
      parseAuthState({
        ok: true,
        role: "player",
        csrfToken: "a".repeat(32),
        expiresAt: "2026-09-30T12:00:00Z",
      }),
    ).toEqual({
      authenticated: true,
      role: "player",
      csrfToken: "a".repeat(32),
      expiresAt: "2026-09-30T12:00:00Z",
    });
  });

  it.each([
    { role: null, csrfToken: "unexpected" },
    { ok: true, role: "admin", csrfToken: "a".repeat(32), expiresAt: "2026-09-30T12:00:00Z" },
    {
      ok: true,
      role: "dm",
      realRole: "dm",
      csrfToken: "a".repeat(32),
      expiresAt: "2026-09-30T12:00:00Z",
    },
    { ok: true, role: "dm", csrfToken: "short", expiresAt: "2026-09-30T12:00:00Z" },
    { ok: true, role: "dm", csrfToken: "a".repeat(32), expiresAt: "not-a-date" },
  ])("rejects malformed authority %#", (value) => {
    expect(() => parseAuthState(value)).toThrow(BoundaryValidationError);
  });
});
