import type { CampaignDataset } from "../core/campaign-data.js";
import { campaignCollection } from "../core/campaign-data.js";
import { twinRepresentatives } from "./campaign-twins.js";
import { projectEntity, projectEntities, recentCampaignActivity, type EntitySummary } from "./campaign-projection.js";
import { recordHash, campaignPages, type AppRoute } from "./routes.js";

const maximumRecent = 12;
const storageKey = (role: string): string => `codex:recent-records:${role}`;

function readRecent(role: string): readonly string[] {
  try {
    const raw = sessionStorage.getItem(storageKey(role));
    if (!raw || raw.length > 16_000) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= 1_000).slice(0, maximumRecent) : [];
  } catch { return []; }
}

export function rememberRecentRecord(campaign: CampaignDataset, route: AppRoute, role: string): void {
  if (route.kind !== "record") return;
  const record = campaignCollection(campaign, route.page.collection).records.find(record => record.key === route.key);
  if (!record) return;
  const entity = projectEntity(campaign, record, route.page);
  const previous = readRecent(role);
  if (previous[0] === entity.route) return;
  try { sessionStorage.setItem(storageKey(role), JSON.stringify([entity.route, ...previous.filter(path => path !== entity.route)].slice(0, maximumRecent))); }
  catch { /* Recent campaign activity remains available without browser storage. */ }
}

/** Store only identities, then resolve labels and visibility from the latest projection. */
export function recentSearchResults(campaign: CampaignDataset, role: string): readonly EntitySummary[] {
  const entities = campaignPages.flatMap(page => projectEntities(campaign, page));
  const byRoute = new Map(entities.map(entity => [entity.route, entity]));
  const aliases = new Map<string, string>();
  for (const page of campaignPages) for (const [key, representative] of twinRepresentatives(campaignCollection(campaign, page.collection).records)) {
    aliases.set(recordHash(page, key), recordHash(page, representative));
  }
  const opened = [...new Set(readRecent(role).map(path => aliases.get(path) ?? path))].flatMap(path => byRoute.get(path) ?? []);
  const seen = new Set(opened.map(entity => entity.route));
  const activity = recentCampaignActivity(campaign, maximumRecent * 2).filter(entity => !seen.has(aliases.get(entity.route) ?? entity.route));
  return [...opened, ...activity].slice(0, maximumRecent);
}
