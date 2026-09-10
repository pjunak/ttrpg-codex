import { describe, expect, it } from "vitest";
import { parseCampaignDataset } from "../src/core/campaign-data.js";
import { collectionFacetChoices, collectionModel, queryCollection } from "../src/app/collection-model.js";
import { defaultCollectionView, parseCollectionView, serializeCollectionView } from "../src/app/collection-view.js";
import { campaignPages, parseAppRoute } from "../src/app/routes.js";
import { setUiLocale } from "../src/app/ui-localization.js";

function dataset(changes: Record<string, { key: string; revision: number; value: unknown }[]>) {
  const keyed = new Set(["factions", "deletedDefaults", "settings", "campaign"]);
  return parseCampaignDataset({ contractVersion: "campaign-data.v1", collections:
    ["characters", "relationships", "locations", "events", "mysteries", "factions", "deletedDefaults", "pantheon", "artifacts", "settings", "historicalEvents", "campaign", "pets"]
      .map(name => ({ name, shape: keyed.has(name) ? "keyed" : "list", materialized: true, revision: 1, records: changes[name] ?? [] })) });
}
const record = (key: string, value: unknown) => ({ key, revision: 1, value });
const characters = campaignPages.find(page => page.id === "characters")!;
const data = dataset({
  characters: [
    record("zar", { name: "Žár 10", description: `${"Opening prose. ".repeat(100)} Strážce severu`, faction: "watch", status: "alive", tags: ["scout", "mage"] }),
    record("zar2", { name: "Žár 2", faction: "watch", status: "dead", tags: ["scout"] }),
    record("ada", { name: "Ada", faction: "party", status: "alive", description: "Other record", privateUnknownField: "do-not-index-this" }),
  ],
  factions: [record("watch", { name: "Noční hlídka" }), record("party", { name: "Adventurers" })],
});

describe("shared collection browsing", () => {
  it("searches complete authored fields and resolved references with all accent-folded tokens", () => {
    const model = collectionModel(data, characters);
    expect(queryCollection(model, { ...defaultCollectionView, query: "ZAR STRAZCE SEVERU" }).groups[0]?.entries.map(entry => entry.key)).toEqual(["zar"]);
    expect(queryCollection(model, { ...defaultCollectionView, query: "nocni hlidka" }).count).toBe(2);
    expect(queryCollection(model, { ...defaultCollectionView, query: "do-not-index-this" }).count).toBe(0);
  });

  it("ORs values within a category, ANDs categories, and counts grouped entries once", () => {
    const model = collectionModel(data, characters);
    const view = { ...defaultCollectionView, group: "tags", filters: [
      { field: "faction", value: "watch" }, { field: "status", value: "alive" }, { field: "status", value: "dead" },
    ] };
    const result = queryCollection(model, view);
    expect(result.count).toBe(2);
    expect(result.groups.map(group => [group.label, group.entries.map(entry => entry.key)])).toEqual([["mage", ["zar"]], ["scout", ["zar2", "zar"]]]);
    expect(queryCollection(model, { ...view, filters: [...view.filters, { field: "tags", value: "mage" }] }).count).toBe(1);
  });

  it("sorts naturally, puts missing values last in either direction, and never mutates source", () => {
    const model = collectionModel(data, characters);
    expect(queryCollection(model, defaultCollectionView).groups[0]?.entries.map(entry => entry.key)).toEqual(["ada", "zar2", "zar"]);
    const locations = campaignPages.find(page => page.id === "locations")!;
    const numeric = collectionModel(dataset({ locations: [record("none", { name: "A" }), record("big", { name: "B", size: 40 }), record("small", { name: "C", size: 20 })] }), locations);
    expect(queryCollection(numeric, { ...defaultCollectionView, sort: "size", direction: "desc" }).groups[0]?.entries.map(entry => entry.key)).toEqual(["big", "small", "none"]);
    expect(queryCollection(numeric, { ...defaultCollectionView, sort: "size" }).groups[0]?.entries.map(entry => entry.key)).toEqual(["small", "big", "none"]);
    expect(model.entries.map(entry => entry.entity.key)).toEqual(["zar", "zar2", "ada"]);
  });

  it("counts facet choices against the other selections and current full-text query", () => {
    const choices = collectionFacetChoices(collectionModel(data, characters), { ...defaultCollectionView, query: "zar", filters: [
      { field: "status", value: "alive" }, { field: "faction", value: "watch" },
    ] }, "status");
    expect(choices.find(choice => choice.value === "alive")?.count).toBe(1);
    expect(choices.find(choice => choice.value === "dead")?.count).toBe(1);
  });

  it("derives faction member counts and uses only the supplied visible projection", () => {
    const factions = campaignPages.find(page => page.id === "factions")!;
    const model = collectionModel(data, factions);
    expect(queryCollection(model, { ...defaultCollectionView, sort: "members", direction: "desc" }).groups[0]?.entries.map(entry => entry.key)).toEqual(["watch", "party"]);
    const visible = collectionModel(dataset({ characters: [record("ada", { name: "Ada", faction: "party" })] }), characters);
    expect(visible.facets.find(facet => facet.key === "faction")?.choices.some(choice => choice.value === "watch")).toBe(false);
    expect(queryCollection(visible, { ...defaultCollectionView, query: "Noční" }).count).toBe(0);
  });

  it("reuses translated field labels and preserves selected missing choices as zero results", () => {
    setUiLocale("cs");
    try {
      const model = collectionModel(data, characters);
      expect(model.facets.find(facet => facet.key === "faction")?.label).toBe("Frakce");
      expect(queryCollection(model, { ...defaultCollectionView, filters: [{ field: "faction", value: "removed" }] }).count).toBe(0);
    } finally { setUiLocale("en"); }
  });

  it("round-trips Unicode and punctuation in URLs and tolerates malformed preferences", () => {
    const view = { ...defaultCollectionView, query: "Žár / &?", sort: "updatedAt", direction: "desc" as const, group: "tags", filters: [{ field: "tags", value: "a:b/&" }] };
    const query = serializeCollectionView(view);
    expect(parseCollectionView(query)).toEqual(view);
    expect(parseAppRoute(`#/characters?${query}`)).toMatchObject({ kind: "collection", view: query });
    expect(parseCollectionView("filter=broken&filter=%7B%7D&direction=bad")).toEqual(defaultCollectionView);
    expect(parseCollectionView("x".repeat(64_001))).toEqual(defaultCollectionView);
  });
});
