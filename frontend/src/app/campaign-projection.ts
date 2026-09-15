import { groupTwinRecords, twinRepresentatives } from "./campaign-twins.js";
import { isRecord } from "../core/boundary.js";
import { activityTimestamp } from "../core/campaign-activity.js";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import {
  campaignPages,
  recordHash,
  type CampaignPageDefinition,
} from "./routes.js";
import { campaignEnumDisplayLabel } from "./campaign-settings.js";
import { attitudeRing, attitudeFilter } from "./campaign-attitude-glow.js";
import { campaignPartyIdentity, type CampaignPartyIdentity } from "./campaign-party.js";

export interface CampaignIdentity {
  readonly name: string;
  readonly tagline: string;
}

export interface EntitySummary {
  readonly partyIdentity: CampaignPartyIdentity | undefined;
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly excerpt: string;
  readonly portrait: string | undefined;
  readonly icon: string | undefined;
  readonly status: string;
  readonly statusLabel: string;
  readonly visibility: "public" | "dm";
  readonly tags: readonly string[];
  readonly attitudes: readonly AttitudePresentation[];
  readonly attitudeRing: string | undefined;
  readonly attitudeFilter: string | undefined;
  readonly route: string;
  readonly updatedAt: string | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface AttitudePresentation {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly strength: number;
}

export interface DashboardEvent extends EntitySummary {
  readonly sitting: number;
  readonly order: number;
  readonly characters: number;
  readonly locations: number;
}

export interface DashboardModel {
  readonly partyIdentity: CampaignPartyIdentity;
  readonly identity: CampaignIdentity;
  readonly party: readonly EntitySummary[];
  readonly companions: readonly EntitySummary[];
  readonly lastSession: number | undefined;
  readonly lastSessionEvents: readonly DashboardEvent[];
  readonly recent: readonly EntitySummary[];
  readonly counts: Readonly<Record<string, number>>;
}

export function projectCampaignIdentity(dataset: CampaignDataset): CampaignIdentity {
  const record = campaignCollection(dataset, "campaign").records.find(({ key }) => key === "main");
  const value = recordValue(record);
  return {
    name: nonEmptyText(value["name"]) ?? "TTRPG Codex",
    tagline: text(value["tagline"]),
  };
}

export function recentCampaignActivity(dataset: CampaignDataset, maximum = 30): readonly EntitySummary[] {
  const representatives = new Map(campaignPages.map(page => [page.id, twinRepresentatives(campaignCollection(dataset, page.collection).records)]));
  const seen = new Set<string>();
  return campaignPages.flatMap(page => campaignCollection(dataset, page.collection).records.map(record => ({ page, entity: projectEntity(dataset, record, page) })))
    .map(({ page, entity }) => ({ page, entity: { ...entity, updatedAt: activityTimestamp(entity.raw, entity.updatedAt) } }))
    .filter(({ entity }) => entity.updatedAt !== undefined)
    .sort((a, b) => Date.parse(b.entity.updatedAt!) - Date.parse(a.entity.updatedAt!) || a.entity.route.localeCompare(b.entity.route))
    .filter(({ page, entity }) => {
      const key = recordHash(page, representatives.get(page.id)!.get(entity.key)!);
      if (seen.has(key)) return false; seen.add(key); return true;
    }).slice(0, maximum).map(({ entity }) => entity);
}

export function projectEntities(
  dataset: CampaignDataset,
  page: CampaignPageDefinition,
): readonly EntitySummary[] {
  const context = createAttitudeContext(dataset);
  return groupTwinRecords(campaignCollection(dataset, page.collection).records).map((record) =>
    projectEntityWithContext(dataset, record, page, context)
  );
}

export function projectEntity(dataset: CampaignDataset, record: CampaignRecord, page: CampaignPageDefinition): EntitySummary {
  return projectEntityWithContext(dataset, record, page, createAttitudeContext(dataset));
}

function projectEntityWithContext(
  dataset: CampaignDataset,
  record: CampaignRecord,
  page: CampaignPageDefinition,
  context: AttitudeContext,
): EntitySummary {
  const value = recordValue(record);
  const attitudes = effectiveAttitudes(context, page.collection, value);
  const partyIdentity = page.collection === "characters" && value["faction"] === "party" ? campaignPartyIdentity(dataset) : undefined;
  return Object.freeze({
    partyIdentity,
    key: record.key,
    name: nonEmptyText(value["name"]) ?? nonEmptyText(value["title"]) ?? record.key,
    title: firstText(value, secondaryFields[page.collection] ?? []),
    excerpt: firstExcerpt(value, excerptFields[page.collection] ?? ["description", "summary", "body"]),
    portrait: safeMediaURL(value["portrait"]),
    icon: partyIdentity?.badge ?? shortIcon(value["icon"] ?? value["badge"]),
    status: text(value["status"]),
    statusLabel: page.collection === "characters"
      ? campaignEnumDisplayLabel(dataset, "characterStatuses", value["status"])
      : text(value["status"]),
    visibility: value["visibility"] === "dm" ? "dm" : "public",
    tags: stringList(value["tags"]),
    attitudes,
    attitudeRing: attitudeRing(attitudes),
    attitudeFilter: attitudeFilter(attitudes),
    route: recordHash(page, record.key),
    updatedAt: timestamp(value["updatedAt"]),
    raw: Object.freeze({ ...value }),
  });
}

export function projectEffectiveAttitudes(
  dataset: CampaignDataset,
  collection: CampaignPageDefinition["collection"],
  value: Readonly<Record<string, unknown>>,
): readonly AttitudePresentation[] {
  return effectiveAttitudes(createAttitudeContext(dataset), collection, value);
}

function effectiveAttitudes(
  context: AttitudeContext,
  collection: CampaignPageDefinition["collection"],
  value: Readonly<Record<string, unknown>>,
): readonly AttitudePresentation[] {
  if (collection !== "characters" && collection !== "locations" && collection !== "factions") {
    return Object.freeze([]);
  }
  let ids = attitudeIDs(value["attitudes"]);
  if (ids.length === 0 && collection === "characters") {
    const faction = text(value["faction"]);
    if (faction === "party") {
      ids = Object.freeze(["party"]);
    } else if (faction !== "") {
      ids = context.factions.get(faction) ?? Object.freeze([]);
    }
  }
  return Object.freeze(ids.flatMap((id) => {
    const definition = context.definitions.get(id);
    return definition === undefined ? [] : [definition];
  }));
}

interface AttitudeContext {
  readonly definitions: ReadonlyMap<string, AttitudePresentation>;
  readonly factions: ReadonlyMap<string, readonly string[]>;
}

function createAttitudeContext(dataset: CampaignDataset): AttitudeContext {
  const factions = new Map<string, readonly string[]>();
  for (const record of campaignCollection(dataset, "factions").records) {
    factions.set(record.key, attitudeIDs(recordValue(record)["attitudes"]));
  }
  return Object.freeze({ definitions: attitudeDefinitions(dataset), factions });
}

export function projectDashboard(dataset: CampaignDataset): DashboardModel {
  const characters = entitiesFor(dataset, "characters");
  const pets = entitiesFor(dataset, "pets");
  const party = characters.filter((character) => character.raw["faction"] === "party")
    .sort((left, right) => left.name.localeCompare(right.name, "cs"));
  const partyKeys = new Set(campaignCollection(dataset, "characters").records.filter(record => recordValue(record)["faction"] === "party").map(record => record.key));
  const companions = pets.filter((pet) =>
    pet.raw["ownerType"] === "party" ||
    (pet.raw["ownerType"] === "character" && partyKeys.has(text(pet.raw["ownerId"])))
  );
  const events = entitiesFor(dataset, "events").map((event): DashboardEvent => Object.freeze({
    ...event,
    sitting: positiveInteger(event.raw["sitting"]),
    order: finiteNumber(event.raw["order"]),
    characters: stringList(event.raw["characters"]).length,
    locations: stringList(event.raw["locations"]).length,
  }));
  const lastSession = events.reduce((highest, event) => Math.max(highest, event.sitting), 0);
  const recent = recentCampaignActivity(dataset);
  const counts: Record<string, number> = {};
  for (const page of campaignPages) {
    counts[page.id] = groupTwinRecords(campaignCollection(dataset, page.collection).records).length;
  }
  return Object.freeze({
    identity: projectCampaignIdentity(dataset),
    partyIdentity: campaignPartyIdentity(dataset),
    party: Object.freeze(party),
    companions: Object.freeze(companions),
    lastSession: lastSession > 0 ? lastSession : undefined,
    lastSessionEvents: Object.freeze(events
      .filter((event) => event.sitting === lastSession && lastSession > 0)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))),
    recent: Object.freeze(recent),
    counts: Object.freeze(counts),
  });
}

