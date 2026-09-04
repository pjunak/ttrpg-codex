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
  readonly kind:
    | "line"
    | "text"
    | "number"
    | "tags"
    | "string-list"
    | "reference"
    | "references"
    | "attitudes"
    | "boolean"
    | "owner";
  readonly maximumLength: number;
  readonly maximumItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly help?: string;
  readonly referenceCollection?: "characters" | "locations" | "factions";
  readonly reservedOptions?: readonly CampaignEditorOption[];
  readonly excludeCurrent?: boolean;
}

export interface CampaignEditorOption {
  readonly value: string;
  readonly label: string;
}

export interface CampaignRecordSaveDetail {
  readonly collection: CampaignPageDefinition["collection"];
  readonly key: string;
  readonly expectedRevision: number;
  readonly creating: boolean;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly visibility?: "public" | "dm";
}

export interface CampaignRecordDeleteDetail {
  readonly collection: CampaignPageDefinition["collection"];
  readonly key: string;
  readonly expectedRevision: number;
}

export interface CampaignEditDirtyDetail {
  readonly dirty: boolean;
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
    applyEditorField(campaign, value, current, field, raw, detail.key);
  }
  if (page.collection === "characters") {
    if (detail.creating && value["faction"] === "") value["faction"] = "neutral";
    if (value["faction"] === "party") value["attitudes"] = [];
  }
  if (page.collection === "pets" && detail.creating && line(value["icon"]) === "") value["icon"] = "🐾";
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

