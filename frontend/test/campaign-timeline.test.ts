import { describe, expect, it } from "vitest";
import { timelineColumns, timelineDraft, timelineRecords, timelineSessions, timelineSitting, nextTimelineSitting,
  moveTimelineEvent, prepareTimelineReorder, TimelineEditError } from "../src/app/campaign-timeline.js";
import type { CampaignDataset, CampaignRecord } from "../src/core/campaign-data.js";

const event = (key: string, fields: Record<string, unknown> = {}, revision = 1): CampaignRecord => ({ key, revision, value: { id: key, name: key, ...fields } });
const dataset = (records: readonly CampaignRecord[]): CampaignDataset => ({ contractVersion: "campaign-data.v1", collections: [
  { name: "events", shape: "list", materialized: true, revision: 1, records },
] });

describe("session timeline", () => {
  it("groups missing sessions into the first column with stable stored-order ties and bounded gaps", () => {
    const campaign = dataset([event("later", { sitting: 3, order: 1 }), event("zero", { sitting: 0 }), event("missing"),
      event("first", { sitting: 1, order: -1 }), event("fraction", { sitting: 2.5 })]);
    const columns = timelineColumns(campaign);
    expect(columns).toEqual([{ sitting: 1, ids: ["first", "zero", "missing", "fraction"] }, { sitting: 3, ids: ["later"] }]);
    expect(timelineSessions(columns)).toEqual([1, 2, 3]);
    expect(timelineSessions([{ sitting: 1_000_000_000, ids: ["far"] }])).toEqual([1, 1_000_000_000]);
    expect(nextTimelineSitting(columns)).toBe(4);
    expect(timelineSitting(Infinity)).toBe(1);
    expect(Number.isSafeInteger(nextTimelineSitting([{ sitting: Number.MAX_SAFE_INTEGER, ids: ["far"] }]))).toBe(true);
  });
  it("deduplicates only reciprocal DM twins and keeps a lone public or stale twin visible", () => {
    const publicEvent = event("public", { linkedTwinId: "dm", visibility: "public" });
    const privateEvent = event("dm", { linkedTwinId: "public", visibility: "dm" });
    expect(timelineRecords(dataset([publicEvent, privateEvent, event("stale", { linkedTwinId: "missing" })])).map(record => record.key)).toEqual(["dm", "stale"]);
    expect(timelineRecords(dataset([publicEvent])).map(record => record.key)).toEqual(["public"]);
    expect(timelineRecords(dataset([publicEvent, event("dm", { visibility: "dm" })]))).toHaveLength(2);
  });
  it("renumbers affected sessions in one batch without changing content, links, map pins or extensions", () => {
    const a = event("a", { sitting: 1, order: 1, description: "Notes", mapX: .2, mapY: .3, characters: ["hero"], addonData: { keep: true } }, 4);
    const campaign = dataset([a, event("b", { sitting: 1, order: 2 }), event("c", { sitting: 3, order: 1 }), event("unrelated", { sitting: 5, order: 80 })]);
    const base = timelineDraft(campaign), original = structuredClone(base);
    const moved = moveTimelineEvent(base, "a", 3, 0);
    expect(base).toEqual(original);
    expect(prepareTimelineReorder(campaign, moved)).toEqual([
      { operation: "put", collection: "events", key: "b", expectedRevision: 1, value: { id: "b", name: "b", sitting: 1, order: 1 } },
      { operation: "put", collection: "events", key: "a", expectedRevision: 4, value: { ...(a.value as object), sitting: 3, order: 1 } },
      { operation: "put", collection: "events", key: "c", expectedRevision: 1, value: { id: "c", name: "c", sitting: 3, order: 2 } },
    ]);
    expect(prepareTimelineReorder(campaign, base)).toEqual([]);
  });
  it("preserves a missing or zero session when only its first-column order changes", () => {
    const campaign = dataset([event("zero", { sitting: 0, order: 1 }), event("missing", { order: 2 })]);
    const mutations = prepareTimelineReorder(campaign, moveTimelineEvent(timelineDraft(campaign), "missing", 1, 0));
    expect(mutations).toMatchObject([{ value: { id: "missing", order: 1 } }, { value: { id: "zero", sitting: 0, order: 2 } }]);
    if (mutations[0]?.operation === "put") expect(mutations[0].value).not.toHaveProperty("sitting");
  });
  it("rejects changed revisions, deleted/new records, duplicate or omitted cards and forged twins", () => {
    const campaign = dataset([event("a"), event("b")]), draft = moveTimelineEvent(timelineDraft(campaign), "a", 2, 0);
    for (const current of [dataset([event("a", {}, 2), event("b")]), dataset([event("a")]), dataset([event("a"), event("b"), event("new")])]) {
      expect(() => prepareTimelineReorder(current, draft)).toThrow("stale");
    }
    for (const columns of [[{ sitting: 1, ids: ["a", "a"] }], [{ sitting: 1, ids: ["a"] }], [{ sitting: 0, ids: ["a", "b"] }],
      [{ sitting: 1, ids: ["a", "b", "hidden"] }], [{ sitting: 1, ids: ["a"] }, { sitting: 1, ids: ["b"] }]]) {
      expect(() => prepareTimelineReorder(campaign, { ...draft, columns })).toThrow(TimelineEditError);
    }
  });
  it("rejects an oversized atomic reorder instead of splitting it into partial saves", () => {
    const campaign = dataset(Array.from({ length: 502 }, (_, index) => event(String(index), { sitting: 1, order: index + 1 })));
    expect(() => prepareTimelineReorder(campaign, moveTimelineEvent(timelineDraft(campaign), "501", 1, 0))).toThrow("limit");
  });
});