export function safeMediaURL(value: unknown): string | undefined {
  return typeof value === "string" && /^\/api\/media\/b_[0-9a-f]{32}$/u.test(value)
    ? value
    : undefined;
}

export function recordValue(record: CampaignRecord | undefined): Readonly<Record<string, unknown>> {
  return isRecord(record?.value) ? record.value : Object.freeze({});
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? Object.freeze(value.filter((item): item is string => typeof item === "string" && item.trim() !== ""))
    : Object.freeze([]);
}

function entitiesFor(
  dataset: CampaignDataset,
  collection: CampaignPageDefinition["collection"],
): readonly EntitySummary[] {
  const page = campaignPages.find((candidate) => candidate.collection === collection);
  if (page === undefined) {
    throw new Error(`campaign page for ${collection} is missing`);
  }
  return projectEntities(dataset, page);
}

function nonEmptyText(value: unknown): string | undefined {
  const result = text(value);
  return result === "" ? undefined : result;
}

function firstText(value: Readonly<Record<string, unknown>>, fields: readonly string[]): string {
  for (const field of fields) {
    const result = text(value[field]);
    if (result !== "") return result;
  }
  return "";
}

function firstExcerpt(value: Readonly<Record<string, unknown>>, fields: readonly string[]): string {
  for (const field of fields) {
    const direct = text(value[field]);
    if (direct !== "") return direct;
    if (!Array.isArray(value[field])) continue;
    for (const candidate of value[field]) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
      if (isRecord(candidate)) {
        const nested = text(candidate["text"] ?? candidate["question"] ?? candidate["answer"]);
        if (nested !== "") return nested;
      }
    }
  }
  return "";
}

