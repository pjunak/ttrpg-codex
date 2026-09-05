import { describe, expect, it } from "vitest";
import { CampaignPartyEditError, campaignPartyIdentity, prepareCampaignPartySave, type CampaignPartySaveDetail } from "../src/app/campaign-party.js";
import { editorFieldsFor, editorOptionsFor } from "../src/app/campaign-record-editor.js";
import { projectDashboard } from "../src/app/campaign-projection.js";
import type { CampaignCollection, CampaignCollectionName, CampaignDataset } from "../src/core/campaign-data.js";

const draft: CampaignPartySaveDetail = { expectedRevision: 3, name: " Night Owls ", icon: " 🦉 ", color: "#9CF", textColor: "#102030" };
const saved = { name: "Old name", icon: "🛡", badge: "⚔", color: "#123456", textColor: "#ffffff", extension: { keep: [1, 2] } };
const setting = (value: unknown = saved, revision = 3) => [{ key: "playerParty", revision, value }];

describe("shared party identity", () => {
  it("reads original defaults, custom badges, and safely normalizes color inputs", () => {
    expect(campaignPartyIdentity(dataset())).toEqual({ name: "Our Party", icon: "🛡", badge: "🛡", color: "#f5f0e4", textColor: "#1a1410" });
    expect(campaignPartyIdentity(dataset(setting({ name: " Night Owls ", icon: "🦉", badge: "⚔", color: "#9CF", textColor: "red; display:none" })))).toEqual({
      name: "Night Owls", icon: "🦉", badge: "⚔", color: "#99ccff", textColor: "#1a1410",
    });
    expect(campaignPartyIdentity(dataset(setting([])))).toEqual(campaignPartyIdentity(dataset()));
  });

  it("updates only the party record, retains extensions, and mirrors the original icon/badge contract", () => {
    const campaign = dataset([...setting(), { key: "branding", revision: 8, value: { title: "Codex" } }]);
    const original = structuredClone(campaign);
    expect(prepareCampaignPartySave(campaign, draft)).toEqual({ operation: "put", collection: "settings", key: "playerParty", expectedRevision: 3,
      value: { name: "Night Owls", icon: "🦉", badge: "🦉", color: "#99ccff", textColor: "#102030", extension: { keep: [1, 2] } },
    });
    expect(campaign).toEqual(original);
  });

  it("creates absent settings with revision zero and restores original empty-name/icon defaults", () => {
    expect(prepareCampaignPartySave(dataset(), { ...draft, expectedRevision: 0, name: " ", icon: "" })).toMatchObject({ value: { name: "Our Party", icon: "🛡", badge: "🛡" } });
  });

  it("rejects concurrent edits and deleted settings without advancing the draft revision", () => {
    for (const campaign of [dataset(setting(saved, 4)), dataset()]) {
      expect(() => prepareCampaignPartySave(campaign, draft)).toThrow(new CampaignPartyEditError("stale"));
    }
  });

  it("rejects malformed stored objects and invalid input instead of replacing them with defaults", () => {
    for (const malformed of [null, [], "bad"]) expect(() => prepareCampaignPartySave(dataset(setting(malformed)), draft)).toThrow(new CampaignPartyEditError("invalid"));
    for (const change of [{ expectedRevision: -1 }, { expectedRevision: 1.5 }, { name: "n".repeat(201) }, { icon: "i".repeat(101) },
      { name: "two\nlines" }, { color: "red" }, { textColor: "#fff;background:url(https://example.invalid)" }]) {
      expect(() => prepareCampaignPartySave(dataset(setting()), { ...draft, ...change })).toThrow(new CampaignPartyEditError("invalid"));
    }
  });

  it("uses one identity for party portraits, inherited glows, faction choices, and pet ownership", () => {
    const campaign = dataset(setting({ ...saved, name: "Night Owls", badge: "🦉" }));
    const model = projectDashboard(campaign);
    expect(model.partyIdentity.name).toBe("Night Owls");
    expect(model.party.map(member => member.key)).toEqual(["scout"]);
    expect(model.party[0]).toMatchObject({ icon: "🦉", partyIdentity: { color: "#123456", textColor: "#ffffff" }, attitudes: [{ id: "party", label: "Night Owls", color: "#123456", strength: 1 }] });
    const faction = editorFieldsFor("characters").find(field => field.key === "faction")!;
    expect(editorOptionsFor(campaign, faction, "scout").filter(option => option.value === "party")).toEqual([{ value: "party", label: "🦉 Night Owls" }]);
    const owner = editorFieldsFor("pets").find(field => field.kind === "owner")!;
    expect(editorOptionsFor(campaign, owner, "pet")).toContainEqual({ value: "party:", label: "🦉 Night Owls" });
  });
});

function dataset(settings: CampaignCollection["records"] = []): CampaignDataset {
  const names: readonly CampaignCollectionName[] = ["characters", "relationships", "locations", "events", "mysteries", "factions", "deletedDefaults", "pantheon", "artifacts", "settings", "historicalEvents", "campaign", "pets"];
  return { contractVersion: "campaign-data.v1", collections: names.map(name => ({ name,
    shape: ["factions", "deletedDefaults", "settings", "campaign"].includes(name) ? "keyed" as const : "list" as const,
    materialized: true, revision: 1, records: name === "settings" ? settings : name === "characters" ? [
      { key: "scout", revision: 1, value: { id: "scout", name: "Scout", faction: "party", icon: "Ignored" } },
      { key: "guard", revision: 1, value: { id: "guard", name: "Guard", faction: "neutral" } },
    ] : [],
  })) };
}
