import { groupTwinRecords } from "./campaign-twins.js";
import { campaignCollection, type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";
import { recordValue } from "./campaign-projection.js";

export interface TimelineColumn { readonly sitting: number; readonly ids: readonly string[] }
export interface TimelineDraft {
  readonly base: readonly { readonly key: string; readonly revision: number }[];
  readonly columns: readonly TimelineColumn[];
}
export class TimelineEditError extends Error {
  constructor(readonly kind: "invalid" | "stale" | "limit") { super(`timeline edit is ${kind}`); }
}

export function timelineSitting(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1; }
export function timelineRecords(campaign: CampaignDataset): readonly CampaignRecord[] {
  return groupTwinRecords(campaignCollection(campaign, "events").records);
}
export function timelineColumns(campaign: CampaignDataset): readonly TimelineColumn[] {
  const groups = new Map<number, string[]>();
  const order = (record: CampaignRecord) => { const value = recordValue(record)["order"]; return typeof value === "number" && Number.isFinite(value) ? value : 0; };
  for (const record of [...timelineRecords(campaign)].sort((a, b) => order(a) - order(b))) {
    const sitting = timelineSitting(recordValue(record)["sitting"]), ids = groups.get(sitting) ?? [];
    ids.push(record.key); groups.set(sitting, ids);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([sitting, ids]) => ({ sitting, ids }));
}
export function timelineDraft(campaign: CampaignDataset): TimelineDraft {
  return { base: campaignCollection(campaign, "events").records.map(({ key, revision }) => ({ key, revision })), columns: timelineColumns(campaign) };
}
export function nextTimelineSitting(columns: readonly TimelineColumn[]): number {
  const max = columns.reduce((max, column) => Math.max(max, column.sitting), 1);
  if (max < Number.MAX_SAFE_INTEGER) return max + 1;
  const occupied = new Set(columns.map(column => column.sitting));
  let next = 1; while (occupied.has(next)) next++;
  return next;
}
export function timelineSessions(columns: readonly TimelineColumn[]): readonly number[] {
  const max = columns.reduce((max, column) => Math.max(max, column.sitting), 1);
  // Keep corrupt or unusually sparse session numbers from allocating millions of columns.
  return max <= 200 ? Array.from({ length: max }, (_, index) => index + 1) : [...new Set([1, ...columns.map(column => column.sitting)])].sort((a, b) => a - b);
}
export function moveTimelineEvent(draft: TimelineDraft, key: string, sitting: number, index: number): TimelineDraft {
  if (timelineSitting(sitting) !== sitting || !Number.isSafeInteger(index) || index < 0 ||
    !draft.columns.some(column => column.ids.includes(key))) throw new TimelineEditError("invalid");
  const columns = draft.columns.map(column => ({ ...column, ids: column.ids.filter(id => id !== key) }));
  let target = columns.find(column => column.sitting === sitting);
  if (target === undefined) { target = { sitting, ids: [] }; columns.push(target); }
  target.ids.splice(Math.min(index, target.ids.length), 0, key);
  return { ...draft, columns: columns.filter(column => column.ids.length > 0).sort((a, b) => a.sitting - b.sitting) };
}
export function sameTimelineOrder(a: readonly TimelineColumn[], b: readonly TimelineColumn[]): boolean {
  return a.length === b.length && a.every((column, index) => column.sitting === b[index]?.sitting &&
    column.ids.length === b[index]?.ids.length && column.ids.every((id, position) => id === b[index]?.ids[position]));
}
export function prepareTimelineReorder(campaign: CampaignDataset, detail: TimelineDraft): readonly CampaignMutation[] {
  if (detail == null || !Array.isArray(detail.base) || !Array.isArray(detail.columns) || detail.base.some(item =>
    typeof item?.key !== "string" || !Number.isSafeInteger(item.revision) || item.revision < 1)) throw new TimelineEditError("invalid");
  const records = campaignCollection(campaign, "events").records, current = new Map(records.map(record => [record.key, record]));
  if (new Set(detail.base.map(item => item.key)).size !== detail.base.length) throw new TimelineEditError("invalid");
  if (detail.base.length !== records.length || detail.base.some(item => current.get(item.key)?.revision !== item.revision)) throw new TimelineEditError("stale");
  const original = timelineColumns(campaign), visible = new Set(original.flatMap(column => column.ids));
  const seen = new Set<string>(), sessions = new Set<number>();
  for (const column of detail.columns) {
    if (column == null || timelineSitting(column.sitting) !== column.sitting || sessions.has(column.sitting) ||
      !Array.isArray(column.ids) || column.ids.length === 0) throw new TimelineEditError("invalid");
    sessions.add(column.sitting);
    for (const key of column.ids) {
      if (!visible.has(key) || seen.has(key)) throw new TimelineEditError("invalid");
      seen.add(key);
    }
  }
  if (visible.size !== seen.size) throw new TimelineEditError("invalid");
  const mutations: CampaignMutation[] = [];
  for (const column of detail.columns) {
    const before = original.find(item => item.sitting === column.sitting);
    if (before !== undefined && sameTimelineOrder([before], [column])) continue;
    column.ids.forEach((key: string, index: number) => {
      const record = current.get(key)!, value = recordValue(record), order = index + 1;
      const moved = timelineSitting(value["sitting"]) !== column.sitting;
      if (!moved && value["order"] === order) return;
      mutations.push({ operation: "put", collection: "events", key, expectedRevision: record.revision,
        value: { ...value, order, ...(moved ? { sitting: column.sitting } : {}) } });
    });
  }
  if (mutations.length > 500) throw new TimelineEditError("limit");
  return mutations;
}
