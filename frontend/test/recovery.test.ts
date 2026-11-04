import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackupRestoreError,
  parseRecoveryListing,
  parseStagedBackupRestore,
  restoreFullBackup,
  waitForHostRestart,
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

describe("full backup restore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("uploads the archive as a ZIP with CSRF and returns the staged backup", async () => {
    const fetch = respond(202, {
      contractVersion: "backup-restore.v1",
      createdAt: "2026-10-04T10:15:44Z",
      hostVersion: "2.0.0",
      appliedMigrations: 1,
    });
    vi.stubGlobal("fetch", fetch);
    const archive = new Blob(["zip"], { type: "application/zip" });
    await expect(
      restoreFullBackup(new AbortController().signal, "token", archive),
    ).resolves.toEqual({ createdAt: "2026-10-04T10:15:44Z", hostVersion: "2.0.0" });
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/backup/restore");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(archive);
    expect(init.headers).toMatchObject({
      "Content-Type": "application/zip",
      "X-Codex-CSRF": "token",
    });
  });

  it("maps server refusals to stable codes and keeps only the invalid-archive reason", async () => {
    for (const [status, kind, code] of [
      [400, "INVALID_BACKUP", "invalid"],
      [409, "RESTORE_PENDING", "pending"],
      [409, "RESTORE_IN_PROGRESS", "busy"],
      [413, "PAYLOAD_TOO_LARGE", "too-large"],
      [503, "RESTORE_UNAVAILABLE", "failed"],
    ] as const) {
      vi.stubGlobal("fetch", respond(status, { error: { kind, message: "manifest is missing" } }));
      const error: unknown = await restoreFullBackup(
        new AbortController().signal,
        "token",
        new Blob(["zip"]),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BackupRestoreError);
      expect((error as BackupRestoreError).code).toBe(code);
      expect((error as BackupRestoreError).detail).toBe(
        code === "invalid" ? "manifest is missing" : "",
      );
    }
  });

  it("rejects malformed staged responses", () => {
    expect(() =>
      parseStagedBackupRestore({
        contractVersion: "backup-restore.v1",
        createdAt: "not a date",
        hostVersion: "2.0.0",
        appliedMigrations: 0,
      }),
    ).toThrow();
    expect(() =>
      parseStagedBackupRestore({
        contractVersion: "backup-restore.v1",
        createdAt: "2026-10-04T10:15:44Z",
        hostVersion: "2.0.0",
        appliedMigrations: 0,
        extra: true,
      }),
    ).toThrow();
  });

  it("waits through a restart until health answers again", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 3) throw new TypeError("connection refused");
        return new Response(JSON.stringify({ status: "ok", version: "2.0.0" }));
      }),
    );
    await expect(
      waitForHostRestart(new AbortController().signal, { delay: 0, interval: 0, deadline: 5000 }),
    ).resolves.toBe(true);
    expect(calls).toBe(3);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    );
    await expect(
      waitForHostRestart(new AbortController().signal, { delay: 0, interval: 1, deadline: 20 }),
    ).resolves.toBe(false);
  });
});
