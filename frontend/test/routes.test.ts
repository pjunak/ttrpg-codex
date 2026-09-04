import { describe, expect, it } from "vitest";
import {
  campaignPages,
  collectionHash,
  parseAppRoute,
  recordHash,
} from "../src/app/routes.js";

describe("application routes", () => {
  it("maps the campaign title page, search, party, collections, records, and add-ons", () => {
    expect(parseAppRoute("")).toEqual({ kind: "dashboard" });
    expect(parseAppRoute("#/search")).toEqual({ kind: "search" });
    expect(parseAppRoute("#/party")).toEqual({ kind: "party" });
    expect(parseAppRoute("#/settings")).toEqual({ kind: "settings" });
    expect(parseAppRoute("#/locations")).toMatchObject({
      kind: "collection", page: { collection: "locations" },
    });
    expect(parseAppRoute("#/locations/greenest%20keep")).toMatchObject({
      kind: "record", key: "greenest keep", page: { collection: "locations" },
    });
    expect(parseAppRoute("#/addons/dm-tools/planner")).toEqual({ kind: "addon" });
  });

  it("round-trips record keys without allowing malformed paths", () => {
    const locations = campaignPages.find((page) => page.collection === "locations");
    expect(locations).toBeDefined();
    if (locations === undefined) return;
    expect(collectionHash(locations)).toBe("#/locations");
    expect(recordHash(locations, "keep/upper hall")).toBe("#/locations/keep%2Fupper%20hall");
    expect(parseAppRoute(recordHash(locations, "keep/upper hall"))).toMatchObject({
      kind: "record", key: "keep/upper hall",
    });
    expect(parseAppRoute("#/locations/%E0%A4%A").kind).toBe("not-found");
    expect(parseAppRoute("#/locations/a/extra").kind).toBe("not-found");
    expect(parseAppRoute("#/unknown").kind).toBe("not-found");
  });
});