export function editorOptionsFor(
  campaign: CampaignDataset,
  field: CampaignEditorField,
  currentKey: string,
): readonly CampaignEditorOption[] {
  if (field.kind === "attitudes") return attitudeOptions(campaign);
  if (field.kind === "owner") return ownerOptions(campaign);
  if (field.referenceCollection === undefined) return Object.freeze([]);
  const seen = new Set<string>();
  const options: CampaignEditorOption[] = [];
  for (const option of field.reservedOptions ?? []) {
    if (!seen.has(option.value)) {
      seen.add(option.value);
      options.push(option);
    }
  }
  for (const record of campaignCollection(campaign, field.referenceCollection).records) {
    if (field.excludeCurrent === true && record.key === currentKey || seen.has(record.key)) continue;
    const value = isRecord(record.value) ? record.value : {};
    const label = line(value["name"]) || line(value["title"]) || record.key;
    seen.add(record.key);
    options.push(Object.freeze({ value: record.key, label }));
  }
  return Object.freeze(options);
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
    ...(options.maximumItems === undefined ? {} : { maximumItems: options.maximumItems }),
    ...(options.minimum === undefined ? {} : { minimum: options.minimum }),
    ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
    ...(options.required === undefined ? {} : { required: options.required }),
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.help === undefined ? {} : { help: options.help }),
    ...(options.referenceCollection === undefined ? {} : { referenceCollection: options.referenceCollection }),
    ...(options.reservedOptions === undefined ? {} : { reservedOptions: options.reservedOptions }),
    ...(options.excludeCurrent === undefined ? {} : { excludeCurrent: options.excludeCurrent }),
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
    field("age", "Age"),
    field("status", "Status"),
    field("circumstances", "Current circumstances", { maximumLength: 1_000 }),
    field("knowledge", "Knowledge", { kind: "number", maximumLength: 1, minimum: 0, maximum: 4 }),
    field("faction", "Faction", {
      kind: "reference",
      referenceCollection: "factions",
      reservedOptions: Object.freeze([
        Object.freeze({ value: "neutral", label: "No faction" }),
        Object.freeze({ value: "party", label: "Player party" }),
      ]),
    }),
    field("location", "Current location", { kind: "reference", referenceCollection: "locations" }),
    field("attitudes", "Attitudes toward the party", {
      kind: "attitudes",
      maximumItems: 32,
      help: "Use Ctrl or Command to select more than one attitude. Party members always use the party palette.",
    }),
    field("tags", "Tags", { kind: "tags", maximumLength: 100, maximumItems: 100 }),
    description,
    field("known", "Known facts", {
      kind: "string-list",
      maximumLength: 10_000,
      maximumItems: 500,
      help: "Write one fact per line.",
    }),
  ]),
  locations: Object.freeze([
    name,
    field("type", "Kind"),
    field("region", "Region"),
    field("knowledge", "Knowledge", { kind: "number", maximumLength: 1, minimum: 0, maximum: 4 }),
    field("parentId", "Contained in", {
      kind: "reference", referenceCollection: "locations", excludeCurrent: true,
    }),
    field("connections", "Connected locations", {
      kind: "references",
      referenceCollection: "locations",
      excludeCurrent: true,
      maximumItems: 500,
      help: "Connections are kept reciprocal by the host.",
    }),
    field("attitudes", "Attitudes", { kind: "attitudes", maximumItems: 32 }),
    field("tags", "Tags", { kind: "tags", maximumLength: 100, maximumItems: 100 }),
    description,
    history,
    field("mapNotes", "Map notes", { kind: "text", maximumLength: 200_000 }),
  ]),
  events: Object.freeze([
    name,
    field("date", "Date"),
    field("sitting", "Session", { kind: "number", maximumLength: 12 }),
    field("priority", "Priority"),
    field("short", "Short summary", { maximumLength: 1_000 }),
    field("characters", "Characters", {
      kind: "references", referenceCollection: "characters", maximumItems: 500,
    }),
    field("locations", "Locations", {
      kind: "references", referenceCollection: "locations", maximumItems: 500,
    }),
    field("tags", "Tags", { kind: "tags", maximumLength: 100, maximumItems: 100 }),
    description,
  ]),
  mysteries: Object.freeze([
    name,
    field("priority", "Priority"),
    field("solved", "Solved", { kind: "boolean" }),
    field("clues", "Clues", {
      kind: "string-list", maximumLength: 10_000, maximumItems: 500, help: "Write one clue per line.",
    }),
    field("characters", "Characters", {
      kind: "references", referenceCollection: "characters", maximumItems: 500,
    }),
    field("locations", "Locations", {
      kind: "references", referenceCollection: "locations", maximumItems: 500,
    }),
  ]),
  factions: Object.freeze([
    name,
    field("badge", "Badge or symbol", { maximumLength: 100 }),
    field("color", "Color", { maximumLength: 20, placeholder: "#555555" }),
    field("textColor", "Text color", { maximumLength: 20, placeholder: "#ffffff" }),
    field("attitudes", "Inherited attitudes", { kind: "attitudes", maximumItems: 32 }),
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
    field("ownerCharacterId", "Holder", { kind: "reference", referenceCollection: "characters" }),
    field("locationId", "Location", { kind: "reference", referenceCollection: "locations" }),
    field("tags", "Tags", { kind: "tags", maximumLength: 100, maximumItems: 100 }),
    description,
  ]),
  historicalEvents: Object.freeze([
    name,
    field("start", "Start"),
    field("end", "End"),
    summary,
    field("characters", "Characters", {
      kind: "references", referenceCollection: "characters", maximumItems: 500,
    }),
    field("locations", "Locations", {
      kind: "references", referenceCollection: "locations", maximumItems: 500,
    }),
    field("tags", "Tags", { kind: "tags", maximumLength: 100, maximumItems: 100 }),
    field("body", "Article", { kind: "text", maximumLength: 200_000 }),
  ]),
  pets: Object.freeze([
    name,
    field("icon", "Icon", { maximumLength: 16, placeholder: "🐾" }),
    field("species", "Species"),
    field("owner", "Owner", { kind: "owner" }),
    field("note", "Note", { maximumLength: 1_000 }),
  ]),
};

