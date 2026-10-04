import { describe, expect, it } from "vitest";
import { campaignBranding, prepareBrandingSave } from "../src/app/campaign-branding.js";
import {
  allSidebarRoutes,
  campaignSidebar,
  defaultSidebarLayout,
  moveSidebarPage,
  parseSidebarLayout,
  prepareSidebarSave,
  sidebarPage,
} from "../src/app/campaign-sidebar.js";
import type { CampaignCollection, CampaignDataset } from "../src/core/campaign-data.js";
import { addonSidebarMode, prepareAddonSidebarSave } from "../src/app/campaign-sidebar.js";

const logo = `/api/media/b_${"1".repeat(32)}`;
const branding = {
  title: "Asurai",
  subtitle: "World atlas",
  logoUrl: logo,
  extension: { keep: true },
};
const layout = {
  extension: { keep: true },
  sections: [
    {
      id: "world",
      label: "My world",
      icon: "🦉",
      collapsible: true,
      defaultOpen: false,
      role: "",
      pages: ["/characters", "/locations"],
      extension: { color: "gold" },
    },
    { id: "private", label: "DM", role: "dm", pages: ["/timeline", "/events"] },
  ],
  hidden: ["/map/world"],
};
const dataset = (records: CampaignCollection["records"] = []): CampaignDataset => ({
  contractVersion: "campaign-data.v1",
  collections: [{ name: "settings", shape: "keyed", materialized: true, revision: 1, records }],
});

describe("campaign branding", () => {
  it("uses original defaults and rejects untrusted logo URLs in presentation", () => {
    expect(campaignBranding()).toEqual({
      title: "TTRPG Codex",
      subtitle: "Wiki & World Atlas",
      logoUrl: "",
    });
    expect(
      campaignBranding(
        dataset([
          {
            key: "branding",
            revision: 1,
            value: { ...branding, logoUrl: "https://other.test/pixel" },
          },
        ]),
      ).logoUrl,
    ).toBe("");
    expect(campaignBranding(dataset([{ key: "branding", revision: 1, value: branding }]))).toEqual({
      title: "Asurai",
      subtitle: "World atlas",
      logoUrl: logo,
    });
  });
  it("preserves extensions across text/logo replacement and reset", () => {
    const campaign = dataset([{ key: "branding", revision: 4, value: branding }]);
    const before = structuredClone(campaign);
    expect(
      prepareBrandingSave(campaign, {
        expectedRevision: 4,
        title: " Tiamat ",
        subtitle: " Atlas ",
        logoUrl: "",
      }),
    ).toMatchObject({
      collection: "settings",
      key: "branding",
      expectedRevision: 4,
      value: { title: "Tiamat", subtitle: "Atlas", logoUrl: "", extension: { keep: true } },
    });
    expect(campaign).toEqual(before);
  });
  it("rejects stale/deleted revisions, malformed objects, and invalid input", () => {
    const detail = { ...branding, expectedRevision: 1 };
    expect(() => prepareBrandingSave(dataset(), detail)).toThrow("stale");
    expect(() =>
      prepareBrandingSave(dataset([{ key: "branding", revision: 2, value: branding }]), detail),
    ).toThrow("stale");
    expect(() =>
      prepareBrandingSave(dataset([{ key: "branding", revision: 1, value: [] }]), detail),
    ).toThrow("invalid");
    for (const patch of [
      { logoUrl: "javascript:alert(1)" },
      { title: "a".repeat(201) },
      { subtitle: "bad\ntext" },
      { expectedRevision: -1 },
    ]) {
      expect(() =>
        prepareBrandingSave(dataset(), { ...detail, expectedRevision: 0, ...patch }),
      ).toThrow("invalid");
    }
  });
});

