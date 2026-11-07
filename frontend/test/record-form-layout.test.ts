import { describe, expect, it } from "vitest";
import { editorFieldsFor } from "../src/app/campaign-record-editor.js";
import { recordFormLayout } from "../src/app/record-form-layout.js";
import { fieldSuggestions } from "../src/app/record-field-controls.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

const collections: readonly CampaignCollectionName[] = [
  "characters",
  "locations",
  "events",
  "mysteries",
  "factions",
  "pantheon",
  "artifacts",
  "historicalEvents",
  "companions",
];

describe("record form layout", () => {
  it.each(collections)("places every %s field exactly once", (collection) => {
    const layout = recordFormLayout(collection);
    const placed = [...layout.sections.flatMap(({ fields }) => fields), ...layout.settings];
    expect(placed.toSorted()).toEqual(
      editorFieldsFor(collection)
        .map(({ key }) => key)
        .toSorted(),
    );
    expect(new Set(layout.sections.map(({ id }) => id)).size).toBe(layout.sections.length);
  });

  it("keeps the name first and no knowledge level anywhere", () => {
    for (const collection of collections) {
      expect(recordFormLayout(collection).sections[0]?.fields[0]).toBe("name");
      expect(editorFieldsFor(collection).some(({ key }) => key === "knowledge")).toBe(false);
    }
  });
});

describe("free-text suggestions", () => {
  it("offers the distinct values other records use, trimmed and sorted", () => {
    const records: CampaignCollection["records"] = [
      { key: "a", revision: 1, value: { type: "Town " } },
      { key: "b", revision: 1, value: { type: "Castle" } },
      { key: "c", revision: 1, value: { type: "Town" } },
      { key: "d", revision: 1, value: { type: "" } },
      { key: "e", revision: 1, value: { type: 4 } },
    ];
    const campaign: CampaignDataset = {
      contractVersion: "campaign-data.v1",
      collections: [{ name: "locations", shape: "list", materialized: true, revision: 1, records }],
    } as unknown as CampaignDataset;
    expect(fieldSuggestions(campaign, "locations", "type")).toEqual(["Castle", "Town"]);
  });
});