function applyEditorField(
  campaign: CampaignDataset,
  value: Record<string, unknown>,
  current: Readonly<Record<string, unknown>>,
  field: CampaignEditorField,
  raw: unknown,
  currentKey: string,
): void {
  switch (field.kind) {
    case "line":
    case "text": {
      if (typeof raw !== "string" || raw.length > field.maximumLength ||
        field.required === true && raw.trim() === "") throw invalidEdit();
      const normalized = field.kind === "line" ? raw.trim() : raw;
      if (normalized !== "" || Object.hasOwn(current, field.key)) value[field.key] = normalized;
      return;
    }
    case "number": {
      if (typeof raw !== "string" || raw.length > field.maximumLength) throw invalidEdit();
      const trimmed = raw.trim();
      if (trimmed === "") {
        delete value[field.key];
        return;
      }
      if (!/^-?\d+(?:\.\d+)?$/u.test(trimmed)) throw invalidEdit();
      const number = Number(trimmed);
      if (!Number.isFinite(number) || field.minimum !== undefined && number < field.minimum ||
        field.maximum !== undefined && number > field.maximum) throw invalidEdit();
      value[field.key] = number;
      return;
    }
    case "tags":
    case "string-list":
      value[field.key] = normalizedStringArray(raw, field);
      return;
    case "reference": {
      if (typeof raw !== "string") throw invalidEdit();
      const reference = raw.trim();
      if (reference !== "" && !editorOptionsFor(campaign, field, currentKey)
        .some(({ value: option }) => option === reference)) throw invalidEdit();
      value[field.key] = reference;
      return;
    }
    case "references": {
      const references = normalizedStringArray(raw, field);
      const options = new Set(editorOptionsFor(campaign, field, currentKey).map(({ value: option }) => option));
      if (references.some((reference) => !options.has(reference))) throw invalidEdit();
      value[field.key] = references;
      return;
    }
    case "attitudes": {
      const attitudes = normalizedStringArray(raw, field);
      const options = new Set(attitudeOptions(campaign).map(({ value: option }) => option));
      if (attitudes.some((attitude) => !options.has(attitude))) throw invalidEdit();
      const existing = new Map<string, Readonly<Record<string, unknown>>>();
      const currentAttitudes = current[field.key];
      if (Array.isArray(currentAttitudes)) {
        for (const candidate of currentAttitudes) {
          if (!isRecord(candidate)) continue;
          const id = line(candidate["id"]);
          if (id !== "") existing.set(id, candidate);
        }
      }
      value[field.key] = attitudes.map((id) => ({ ...(existing.get(id) ?? {}), id }));
      return;
    }
    case "boolean":
      if (typeof raw !== "boolean") throw invalidEdit();
      value[field.key] = raw;
      return;
    case "owner": {
      if (typeof raw !== "string") throw invalidEdit();
      const option = ownerOptions(campaign).find(({ value: candidate }) => candidate === raw);
      if (option === undefined) throw invalidEdit();
      const separator = raw.indexOf(":");
      const ownerType = separator === -1 ? raw : raw.slice(0, separator);
      const ownerID = separator === -1 ? "" : raw.slice(separator + 1);
      value["ownerType"] = ownerType;
      value["ownerId"] = ownerID;
      return;
    }
  }
}

function normalizedStringArray(raw: unknown, field: CampaignEditorField): string[] {
  if (!Array.isArray(raw) || raw.length > (field.maximumItems ?? 500)) throw invalidEdit();
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    if (typeof candidate !== "string") throw invalidEdit();
    const normalized = candidate.trim();
    if (normalized === "") continue;
    if (normalized.length > field.maximumLength) throw invalidEdit();
    const identity = normalized.toLocaleLowerCase();
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push(normalized);
    }
  }
  return result;
}

function attitudeOptions(campaign: CampaignDataset): readonly CampaignEditorOption[] {
  const record = campaignCollection(campaign, "settings").records.find(({ key }) => key === "attitudes");
  if (!Array.isArray(record?.value)) return Object.freeze([]);
  const options: CampaignEditorOption[] = [];
  const seen = new Set<string>();
  for (const candidate of record.value) {
    if (!isRecord(candidate)) continue;
    const value = line(candidate["id"]);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    options.push(Object.freeze({ value, label: line(candidate["label"]) || value }));
  }
  return Object.freeze(options);
}

function ownerOptions(campaign: CampaignDataset): readonly CampaignEditorOption[] {
  const options: CampaignEditorOption[] = [
    Object.freeze({ value: "none:", label: "Unassigned" }),
    Object.freeze({ value: "party:", label: "Player party" }),
  ];
  for (const [collection, prefix] of [["characters", "character"], ["factions", "faction"]] as const) {
    for (const record of campaignCollection(campaign, collection).records) {
      const value = isRecord(record.value) ? record.value : {};
      const label = line(value["name"]) || record.key;
      options.push(Object.freeze({
        value: `${prefix}:${record.key}`,
        label: `${prefix === "character" ? "Character" : "Faction"}: ${label}`,
      }));
    }
  }
  return Object.freeze(options);
}

function line(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function randomToken(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
