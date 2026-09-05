import { describe, expect, it } from "vitest";
import type { ActiveBrowserContribution } from "../src/addons/browser-sdk.js";
import { isTimelineSlot, timelineSlotContext, type TimelineSlotContext } from "../src/app/timeline-contributions.js";

const active: ActiveBrowserContribution = { addonId: "fixture", generationId: "a".repeat(64), signal: new AbortController().signal,
  binding: { kind: "element", tag: "fixture-widget" }, permissions: [{ id: "core.data.read", resources: ["events"] }],
  descriptor: { id: "extra", surface: "slot", label: "Extra", roles: ["dm"], requires: [], order: 1, config: { contractVersion: 1, slot: "timeline:card:extra" } } };
const context: TimelineSlotContext = { slot: "timeline:card:extra", editing: true, sitting: 2, events: [{ key: "arrival", revision: 3 }] };
describe("timeline slot context", () => {
  it("matches only the declared version and supported slot", () => {
    expect(isTimelineSlot(active, "timeline:card:extra")).toBe(true);
    expect(isTimelineSlot(active, "timeline:toolbar")).toBe(false);
    for (const config of [{}, { slot: "timeline:card:extra" }, { contractVersion: 2, slot: "timeline:card:extra" }, { contractVersion: 1, slot: "timeline:card:extra", html: "bad" }]) {
      expect(isTimelineSlot({ ...active, descriptor: { ...active.descriptor, config } })).toBe(false);
    }
  });
  it("supplies identities only with approved event read grants, never copies record bodies", () => {
    const source = { ...context, events: [{ key: "arrival", revision: 3, value: { secret: "Never forward" } }] };
    expect(timelineSlotContext(source, active)).toEqual({ contractVersion: "timeline-context.v1", ...context, truncated: false });
    expect(timelineSlotContext(context, { ...active, permissions: [] }).events).toEqual([]);
    expect(timelineSlotContext(context, { ...active, permissions: [{ id: "core.data.read", resources: ["characters"] }] }).events).toEqual([]);
  });
  it("bounds context by count and UTF-8 bytes while reporting truncation", () => {
    const events = Array.from({ length: 500 }, (_, i) => ({ key: String(i), revision: 1 }));
    expect(timelineSlotContext({ ...context, events }, active)).toMatchObject({ truncated: true, events: events.slice(0, 256) });
    const large = timelineSlotContext({ ...context, events: events.map(event => ({ ...event, key: "é".repeat(500) })) }, active);
    expect(large.truncated).toBe(true); expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeLessThan(25_000);
  });
});
