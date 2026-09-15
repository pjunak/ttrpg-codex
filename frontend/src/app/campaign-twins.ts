import { isRecord } from "../core/boundary.js";
import type { CampaignRecord } from "../core/campaign-data.js";

/** Group only reciprocal opposite-visibility pairs present in this projection. */
export function twinRepresentatives(records: readonly CampaignRecord[]): ReadonlyMap<string, string> {
  const byKey = new Map(records.map(record => [record.key, record]));
  return new Map(records.map(record => {
    const value = isRecord(record.value) ? record.value : {};
    const other = typeof value["linkedTwinId"] === "string" ? byKey.get(value["linkedTwinId"]) : undefined;
    const twin = isRecord(other?.value) ? other.value : {};
    const reciprocal = other && other.key !== record.key && twin["linkedTwinId"] === record.key &&
      (value["visibility"] === "dm") !== (twin["visibility"] === "dm");
    return [record.key, reciprocal && twin["visibility"] === "dm" ? other.key : record.key];
  }));
}

export function groupTwinRecords(records: readonly CampaignRecord[]): readonly CampaignRecord[] {
  const representatives = twinRepresentatives(records);
  return records.filter(record => representatives.get(record.key) === record.key);
}