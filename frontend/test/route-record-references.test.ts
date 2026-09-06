import { expect, it } from "vitest";
import type { ActiveBrowserContribution } from "../src/addons/browser-sdk.js";
import type { CampaignDataset } from "../src/core/campaign-data.js";
import { routeRecordReferences } from "../src/app/route-record-references.js";

const active: ActiveBrowserContribution = { addonId: "fixture", generationId: "a".repeat(64), signal: new AbortController().signal,
  descriptor: { id: "route", surface: "route", label: "Route", roles: ["dm"], requires: [], order: 0, config: { path: "route" } },
  binding: { kind: "element", tag: "fixture-route" }, permissions: [{ id: "core.data.read", resources: ["events"] }] };
const campaign: CampaignDataset = { contractVersion: "campaign-data.v1", collections: [
  { name: "events", shape: "list", materialized: true, revision: 1, records: [{ key: "a/b", revision: 1, value: { name: "Arrival", body: "Do not share bodies" } }] },
  { name: "characters", shape: "list", materialized: true, revision: 1, records: [{ key: "hero", revision: 1, value: { name: "No character grant" } }] },
] };

it("shares only approved visible labels and host-built record links", () => {
  expect(routeRecordReferences(campaign, active)).toEqual({ ready: true, truncated: false,
    records: [{ collection: "events", id: "a/b", label: "Arrival", href: "#/events/a%2Fb" }] });
  expect(routeRecordReferences(campaign, { ...active, permissions: [] })).toBeUndefined();
  expect(routeRecordReferences(campaign, { ...active, permissions: [{ id: "core.data.write", resources: ["events"] }] })).toBeUndefined();
});
it("distinguishes a missing campaign snapshot from an empty visible collection", () => {
  expect(routeRecordReferences(undefined, active)).toEqual({ ready: false, records: [], truncated: false });
  expect(routeRecordReferences({ ...campaign, collections: [] }, active)).toEqual({ ready: true, records: [], truncated: false });
});
it("bounds label, count and serialized size and reports omitted records", () => {
  const large: CampaignDataset = { ...campaign, collections: [{ ...campaign.collections[0]!, records: Array.from({ length: 2000 }, (_, i) => ({ key: String(i), revision: 1, value: { name: "é".repeat(500) } })) }] };
  const result = routeRecordReferences(large, active)!;
  expect(result.truncated).toBe(true); expect(result.records.length).toBeLessThanOrEqual(1000);
  expect(result.records[0]!.label.length).toBe(200);
  const message = { protocol: "codex-isolated-frame.v1", type: "context", host: { contractVersion: "addon-route-context.v1", locale: "en",
    query: [["search", '"'.repeat(4096)]], recordReferences: result } };
  expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThan(64 * 1024);
});
