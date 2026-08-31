import { describe, expect, it } from "vitest";
import {
  BoundaryValidationError,
  parseAuthState,
  parseHealth,
} from "../src/core/api.js";

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

describe("parseAuthState", () => {
  it("accepts anonymous and DM-as-player authority", () => {
    expect(parseAuthState({ role: null, realRole: null })).toEqual({
      authenticated: false,
      role: null,
      realRole: null,
    });
    expect(parseAuthState({
      ok: true,
      role: "player",
      realRole: "dm",
      csrfToken: "a".repeat(32),
      expiresAt: "2026-09-30T12:00:00Z",
    })).toEqual({
      authenticated: true,
      role: "player",
      realRole: "dm",
      csrfToken: "a".repeat(32),
      expiresAt: "2026-09-30T12:00:00Z",
    });
  });

  it.each([
    { role: null, realRole: null, csrfToken: "unexpected" },
    { ok: true, role: "dm", realRole: "player", csrfToken: "a".repeat(32), expiresAt: "2026-09-30T12:00:00Z" },
    { ok: true, role: "dm", realRole: "dm", csrfToken: "short", expiresAt: "2026-09-30T12:00:00Z" },
    { ok: true, role: "dm", realRole: "dm", csrfToken: "a".repeat(32), expiresAt: "not-a-date" },
  ])("rejects malformed authority %#", (value) => {
    expect(() => parseAuthState(value)).toThrow(BoundaryValidationError);
  });
});
