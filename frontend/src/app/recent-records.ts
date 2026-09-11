import type { CampaignDataset } from "../core/campaign-data.js";
import { projectEntities, recentCampaignActivity, type EntitySummary } from "./campaign-projection.js";
import { campaignPages, type AppRoute } from "./routes.js";

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
  const entity = projectEntities(campaign, route.page).find(entity => entity.key === route.key);
  if (!entity) return;
  const previous = readRecent(role);
  if (previous[0] === entity.route) return;
  try { sessionStorage.setItem(storageKey(role), JSON.stringify([entity.route, ...previous.filter(path => path !== entity.route)].slice(0, maximumRecent))); }
  catch { /* Recent campaign activity remains available without browser storage. */ }
}

/** Store only identities, then resolve labels and visibility from the latest projection. */
export function recentSearchResults(campaign: CampaignDataset, role: string): readonly EntitySummary[] {
  const entities = campaignPages.flatMap(page => projectEntities(campaign, page));
  const byRoute = new Map(entities.map(entity => [entity.route, entity]));
  const opened = readRecent(role).flatMap(path => byRoute.get(path) ?? []);
  const seen = new Set(opened.map(entity => entity.route));
  const activity = recentCampaignActivity(campaign, maximumRecent * 2).filter(entity => !seen.has(entity.route));
  return [...opened, ...activity].slice(0, maximumRecent);
}
