import { describe, expect, it } from "vitest";
import type { ActiveBrowserContribution } from "../src/addons/browser-sdk.js";
import { acceptsRecordContribution, recordContributionContext } from "../src/app/record-contributions.js";

const contribution = (surface: "slot" | "editor-panel", config: Record<string, unknown>, resources = ["locations"]): ActiveBrowserContribution => ({
  addonId: "fixture", generationId: "generation", signal: new AbortController().signal,
  permissions: [{ id: "core.data.read", resources }],
  descriptor: { id: "panel", surface, label: "Panel", roles: ["dm"], requires: [], order: 0, config }, binding: { kind: "element", tag: "fixture-panel" },
});
describe("record contribution contract", () => {
  it("requires an exact destination and collection grant", () => {
    const config = { contractVersion: 1, slot: "map:pin:panel" };
    expect(acceptsRecordContribution(contribution("slot", config), "map", "locations")).toBe(true);
    expect(acceptsRecordContribution(contribution("slot", config, []), "map", "locations")).toBe(false);
    expect(acceptsRecordContribution(contribution("slot", config), "map", "characters")).toBe(false);
    expect(acceptsRecordContribution(contribution("slot", { ...config, extra: true }), "map", "locations")).toBe(false);
    expect(acceptsRecordContribution(contribution("editor-panel", { contractVersion: 1, collection: "locations" }), "editor", "locations")).toBe(true);
    expect(acceptsRecordContribution(contribution("editor-panel", { contractVersion: 1, collection: "settings" }, ["settings"]), "editor", "settings")).toBe(false);
  });
  it("projects bounded identity only, without record bodies or hidden fields", () => {
    const record = { key: "harbor", revision: 7, value: { name: "Harbor", body: "secret prose", dmNotes: "secret", nested: { token: "secret" } } };
    expect(recordContributionContext(record, "locations", "map", "cs")).toEqual({ contractVersion: "record-context.v1", locale: "cs", readOnly: true,
      record: { collection: "locations", id: "harbor", revision: 7, label: "Harbor", href: "#/locations/harbor" } });
    expect(recordContributionContext({ ...record, value: { name: "x".repeat(500) } }, "locations", "editor", "en").record.label).toHaveLength(200);
  });
});
