import { describe, expect, it } from "vitest";
import { BoundaryValidationError } from "../src/core/boundary.js";
import { readJSONResponse } from "../src/core/http.js";

class TestHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`returned ${status}`);
  }
}

const rules = (maxBytes = 64) => ({
  boundary: "test",
  maxBytes,
  signal: new AbortController().signal,
  httpError: (status: number, body: unknown) => new TestHTTPError(status, body),
});

describe("readJSONResponse", () => {
  it("returns parsed JSON within the limit", async () => {
    await expect(readJSONResponse(Response.json({ ok: true }), rules())).resolves.toEqual({
      ok: true,
    });
  });

  it("hands the caller's error the status and a JSON error body", async () => {
    await expect(
      readJSONResponse(Response.json({ error: { kind: "CONFLICT" } }, { status: 409 }), rules()),
    ).rejects.toMatchObject({ status: 409, body: { error: { kind: "CONFLICT" } } });
    await expect(
      readJSONResponse(new Response("<html>Bad Gateway</html>", { status: 502 }), rules()),
    ).rejects.toMatchObject({ status: 502, body: undefined });
  });

  it("rejects a wrong type, an oversized body and invalid JSON at the boundary", async () => {
    for (const response of [
      new Response("{}"),
      Response.json({ text: "x".repeat(100) }),
      new Response("{", { headers: { "Content-Type": "application/json" } }),
    ])
      await expect(readJSONResponse(response, rules())).rejects.toThrow(BoundaryValidationError);
  });

  it("counts UTF-8 bytes, not characters", async () => {
    // 26 characters, 44 bytes.
    const body = { t: "čččččččččččččččččč" };
    await expect(readJSONResponse(Response.json(body), rules(44))).resolves.toEqual(body);
    await expect(readJSONResponse(Response.json(body), rules(43))).rejects.toThrow(
      "response exceeds 43 bytes",
    );
  });
});
