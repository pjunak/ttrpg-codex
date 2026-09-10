import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { editorFieldsFor, editorOptionsFor, type CampaignEditorField } from "./campaign-record-editor.js";
import { projectEntities, recordValue, text, type EntitySummary } from "./campaign-projection.js";
import { searchable, searchTokens } from "./campaign-search.js";
import type { CampaignPageDefinition } from "./routes.js";
import { currentUiLocale, uiText } from "./ui-localization.js";
import type { CollectionView } from "./collection-view.js";

export interface CollectionChoice { readonly value: string; readonly label: string; readonly count: number }
export interface CollectionFacet { readonly key: string; readonly label: string; readonly choices: readonly CollectionChoice[]; readonly multiple: boolean }
export interface CollectionSort { readonly key: string; readonly label: string }
interface CollectionEntry {
  readonly entity: EntitySummary;
  readonly search: string;
  readonly facets: ReadonlyMap<string, readonly string[]>;
  readonly sorts: ReadonlyMap<string, string | number | undefined>;
}
export interface CollectionModel {
  readonly entries: readonly CollectionEntry[];
  readonly facets: readonly CollectionFacet[];
  readonly sorts: readonly CollectionSort[];
}
export interface CollectionGroup { readonly key: string; readonly label: string; readonly entries: readonly EntitySummary[] }
const models = new WeakMap<CampaignDataset, Map<string, CollectionModel>>();

/** All source values and choice labels come from the current role projection. */
export function collectionModel(dataset: CampaignDataset, page: CampaignPageDefinition): CollectionModel {
  const key = `${page.id}:${page.collection}:${currentUiLocale()}`;
  const cached = models.get(dataset)?.get(key);
  if (cached) return cached;
  const fields = editorFieldsFor(page.collection);
  const facetFields = fields.filter(field => field.browse === true || field.browse !== false &&
    ["enum", "reference", "references", "tags", "attitudes", "boolean", "owner"].includes(field.kind));
  const collator = new Intl.Collator(currentUiLocale(), { numeric: true, sensitivity: "base" });
  const choices = new Map(facetFields.map(field => [field.key, new Map(editorOptionsFor(dataset, field, "").map(option => [option.value, option.label]))]));
  const counts = new Map(facetFields.map(field => [field.key, new Map<string, number>()]));
  const sortFields = fields.filter(field => field.kind === "number" || facetFields.includes(field) && !["references", "tags", "attitudes"].includes(field.kind));
  const sorts: CollectionSort[] = [{ key: "name", label: uiText("Name") }, { key: "updatedAt", label: uiText("browse.updated") },
    ...sortFields.map(field => ({ key: field.key, label: field.label }))];
  const memberCounts = new Map<string, number>();
  if (page.collection === "factions") {
    for (const record of campaignCollection(dataset, "characters").records) {
      const faction = text(recordValue(record)["faction"]);
      memberCounts.set(faction, (memberCounts.get(faction) ?? 0) + 1);
    }
    sorts.push({ key: "members", label: uiText("browse.members") });
  }
  const entries = projectEntities(dataset, page).map(entity => {
    const facets = new Map<string, readonly string[]>();
    const sortValues = new Map<string, string | number | undefined>([["name", entity.name], ["updatedAt", entity.updatedAt ? Date.parse(entity.updatedAt) : undefined]]);
    const labels: string[] = [];
    for (const field of facetFields) {
      const values = [...new Set(facetValues(field, entity))];
      facets.set(field.key, values);
      const options = choices.get(field.key)!;
      for (const value of values) {
        const label = options.get(value) ?? (value === "" ? uiText("browse.missing") : field.kind === "boolean" ? uiText(value === "true" ? "Yes" : "No")
          : field.referenceCollection || field.kind === "owner" ? uiText("browse.unavailable") : value);
        options.set(value, label); labels.push(label);
        const totals = counts.get(field.key)!; totals.set(value, (totals.get(value) ?? 0) + 1);
      }
      const first = values[0];
      sortValues.set(field.key, first === undefined || first === "" ? undefined : field.kind === "number" ? Number(first) : options.get(first));
    }
    for (const field of sortFields.filter(field => field.kind === "number")) {
      const raw = entity.raw[field.key];
      sortValues.set(field.key, (typeof raw === "number" || typeof raw === "string" && raw.trim() !== "") && Number.isFinite(Number(raw)) ? Number(raw) : undefined);
    }
    if (page.collection === "factions") sortValues.set("members", memberCounts.get(entity.key) ?? 0);
    const source = [entity.name, entity.title, ...labels, ...fields.map(field => field.referenceCollection ? "" : searchText(entity.raw[field.key]))].join(" ");
    return { entity, search: searchable(source), facets, sorts: sortValues };
  });
  const result = { entries, sorts, facets: facetFields.map(field => ({ key: field.key, label: field.label,
    multiple: ["references", "tags", "attitudes"].includes(field.kind),
    choices: [...choices.get(field.key)!].map(([value, label]) => ({ value, label, count: counts.get(field.key)!.get(value) ?? 0 }))
      .sort((a, b) => collator.compare(a.label, b.label) || a.value.localeCompare(b.value)) })) };
  const cache = models.get(dataset) ?? new Map<string, CollectionModel>();
  cache.set(key, result); models.set(dataset, cache);
  return result;
}

