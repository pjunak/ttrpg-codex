import type { CampaignDataset } from "../core/campaign-data.js";
import { projectEntities, type EntitySummary } from "./campaign-projection.js";
import { campaignPages, type CampaignPageDefinition } from "./routes.js";

export interface CampaignSearchResult extends EntitySummary {
  readonly page: CampaignPageDefinition;
  readonly score: number;
}

export interface CampaignSearchGroup {
  readonly page: CampaignPageDefinition;
  readonly results: readonly CampaignSearchResult[];
}

/** Searches only the already role-projected campaign dataset held by the host. */
export function searchCampaign(
  campaign: CampaignDataset,
  query: string,
  maximumResults = 60,
): readonly CampaignSearchGroup[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0 || maximumResults <= 0) return Object.freeze([]);

  const matches: CampaignSearchResult[] = [];
  for (const page of campaignPages) {
    for (const entity of projectEntities(campaign, page)) {
      const score = searchScore(entity, tokens);
      if (score > 0) matches.push(Object.freeze({ ...entity, page, score }));
    }
  }
  matches.sort((left, right) =>
    right.score - left.score || left.name.localeCompare(right.name) || left.key.localeCompare(right.key)
  );

  const accepted = matches.slice(0, maximumResults);
  const groups: CampaignSearchGroup[] = [];
  for (const page of campaignPages) {
    const results = accepted.filter((result) => result.page.id === page.id);
    if (results.length > 0) groups.push(Object.freeze({ page, results: Object.freeze(results) }));
  }
  return Object.freeze(groups);
}

function searchScore(entity: EntitySummary, tokens: readonly string[]): number {
  const name = searchable(entity.name);
  const title = searchable(entity.title);
  const tags = searchable(entity.tags.join(" "));
  const excerpt = searchable(entity.excerpt);
  const all = `${name} ${title} ${tags} ${excerpt}`;
  if (!tokens.every((token) => all.includes(token))) return 0;

  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 120;
    else if (name.startsWith(token)) score += 70;
    else if (name.includes(token)) score += 45;
    if (title.includes(token)) score += 24;
    if (tags.includes(token)) score += 16;
    if (excerpt.includes(token)) score += 6;
  }
  return score;
}

function searchTokens(query: string): readonly string[] {
  return Object.freeze([...new Set(searchable(query).split(/\s+/u).filter((token) => token.length > 0))]);
}

function searchable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .trim();
}
