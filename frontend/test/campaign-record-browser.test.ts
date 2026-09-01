import { describe, expect, it } from "vitest";
import {
  contributionTargetsCollection,
  createCampaignRecordKey,
  projectCampaignRecords,
} from "../src/app/campaign-record-browser.js";
import { campaignPages } from "../src/app/core-navigation.js";
import type {
  CampaignCollectionName,
  CampaignDataset,
} from "../src/core/campaign-data.js";
import type { ActiveBrowserContribution } from "../src/addons/browser-sdk.js";

const shapes = {
  characters: "list",
  relationships: "list",
  locations: "list",
  events: "list",
  mysteries: "list",
  factions: "keyed",
  deletedDefaults: "keyed",
  pantheon: "list",
  artifacts: "list",
  settings: "keyed",
  historicalEvents: "list",
  campaign: "keyed",
  pets: "list",
} as const;

describe("campaign record browser", () => {
  it("projects, filters, and sorts bounded summaries", () => {
    const characters = campaignPages.find((page) => page.collection === "characters");
    expect(characters).toBeDefined();
    if (characters === undefined) {
      return;
    }
    const dataset = fixture({
      characters: [
        { key: "ryn", revision: 3, value: { name: "Ryn", title: "Pathfinder" } },
        { key: "ashara", revision: 2, value: { name: "Ashara", description: "Keeper of flame", visibility: "dm" } },
      ],
    });

    expect(projectCampaignRecords(dataset, characters)).toEqual([
      { key: "ashara", title: "Ashara", summary: "Keeper of flame", visibility: "dm", revision: 2 },
      { key: "ryn", title: "Ryn", summary: "Pathfinder", visibility: "public", revision: 3 },
    ]);
    expect(projectCampaignRecords(dataset, characters, "flame")).toHaveLength(1);
    expect(projectCampaignRecords(dataset, characters, "RYN")[0]?.key).toBe("ryn");
  });

  it("creates stable bounded identity prefixes without trusting the title verbatim", () => {
    expect(createCampaignRecordKey("Chrám Chantone", "ABC-123")).toBe("chram-chantone-abc123");
    expect(createCampaignRecordKey("!!!", "x")).toBe("record-x");
    expect(createCampaignRecordKey("a".repeat(200), "token")).toHaveLength(86);
  });

  it("routes article sections only to their declared core collection", () => {
    const active = {
      descriptor: { config: { collection: "characters" } },
    } as unknown as ActiveBrowserContribution;
    expect(contributionTargetsCollection(active, "characters")).toBe(true);
    expect(contributionTargetsCollection(active, "locations")).toBe(false);
  });
});

function fixture(
  records: Partial<Record<CampaignCollectionName, CampaignDataset["collections"][number]["records"]>>,
): CampaignDataset {
  return {
    contractVersion: "campaign-data.v1",
    collections: (Object.entries(shapes) as Array<[CampaignCollectionName, "list" | "keyed"]>)
      .map(([name, shape]) => ({
        name,
        shape,
        materialized: records[name] !== undefined,
        revision: records[name] === undefined ? 0 : 1,
        records: records[name] ?? [],
      })),
  };
}
