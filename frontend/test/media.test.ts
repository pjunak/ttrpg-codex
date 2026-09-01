import { describe, expect, it } from "vitest";
import { BoundaryValidationError } from "../src/core/boundary.js";
import {
  MediaClient,
  MediaHTTPError,
  parseMediaBlob,
  parseMediaDeleteResult,
  type MediaFetch,
} from "../src/core/media.js";

const blob = {
  contractVersion: "media-blob.v1",
  id: "b_11111111111111111111111111111111",
  url: "/api/media/b_11111111111111111111111111111111",
  kind: "character-portrait",
  target: "hero",
  mediaType: "image/png",
  bytes: 12,
  revision: 1,
  createdAt: "2026-09-01T17:00:00Z",
} as const;

describe("media boundary parsers", () => {
  it("accepts exact blob and deletion results", () => {
    expect(parseMediaBlob(blob)).toEqual(blob);
    expect(parseMediaDeleteResult({
      contractVersion: "media-delete-result.v1",
      id: blob.id,
      revision: 2,
      deleted: true,
    })).toEqual({
      contractVersion: "media-delete-result.v1",
      id: blob.id,
      revision: 2,
      deleted: true,
    });
  });

  it.each([
    { ...blob, url: "/api/media/b_22222222222222222222222222222222" },
    { ...blob, privatePath: "C:/data/blob" },
    { ...blob, kind: "unknown" },
    { ...blob, revision: 0 },
  ])("rejects malformed or path-leaking blob payloads %#", (value) => {
    expect(() => parseMediaBlob(value)).toThrow(BoundaryValidationError);
  });
});

describe("MediaClient", () => {
  it("uploads raw bytes with encoded filename and bound CSRF", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchMedia: MediaFetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(blob, 201);
    };
    const client = new MediaClient(fetchMedia);
    const content = new Blob(["image bytes"], { type: "image/png" });
    const signal = new AbortController().signal;

    await expect(client.upload(
      "character-portrait", "hero", content, "Hrdina žluťoučký.png",
      "c".repeat(32), signal,
    )).resolves.toEqual(blob);

    expect(calls[0]?.input).toBe("/api/media/character-portrait/hero");
    expect(calls[0]?.init).toMatchObject({
      method: "POST", body: content, credentials: "same-origin", cache: "no-store", signal,
    });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("Content-Type")).toBe("image/png");
    expect(headers.get("X-Codex-CSRF")).toBe("c".repeat(32));
    expect(headers.get("X-Codex-Filename")).toBe(encodeURIComponent("Hrdina žluťoučký.png"));
  });

  it("fetches latest metadata and sends revision-checked deletion", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const client = new MediaClient(async (input, init) => {
      calls.push({ input, init });
      if (init.method === "DELETE") {
        return jsonResponse({
          contractVersion: "media-delete-result.v1",
          id: blob.id,
          revision: 2,
          deleted: true,
        });
      }
      return jsonResponse(blob);
    });
    const signal = new AbortController().signal;

    await expect(client.latest("character-portrait", "hero", signal)).resolves.toEqual(blob);
    await expect(client.delete(blob.id, 1, "d".repeat(32), signal)).resolves.toMatchObject({
      revision: 2,
      deleted: true,
    });
    expect(calls[0]?.input).toBe("/api/media/latest/character-portrait/hero");
    expect(calls[1]?.input).toBe(`/api/media/${blob.id}`);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      contractVersion: "media-delete.v1",
      expectedRevision: 1,
    });
  });

  it("rejects invalid requests locally and reports only HTTP status", async () => {
    const client = new MediaClient(async () => new Response("private detail", { status: 403 }));
    await expect(client.upload(
      "world-map", "not-main", new Blob(["x"], { type: "image/png" }), "map.png",
      "c".repeat(32), new AbortController().signal,
    )).rejects.toThrow(BoundaryValidationError);
    await expect(client.latest(
      "character-portrait", "hero", new AbortController().signal,
    )).rejects.toEqual(new MediaHTTPError(403, "GET /api/media/latest/{kind}/{target}"));
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
