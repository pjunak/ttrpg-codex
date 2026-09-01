import { isRecord } from "../core/boundary.js";
import {
  campaignCollection,
  type CampaignDataset,
} from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";
import type {
  CampaignRecordDeleteDetail,
  CampaignRecordSaveDetail,
} from "./campaign-record-browser.js";
import {
  campaignPages,
  type CampaignPageDescriptor,
} from "./core-navigation.js";

export class CampaignRecordEditError extends Error {
  override readonly name = "CampaignRecordEditError";

  constructor(readonly kind: "invalid" | "stale", message: string) {
    super(message);
  }
}

export interface PreparedCampaignRecordMutation {
  readonly page: CampaignPageDescriptor;
  readonly mutation: CampaignMutation;
}

export function prepareCampaignRecordSave(
  dataset: CampaignDataset,
  detail: CampaignRecordSaveDetail,
  canManageVisibility: boolean,
): PreparedCampaignRecordMutation {
  const page = campaignPages.find((candidate) => candidate.collection === detail.collection);
  if (page === undefined || !validRecordKey(detail.key) ||
    typeof detail.creating !== "boolean" || !validRevision(detail.expectedRevision, false) ||
    !isRecord(detail.fields)) {
    throw invalidEdit();
  }
  const collection = campaignCollection(dataset, page.collection);
  const record = collection.records.find((candidate) => candidate.key === detail.key);
  if (detail.creating !== (record === undefined) || (record?.revision ?? 0) !== detail.expectedRevision) {
    throw new CampaignRecordEditError("stale", "record revision is stale");
  }
  const allowedFields = new Set(page.fields.map((field) => field.key));
  if (Object.keys(detail.fields).length !== allowedFields.size ||
    Object.keys(detail.fields).some((key) => !allowedFields.has(key))) {
    throw invalidEdit();
  }
  for (const field of page.fields) {
    const value = detail.fields[field.key];
    if (typeof value !== "string" || value.length > field.maximumLength ||
      field.required === true && value.trim() === "") {
      throw invalidEdit();
    }
  }
  if (detail.visibility !== undefined && (!page.visibilityBearing || !canManageVisibility ||
    (detail.visibility !== "public" && detail.visibility !== "dm"))) {
    throw invalidEdit();
  }
  const current = isRecord(record?.value) ? record.value : {};
  const value: Record<string, unknown> = { ...current, ...detail.fields, id: detail.key };
  if (detail.visibility !== undefined) {
    value["visibility"] = detail.visibility;
  }
  return {
    page,
    mutation: {
      operation: "put",
      collection: page.collection,
      key: detail.key,
      expectedRevision: detail.expectedRevision,
      value,
    },
  };
}

export function prepareCampaignRecordDelete(
  dataset: CampaignDataset,
  detail: CampaignRecordDeleteDetail,
): PreparedCampaignRecordMutation {
  const page = campaignPages.find((candidate) => candidate.collection === detail.collection);
  if (page === undefined || !validRecordKey(detail.key) || !validRevision(detail.expectedRevision, true)) {
    throw invalidEdit();
  }
  const record = campaignCollection(dataset, page.collection).records
    .find((candidate) => candidate.key === detail.key);
  if (record?.revision !== detail.expectedRevision) {
    throw new CampaignRecordEditError("stale", "record revision is stale");
  }
  return {
    page,
    mutation: {
      operation: "delete",
      collection: page.collection,
      key: detail.key,
      expectedRevision: detail.expectedRevision,
    },
  };
}

function validRecordKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 1_024 && !/\p{Cc}/u.test(value);
}

function validRevision(value: unknown, positive: boolean): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

function invalidEdit(): CampaignRecordEditError {
  return new CampaignRecordEditError("invalid", "record edit is invalid");
}
