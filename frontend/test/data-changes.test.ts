import { expect, it, vi } from "vitest";
import { BrowserAddonDataChanges } from "../src/addons/data-changes.js";
import { BrowserAddonDataClient } from "../src/addons/data-client.js";
import { parseAddonDataChange, SharedEventStream } from "../src/core/event-stream.js";

const publication = { sequence: 9, topic: "addon-data-changed", resourceId: "dm-tools/collection/planning_items", revision: "17", occurredAt: "2026-09-08T12:00:00Z", metadata: {} };
const message = (value: unknown = publication, id = "9") => new MessageEvent("addon-data-changed", { data: JSON.stringify(value), lastEventId: id });

it("delivers validated add-on invalidations through the shared stream without data or revisions", () => {
  const source = new EventTarget(), onRefresh = vi.fn(), onBoundaryError = vi.fn();
  const stream = new SharedEventStream(() => ({ addEventListener: source.addEventListener.bind(source), close: () => undefined }));
  stream.open({ onRefresh, onBoundaryError }); source.dispatchEvent(message());
  expect(onRefresh).toHaveBeenLastCalledWith({ cause: "addon-data-changed", cursor: 9, addonId: "dm-tools", kind: "collection", dataId: "planning_items" });
  source.dispatchEvent(message({ ...publication, metadata: { records: ["private"] } }));
  expect(onBoundaryError).toHaveBeenCalledOnce(); expect(onRefresh).toHaveBeenCalledOnce();
  stream.close(); source.dispatchEvent(message()); expect(onRefresh).toHaveBeenCalledOnce();
});

it.each([
  { resourceId: "dm-tools/collection/planning_items/private" }, { resourceId: "dm-tools/private/data" },
  { resourceId: "../collection/data" }, { resourceId: `dm-tools/collection/${"x".repeat(101)}` },
  { revision: "0" }, { revision: "9007199254740992" }, { occurredAt: "today" }, { metadata: null }, { secret: true }, { sequence: 8 },
])("rejects malformed add-on change %j", patch => { expect(() => parseAddonDataChange(message({ ...publication, ...patch }))).toThrow(); });

it("scopes subscriptions to the package and generation and isolates listener failures", () => {
  const diagnostic = vi.fn(), changes = new BrowserAddonDataChanges(diagnostic);
  const generation = new AbortController(), contribution = new AbortController(), seen = vi.fn(), sibling = vi.fn();
  const api = new BrowserAddonDataClient({ addonId: "dm-tools", generationId: "a".repeat(64), csrfToken: "b".repeat(32), signal: generation.signal, subscribe: changes.scoped("dm-tools", generation.signal) }).api();
  const disposeBroken = api.subscribe!(() => { throw new Error("listener failed"); });
  api.subscribe!(seen, { signal: contribution.signal }); changes.scoped("sibling", generation.signal)(sibling);
  changes.handleEvent(parseAddonDataChange(message()));
  expect(seen).toHaveBeenLastCalledWith({ reason: "changed", kind: "collection", dataId: "planning_items" });
  expect(Object.isFrozen(seen.mock.calls[0]![0])).toBe(true); expect(diagnostic).toHaveBeenCalledOnce(); expect(sibling).not.toHaveBeenCalled();
  disposeBroken(); disposeBroken(); contribution.abort();
  for (const cause of ["hello", "reset", "campaign-restored"] as const) changes.handleEvent({ cause, cursor: 10 });
  expect(seen).toHaveBeenCalledOnce(); expect(sibling).toHaveBeenCalledTimes(3);
  generation.abort(); changes.handleEvent({ cause: "reset", cursor: 11 }); expect(sibling).toHaveBeenCalledTimes(3);
  expect(() => api.subscribe!(seen)).toThrow();
});
