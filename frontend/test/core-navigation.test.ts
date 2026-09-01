import { describe, expect, it } from "vitest";
import {
  campaignCollectionHash,
  campaignPages,
  campaignRecordHash,
  parseCoreRoute,
} from "../src/app/core-navigation.js";

describe("core navigation", () => {
  it("parses overview, collection, record, and add-on namespaces", () => {
    expect(parseCoreRoute("#/overview")).toEqual({ kind: "overview" });
    expect(parseCoreRoute("#/characters")).toMatchObject({
      kind: "collection", page: { collection: "characters" },
    });
    expect(parseCoreRoute("#/locations/chr%C3%A1m_chantone")).toMatchObject({
      kind: "record", page: { collection: "locations" }, key: "chrám_chantone",
    });
    expect(parseCoreRoute("#/addons/dm-tools/planner")).toEqual({ kind: "addon" });
  });

  it("fails closed for malformed and unknown paths", () => {
    expect(parseCoreRoute("#/characters/a/b")).toMatchObject({ kind: "not-found" });
    expect(parseCoreRoute("#/characters/%zz")).toMatchObject({ kind: "not-found" });
    expect(parseCoreRoute("#/settings")).toMatchObject({ kind: "not-found" });
  });

  it("builds encoded canonical links from one descriptor registry", () => {
    const locations = campaignPages.find((page) => page.collection === "locations");
    expect(locations).toBeDefined();
    if (locations === undefined) {
      return;
    }
    expect(campaignCollectionHash(locations)).toBe("#/locations");
    expect(campaignRecordHash(locations, "chrám/upper floor")).toBe(
      "#/locations/chr%C3%A1m%2Fupper%20floor",
    );
  });
});
