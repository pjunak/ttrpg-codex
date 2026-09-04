import { isRecord } from "../core/boundary.js";
import {
  campaignCollection,
  type CampaignCollectionName,
  type CampaignDataset,
} from "../core/campaign-data.js";
import type { CampaignMutation } from "../core/campaign-mutations.js";
import { campaignPages, type CampaignPageDefinition } from "./routes.js";

export interface CampaignEditorField {
  readonly key: string;
  readonly label: string;
  readonly kind: "line" | "text" | "number";
  readonly maximumLength: number;
  readonly required?: boolean;
  readonly placeholder?: string;
}

export interface CampaignRecordSaveDetail {
  readonly collection: CampaignPageDefinition["collection"];
  readonly key: string;
  readonly expectedRevision: number;
  readonly creating: boolean;
  readonly fields: Readonly<Record<string, string>>;
  readonly visibility?: "public" | "dm";
}

export interface CampaignRecordDeleteDetail {
  readonly collection: CampaignPageDefinition["collection"];
  readonly key: string;
  readonly expectedRevision: number;
}

export interface PreparedCampaignRecordMutation {
  readonly page: CampaignPageDefinition;
  readonly mutation: CampaignMutation;
}

export class CampaignRecordEditError extends Error {
  override readonly name = "CampaignRecordEditError";

  constructor(readonly kind: "invalid" | "stale", message: string) {
    super(message);
  }
}

export function editorFieldsFor(collection: CampaignCollectionName): readonly CampaignEditorField[] {
  return editorFields[collection] ?? Object.freeze([]);
}

export function collectionManagesVisibility(collection: CampaignCollectionName): boolean {
  return collection !== "pets";
}

export function prepareCampaignRecordSave(
  campaign: CampaignDataset,
  detail: CampaignRecordSaveDetail,
  canManageVisibility: boolean,
): PreparedCampaignRecordMutation {
  const page = campaignPages.find(({ collection }) => collection === detail.collection);
  const fields = editorFieldsFor(detail.collection);
  if (page === undefined || fields.length === 0 || !validRecordKey(detail.key) ||
    typeof detail.creating !== "boolean" || !validRevision(detail.expectedRevision, false) ||
    !isRecord(detail.fields)) {
    throw invalidEdit();
  }
  const collection = campaignCollection(campaign, page.collection);
  const record = collection.records.find(({ key }) => key === detail.key);
  if (detail.creating !== (record === undefined) || (record?.revision ?? 0) !== detail.expectedRevision) {
    throw new CampaignRecordEditError("stale", "record revision is stale");
  }
  const allowed = new Set(fields.map(({ key }) => key));
  const received = Object.keys(detail.fields);
  if (received.length !== allowed.size || received.some((key) => !allowed.has(key))) {
    throw invalidEdit();
  }

  const current = isRecord(record?.value) ? record.value : {};
  const value: Record<string, unknown> = { ...current };
  for (const field of fields) {
    const raw = detail.fields[field.key];
    if (typeof raw !== "string" || raw.length > field.maximumLength ||
      field.required === true && raw.trim() === "") {
      throw invalidEdit();
    }
    if (field.kind === "number") {
      const trimmed = raw.trim();
      if (trimmed === "") {
        delete value[field.key];
      } else if (/^-?\d+(?:\.\d+)?$/u.test(trimmed) && Number.isFinite(Number(trimmed))) {
        value[field.key] = Number(trimmed);
      } else {
        throw invalidEdit();
      }
    } else {
      const normalized = field.kind === "line" ? raw.trim() : raw;
      if (normalized !== "" || Object.hasOwn(current, field.key)) value[field.key] = normalized;
    }
  }
  value["id"] = detail.key;

  const visibilityBearing = collectionManagesVisibility(page.collection);
  if (detail.visibility !== undefined) {
    if (!visibilityBearing || !canManageVisibility ||
      (detail.visibility !== "public" && detail.visibility !== "dm")) {
      throw invalidEdit();
    }
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
  campaign: CampaignDataset,
  detail: CampaignRecordDeleteDetail,
): PreparedCampaignRecordMutation {
  const page = campaignPages.find(({ collection }) => collection === detail.collection);
  if (page === undefined || !validRecordKey(detail.key) || !validRevision(detail.expectedRevision, true)) {
    throw invalidEdit();
  }
  const record = campaignCollection(campaign, page.collection).records.find(({ key }) => key === detail.key);
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

export function createCampaignRecordKey(name: string, token = randomToken()): string {
  const slug = name.normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/gu, "") || "record";
  const suffix = token.toLocaleLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 12) || "new";
  return `${slug}-${suffix}`;
}

function field(
  key: string,
  label: string,
  options: Partial<Omit<CampaignEditorField, "key" | "label">> = {},
): CampaignEditorField {
  return Object.freeze({
    key,
    label,
    kind: options.kind ?? "line",
    maximumLength: options.maximumLength ?? 500,
    ...(options.required === undefined ? {} : { required: options.required }),
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
  });
}

const name = field("name", "Name", { maximumLength: 200, required: true });
const description = field("description", "Description", { kind: "text", maximumLength: 200_000 });
const history = field("history", "History", { kind: "text", maximumLength: 200_000 });
const summary = field("summary", "Summary", { kind: "text", maximumLength: 200_000 });

const editorFields: Readonly<Partial<Record<CampaignCollectionName, readonly CampaignEditorField[]>>> = {
  characters: Object.freeze([
    name,
    field("title", "Title"),
    field("species", "Species"),
    field("gender", "Gender"),
    field("status", "Status"),
    description,
    field("known", "What is known", { kind: "text", maximumLength: 200_000 }),
    history,
  ]),
  locations: Object.freeze([
    name,
    field("type", "Kind"),
    field("region", "Region"),
    description,
    history,
  ]),
  events: Object.freeze([
    name,
    field("date", "Date"),
    field("sitting", "Session", { kind: "number", maximumLength: 12 }),
    field("short", "Short summary", { maximumLength: 1_000 }),
    description,
  ]),
  mysteries: Object.freeze([
    name,
    field("status", "Status"),
    field("priority", "Priority"),
    summary,
    field("known", "Known clues", { kind: "text", maximumLength: 200_000 }),
    field("unknown", "Open questions", { kind: "text", maximumLength: 200_000 }),
  ]),
  factions: Object.freeze([
    name,
    field("type", "Kind"),
    field("domain", "Domain"),
    field("motto", "Motto", { maximumLength: 1_000 }),
    description,
  ]),
  pantheon: Object.freeze([
    name,
    field("domain", "Domain"),
    field("symbol", "Symbol"),
    field("alignment", "Alignment"),
    description,
  ]),
  artifacts: Object.freeze([
    name,
    field("type", "Kind"),
    field("origin", "Origin"),
    description,
    history,
  ]),
  historicalEvents: Object.freeze([
    name,
    field("date", "Date"),
    field("period", "Period"),
    summary,
    description,
  ]),
  pets: Object.freeze([
    name,
    field("species", "Species"),
    field("status", "Status"),
    description,
    field("notes", "Notes", { kind: "text", maximumLength: 200_000 }),
  ]),
};

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

function randomToken(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
