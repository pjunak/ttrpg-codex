import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";

export type CampaignIdentityField = "name" | "tagline";

export interface CampaignIdentitySaveDetail {
  readonly field: CampaignIdentityField;
  readonly value: string;
  readonly expectedRevision: number;
}

export class CampaignIdentityEditError extends Error {
  override readonly name = "CampaignIdentityEditError";
  constructor(readonly kind: "invalid" | "stale") { super(`campaign identity edit is ${kind}`); }
}

export function campaignIdentityRecord(campaign: CampaignDataset) {
  return campaignCollection(campaign, "campaign").records.find(({ key }) => key === "main");
}

export function prepareCampaignIdentitySave(
  campaign: CampaignDataset,
  detail: CampaignIdentitySaveDetail,
): CampaignMutation {
  if ((detail.field !== "name" && detail.field !== "tagline") || typeof detail.value !== "string" ||
    !Number.isSafeInteger(detail.expectedRevision) || detail.expectedRevision < 0 ||
    detail.value.length > 500 || /\p{Cc}/u.test(detail.value) ||
    (detail.field === "name" && detail.value.trim() === "")) {
    throw new CampaignIdentityEditError("invalid");
  }
  const record = campaignIdentityRecord(campaign);
  if ((record?.revision ?? 0) !== detail.expectedRevision) throw new CampaignIdentityEditError("stale");
  const current = record === undefined ? {} : record.value;
  if (!isRecord(current)) throw new CampaignIdentityEditError("invalid");
  return Object.freeze({
    operation: "put", collection: "campaign", key: "main", expectedRevision: detail.expectedRevision,
    value: Object.freeze({ ...current, [detail.field]: detail.value.trim() }),
  });
}
