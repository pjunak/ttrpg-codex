import { requestBodyText } from "./request-body.js";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred.js";
import { BoundaryValidationError } from "../src/core/boundary.js";
import {
  MediaClient,
  MediaHTTPError,
  parseMediaBlob,
  parseMediaDeleteResult,
  parseMapTileManifest,
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
  it("validates bounded map pyramid dimensions and rejects foreign tile sources", async () => {
    const manifest = {
      contractVersion: "map-tiles.v1",
      id: blob.id,
      width: 1280,
      height: 800,
      tileSize: 256,
      depth: 3,
    };
    expect(parseMapTileManifest(manifest)).toEqual(manifest);
    for (const invalid of [
      { ...manifest, depth: 2 },
      { ...manifest, tileSize: 512 },
      { ...manifest, width: 32769 },
      { ...manifest, width: 32000, height: 32000, depth: 7 },
      { ...manifest, width: 0 },
      { ...manifest, url: "https://external.invalid/{z}" },
    ]) {
      expect(() => parseMapTileManifest(invalid)).toThrow(BoundaryValidationError);
    }
    const calls: string[] = [];
    const client = new MediaClient(async (input, init) => {
      calls.push(input);
      expect(init.cache).toBe("no-store");
      return jsonResponse(manifest);
    });
    const signal = new AbortController().signal;
    await expect(client.mapTiles(blob.url, signal)).resolves.toEqual(manifest);
    expect(calls).toEqual([`${blob.url}/tiles/v1/manifest`]);
    await expect(client.mapTiles("https://example.invalid/map.png", signal)).rejects.toThrow(
      BoundaryValidationError,
    );
    const foreign = new MediaClient(async () =>
      jsonResponse({ ...manifest, id: "b_" + "2".repeat(32) }),
    );
    await expect(foreign.mapTiles(blob.url, signal)).rejects.toThrow(BoundaryValidationError);
  });
  it("accepts exact blob and deletion results", () => {
    expect(parseMediaBlob(blob)).toEqual(blob);
    expect(
      parseMediaDeleteResult({
        contractVersion: "media-delete-result.v1",
        id: blob.id,
        revision: 2,
        deleted: true,
      }),
    ).toEqual({
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
  for (const method of ["upload", "latest", "delete", "map tiles"] as const) {
    for (const phase of ["headers", "body"] as const) {
      it.each(["success", "failure"] as const)(
        `cancels held ${method} ${phase} before its late %s without replay`,
        async (outcome) => {
          const started = deferred();
          const release = deferred();
          const finished = deferred();
          const fetchMedia = vi.fn(async () => {
            const hold = async () => {
              started.resolve();
              await release.promise;
              finished.resolve();
              if (outcome === "failure") throw new Error("retired upload failure");
            };
            const payload =
              method === "delete"
                ? {
                    contractVersion: "media-delete-result.v1",
                    id: blob.id,
                    revision: 2,
                    deleted: true,
                  }
                : method === "map tiles"
                  ? {
                      contractVersion: "map-tiles.v1",
                      id: blob.id,
                      width: 1280,
                      height: 800,
                      tileSize: 256,
                      depth: 3,
                    }
                  : blob;
            const response = jsonResponse(payload, 201);
            vi.spyOn(response, "text").mockImplementation(async () => {
              if (phase === "body") await hold();
              return JSON.stringify(payload);
            });
            if (phase === "headers") await hold();
            return response;
          });
          const client = new MediaClient(fetchMedia);
          const controller = new AbortController();
          const reason = new Error("application disconnected");
          let settlement: unknown;
          const request =
            method === "upload"
              ? client.upload(
                  "character-portrait",
                  "hero",
                  new Blob(["image"], { type: "image/png" }),
                  "portrait.png",
                  "c".repeat(32),
                  controller.signal,
                )
              : method === "latest"
                ? client.latest("character-portrait", "hero", controller.signal)
                : method === "delete"
                  ? client.delete(blob.id, 1, "c".repeat(32), controller.signal)
                  : client.mapTiles(blob.url, controller.signal);
          const operation = request.then(
            (value) => {
              settlement = value;
            },
            (cause: unknown) => {
              settlement = cause;
            },
          );
          await started.promise;
          try {
            controller.abort(reason);
            await vi.waitFor(() => expect(settlement).toBe(reason));
          } finally {
            release.resolve();
            await finished.promise;
            await operation;
          }
          expect(settlement).toBe(reason);
          expect(fetchMedia).toHaveBeenCalledTimes(1);
        },
      );
    }
  }

  it("uploads raw bytes with encoded filename and bound CSRF", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchMedia: MediaFetch = async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(blob, 201);
    };
    const client = new MediaClient(fetchMedia);
    const content = new Blob(["image bytes"], { type: "image/png" });
    const signal = new AbortController().signal;

    await expect(
      client.upload(
        "character-portrait",
        "hero",
        content,
        "Hrdina žluťoučký.png",
        "c".repeat(32),
        signal,
      ),
    ).resolves.toEqual(blob);

    expect(calls[0]?.input).toBe("/api/media/character-portrait/hero");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      body: content,
      credentials: "same-origin",
      cache: "no-store",
      signal,
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
    expect(JSON.parse(requestBodyText(calls[1]?.init.body))).toEqual({
      contractVersion: "media-delete.v1",
      expectedRevision: 1,
    });
  });

  it("rejects invalid requests locally and reports only HTTP status", async () => {
    const client = new MediaClient(async () => new Response("private detail", { status: 403 }));
    await expect(
      client.upload(
        "world-map",
        "not-main",
        new Blob(["x"], { type: "image/png" }),
        "map.png",
        "c".repeat(32),
        new AbortController().signal,
      ),
    ).rejects.toThrow(BoundaryValidationError);
    await expect(
      client.latest("character-portrait", "hero", new AbortController().signal),
    ).rejects.toEqual(new MediaHTTPError(403, "GET /api/media/latest/{kind}/{target}"));
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
