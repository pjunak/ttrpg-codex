import type { ActiveBrowserContribution } from "../addons/browser-sdk.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import { isRecord } from "../core/boundary.js";
import { campaignPages, recordHash } from "./routes.js";

/** Labels and routes from the role-projected dataset, limited to approved grants. */
export function routeRecordReferences(campaign: CampaignDataset | undefined, active: ActiveBrowserContribution) {
  const resources = new Set(active.permissions?.filter(grant => grant.id === "core.data.read").flatMap(grant => grant.resources));
  const pages = campaignPages.filter(page => resources.has(page.collection));
  if (!pages.length) return undefined;
  const records: { collection: string; id: string; label: string; href: string }[] = [];
  const encoder = new TextEncoder();
  let bytes = 0, truncated = false;
  for (const page of pages) for (const record of campaign?.collections.find(collection => collection.name === page.collection)?.records ?? []) {
    const value = record.value;
    const name = isRecord(value) ? value["name"] ?? value["title"] : undefined;
    const reference = { collection: page.collection, id: record.key, label: (typeof name === "string" && name.trim() ? name : record.key).slice(0, 200), href: recordHash(page, record.key) };
    const size = encoder.encode(JSON.stringify(reference)).length;
    // Leave room for query pairs and the envelope in the isolated 64 KiB bridge.
    if (records.length >= 1000 || bytes + size > 48_000) { truncated = true; continue; }
    bytes += size; records.push(reference);
  }
  return { records, truncated, ready: campaign !== undefined };
}