describe("curated sidebar layout", () => {
  it("keeps add-on pages opt-in and preserves inactive entries in visibility updates", () => {
    const key = "test-addon:/addons/test-addon/tools";
    const campaign = dataset([
      {
        key: "addonSidebarVisibility",
        revision: 4,
        value: { "retired:/old/path": "dm", [key]: "dm" },
      },
    ]);
    expect(addonSidebarMode(undefined, key)).toBe("hidden");
    expect(addonSidebarMode(campaign, key)).toBe("dm");
    expect(
      prepareAddonSidebarSave(campaign, { expectedRevision: 4, modes: { [key]: "everyone" } }),
    ).toMatchObject({
      expectedRevision: 4,
      value: { "retired:/old/path": "dm", [key]: "everyone" },
    });
    expect(() =>
      prepareAddonSidebarSave(campaign, { expectedRevision: 3, modes: { [key]: "hidden" } }),
    ).toThrow("stale");
    expect(() =>
      prepareAddonSidebarSave(campaign, {
        expectedRevision: 4,
        modes: { [key]: "admin" as never },
      }),
    ).toThrow("invalid");
  });
  it("uses the restored shell defaults only when the record is absent", () => {
    expect(campaignSidebar(dataset())).toEqual(defaultSidebarLayout());
    const curated = campaignSidebar(
      dataset([{ key: "sidebarLayout", revision: 2, value: layout }]),
    );
    expect(curated.sections.map((section) => section.id)).toEqual(["world", "private"]);
    expect(curated.sections[0]).toMatchObject({
      label: "My world",
      defaultOpen: false,
      pages: ["/characters", "/locations"],
      extension: { color: "gold" },
    });
    expect(curated.hidden).toContain("/party");
    expect(curated.hidden).toContain("/map/world");
  });
  it("resolves only implemented core pages", () => {
    expect(sidebarPage("/characters")?.route).toBe("/characters");
    expect(sidebarPage("/map/world")?.route).toBe("/map/world");
    expect(sidebarPage("/graph/factions")).toMatchObject({
      route: "/graph/factions",
      label: "Mind Palace",
    });
    expect(sidebarPage("/graph/factions")).toMatchObject({ route: "/graph/factions" });
    expect(sidebarPage("/graph/mysteries")).toMatchObject({ route: "/graph/mysteries" });
    expect(sidebarPage("https://other.test")).toBeUndefined();
    expect(sidebarPage("/dm")).toBeUndefined();
  });
  it("moves and hides pages while preserving extension fields", () => {
    const parsed = parseSidebarLayout(layout),
      before = structuredClone(parsed);
    const moved = moveSidebarPage(parsed, "/characters", "private", 1);
    expect(moved.sections[0]?.pages).toEqual(["/locations"]);
    expect(moved.sections[1]?.pages).toEqual(["/timeline", "/characters", "/events"]);
    expect(moved.sections[0]?.["extension"]).toEqual({ color: "gold" });
    const hidden = moveSidebarPage(moved, "/characters", "__hidden__", 0);
    expect(hidden.hidden[0]).toBe("/characters");
    expect(new Set(allSidebarRoutes(hidden)).size).toBe(allSidebarRoutes(hidden).length);
    expect(parsed).toEqual(before);
    expect(moveSidebarPage(parsed, "/characters", "absent", 0)).toBe(parsed);
  });
  it("merges the reviewed layout with an optimistic revision and keeps unknown data", () => {
    const campaign = dataset([{ key: "sidebarLayout", revision: 7, value: layout }]);
    const parsed = campaignSidebar(campaign);
    expect(
      prepareSidebarSave(campaign, {
        expectedRevision: 7,
        layout: moveSidebarPage(parsed, "/locations", "__hidden__", 0),
      }),
    ).toMatchObject({
      collection: "settings",
      key: "sidebarLayout",
      expectedRevision: 7,
      value: { extension: { keep: true } },
    });
    expect(() => prepareSidebarSave(campaign, { expectedRevision: 6, layout: parsed })).toThrow(
      "stale",
    );
    expect(() => prepareSidebarSave(dataset(), { expectedRevision: 7, layout: parsed })).toThrow(
      "stale",
    );
  });
  it("rejects malformed structure, duplicate identities, and unsafe routes without normalizing away data", () => {
    for (const raw of [
      null,
      [],
      { sections: {} },
      { sections: [{ id: "x", pages: ["/characters", "/characters"] }] },
      {
        sections: [
          { id: "x", pages: [] },
          { id: "x", pages: [] },
        ],
      },
      { sections: [{ id: "x", pages: [], role: "player" }] },
      { sections: [{ id: "x", pages: ["//other.test"] }] },
      { sections: [{ id: "x", pages: ["javascript:bad"] }] },
      { sections: [{ id: "x", pages: ["/future/page"] }] },
      { sections: [{ id: "x", pages: ["/dm"] }] },
    ]) {
      expect(() => parseSidebarLayout(raw)).toThrow("invalid");
    }
  });
});