function shortIcon(value: unknown): string | undefined {
  const result = text(value);
  return result !== "" && [...result].length <= 4 ? result : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isSafeInteger(value) && value > 0 && Number.isFinite(date.getTime())
      ? date.toISOString()
      : undefined;
  }
  const candidate = text(value);
  return /^\d{4}-\d{2}-\d{2}T/u.test(candidate) && Number.isFinite(Date.parse(candidate))
    ? candidate
    : undefined;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function attitudeDefinitions(dataset: CampaignDataset): ReadonlyMap<string, AttitudePresentation> {
  const result = new Map<string, AttitudePresentation>();
  const settings = campaignCollection(dataset, "settings");
  const attitudeRecord = settings.records.find(({ key }) => key === "attitudes");
  if (Array.isArray(attitudeRecord?.value)) {
    for (const candidate of attitudeRecord.value) {
      if (!isRecord(candidate)) continue;
      const id = text(candidate["id"]);
      const color = safeHexColor(candidate["labelColor"] ?? candidate["bg"]);
      if (id === "" || color === undefined || result.has(id)) continue;
      result.set(id, Object.freeze({
        id,
        label: text(candidate["label"]) || id,
        color,
        strength: normalizedStrength(candidate["strength"]),
      }));
    }
  }
  const party = campaignPartyIdentity(dataset);
  const configuredPartyStrength = result.get("party")?.strength ?? 1;
  if (!result.has("party")) {
    result.set("party", Object.freeze({
      id: "party",
      label: party.name,
      color: party.color,
      strength: configuredPartyStrength,
    }));
  }
  return result;
}

function attitudeIDs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    const id = typeof candidate === "string" ? candidate : isRecord(candidate) ? text(candidate["id"]) : "";
    if (id !== "" && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return Object.freeze(ids);
}

function normalizedStrength(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 1;
}

function safeHexColor(value: unknown): string | undefined {
  const candidate = text(value);
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(candidate) ? candidate.toLowerCase() : undefined;
}

const secondaryFields: Readonly<Partial<Record<CampaignPageDefinition["collection"], readonly string[]>>> = {
  characters: ["title", "species"],
  locations: ["region", "type"],
  events: ["date", "short"],
  mysteries: ["priority"],
  factions: [],
  pantheon: ["domain", "title"],
  artifacts: [],
  historicalEvents: ["start", "end"],
  pets: ["species", "ownerType"],
};

const excerptFields: Readonly<Partial<Record<CampaignPageDefinition["collection"], readonly string[]>>> = {
  characters: ["description", "known", "circumstances"],
  locations: ["description", "history", "mapNotes"],
  events: ["short", "description"],
  mysteries: ["clues", "questions"],
  factions: ["description"],
  pantheon: ["description"],
  artifacts: ["description"],
  historicalEvents: ["summary", "body"],
  pets: ["note"],
};
