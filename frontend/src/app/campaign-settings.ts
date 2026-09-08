import { isRecord } from "../core/boundary.js";
import { uiSourceLabel } from "./ui-localization.js";
import {
  campaignCollection,
  type CampaignCollectionName,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import {
  type CampaignEnumCategory,
  type CampaignEnumDeleteMutation,
  type CampaignMutation,
} from "../core/campaign-mutations.js";

export type CampaignSettingFieldKind = "text" | "color" | "integer" | "decimal" | "select" | "directions";

export interface CampaignSettingField {
  readonly key: string;
  readonly label: string;
  readonly kind: CampaignSettingFieldKind;
  readonly required?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly help?: string;
}

export interface CampaignEnumDescriptor {
  readonly category: CampaignEnumCategory;
  readonly label: string;
  readonly singular: string;
  readonly icon: string;
  readonly summary: string;
  readonly fields: readonly CampaignSettingField[];
}

export interface CampaignEnumItem {
  readonly id: string;
  readonly label: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface CampaignEnumSaveDetail {
  readonly category: CampaignEnumCategory;
  readonly originalId: string | null;
  readonly expectedRevision: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

export class CampaignSettingsEditError extends Error {
  override readonly name = "CampaignSettingsEditError";

  constructor(message: string, readonly kind: "invalid" | "stale" = "invalid") { super(message); }
}

const colorField = (key: string, label: string, help?: string): CampaignSettingField =>
  field(key, label, "color", true, help === undefined ? {} : { help });

export const campaignEnumDescriptors: readonly CampaignEnumDescriptor[] = Object.freeze([
  descriptor("relationshipTypes", "Relationships", "relationship", "◇",
    "Names and drawing rules used by character relationships and later graph views.", [
      field("label", "Display name", "text", true),
      colorField("color", "Line color"),
      field("style", "Line style", "select", true, {
        options: choices(["solid", "dashed", "dotted"]),
      }),
      field("target", "Target kind", "select", true, {
        options: Object.freeze([
          Object.freeze({ value: "character", label: "Character" }),
          Object.freeze({ value: "location", label: "Location" }),
        ]),
      }),
      field("dirs", "Allowed directions", "directions", true,
        { help: "Location relationships always point from the character to the location." }),
    ]),
  descriptor("genders", "Genders", "gender", "⚥",
    "Choices offered by the character editor. Stored IDs remain unchanged when labels change.", [
      field("label", "Display name", "text", true),
    ]),
  descriptor("pinTypes", "Map markers", "marker type", "⌖",
    "Marker definitions shared by the map editor. Artwork remains part of the later map workflow.", [
      field("label", "Display name", "text", true),
      field("defaultIconId", "Bundled icon ID", "text", false,
        { help: "Leave blank to use the marker type ID." }),
      field("size", "Default size", "integer", true, { minimum: 8, maximum: 256 }),
    ]),
  descriptor("characterStatuses", "Character statuses", "status", "●",
    "Life-state choices used by character records.", [
      field("label", "Display name", "text", true),
      field("icon", "Symbol", "text", true),
      colorField("color", "Color"),
    ]),
  descriptor("eventPriorities", "Event priorities", "priority", "⚑",
    "Priority choices used by campaign events.", [
      field("label", "Display name", "text", true),
      colorField("color", "Color"),
    ]),
  descriptor("attitudes", "Party attitudes", "attitude", "✦",
    "The shared palette behind character, location, and faction attitude glows.", [
      field("label", "Display name", "text", true),
      colorField("bg", "Marker color"),
      colorField("fg", "Marker text"),
      colorField("labelColor", "Label and glow"),
      field("strength", "Glow strength", "decimal", true, { minimum: 0, maximum: 1 }),
    ]),
]);

export function campaignEnumDescriptor(category: CampaignEnumCategory): CampaignEnumDescriptor {
  const result = campaignEnumDescriptors.find((candidate) => candidate.category === category);
  if (result === undefined) throw invalidEdit();
  return result;
}

export function campaignEnumRecord(
  campaign: CampaignDataset,
  category: CampaignEnumCategory,
): CampaignRecord | undefined {
  return campaignCollection(campaign, "settings").records.find(({ key }) => key === category);
}

export function campaignEnumItems(
  campaign: CampaignDataset,
  category: CampaignEnumCategory,
): readonly CampaignEnumItem[] {
  const record = campaignEnumRecord(campaign, category);
  if (record === undefined) return Object.freeze([]);
  if (!Array.isArray(record.value)) throw invalidEdit();
  const result: CampaignEnumItem[] = [];
  const seen = new Set<string>();
  for (const candidate of record.value) {
    if (!isRecord(candidate)) throw invalidEdit();
    const id = boundedIdentity(candidate["id"]);
    if (seen.has(id)) throw invalidEdit();
    seen.add(id);
    result.push(Object.freeze({ id, label: boundedText(candidate["label"] ?? id, 200), value: candidate }));
  }
  return Object.freeze(result);
}

export function campaignEnumDisplayLabel(
  campaign: CampaignDataset,
  category: CampaignEnumCategory,
  value: unknown,
): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (id === "") return "";
  const record = campaignEnumRecord(campaign, category);
  if (!Array.isArray(record?.value)) return id;
  const definition = record.value.find((candidate) => isRecord(candidate) && candidate["id"] === id);
  if (!isRecord(definition)) return id;
  const label = definition["label"];
  return typeof label === "string" && label.trim() !== "" ? label.trim() : id;
}

export function prepareCampaignEnumSave(
  campaign: CampaignDataset,
  detail: CampaignEnumSaveDetail,
): CampaignMutation {
  const descriptor = campaignEnumDescriptor(detail.category);
  const record = campaignEnumRecord(campaign, detail.category);
  const expectedRevision = record?.revision ?? 0;
  if (!Number.isSafeInteger(detail.expectedRevision)) throw invalidEdit();
  if (detail.expectedRevision !== expectedRevision) throw staleEdit();
  if (record !== undefined && !Array.isArray(record.value)) throw invalidEdit();
  const existingItems = campaignEnumItems(campaign, detail.category);
  const values = [...(Array.isArray(record?.value) ? record.value : [])];
  const existingIndex = detail.originalId === null ? -1 : existingItems.findIndex(({ id }) => id === detail.originalId);
  if (detail.originalId !== null && existingIndex < 0) throw invalidEdit();
  const existing = existingIndex < 0 ? {} : values[existingIndex];
  if (!isRecord(existing) || !isRecord(detail.fields)) throw invalidEdit();
  const id = detail.originalId ?? boundedIdentity(detail.fields["id"]);
  if (existingItems.some((candidate, index) => index !== existingIndex && candidate.id === id)) {
    throw invalidEdit();
  }
  const value = normalizedEnumValue(descriptor, id, detail.fields, existing);
  if (existingIndex < 0) values.push(value);
  else values[existingIndex] = value;
  return Object.freeze({
    operation: "put",
    collection: "settings",
    key: detail.category,
    expectedRevision,
    value: Object.freeze(values),
  });
}

export function prepareCampaignEnumDelete(
  campaign: CampaignDataset,
  mutation: CampaignEnumDeleteMutation,
): CampaignEnumDeleteMutation {
  const record = campaignEnumRecord(campaign, mutation.category);
  if (record === undefined || record.revision !== mutation.expectedRevision) throw staleEdit();
  const items = campaignEnumItems(campaign, mutation.category);
  if (!items.some(({ id }) => id === mutation.itemId)) throw invalidEdit();
  if (mutation.mode === "replace" && !items.some(({ id }) => id === mutation.replacementId)) throw invalidEdit();
  return Object.freeze(mutation);
}

export function campaignEnumUsageCount(
  campaign: CampaignDataset,
  category: CampaignEnumCategory,
  itemID: string,
): number {
  const bindings = enumBindings[category];
  let count = 0;
  for (const binding of bindings) {
    for (const record of campaignCollection(campaign, binding.collection).records) {
      if (!isRecord(record.value)) continue;
      const value = record.value[binding.field];
      if (("array" in binding && binding.array) ? enumArrayContains(value, itemID) : value === itemID) count += 1;
    }
  }
  return count;
}

function normalizedEnumValue(
  descriptor: CampaignEnumDescriptor,
  id: string,
  fields: Readonly<Record<string, unknown>>,
  existing: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const value: Record<string, unknown> = { ...existing, id };
  for (const definition of descriptor.fields) {
    const raw = fields[definition.key];
    switch (definition.kind) {
      case "text": {
        const text = boundedText(raw, definition.key === "icon" ? 16 : 200);
        if (definition.required === true && text === "") throw invalidEdit();
        if (text === "") delete value[definition.key];
        else value[definition.key] = text;
        break;
      }
      case "color": {
        const color = boundedText(raw, 20).toLowerCase();
        if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/u.test(color)) throw invalidEdit();
        value[definition.key] = color;
        break;
      }
      case "integer": {
        const number = numericValue(raw);
        if (!Number.isSafeInteger(number) || !inRange(number, definition)) throw invalidEdit();
        value[definition.key] = number;
        break;
      }
      case "decimal": {
        const number = numericValue(raw);
        if (!Number.isFinite(number) || !inRange(number, definition)) throw invalidEdit();
        value[definition.key] = number;
        break;
      }
      case "select": {
        const selected = boundedText(raw, 100);
        if (!definition.options?.some(({ value: option }) => option === selected)) throw invalidEdit();
        value[definition.key] = selected;
        break;
      }
      case "directions": {
        if (!Array.isArray(raw)) throw invalidEdit();
        const directions = [...new Set(raw.map((candidate) => boundedText(candidate, 20)))];
        if (directions.length === 0 || directions.some((direction) =>
          direction !== "from" && direction !== "to" && direction !== "both")) throw invalidEdit();
        value[definition.key] = directions;
        break;
      }
    }
  }
  if (descriptor.category === "relationshipTypes" && value["target"] === "location") {
    value["dirs"] = ["from"];
  }
  return Object.freeze(value);
}

function descriptor(
  category: CampaignEnumCategory,
  label: string,
  singular: string,
  icon: string,
  summary: string,
  fields: readonly CampaignSettingField[],
): CampaignEnumDescriptor {
  return Object.freeze({ category, get label() { return uiSourceLabel(label); },
    get singular() { return uiSourceLabel(singular); }, icon,
    get summary() { return uiSourceLabel(summary); }, fields: Object.freeze(fields) });
}

function field(
  key: string,
  label: string,
  kind: CampaignSettingFieldKind,
  required = false,
  options: Partial<Omit<CampaignSettingField, "key" | "label" | "kind" | "required">> = {},
): CampaignSettingField {
  const result: CampaignSettingField = { key, get label() { return uiSourceLabel(label); }, kind, required, ...options,
    ...(options.options === undefined ? {} : { options: options.options.map(option => Object.freeze({
      value: option.value, get label() { return uiSourceLabel(option.label); },
    })) }),
  };
  if (options.help !== undefined) Object.defineProperty(result, "help", { enumerable: true, get: () => uiSourceLabel(options.help!) });
  return Object.freeze(result);
}

function choices(values: readonly string[]): readonly { readonly value: string; readonly label: string }[] {
  return Object.freeze(values.map((value) => Object.freeze({
    value,
    label: `${value[0]?.toLocaleUpperCase() ?? ""}${value.slice(1)}`,
  })));
}

interface EnumBinding { readonly collection: CampaignCollectionName; readonly field: string; readonly array?: boolean }

const enumBindings = Object.freeze({
  relationshipTypes: Object.freeze([{ collection: "relationships", field: "type" }]),
  genders: Object.freeze([{ collection: "characters", field: "gender" }]),
  pinTypes: Object.freeze([{ collection: "locations", field: "pinType" }]),
  characterStatuses: Object.freeze([{ collection: "characters", field: "status" }]),
  eventPriorities: Object.freeze([{ collection: "events", field: "priority" }]),
  attitudes: Object.freeze([
    { collection: "characters", field: "attitudes", array: true },
    { collection: "locations", field: "attitudes", array: true },
    { collection: "factions", field: "attitudes", array: true },
  ]),
} satisfies Record<CampaignEnumCategory, readonly EnumBinding[]>);

function enumArrayContains(value: unknown, id: string): boolean {
  return Array.isArray(value) && value.some((candidate) =>
    candidate === id || isRecord(candidate) && candidate["id"] === id);
}

function boundedIdentity(value: unknown): string {
  const result = boundedText(value, 200);
  if (result === "" || new TextEncoder().encode(result).byteLength > 200 || /\p{Cc}/u.test(result)) throw invalidEdit();
  return result;
}

function boundedText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length > maximumLength) throw invalidEdit();
  return value.trim();
}

function numericValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return Number.NaN;
  return Number(value);
}

function inRange(value: number, field: CampaignSettingField): boolean {
  return (field.minimum === undefined || value >= field.minimum) &&
    (field.maximum === undefined || value <= field.maximum);
}

function staleEdit(): CampaignSettingsEditError {
  return new CampaignSettingsEditError("campaign settings revision is stale", "stale");
}

function invalidEdit(): CampaignSettingsEditError {
  return new CampaignSettingsEditError("campaign settings edit is invalid");
}
