import type { CampaignCollectionName } from "../core/campaign-data.js";

export interface CampaignEditorField {
  readonly key: string;
  readonly label: string;
  readonly kind: "line" | "text";
  readonly maximumLength: number;
  readonly required?: boolean;
}

export interface CampaignPageDescriptor {
  readonly collection: CampaignCollectionName;
  readonly path: string;
  readonly singularLabel: string;
  readonly pluralLabel: string;
  readonly fields: readonly CampaignEditorField[];
  readonly visibilityBearing: boolean;
}

const description = Object.freeze({
  key: "description", label: "Description", kind: "text", maximumLength: 200_000,
} satisfies CampaignEditorField);
const name = Object.freeze({
  key: "name", label: "Name", kind: "line", maximumLength: 200, required: true,
} satisfies CampaignEditorField);

export const campaignPages: readonly CampaignPageDescriptor[] = Object.freeze([
  page("characters", "characters", "Character", "Characters", [
    name, field("title", "Title"), description,
  ]),
  page("locations", "locations", "Location", "Locations", [
    name, field("type", "Type"), description,
  ]),
  page("events", "events", "Event", "Events", [
    name, field("short", "Short summary", 500), description,
  ]),
  page("mysteries", "mysteries", "Mystery", "Mysteries", [
    name, field("status", "Status"), description,
  ]),
  page("factions", "factions", "Faction", "Factions", [
    name, field("motto", "Motto", 500), description,
  ]),
  page("pantheon", "pantheon", "Deity", "Pantheon", [
    name, field("domain", "Domain"), description,
  ]),
  page("artifacts", "artifacts", "Artifact", "Artifacts", [
    name, field("type", "Type"), description,
  ]),
  page("historicalEvents", "history", "Historical event", "History", [
    name, field("date", "Date"), description,
  ]),
  page("pets", "pets", "Companion", "Companions", [
    name, field("species", "Species"), field("notes", "Notes", 200_000, "text"),
  ], false),
]);

export type CoreRoute =
  | { readonly kind: "overview" }
  | { readonly kind: "collection"; readonly page: CampaignPageDescriptor }
  | { readonly kind: "record"; readonly page: CampaignPageDescriptor; readonly key: string }
  | { readonly kind: "addon" }
  | { readonly kind: "not-found"; readonly path: string };

export function parseCoreRoute(hash: string): CoreRoute {
  const raw = hash === "" || hash === "#" ? "/" : hash.startsWith("#") ? hash.slice(1) : hash;
  const path = raw.split("?", 1)[0] ?? "/";
  if (path === "/" || path === "/overview") {
    return { kind: "overview" };
  }
  if (path.startsWith("/addons/")) {
    return { kind: "addon" };
  }
  const parts = path.split("/").filter((part) => part !== "");
  const page = campaignPages.find((candidate) => candidate.path === parts[0]);
  if (page === undefined || parts.length > 2) {
    return { kind: "not-found", path };
  }
  if (parts.length === 1) {
    return { kind: "collection", page };
  }
  const key = decodeRoutePart(parts[1] ?? "");
  return key === null || key === ""
    ? { kind: "not-found", path }
    : { kind: "record", page, key };
}

export function campaignCollectionHash(page: CampaignPageDescriptor): string {
  return `#/${page.path}`;
}

export function campaignRecordHash(page: CampaignPageDescriptor, key: string): string {
  return `${campaignCollectionHash(page)}/${encodeURIComponent(key)}`;
}

function page(
  collection: CampaignCollectionName,
  path: string,
  singularLabel: string,
  pluralLabel: string,
  fields: readonly CampaignEditorField[],
  visibilityBearing = true,
): CampaignPageDescriptor {
  return Object.freeze({
    collection, path, singularLabel, pluralLabel,
    fields: Object.freeze([...fields]), visibilityBearing,
  });
}

function field(
  key: string,
  label: string,
  maximumLength = 200,
  kind: CampaignEditorField["kind"] = "line",
): CampaignEditorField {
  return Object.freeze({ key, label, kind, maximumLength });
}

function decodeRoutePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
