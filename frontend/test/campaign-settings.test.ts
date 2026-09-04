import { describe, expect, it } from "vitest";
import {
  campaignEnumDisplayLabel,
  campaignEnumDescriptors,
  campaignEnumItems,
  campaignEnumUsageCount,
  prepareCampaignEnumDelete,
  prepareCampaignEnumSave,
} from "../src/app/campaign-settings.js";
import type {
  CampaignCollection,
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";

describe("campaign settings", () => {
  it("defines the six enum categories owned by the host", () => {
    expect(campaignEnumDescriptors.map(({ category }) => category)).toEqual([
      "relationshipTypes", "genders", "pinTypes", "characterStatuses", "eventPriorities", "attitudes",
    ]);
  });

  it("updates a definition without changing its ID or extension fields", () => {
    const campaign = dataset({
      settings: [{
        key: "attitudes", revision: 4,
        value: [{ id: "ally", label: "Ally", bg: "#2E7D32", fg: "#fff", labelColor: "#4CAF50", strength: 1,
          addonPalette: { ring: true } }],
      }],
    });
    const mutation = prepareCampaignEnumSave(campaign, {
      category: "attitudes",
      originalId: "ally",
      expectedRevision: 4,
      fields: {
        label: "Trusted ally", bg: "#287132", fg: "#ffffff", labelColor: "#51af59", strength: "0.75",
      },
    });

    expect(mutation).toEqual({
      operation: "put",
      collection: "settings",
      key: "attitudes",
      expectedRevision: 4,
      value: [{
        id: "ally", label: "Trusted ally", bg: "#287132", fg: "#ffffff", labelColor: "#51af59",
        strength: 0.75, addonPalette: { ring: true },
      }],
    });
  });

  it("creates typed relationship definitions and constrains location direction", () => {
    const mutation = prepareCampaignEnumSave(dataset(), {
      category: "relationshipTypes",
      originalId: null,
      expectedRevision: 0,
      fields: {
        id: "guards", label: "guards", color: "#84552a", style: "dashed",
        target: "location", dirs: ["from", "to", "both"],
      },
    });
    expect(mutation).toMatchObject({
      operation: "put", collection: "settings", key: "relationshipTypes", expectedRevision: 0,
      value: [{
        id: "guards", label: "guards", color: "#84552a", style: "dashed",
        target: "location", dirs: ["from"],
      }],
    });
  });

  it("counts usages with the same scalar and object-array rules as the Go service", () => {
    const campaign = dataset({
      characters: [
        { key: "a", revision: 1, value: { id: "a", status: "alive", attitudes: [{ id: "ally" }] } },
        { key: "b", revision: 1, value: { id: "b", status: "alive", attitudes: ["ally"] } },
      ],
      locations: [{ key: "town", revision: 1, value: { id: "town", attitudes: [{ id: "ally" }] } }],
      factions: [{ key: "watch", revision: 1, value: { attitudes: [{ id: "ally" }] } }],
    });
    expect(campaignEnumUsageCount(campaign, "characterStatuses", "alive")).toBe(2);
    expect(campaignEnumUsageCount(campaign, "attitudes", "ally")).toBe(4);
  });

  it("uses human labels for stored enum IDs without hiding orphaned values", () => {
    const campaign = dataset({
      settings: [{ key: "genders", revision: 1, value: [{ id: "female", label: "Woman" }] }],
    });
    expect(campaignEnumDisplayLabel(campaign, "genders", "female")).toBe("Woman");
    expect(campaignEnumDisplayLabel(campaign, "genders", "retired-id")).toBe("retired-id");
    expect(campaignEnumDisplayLabel(campaign, "genders", null)).toBe("");
  });

  it("prepares only current, valid enum deletion requests", () => {
    const campaign = dataset({
      settings: [{ key: "genders", revision: 3, value: [{ id: "old", label: "Old" }, { id: "new", label: "New" }] }],
    });
    expect(prepareCampaignEnumDelete(campaign, {
      category: "genders", itemId: "old", expectedRevision: 3, mode: "replace", replacementId: "new",
    })).toMatchObject({ mode: "replace", replacementId: "new" });
    expect(() => prepareCampaignEnumDelete(campaign, {
      category: "genders", itemId: "old", expectedRevision: 2, mode: "clear",
    })).toThrow("campaign settings edit is invalid");
  });

  it("fails closed on duplicate IDs and malformed edited values", () => {
    const malformed = dataset({
      settings: [{ key: "genders", revision: 1, value: [{ id: "same" }, { id: "same" }] }],
    });
    expect(() => campaignEnumItems(malformed, "genders")).toThrow("campaign settings edit is invalid");
    expect(() => prepareCampaignEnumSave(malformed, {
      category: "genders", originalId: "same", expectedRevision: 1, fields: { label: "Same" },
    })).toThrow("campaign settings edit is invalid");
    expect(() => prepareCampaignEnumSave(dataset(), {
      category: "eventPriorities", originalId: null, expectedRevision: 0,
      fields: { id: "urgent", label: "Urgent", color: "red" },
    })).toThrow("campaign settings edit is invalid");
  });
});

const names: readonly CampaignCollectionName[] = [
  "characters", "relationships", "locations", "events", "mysteries", "factions", "deletedDefaults",
  "pantheon", "artifacts", "settings", "historicalEvents", "campaign", "pets",
];

function dataset(
  overrides: Partial<Record<CampaignCollectionName, CampaignCollection["records"]>> = {},
): CampaignDataset {
  return {
    contractVersion: "campaign-data.v1",
    collections: names.map((name) => ({
      name,
      shape: name === "factions" || name === "deletedDefaults" || name === "settings" || name === "campaign"
        ? "keyed" as const
        : "list" as const,
      materialized: true,
      revision: 1,
      records: overrides[name] ?? [],
    })),
  };
}
