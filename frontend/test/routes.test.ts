import { describe, expect, it } from "vitest";
import {
  campaignPages,
  collectionHash,
  parseAppRoute,
  recordHash,
  eventMapHash,
  locationMapHash,
  mapSettingsHash,
} from "../src/app/routes.js";

describe("application routes", () => {
  it("opens the preserved timeline aliases and session-aware shared event editor", () => {
    for (const hash of ["#/timeline", "#/casova-osa", "#/mapa/casova-osa"]) expect(parseAppRoute(hash)).toEqual({ kind: "timeline" });
    expect(parseAppRoute("#/timeline/new/3")).toMatchObject({ kind: "create", preset: "event", sitting: 3, page: { collection: "events" } });
    expect(parseAppRoute("#/events/river%2Fcamp/edit")).toMatchObject({ kind: "record", key: "river/camp", editing: true });
    for (const hash of ["#/timeline/new/0", "#/timeline/new/2.5", "#/timeline/new/9007199254740992", "#/events/%00/edit", "#/events/river/edit/extra"]) {
      expect(parseAppRoute(hash).kind).toBe("not-found");
    }
  });
  it("maps the campaign title page, search, party, collections, records, and add-ons", () => {
    expect(parseAppRoute("")).toEqual({ kind: "dashboard" });
    expect(parseAppRoute("#/search")).toEqual({ kind: "search" });
    expect(parseAppRoute("#/party")).toEqual({ kind: "party" });
    expect(parseAppRoute("#/party/new")).toMatchObject({ kind: "create", preset: "party", page: { collection: "characters" } });
    expect(parseAppRoute("#/characters/new")).toMatchObject({ kind: "record", key: "new" });
    expect(parseAppRoute("#/settings")).toEqual({ kind: "settings" });
    expect(parseAppRoute("#/map/world")).toEqual({ kind: "map", parentId: null });
    expect(parseAppRoute("#/map/local/gate%2Fupper")).toEqual({ kind: "map", parentId: "gate/upper" });
    expect(parseAppRoute("#/mapa/svet")).toEqual({ kind: "map", parentId: null });
    expect(parseAppRoute("#/map/local/%00").kind).toBe("not-found");
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
  it("round-trips event map links with explicit show/place intent and rejects malformed targets", () => {
    expect(parseAppRoute(eventMapHash(null, "camp/river", "show"))).toEqual({ kind: "map", parentId: null, event: { key: "camp/river", mode: "show" } });
    expect(parseAppRoute(eventMapHash("gate/upper", "camp ?#", "place"))).toEqual({ kind: "map", parentId: "gate/upper", event: { key: "camp ?#", mode: "place" } });
    for (const hash of ["#/map/world/event/%00/place", "#/map/world/event/%E0%A4%A/show", "#/map/local/%00/event/camp/show",
      "#/map/world/event/camp/delete", "#/map/world/event/camp/show/extra", "#/map/world/event//place"]) {
      expect(parseAppRoute(hash).kind).toBe("not-found");
    }
  });
  it("opens map settings in the requested world or local scope", () => {
    expect(parseAppRoute(mapSettingsHash(null))).toEqual({ kind: "settings", mapParentId: null });
    expect(parseAppRoute(mapSettingsHash("gate/upper"))).toEqual({ kind: "settings", mapParentId: "gate/upper" });
    expect(parseAppRoute("#/settings/maps/local/%00").kind).toBe("not-found");
    expect(parseAppRoute("#/settings/maps/local/%E0%A4%A").kind).toBe("not-found");
  });
  it("round-trips location show/place links and rejects malformed or unknown actions", () => {
    expect(parseAppRoute(locationMapHash(null, "gate/north ?#", "show"))).toEqual({ kind: "map", parentId: null, location: { key: "gate/north ?#", mode: "show" } });
    expect(parseAppRoute(locationMapHash("gate/upper", "room", "place"))).toEqual({ kind: "map", parentId: "gate/upper", location: { key: "room", mode: "place" } });
    for (const hash of ["#/map/world/location/%00/place", "#/map/world/location/%E0%A4%A/show", "#/map/local/%00/location/room/show",
      "#/map/world/location/gate/delete", "#/map/world/location/gate/show/extra", "#/map/world/location//place"]) {
      expect(parseAppRoute(hash).kind).toBe("not-found");
    }
  });
});
