import type { ActiveBrowserContribution } from "../addons/browser-sdk.js";
import type { CampaignCollectionName, CampaignRecord } from "../core/campaign-data.js";
import { isRecord } from "../core/boundary.js";
import { campaignPages, recordHash } from "./routes.js";

export type RecordContributionMode = "map" | "editor";

export function acceptsRecordContribution(active: ActiveBrowserContribution, mode: RecordContributionMode, collection: CampaignCollectionName): boolean {
  const config = active.descriptor.config;
  if (!campaignPages.some(page => page.collection === collection)) return false;
  if (!active.permissions?.some(grant => grant.id === "core.data.read" && grant.resources.includes(collection))) return false;
  return config["contractVersion"] === 1 && (mode === "map"
    ? active.descriptor.surface === "slot" && collection === "locations" && config["slot"] === "map:pin:panel" && Object.keys(config).every(key => ["contractVersion", "slot", "labels"].includes(key))
    : active.descriptor.surface === "editor-panel" && config["collection"] === collection && Object.keys(config).every(key => ["contractVersion", "collection", "labels"].includes(key)));
}

/** The caller supplies a current role-visible record, never the editor's frozen draft. */
export function recordContributionContext(record: CampaignRecord, collection: CampaignCollectionName, mode: RecordContributionMode, locale: string) {
  const page = campaignPages.find(page => page.collection === collection);
  if (!page) throw new Error("Record contributions require a record page.");
  const value = isRecord(record.value) ? record.value : {};
  return { contractVersion: "record-context.v1", locale, readOnly: mode === "map",
    record: { collection, id: record.key, revision: record.revision,
      label: (typeof value["name"] === "string" ? value["name"] : record.key).slice(0, 200), href: recordHash(page, record.key) } };
}
