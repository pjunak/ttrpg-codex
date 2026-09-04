import { isRecord } from "../core/boundary.js";
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

export interface CampaignIdentity {
  readonly name: string;
  readonly tagline: string;
}

export interface EntitySummary {
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly excerpt: string;
  readonly portrait: string | undefined;
  readonly icon: string | undefined;
  readonly status: string;
  readonly visibility: "public" | "dm";
  readonly tags: readonly string[];
  readonly route: string;
  readonly updatedAt: string | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface DashboardEvent extends EntitySummary {
  readonly sitting: number;
  readonly order: number;
  readonly characters: number;
  readonly locations: number;
}

export interface DashboardModel {
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

export function projectEntities(
  dataset: CampaignDataset,
  page: CampaignPageDefinition,
): readonly EntitySummary[] {
  return campaignCollection(dataset, page.collection).records.map((record) =>
    projectEntity(record, page)
  );
}

export function projectEntity(
  record: CampaignRecord,
  page: CampaignPageDefinition,
): EntitySummary {
  const value = recordValue(record);
  return Object.freeze({
    key: record.key,
    name: nonEmptyText(value["name"]) ?? nonEmptyText(value["title"]) ?? record.key,
    title: firstText(value, secondaryFields[page.collection] ?? []),
    excerpt: firstText(value, excerptFields[page.collection] ?? ["description", "summary", "body"]),
    portrait: safeMediaURL(value["portrait"]),
    icon: shortIcon(value["icon"] ?? value["badge"]),
    status: text(value["status"]),
    visibility: value["visibility"] === "dm" ? "dm" : "public",
    tags: stringList(value["tags"]),
    route: recordHash(page, record.key),
    updatedAt: timestamp(value["updatedAt"]),
    raw: Object.freeze({ ...value }),
  });
}

export function projectDashboard(dataset: CampaignDataset): DashboardModel {
  const characters = entitiesFor(dataset, "characters");
  const pets = entitiesFor(dataset, "pets");
  const party = characters.filter((character) => character.raw["faction"] === "party");
  const partyKeys = new Set(party.map(({ key }) => key));
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
  const recent = campaignPages.flatMap((page) => projectEntities(dataset, page))
    .filter((entity) => entity.updatedAt !== undefined)
    .sort((left, right) => Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? ""))
    .slice(0, 6);
  const counts: Record<string, number> = {};
  for (const page of campaignPages) {
    counts[page.id] = campaignCollection(dataset, page.collection).records.length;
  }
  return Object.freeze({
    identity: projectCampaignIdentity(dataset),
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

function shortIcon(value: unknown): string | undefined {
  const result = text(value);
  return result !== "" && [...result].length <= 4 ? result : undefined;
}

function timestamp(value: unknown): string | undefined {
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

const secondaryFields: Readonly<Partial<Record<CampaignPageDefinition["collection"], readonly string[]>>> = {
  characters: ["title", "species"],
  locations: ["type", "region"],
  events: ["date", "short"],
  mysteries: ["priority", "status"],
  factions: ["type", "domain"],
  pantheon: ["domain", "title"],
  artifacts: ["type", "holder"],
  historicalEvents: ["date", "period"],
  pets: ["species", "ownerType"],
};

const excerptFields: Readonly<Partial<Record<CampaignPageDefinition["collection"], readonly string[]>>> = {
  characters: ["description", "known", "summary"],
  locations: ["description", "summary", "history"],
  events: ["short", "description", "summary"],
  mysteries: ["summary", "description", "known"],
  factions: ["description", "summary", "known"],
  pantheon: ["description", "summary", "body"],
  artifacts: ["description", "summary", "history"],
  historicalEvents: ["summary", "description", "body"],
  pets: ["description", "notes", "summary"],
};
