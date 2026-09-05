import { describe, expect, it } from "vitest";
import { campaignBranding, prepareBrandingSave } from "../src/app/campaign-branding.js";
import { allSidebarRoutes, campaignSidebar, defaultSidebarLayout, moveSidebarPage, parseSidebarLayout, prepareSidebarSave, sidebarPage } from "../src/app/campaign-sidebar.js";
import type { CampaignCollection, CampaignDataset } from "../src/core/campaign-data.js";
import { addonSidebarMode, prepareAddonSidebarSave } from "../src/app/campaign-sidebar.js";

const logo = `/api/media/b_${"1".repeat(32)}`;
const branding = { title: "Asurai", subtitle: "World atlas", logoUrl: logo, extension: { keep: true } };
const layout = { extension: { keep: true }, sections: [
  { id: "svet", label: "My world", icon: "🦉", collapsible: true, defaultOpen: false, role: "", pages: ["/postavy", "/mista"], extension: { color: "gold" } },
  { id: "private", label: "DM", role: "dm", pages: ["/dm", "/future/page"] },
], hidden: ["/mapa/svet"] };
const dataset = (records: CampaignCollection["records"] = []): CampaignDataset => ({ contractVersion: "campaign-data.v1", collections: [
  { name: "settings", shape: "keyed", materialized: true, revision: 1, records },
] });

describe("campaign branding", () => {
  it("uses original defaults and rejects untrusted logo URLs in presentation", () => {
    expect(campaignBranding()).toEqual({ title: "TTRPG Codex", subtitle: "Wiki & World Atlas", logoUrl: "" });
    expect(campaignBranding(dataset([{ key: "branding", revision: 1, value: { ...branding, logoUrl: "https://other.test/pixel" } }])).logoUrl).toBe("");
    expect(campaignBranding(dataset([{ key: "branding", revision: 1, value: branding }]))).toEqual({ title: "Asurai", subtitle: "World atlas", logoUrl: logo });
  });
  it("preserves extensions across text/logo replacement and reset", () => {
    const campaign = dataset([{ key: "branding", revision: 4, value: branding }]);
    const before = structuredClone(campaign);
    expect(prepareBrandingSave(campaign, { expectedRevision: 4, title: " Tiamat ", subtitle: " Atlas ", logoUrl: "" })).toMatchObject({
      collection: "settings", key: "branding", expectedRevision: 4, value: { title: "Tiamat", subtitle: "Atlas", logoUrl: "", extension: { keep: true } },
    });
    expect(campaign).toEqual(before);
  });
  it("rejects stale/deleted revisions, malformed objects, and invalid input", () => {
    const detail = { ...branding, expectedRevision: 1 };
    expect(() => prepareBrandingSave(dataset(), detail)).toThrow("stale");
    expect(() => prepareBrandingSave(dataset([{ key: "branding", revision: 2, value: branding }]), detail)).toThrow("stale");
    expect(() => prepareBrandingSave(dataset([{ key: "branding", revision: 1, value: [] }]), detail)).toThrow("invalid");
    for (const patch of [{ logoUrl: "javascript:alert(1)" }, { title: "a".repeat(201) }, { subtitle: "bad\ntext" }, { expectedRevision: -1 }]) {
      expect(() => prepareBrandingSave(dataset(), { ...detail, expectedRevision: 0, ...patch })).toThrow("invalid");
    }
  });
});