function facetValues(field: CampaignEditorField, entity: EntitySummary): readonly string[] {
  const raw = entity.raw[field.key];
  if (field.kind === "attitudes") return entity.attitudes.length ? entity.attitudes.map(item => item.id) : [""];
  if (field.kind === "owner") return [`${text(entity.raw["ownerType"]) || "none"}:${text(entity.raw["ownerId"])}`];
  if (field.kind === "boolean") return [raw === true ? "true" : "false"];
  if (Array.isArray(raw)) { const values = raw.filter((value): value is string => typeof value === "string"); return values.length ? values : [""]; }
  return [typeof raw === "string" || typeof raw === "number" ? String(raw) : ""];
}

function searchText(value: unknown, depth = 0): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (depth > 6) return "";
  if (Array.isArray(value)) return value.map(item => searchText(item, depth + 1)).join(" ");
  if (isRecord(value)) return Object.values(value).map(item => searchText(item, depth + 1)).join(" ");
  return "";
}

function matchingEntries(model: CollectionModel, view: CollectionView): CollectionEntry[] {
  const tokens = searchTokens(view.query);
  const filters = new Map<string, Set<string>>();
  for (const filter of view.filters) {
    if (!model.facets.some(facet => facet.key === filter.field)) continue;
    const values = filters.get(filter.field) ?? new Set<string>(); values.add(filter.value); filters.set(filter.field, values);
  }
  return model.entries.filter(entry => tokens.every(token => entry.search.includes(token)) &&
    [...filters].every(([field, values]) => entry.facets.get(field)?.some(value => values.has(value))));
}

export function collectionFacetChoices(model: CollectionModel, view: CollectionView, field: string): readonly CollectionChoice[] {
  const counts = new Map<string, number>();
  for (const entry of matchingEntries(model, { ...view, filters: view.filters.filter(filter => filter.field !== field) })) {
    for (const value of entry.facets.get(field) ?? []) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return model.facets.find(facet => facet.key === field)?.choices.map(choice => ({ ...choice, count: counts.get(choice.value) ?? 0 })) ?? [];
}

export function queryCollection(model: CollectionModel, view: CollectionView): { readonly count: number; readonly groups: readonly CollectionGroup[] } {
  const collator = new Intl.Collator(currentUiLocale(), { numeric: true, sensitivity: "base" });
  const sort = model.sorts.some(sort => sort.key === view.sort) ? view.sort : "name";
  const entries = matchingEntries(model, view)
    .sort((left, right) => {
      const a = left.sorts.get(sort), b = right.sorts.get(sort);
      const ordered = a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1
        : (typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b))) * (view.direction === "desc" ? -1 : 1);
      return ordered || collator.compare(left.entity.name, right.entity.name) || left.entity.key.localeCompare(right.entity.key);
    });
  const facet = model.facets.find(facet => facet.key === view.group);
  if (!facet) return { count: entries.length, groups: [{ key: "", label: "", entries: entries.map(entry => entry.entity) }] };
  const grouped = new Map<string, EntitySummary[]>();
  for (const entry of entries) for (const value of entry.facets.get(facet.key) ?? [""]) {
    const group = grouped.get(value) ?? []; group.push(entry.entity); grouped.set(value, group);
  }
  return { count: entries.length, groups: [...grouped].map(([key, entries]) => ({ key, label: facet.choices.find(choice => choice.value === key)?.label ?? uiText("browse.unavailable"), entries }))
    .sort((a, b) => collator.compare(a.label, b.label) || a.key.localeCompare(b.key)) };
}
