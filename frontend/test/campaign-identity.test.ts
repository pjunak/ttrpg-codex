import { describe, expect, it } from "vitest";
import { CampaignIdentityEditError, prepareCampaignIdentitySave } from "../src/app/campaign-identity.js";
import type { CampaignDataset } from "../src/core/campaign-data.js";

function dataset(value: unknown = { name: "Asurai", tagline: "The north", extra: { keep: true } }, revision = 3): CampaignDataset {
  return { contractVersion: "campaign-data.v1", collections: [{ name: "campaign", shape: "keyed", materialized: true,
    revision, records: [{ key: "main", revision, value }] }] };
}
const empty: CampaignDataset = { contractVersion: "campaign-data.v1", collections: [
  { name: "campaign", shape: "keyed", materialized: false, revision: 0, records: [] },
] };

describe("campaign identity editing", () => {
  it("merges only the reviewed field and preserves extensions and the other identity field", () => {
    expect(prepareCampaignIdentitySave(dataset(), { expectedRevision: 3, field: "name", value: " Asurai II " })).toEqual({
      operation: "put", collection: "campaign", key: "main", expectedRevision: 3,
      value: { name: "Asurai II", tagline: "The north", extra: { keep: true } },
    });
    expect(prepareCampaignIdentitySave(dataset(), { expectedRevision: 3, field: "tagline", value: "" })).toMatchObject({
      value: { name: "Asurai", tagline: "", extra: { keep: true } },
    });
  });

  it("rejects an intervening update or deletion instead of rebasing the opening revision", () => {
    const detail = { expectedRevision: 2, field: "name" as const, value: "My draft" };
    expect(() => prepareCampaignIdentitySave(dataset(), detail)).toThrow(new CampaignIdentityEditError("stale"));
    expect(() => prepareCampaignIdentitySave(empty, detail))
      .toThrow(new CampaignIdentityEditError("stale"));
  });

  it("can initialize an absent identity without inventing unrelated settings", () => {
    expect(prepareCampaignIdentitySave(empty, {
      expectedRevision: 0, field: "name", value: "Asurai",
    })).toMatchObject({ expectedRevision: 0, value: { name: "Asurai" } });
  });

  it("rejects malformed stored records and invalid input", () => {
    const detail = { expectedRevision: 3, field: "name" as const, value: "Asurai" };
    for (const value of [null, [], "old record"]) {
      expect(() => prepareCampaignIdentitySave(dataset(value), detail)).toThrow(new CampaignIdentityEditError("invalid"));
    }
    for (const change of [{ value: " " }, { value: "a\nb" }, { value: "x".repeat(501) },
      { expectedRevision: -1 }, { expectedRevision: 1.5 }, { field: "extra" as never }]) {
      expect(() => prepareCampaignIdentitySave(dataset(), { ...detail, ...change })).toThrow(new CampaignIdentityEditError("invalid"));
    }
  });
});
