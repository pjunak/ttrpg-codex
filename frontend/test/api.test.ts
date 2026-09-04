import { describe, expect, it } from "vitest";
import {
  BoundaryValidationError,
  parseAuthState,
  parseHealth,
  switchRole,
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

describe("switchRole", () => {
  it("rotates a DM session with the current CSRF token", async () => {
    const originalFetch = globalThis.fetch;
    let captured: {
      input: string | URL | Request;
      init: RequestInit | undefined;
    } | undefined;
    globalThis.fetch = async (input, init) => {
      captured = { input, init };
      return new Response(JSON.stringify({
        ok: true,
        role: "player",
        realRole: "dm",
        csrfToken: "b".repeat(32),
        expiresAt: "2026-09-30T12:00:00Z",
      }), { headers: { "Content-Type": "application/json" } });
    };
    try {
      await expect(switchRole(
        "player", "a".repeat(32), new AbortController().signal,
      )).resolves.toMatchObject({ role: "player", realRole: "dm" });
      expect(captured?.input).toBe("/api/view-as");
      expect(captured?.init?.method).toBe("POST");
      expect(new Headers(captured?.init?.headers).get("X-Codex-CSRF")).toBe("a".repeat(32));
      expect(JSON.parse(String(captured?.init?.body))).toEqual({ role: "player" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a missing CSRF token before making a request", async () => {
    await expect(switchRole(
      "dm", "short", new AbortController().signal,
    )).rejects.toThrow(BoundaryValidationError);
  });
});
