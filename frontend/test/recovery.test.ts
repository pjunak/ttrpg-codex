import { describe, expect, it } from "vitest";
import { parseRecoveryListing } from "../src/core/recovery.js";
import { parseCampaignRestored } from "../src/core/event-stream.js";

describe("campaign recovery boundaries", () => {
  const point = { id: 2, createdAt: "2026-09-08T12:00:00.000Z", reason: "manual", bytes: 512, records: 4, documents: 2, media: 1 };
  const listing = { contractVersion: "recovery-points.v1", revision: 7, points: [point] };
  it("accepts a bounded newest-first list with no campaign bodies", () => {
    expect(parseRecoveryListing(listing)).toEqual(listing);
    expect(parseRecoveryListing({ ...listing, revision: 0, points: [] }).points).toEqual([]);
    for (const value of [null, { ...listing, revision: -1 }, { ...listing, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...listing, points: [point, point] }, { ...listing, points: [{ ...point, records: -1 }] }, { ...listing, points: [{ ...point, id: 0 }] }, { ...listing, points: [{ ...point, reason: "unknown" }] }, { ...listing, points: [{ ...point, createdAt: "invalid" }] }, { ...listing, points: [{ ...point, image: { private: true } }] }]) expect(() => parseRecoveryListing(value)).toThrow();
  });
  it("accepts only payload-free durable recovery invalidations", () => {
    const value = { sequence: 9, topic: "campaign-restored", revision: "12", occurredAt: "2026-09-08T12:00:00Z", metadata: {} };
    const message = (body: unknown) => Object.assign(new Event("campaign-restored"), { data: JSON.stringify(body), lastEventId: "9" });
    expect(parseCampaignRestored(message(value))).toEqual({ cause: "campaign-restored", cursor: 9 });
    for (const invalid of [{ ...value, metadata: { privateKey: "dm-secret" } }, { ...value, sequence: 8 }, { ...value, revision: "-1" }, { ...value, resourceId: "private" }]) expect(() => parseCampaignRestored(message(invalid))).toThrow();
  });
});
