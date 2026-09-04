import { isRecord } from "../core/boundary.js";
import {
  campaignCollection,
  type CampaignCollectionName,
  type CampaignDataset,
} from "../core/campaign-data.js";
import type { CampaignEnumCategory, CampaignMutation } from "../core/campaign-mutations.js";
import { campaignPages, type CampaignPageDefinition } from "./routes.js";

export interface CampaignEditorField {
  readonly key: string;
  readonly label: string;
  readonly kind:
    | "line"
    | "text"
    | "markdown"
    | "number"
    | "tags"
    | "string-list"
    | "enum"
    | "reference"
    | "references"
    | "attitudes"
    | "questions"
    | "rank-assignment"
    | "rank-chains"
    | "location-roles"
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
  readonly enumCategory?: CampaignEnumCategory;
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
  readonly relationships?: readonly CampaignRelationshipEditDetail[];
}

export type CampaignRelationshipDirection = "from" | "to" | "both";

export interface CampaignRelationshipEditDetail {
  readonly originalKey: string | null;
  readonly expectedRevision: number;
  readonly direction: CampaignRelationshipDirection;
  readonly target: string;
  readonly type: string;
  readonly label: string;
  readonly visibility?: "public" | "dm";
}

export interface CampaignRelationshipTypeOption extends CampaignEditorOption {
  readonly targetCollection: "characters" | "locations";
  readonly directions: readonly CampaignRelationshipDirection[];
}

export interface CampaignRecordDeleteDetail {
  readonly collection: CampaignPageDefinition["collection"];
  readonly key: string;
  readonly expectedRevision: number;
}

export interface CampaignEditDirtyDetail {
  readonly dirty: boolean;
}

export interface PreparedCampaignRecordTransaction {
  readonly page: CampaignPageDefinition;
  readonly mutations: readonly CampaignMutation[];
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
): PreparedCampaignRecordTransaction {
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
  if (detail.relationships !== undefined && (page.collection !== "characters" || detail.creating)) {
    throw invalidEdit();
  }
  const mutations: CampaignMutation[] = [{
      operation: "put",
      collection: page.collection,
      key: detail.key,
      expectedRevision: detail.expectedRevision,
      value,
  }];
  if (detail.relationships !== undefined) {
    mutations.push(...prepareRelationshipMutations(
      campaign,
      detail.key,
      detail.relationships,
      canManageVisibility,
    ));
  }
  return { page, mutations: Object.freeze(mutations) };
}

export function prepareCampaignRecordDelete(
  campaign: CampaignDataset,
  detail: CampaignRecordDeleteDetail,
): PreparedCampaignRecordTransaction {
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
    mutations: Object.freeze([{
      operation: "delete",
      collection: page.collection,
      key: detail.key,
      expectedRevision: detail.expectedRevision,
    }]),
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
  if (field.kind === "enum" && field.enumCategory !== undefined) return enumOptions(campaign, field.enumCategory);
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
    ...(options.enumCategory === undefined ? {} : { enumCategory: options.enumCategory }),
    ...(options.reservedOptions === undefined ? {} : { reservedOptions: options.reservedOptions }),
    ...(options.excludeCurrent === undefined ? {} : { excludeCurrent: options.excludeCurrent }),
  });
}

const name = field("name", "Name", { maximumLength: 200, required: true });
const description = field("description", "Description", { kind: "markdown", maximumLength: 200_000 });
const history = field("history", "History", { kind: "markdown", maximumLength: 200_000 });
const summary = field("summary", "Summary", { kind: "markdown", maximumLength: 200_000 });

