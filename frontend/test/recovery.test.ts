import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackupImportError,
  importBackup,
  parseImportedBackup,
  parseRecoveryListing,
} from "../src/core/recovery.js";
import { parseCampaignRestored } from "../src/core/event-stream.js";

describe("campaign recovery boundaries", () => {
  const point = {
    id: 2,
    createdAt: "2026-09-08T12:00:00.000Z",
    reason: "manual",
    bytes: 512,
    records: 4,
    documents: 0,
    media: 1,
    generationId: "",
    compatible: true,
  };
  const addonPoint = {
    ...point,
    id: 3,
    reason: "imported",
    records: 0,
    documents: 2,
    generationId: "a".repeat(64),
    compatible: false,
  };
  const campaign = { scope: "campaign", points: [point] };
  const sheets = { scope: "addon", addonId: "sheets", points: [addonPoint] };
  const listing = { contractVersion: "recovery-points.v3", revision: 7, parts: [campaign, sheets] };
  it("accepts bounded newest-first parts with no saved bodies", () => {
    expect(parseRecoveryListing(listing)).toEqual(listing);
    expect(
      parseRecoveryListing({ ...listing, revision: 0, parts: [{ ...campaign, points: [] }] }).parts,
    ).toEqual([{ scope: "campaign", points: [] }]);
    const withPoints = (points: unknown[]) => ({ ...listing, parts: [{ ...campaign, points }] });
    for (const value of [
      null,
      { ...listing, revision: -1 },
      { ...listing, revision: Number.MAX_SAFE_INTEGER + 1 },
      withPoints([point, point]),
      withPoints([{ ...point, records: -1 }]),
      withPoints([{ ...point, id: 0 }]),
      withPoints([{ ...point, reason: "unknown" }]),
      withPoints([{ ...point, createdAt: "invalid" }]),
      withPoints([{ ...point, image: { private: true } }]),
      withPoints([{ ...point, generationId: "latest" }]),
      withPoints(Array.from({ length: 51 }, (_, index) => ({ ...point, id: 60 - index }))),
    ])
      expect(() => parseRecoveryListing(value)).toThrow();
  });
  it("accepts only payload-free durable recovery invalidations", () => {
    const value = {
      sequence: 9,
      topic: "campaign-restored",
      revision: "12",
      occurredAt: "2026-09-08T12:00:00Z",
      metadata: {},
    };
    const message = (body: unknown) =>
      Object.assign(new Event("campaign-restored"), {
        data: JSON.stringify(body),
        lastEventId: "9",
      });
    expect(parseCampaignRestored(message(value))).toEqual({
      cause: "campaign-restored",
      cursor: 9,
    });
    for (const invalid of [
      { ...value, metadata: { privateKey: "dm-secret" } },
      { ...value, sequence: 8 },
      { ...value, revision: "-1" },
      { ...value, resourceId: "private" },
    ])
      expect(() => parseCampaignRestored(message(invalid))).toThrow();
  });
  it("starts with the campaign and keeps add-on parts closed and uniquely ordered", () => {
    const planner = { ...sheets, addonId: "planner" };
    for (const parts of [
      [],
      [sheets],
      [campaign, campaign],
      [campaign, sheets, sheets],
      [campaign, sheets, planner],
      [campaign, { ...sheets, addonId: "../sheets" }],
      [campaign, { ...sheets, body: { private: true } }],
      [{ ...campaign, addonId: "sheets" }, sheets],
      [campaign, { ...sheets, points: [{ ...addonPoint, compatible: "yes" }] }],
    ])
      expect(() => parseRecoveryListing({ ...listing, parts })).toThrow();
    expect(() =>
      parseRecoveryListing({ ...listing, contractVersion: "recovery-points.v2" }),
    ).toThrow();
  });
});

describe("backup import", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("uploads the bundle as a ZIP with CSRF and returns what was imported", async () => {
    const fetch = respond(200, {
      contractVersion: "backup-import.v1",
      createdAt: "2026-10-04T10:15:44Z",
      parts: 3,
    });
    vi.stubGlobal("fetch", fetch);
    const archive = new Blob(["zip"], { type: "application/zip" });
    await expect(importBackup(new AbortController().signal, "token", archive)).resolves.toEqual({
      createdAt: "2026-10-04T10:15:44Z",
      parts: 3,
    });
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/backup/import");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(archive);
    expect(init.headers).toMatchObject({
      "Content-Type": "application/zip",
      "X-Codex-CSRF": "token",
    });
  });

  it("maps server refusals to stable codes and keeps only the invalid-bundle reason", async () => {
    for (const [status, kind, code] of [
      [400, "INVALID_BACKUP", "invalid"],
      [403, "FORBIDDEN", "forbidden"],
      [413, "PAYLOAD_TOO_LARGE", "too-large"],
      [503, "BACKUP_UNAVAILABLE", "failed"],
    ] as const) {
      vi.stubGlobal("fetch", respond(status, { error: { kind, message: "manifest is missing" } }));
      const error: unknown = await importBackup(
        new AbortController().signal,
        "token",
        new Blob(["zip"]),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BackupImportError);
      expect((error as BackupImportError).code).toBe(code);
      expect((error as BackupImportError).detail).toBe(
        code === "invalid" ? "manifest is missing" : "",
      );
    }
  });

  it("rejects malformed import responses", () => {
    const valid = {
      contractVersion: "backup-import.v1",
      createdAt: "2026-10-04T10:15:44Z",
      parts: 1,
    };
    expect(parseImportedBackup(valid)).toEqual({ createdAt: valid.createdAt, parts: 1 });
    for (const value of [
      { ...valid, createdAt: "not a date" },
      { ...valid, parts: 0 },
      { ...valid, contractVersion: "backup-restore.v1" },
      { ...valid, extra: true },
    ])
      expect(() => parseImportedBackup(value)).toThrow();
  });
});
