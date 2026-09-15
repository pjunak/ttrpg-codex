import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import { campaignPartyIdentity } from "./campaign-party.js";
import { projectEntity, recordValue, stringList, text } from "./campaign-projection.js";
import { groupTwinRecords, twinRepresentatives } from "./campaign-twins.js";
import { campaignPages } from "./routes.js";
import { uiText } from "./ui-localization.js";

export interface ArticleReference { readonly label: string; readonly href?: string }
export interface ArticleContextGroup { readonly title?: string; readonly entries: readonly ArticleReference[] }
export interface ArticleContextSection { readonly id: string; readonly title: string; readonly groups: readonly ArticleContextGroup[] }

/** References resolve against the current authorized snapshot, never a remembered label or guessed URL. */
export function articleReference(campaign: CampaignDataset, collection: string, key: string): ArticleReference {
  if (collection === "factions" && key === "party") return {label: campaignPartyIdentity(campaign).name, href: "#/party"};
  const page = campaignPages.find(page => page.collection === collection);
  const record = page && campaignCollection(campaign, page.collection).records.find(record => record.key === key);
  if (!page || !record) return {label: uiText("context.unavailable")};
  const entity = projectEntity(campaign, record, page);
  return {label: entity.name, href: entity.route};
}

export function articleReferences(campaign: CampaignDataset, collection: string, value: unknown): readonly ArticleReference[] {
  const keys = typeof value === "string" && value ? [value] : stringList(value);
  return [...new Set(keys)].map(key => articleReference(campaign, collection, key));
}

export function articleOwner(campaign: CampaignDataset, value: Readonly<Record<string, unknown>>): readonly ArticleReference[] {
  if (value["ownerType"] === "party") return [articleReference(campaign, "factions", "party")];
  const collection = value["ownerType"] === "character" ? "characters" : value["ownerType"] === "faction" ? "factions" : undefined;
  return collection ? articleReferences(campaign, collection, value["ownerId"]) : [];
}

function identityKeys(records: readonly CampaignRecord[], key: string): ReadonlySet<string> {
  const representatives = twinRepresentatives(records), representative = representatives.get(key);
  return new Set(representative === undefined ? [key] : records.filter(record => representatives.get(record.key) === representative).map(record => record.key));
}

export function articleContext(campaign: CampaignDataset, collection: string, key: string): readonly ArticleContextSection[] {
  const records = campaign.collections.find(item => item.name === collection)?.records ?? [];
  const record = records.find(record => record.key === key);
  if (!record) return [];
  const value = recordValue(record), keys = identityKeys(records, key);
  const sections: ArticleContextSection[] = [];
  const references = (name: string, matching: readonly CampaignRecord[]) =>
    groupTwinRecords(matching).map(record => articleReference(campaign, name, record.key));
  const add = (id: string, title: string, entries: readonly ArticleReference[]) => {
    if (entries.length) sections.push({id, title, groups: [{entries}]});
  };
  const matching = (name: "characters" | "locations" | "events" | "pets", predicate: (value: Readonly<Record<string, unknown>>) => boolean) =>
    campaignCollection(campaign, name).records.filter(record => predicate(recordValue(record)));

  if (collection === "locations") {
    const ancestors: ArticleReference[] = [], seen = new Set([key]), byKey = new Map(records.map(record => [record.key, record]));
    let parent = text(value["parentId"]);
    while (parent) {
      if (seen.has(parent)) { ancestors.unshift({label: uiText("context.cycle")}); break; }
      seen.add(parent);
      ancestors.unshift(articleReference(campaign, "locations", parent));
      const ancestor = byKey.get(parent);
      if (!ancestor) break;
      parent = text(recordValue(ancestor)["parentId"]);
    }
    add("ancestors", uiText("context.ancestors"), ancestors);
    add("connections", uiText("context.connected"), articleReferences(campaign, "locations", value["connections"]));
    add("children", uiText("context.children"), references("locations", matching("locations", item => keys.has(text(item["parentId"]))).filter(record => !keys.has(record.key))));
    add("residents", uiText("context.residents"), references("characters", matching("characters", item => keys.has(text(item["location"])))));
  }
  if (collection === "characters" || collection === "locations") {
    const field = collection === "characters" ? "characters" : "locations";
    add("events", uiText("context.events"), references("events", matching("events", item => stringList(item[field]).some(key => keys.has(key)))));
  }
  if (collection === "characters" || collection === "factions") {
    const owner = collection === "characters" ? "character" : "faction";
    add("companions", uiText("context.companions"), references("pets", matching("pets", item => item["ownerType"] === owner && keys.has(text(item["ownerId"])))));
  }
  if (collection === "factions") {
    const members = groupTwinRecords(matching("characters", item => keys.has(text(item["faction"]))));
    const chains = Array.isArray(value["rankChains"]) ? value["rankChains"].filter(isRecord) : [];
    const assigned = new Set<string>(), groups: ArticleContextGroup[] = [];
    for (const chain of chains) {
      const chainId = text(chain["id"]); if (!chainId) continue;
      const ranks = stringList(chain["ranks"]);
      for (const rank of ranks) {
        const occupants = members.filter(member => {
          const item = recordValue(member); return item["rankChain"] === chainId && item["rank"] === rank;
        });
        occupants.forEach(member => assigned.add(member.key));
        groups.push({title: [text(chain["name"]), rank].filter(Boolean).join(" — "), entries: references("characters", occupants)});
      }
      if (!ranks.length) groups.push({title: text(chain["name"]), entries: []});
    }
    const remaining = members.filter(member => !assigned.has(member.key));
    if (remaining.length) groups.push({title: uiText("context.unassigned"), entries: references("characters", remaining)});
    if (groups.length) sections.unshift({id: "members", title: uiText("context.members"), groups});
  }
  return sections;
}