const editorFields: Readonly<Partial<Record<CampaignCollectionName, readonly CampaignEditorField[]>>> = {
  characters: Object.freeze([
    name,
    field("title", "Title"),
    field("species", "Species"),
    field("gender", "Gender", { kind: "enum", enumCategory: "genders" }),
    field("age", "Age"),
    field("status", "Status", { kind: "enum", enumCategory: "characterStatuses" }),
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
    field("rankAssignment", "Faction rank", {
      kind: "rank-assignment",
      maximumLength: 200,
      help: "Ranks come from the selected faction's ordered rank chains.",
    }),
    field("location", "Current location", { kind: "reference", referenceCollection: "locations" }),
    field("locationRoles", "Other location roles", {
      kind: "location-roles",
      maximumLength: 500,
      maximumItems: 500,
      help: "Record recurring duties or ties outside the character's current location.",
    }),
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
    field("unknown", "Open questions", {
      kind: "questions",
      maximumLength: 10_000,
      maximumItems: 500,
      help: "An answer closes a question without erasing the original thread.",
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
    field("priority", "Priority", { kind: "enum", enumCategory: "eventPriorities" }),
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
    description,
    field("clues", "Clues", {
      kind: "string-list", maximumLength: 10_000, maximumItems: 500, help: "Write one clue per line.",
    }),
    field("characters", "Characters", {
      kind: "references", referenceCollection: "characters", maximumItems: 500,
    }),
    field("locations", "Locations", {
      kind: "references", referenceCollection: "locations", maximumItems: 500,
    }),
    field("questions", "Questions and answers", {
      kind: "questions",
      maximumLength: 10_000,
      maximumItems: 500,
      help: "Keep the question after its answer is discovered so the investigation remains readable.",
    }),
  ]),
  factions: Object.freeze([
    name,
    field("badge", "Badge or symbol", { maximumLength: 100 }),
    field("color", "Color", { maximumLength: 20, placeholder: "#555555" }),
    field("textColor", "Text color", { maximumLength: 20, placeholder: "#ffffff" }),
    field("attitudes", "Inherited attitudes", { kind: "attitudes", maximumItems: 32 }),
    field("rankChains", "Rank chains", {
      kind: "rank-chains",
      maximumLength: 200,
      maximumItems: 100,
      help: "Order ranks from highest to lowest. Existing chain IDs remain stable when renamed.",
    }),
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
    field("body", "Article", { kind: "markdown", maximumLength: 200_000 }),
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
    case "text":
    case "markdown": {
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
    case "enum": {
      if (field.enumCategory === undefined) throw invalidEdit();
      const selected = boundedLine(raw, field.maximumLength);
      const available = new Set(enumOptions(campaign, field.enumCategory).map(({ value: option }) => option));
      if (selected !== "" && !available.has(selected) && selected !== line(current[field.key])) throw invalidEdit();
      value[field.key] = selected;
      return;
    }
    case "questions":
      value[field.key] = normalizedQuestions(raw, field);
      return;
    case "rank-chains":
      value[field.key] = normalizedRankChains(raw, current[field.key], field);
      return;
    case "location-roles":
      value[field.key] = normalizedLocationRoles(campaign, raw, current[field.key], field);
      return;
    case "rank-assignment": {
      if (!isRecord(raw)) throw invalidEdit();
      const chainID = boundedLine(raw["chainId"], field.maximumLength);
      const rank = boundedLine(raw["rank"], field.maximumLength);
      if ((chainID === "") !== (rank === "")) throw invalidEdit();
      const factionID = line(value["faction"]);
      const currentChain = line(current["rankChain"]);
      const currentRank = line(current["rank"]);
      if (chainID !== "" && !validRankAssignment(campaign, factionID, chainID, rank) &&
        (chainID !== currentChain || rank !== currentRank)) throw invalidEdit();
      value["rankChain"] = chainID;
      value["rank"] = rank;
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

export function relationshipTypeOptionsFor(campaign: CampaignDataset): readonly CampaignRelationshipTypeOption[] {
  const record = campaignCollection(campaign, "settings").records.find(({ key }) => key === "relationshipTypes");
  const candidates = Array.isArray(record?.value) ? record.value : defaultRelationshipTypes;
  const result: CampaignRelationshipTypeOption[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const id = line(candidate["id"]);
    if (!validIdentityPart(id) || seen.has(id)) continue;
    const targetCollection = candidate["target"] === "location" ? "locations" : "characters";
    const configuredDirections = Array.isArray(candidate["dirs"])
      ? candidate["dirs"].filter(isRelationshipDirection)
      : ["from", "to"] as CampaignRelationshipDirection[];
    const directions = targetCollection === "locations"
      ? ["from"] as CampaignRelationshipDirection[]
      : [...new Set(configuredDirections)];
    if (directions.length === 0) directions.push("from");
    seen.add(id);
    result.push(Object.freeze({
      value: id,
      label: line(candidate["label"]) || id,
      targetCollection,
      directions: Object.freeze(directions),
    }));
  }
  return Object.freeze(result);
}

export function relationshipEditorRowsFor(
  campaign: CampaignDataset,
  characterKey: string,
  canManageVisibility: boolean,
): readonly CampaignRelationshipEditDetail[] {
  const rows: CampaignRelationshipEditDetail[] = [];
  for (const record of campaignCollection(campaign, "relationships").records) {
    if (!isRecord(record.value)) continue;
    const source = line(record.value["source"]);
    const target = line(record.value["target"]);
    if (source !== characterKey && target !== characterKey) continue;
    rows.push(Object.freeze({
      originalKey: record.key,
      expectedRevision: record.revision,
      direction: source === characterKey ? "from" : "to",
      target: source === characterKey ? target : source,
      type: line(record.value["type"]),
      label: line(record.value["label"]),
      ...(canManageVisibility && (record.value["visibility"] === "dm" || record.value["visibility"] === "public")
        ? { visibility: record.value["visibility"] }
        : {}),
    }));
  }
  return Object.freeze(rows);
}

export function createRelationshipRecordKey(source: string, target: string, type: string): string {
  if (!validIdentityPart(source) || !validIdentityPart(target) || !validIdentityPart(type)) throw invalidEdit();
  const bytes = new TextEncoder().encode(JSON.stringify([source, target, type]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `relationship:${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

function prepareRelationshipMutations(
  campaign: CampaignDataset,
  characterKey: string,
  edits: readonly CampaignRelationshipEditDetail[],
  canManageVisibility: boolean,
): readonly CampaignMutation[] {
  if (!Array.isArray(edits)) throw invalidEdit();
  const current = new Map(campaignCollection(campaign, "relationships").records
    .filter((record) => isRecord(record.value) &&
      (line(record.value["source"]) === characterKey || line(record.value["target"]) === characterKey))
    .map((record) => [record.key, record]));
  const types = new Map(relationshipTypeOptionsFor(campaign).map((option) => [option.value, option]));
  const seenOriginals = new Set<string>();
  const desired = new Map<string, { readonly value: Record<string, unknown>; readonly originalKey: string | null }>();

  for (const edit of edits as readonly unknown[]) {
    if (!isRecord(edit) || (edit["originalKey"] !== null && typeof edit["originalKey"] !== "string") ||
      !validRevision(edit["expectedRevision"], false) || !isRelationshipDirection(edit["direction"]) ||
      typeof edit["target"] !== "string" || typeof edit["type"] !== "string" || typeof edit["label"] !== "string") {
      throw invalidEdit();
    }
    const originalKey = edit["originalKey"] as string | null;
    const original = originalKey === null ? undefined : current.get(originalKey);
    if (originalKey === null ? edit["expectedRevision"] !== 0 :
      original === undefined || original.revision !== edit["expectedRevision"] || seenOriginals.has(originalKey)) {
      throw invalidEdit();
    }
    if (originalKey !== null) seenOriginals.add(originalKey);

    const target = edit["target"].trim();
    const type = edit["type"].trim();
    const label = edit["label"].trim();
    if (!validIdentityPart(target) || !validIdentityPart(type) || label.length > 500) throw invalidEdit();
    const originalValue = isRecord(original?.value) ? original.value : {};
    const option = types.get(type);
    const originalType = line(originalValue["type"]);
    const targetCollection = option?.targetCollection ?? (type === "mission" ? "locations" : "characters");
    const directions = option?.directions ?? (type === originalType
      ? ["from", "to"] as const
      : Object.freeze([]));
    if (!directions.includes(edit["direction"] as CampaignRelationshipDirection) ||
      targetCollection === "locations" && edit["direction"] !== "from") throw invalidEdit();
    const targetExists = campaignCollection(campaign, targetCollection).records.some(({ key }) => key === target);
    if (!targetExists || targetCollection === "characters" && target === characterKey) throw invalidEdit();
    if (edit["visibility"] !== undefined &&
      (!canManageVisibility || edit["visibility"] !== "public" && edit["visibility"] !== "dm")) throw invalidEdit();

    const requestedDirections = edit["direction"] === "both" ? ["from", "to"] as const : [edit["direction"]];
    requestedDirections.forEach((direction, index) => {
      const source = direction === "from" ? characterKey : target;
      const relationshipTarget = direction === "from" ? target : characterKey;
      const key = createRelationshipRecordKey(source, relationshipTarget, type);
      if (desired.has(key)) throw invalidEdit();
      const value: Record<string, unknown> = {
        ...(index === 0 ? originalValue : {}),
        source,
        target: relationshipTarget,
        type,
      };
      if (label !== "" || Object.hasOwn(originalValue, "label")) value["label"] = label;
      if (edit["visibility"] !== undefined) value["visibility"] = edit["visibility"];
      else if (original === undefined) value["visibility"] = "public";
      desired.set(key, { value, originalKey: index === 0 ? originalKey : null });
    });
  }

  const mutations: CampaignMutation[] = [];
  for (const record of current.values()) {
    const retained = [...desired.entries()].some(([key, item]) => item.originalKey === record.key && key === record.key);
    if (!retained) {
      mutations.push({
        operation: "delete", collection: "relationships", key: record.key, expectedRevision: record.revision,
      });
    }
  }
  for (const [key, item] of desired) {
    const existing = current.get(key);
    if (existing !== undefined && item.originalKey !== key) throw invalidEdit();
    if (existing !== undefined && JSON.stringify(existing.value) === JSON.stringify(item.value)) continue;
    mutations.push({
      operation: "put",
      collection: "relationships",
      key,
      expectedRevision: existing?.revision ?? 0,
      value: item.value,
    });
  }
  // The character itself is mutation 500 at most. Reject an oversized
  // compound edit here instead of letting the transport turn it into a
  // less useful generic request error.
  if (mutations.length > 499) throw invalidEdit();
  return Object.freeze(mutations);
}

function normalizedQuestions(raw: unknown, field: CampaignEditorField): Record<string, string>[] {
  if (!Array.isArray(raw) || raw.length > (field.maximumItems ?? 500)) throw invalidEdit();
  return raw.flatMap((candidate) => {
    if (!isRecord(candidate)) throw invalidEdit();
    const text = boundedLine(candidate["text"], field.maximumLength);
    const answer = boundedLine(candidate["answer"], 100_000);
    return text === "" ? [] : [{ text, answer }];
  });
}

function normalizedRankChains(raw: unknown, current: unknown, field: CampaignEditorField): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length > (field.maximumItems ?? 100)) throw invalidEdit();
  const existing = new Map<string, Readonly<Record<string, unknown>>>();
  if (Array.isArray(current)) {
    for (const candidate of current) if (isRecord(candidate)) existing.set(line(candidate["id"]), candidate);
  }
  const seen = new Set<string>();
  return raw.flatMap((candidate) => {
    if (!isRecord(candidate)) throw invalidEdit();
    const name = boundedLine(candidate["name"], field.maximumLength);
    if (name === "") return [];
    const id = boundedLine(candidate["id"], field.maximumLength);
    if (id === "" || seen.has(id)) throw invalidEdit();
    seen.add(id);
    const ranks = normalizedBoundedStrings(candidate["ranks"], 200, field.maximumLength);
    return [{ ...(existing.get(id) ?? {}), id, name, ranks }];
  });
}

function normalizedLocationRoles(
  campaign: CampaignDataset,
  raw: unknown,
  current: unknown,
  field: CampaignEditorField,
): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length > (field.maximumItems ?? 500)) throw invalidEdit();
  const locations = new Set(campaignCollection(campaign, "locations").records.map(({ key }) => key));
  const existing = new Map<string, Readonly<Record<string, unknown>>>();
  if (Array.isArray(current)) {
    for (const candidate of current) if (isRecord(candidate)) existing.set(line(candidate["locationId"]), candidate);
  }
  const seen = new Set<string>();
  return raw.flatMap((candidate) => {
    if (!isRecord(candidate)) throw invalidEdit();
    const locationID = boundedLine(candidate["locationId"], 1_024);
    const role = boundedLine(candidate["role"], field.maximumLength);
    if (locationID === "") return [];
    if (!locations.has(locationID) || seen.has(locationID)) throw invalidEdit();
    seen.add(locationID);
    return [{ ...(existing.get(locationID) ?? {}), locationId: locationID, role }];
  });
}

function normalizedBoundedStrings(raw: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(raw) || raw.length > maximumItems) throw invalidEdit();
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const value = boundedLine(candidate, maximumLength);
    const identity = value.toLocaleLowerCase();
    if (value !== "" && !seen.has(identity)) {
      seen.add(identity);
      result.push(value);
    }
  }
  return result;
}

function validRankAssignment(
  campaign: CampaignDataset,
  factionID: string,
  chainID: string,
  rank: string,
): boolean {
  const faction = campaignCollection(campaign, "factions").records.find(({ key }) => key === factionID);
  if (!isRecord(faction?.value) || !Array.isArray(faction.value["rankChains"])) return false;
  return faction.value["rankChains"].some((candidate) => isRecord(candidate) &&
    line(candidate["id"]) === chainID && Array.isArray(candidate["ranks"]) &&
    candidate["ranks"].some((item) => line(item) === rank));
}

function boundedLine(value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length > maximumLength) throw invalidEdit();
  return value.trim();
}

function validIdentityPart(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= 200 && !/\p{Cc}/u.test(value);
}

function isRelationshipDirection(value: unknown): value is CampaignRelationshipDirection {
  return value === "from" || value === "to" || value === "both";
}

const defaultRelationshipTypes = Object.freeze([
  Object.freeze({ id: "commands", label: "commands", dirs: ["from", "to"] }),
  Object.freeze({ id: "ally", label: "ally", dirs: ["from", "to", "both"] }),
  Object.freeze({ id: "enemy", label: "enemy", dirs: ["from", "to", "both"] }),
  Object.freeze({ id: "mission", label: "mission", dirs: ["from"], target: "location" }),
  Object.freeze({ id: "mystery", label: "mystery", dirs: ["from", "to", "both"] }),
  Object.freeze({ id: "captured_by", label: "captured by", dirs: ["from", "to"] }),
  Object.freeze({ id: "history", label: "history", dirs: ["from", "to", "both"] }),
  Object.freeze({ id: "uncertain", label: "uncertain bond", dirs: ["from", "to", "both"] }),
  Object.freeze({ id: "negotiates", label: "negotiates", dirs: ["from", "to", "both"] }),
]);

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

function enumOptions(
  campaign: CampaignDataset,
  category: CampaignEnumCategory,
): readonly CampaignEditorOption[] {
  const record = campaignCollection(campaign, "settings").records.find(({ key }) => key === category);
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
