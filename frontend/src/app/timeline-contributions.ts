import type { ActiveBrowserContribution } from "../addons/browser-sdk.js";

const timelineSlots = ["timeline:toolbar", "timeline:column:header", "timeline:column:footer", "timeline:card:extra"] as const;
export type TimelineSlot = typeof timelineSlots[number];
export interface TimelineSlotContext {
  readonly slot: TimelineSlot;
  readonly editing: boolean;
  readonly sitting: number | null;
  readonly events: readonly { readonly key: string; readonly revision: number }[];
}
export function isTimelineSlot(active: ActiveBrowserContribution, slot?: TimelineSlot): boolean {
  const config = active.descriptor.config;
  return active.descriptor.surface === "slot" && Object.keys(config).length === 2 && config["contractVersion"] === 1 &&
    timelineSlots.some(value => value === config["slot"] && (slot === undefined || slot === value));
}

/** Slot context identifies current UI records without passing campaign bodies or authority. */
export function timelineSlotContext(context: TimelineSlotContext, active: ActiveBrowserContribution) {
  const permitted = active.permissions?.some(grant => grant.id === "core.data.read" && grant.resources.includes("events"));
  const events = []; let bytes = 0;
  if (permitted) for (const event of context.events) {
    bytes += new TextEncoder().encode(JSON.stringify(event)).length;
    if (events.length === 256 || bytes > 24_000) break;
    events.push({ key: event.key, revision: event.revision });
  }
  return { contractVersion: "timeline-context.v1", slot: context.slot, editing: context.editing, sitting: context.sitting,
    events, truncated: permitted === true && events.length < context.events.length };
}