describe("curated sidebar layout", () => {
  it("keeps add-on pages opt-in and preserves inactive entries in visibility updates", () => {
    const key = "test-addon:/addons/test-addon/tools";
    const campaign = dataset([{ key: "addonSidebarVisibility", revision: 4, value: { "retired:/old/path": "dm", [key]: "dm" } }]);
    expect(addonSidebarMode(undefined, key)).toBe("hidden");
    expect(addonSidebarMode(campaign, key)).toBe("dm");
    expect(prepareAddonSidebarSave(campaign, { expectedRevision: 4, modes: { [key]: "everyone" } })).toMatchObject({
      expectedRevision: 4, value: { "retired:/old/path": "dm", [key]: "everyone" },
    });
    expect(() => prepareAddonSidebarSave(campaign, { expectedRevision: 3, modes: { [key]: "hidden" } })).toThrow("stale");
    expect(() => prepareAddonSidebarSave(campaign, { expectedRevision: 4, modes: { [key]: "admin" as never } })).toThrow("invalid");
  });
  it("uses the restored shell defaults only when the record is absent", () => {
    expect(campaignSidebar(dataset())).toEqual(defaultSidebarLayout());
    const curated = campaignSidebar(dataset([{ key: "sidebarLayout", revision: 2, value: layout }]));
    expect(curated.sections.map(section => section.id)).toEqual(["svet", "private"]);
    expect(curated.sections[0]).toMatchObject({ label: "My world", defaultOpen: false, pages: ["/postavy", "/mista"], extension: { color: "gold" } });
    expect(curated.hidden).toContain("/party");
    expect(curated.hidden).toContain("/mapa/svet");
  });
  it("resolves preserved route aliases through the implemented registry only", () => {
    expect(sidebarPage("/postavy")?.route).toBe("/characters");
    expect(sidebarPage("/mapa/svet")?.route).toBe("/map/world");
    expect(sidebarPage("/mapa/palac")).toBeUndefined();
    expect(sidebarPage("https://other.test")).toBeUndefined();
    expect(sidebarPage("/dm")).toBeUndefined();
  });
  it("moves and hides pages while preserving extension fields and unavailable routes", () => {
    const parsed = parseSidebarLayout(layout), before = structuredClone(parsed);
    const moved = moveSidebarPage(parsed, "/postavy", "private", 1);
    expect(moved.sections[0]?.pages).toEqual(["/mista"]);
    expect(moved.sections[1]?.pages).toEqual(["/dm", "/postavy", "/future/page"]);
    expect(moved.sections[0]?.["extension"]).toEqual({ color: "gold" });
    const hidden = moveSidebarPage(moved, "/postavy", "__hidden__", 0);
    expect(hidden.hidden[0]).toBe("/postavy");
    expect(new Set(allSidebarRoutes(hidden)).size).toBe(allSidebarRoutes(hidden).length);
    expect(parsed).toEqual(before);
    expect(moveSidebarPage(parsed, "/postavy", "absent", 0)).toBe(parsed);
  });
  it("merges the reviewed layout with an optimistic revision and keeps unknown data", () => {
    const campaign = dataset([{ key: "sidebarLayout", revision: 7, value: layout }]);
    const parsed = campaignSidebar(campaign);
    expect(prepareSidebarSave(campaign, { expectedRevision: 7, layout: moveSidebarPage(parsed, "/mista", "__hidden__", 0) })).toMatchObject({
      collection: "settings", key: "sidebarLayout", expectedRevision: 7, value: { extension: { keep: true } },
    });
    expect(() => prepareSidebarSave(campaign, { expectedRevision: 6, layout: parsed })).toThrow("stale");
    expect(() => prepareSidebarSave(dataset(), { expectedRevision: 7, layout: parsed })).toThrow("stale");
  });
  it("rejects malformed structure, duplicate identities, and unsafe routes without normalizing away data", () => {
    for (const raw of [null, [], { sections: {} }, { sections: [{ id: "x", pages: ["/characters", "/postavy"] }] },
      { sections: [{ id: "x", pages: [] }, { id: "x", pages: [] }] }, { sections: [{ id: "x", pages: [], role: "player" }] },
      { sections: [{ id: "x", pages: ["//other.test"] }] }, { sections: [{ id: "x", pages: ["javascript:bad"] }] }]) {
      expect(() => parseSidebarLayout(raw)).toThrow("invalid");
    }
  });
});
