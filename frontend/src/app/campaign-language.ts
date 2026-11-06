import { isRecord } from "../core/boundary.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";
import { applySiteLanguages, parseSiteLanguages, type SiteLanguages } from "./ui-localization.js";

/** The DM's site languages; unknown fields of the record survive edits. */
export interface CampaignLanguageSaveDetail extends SiteLanguages {
  readonly expectedRevision: number;
}

export class CampaignLanguageEditError extends Error {
  override readonly name = "CampaignLanguageEditError";

  constructor(
    message: string,
    readonly kind: "invalid" | "stale" = "invalid",
  ) {
    super(message);
  }
}

export function campaignLanguageRecord(campaign: CampaignDataset): CampaignRecord | undefined {
  return campaignCollection(campaign, "settings").records.find(({ key }) => key === "language");
}

/** The campaign's site languages, or undefined while the DM has not chosen. */
export function campaignSiteLanguages(campaign: CampaignDataset): SiteLanguages | undefined {
  return parseSiteLanguages(campaignLanguageRecord(campaign)?.value);
}

/** Makes the campaign's site languages the ones this browser resolves against. */
export function applyCampaignLanguages(campaign: CampaignDataset): void {
  applySiteLanguages(campaignSiteLanguages(campaign));
}

export function prepareCampaignLanguageSave(
  campaign: CampaignDataset,
  detail: CampaignLanguageSaveDetail,
): CampaignMutation {
  const record = campaignLanguageRecord(campaign);
  const languages = parseSiteLanguages(detail);
  if (!Number.isSafeInteger(detail.expectedRevision) || languages === undefined)
    throw new CampaignLanguageEditError("campaign language edit is invalid");
  if (detail.expectedRevision !== (record?.revision ?? 0))
    throw new CampaignLanguageEditError("campaign language revision is stale", "stale");
  const current = record === undefined ? {} : record.value;
  if (!isRecord(current)) throw new CampaignLanguageEditError("campaign language edit is invalid");
  return Object.freeze({
    operation: "put",
    collection: "settings",
    key: "language",
    expectedRevision: detail.expectedRevision,
    value: Object.freeze({
      ...current,
      defaultLocale: languages.defaultLocale,
      enabledLocales: [...languages.enabledLocales],
    }),
  });
}
