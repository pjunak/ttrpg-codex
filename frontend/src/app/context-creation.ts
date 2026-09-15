import {campaignCollection, type CampaignDataset} from "../core/campaign-data.js";
import {recordValue} from "./campaign-projection.js";
import {campaignPages, collectionHash, contextCreationActions, createReturnHash, type AppRoute} from "./routes.js";

type CreateRoute = Extract<AppRoute, {kind: "create"}>;
export function creationSource(route: CreateRoute, campaign: CampaignDataset) {
  const context = route.context;
  if (!context) return undefined;
  const action = contextCreationActions[context.action];
  const page = campaignPages.find(page => page.collection === action.source)!;
  return {page, record: campaignCollection(campaign, action.source).records.find(record => record.key === context.key)};
}
export function contextualCreationFields(route: CreateRoute, campaign: CampaignDataset): Readonly<Record<string, unknown>> {
  if (!route.context) return {};
  const source = creationSource(route, campaign)?.record;
  if (!source) return {};
  const action = contextCreationActions[route.context.action], key = route.context.key;
  return {[action.field]: action.field === "locations" ? [key] : key,
    visibility: recordValue(source)["visibility"] === "dm" ? "dm" : "public",
    ...(action.target === "events" ? {sitting: 1} : {})};
}
export function creationBackHash(route: CreateRoute, campaign: CampaignDataset): string {
  const source = creationSource(route, campaign);
  return source && !source.record ? collectionHash(source.page) : createReturnHash(route);
}
