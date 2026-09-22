import { expect, it } from "vitest";
import { BrowserContributionEdits, parseContributionEditState } from "../src/addons/edit-state.js";
import type { ActiveBrowserContribution } from "../src/addons/browser-sdk.js";

function active(signal: AbortSignal, id = "planner"): ActiveBrowserContribution {
  return { addonId: "dm-tools", generationId: "a".repeat(64), signal,
    descriptor: { id, surface: "route", label: id, order: 0, roles: ["dm"], requires: [], config: { path: id } },
    binding: { kind: "element", tag: "dm-planner" } };
}

it("aggregates separate mounted views and cannot clear another view's draft", () => {
  const registry = new BrowserContributionEdits(), controller = new AbortController();
  const first = registry.open(active(controller.signal)), second = registry.open(active(controller.signal));
  first.handle.set({ dirty: true, saving: false });
  second.handle.set({ dirty: false, saving: false });
  expect(registry.state()).toEqual({ dirty: true, saving: false });
  first.dispose(); first.handle.set({ dirty: true, saving: true });
  expect(registry.state()).toEqual({ dirty: false, saving: false });
  second.handle.set({ dirty: true, saving: true }); controller.abort();
  expect(registry.state()).toEqual({ dirty: false, saving: false });
  second.handle.set({ dirty: true, saving: true });
  expect(registry.state()).toEqual({ dirty: false, saving: false });
});

it("only skips retained route drafts on query navigation and always protects saves", () => {
  const registry = new BrowserContributionEdits(), controller = new AbortController();
  const planner = registry.open(active(controller.signal));
  planner.handle.set({ dirty: true, saving: false });
  expect(registry.state(() => true).dirty).toBe(true);
  planner.handle.set({ dirty: true, saving: false, retainOnQueryChange: true });
  expect(registry.state(() => true).dirty).toBe(false);
  expect(registry.state(() => false).dirty).toBe(true);
  planner.handle.set({ dirty: false, saving: true, retainOnQueryChange: true });
  expect(registry.state(() => true).saving).toBe(true);
  controller.abort();
});

it("accepts flags only, copies caller state, and ignores disposed handles", () => {
  for (const state of [null, {}, { dirty: true }, { dirty: true, saving: "yes" }, { dirty: true, saving: false, body: "draft" }, { dirty: true, saving: false, retainOnQueryChange: 1 }]) {
    expect(() => parseContributionEditState(state)).toThrow();
  }
  const registry = new BrowserContributionEdits(), controller = new AbortController();
  const view = registry.open(active(controller.signal)), state = { dirty: true, saving: false };
  view.handle.set(state); state.dirty = false;
  expect(registry.state().dirty).toBe(true);
  view.dispose(); view.dispose();
  expect(registry.state().dirty).toBe(false);
  controller.abort();
});

it("hands off detached input once across restart and keeps the guard during the gap", () => {
  const registry = new BrowserContributionEdits(), controller = new AbortController(), slot = Symbol();
  const first = registry.open(active(controller.signal), slot);
  const snapshot = { version: 1, inputs: { notes: "Pending" }, operationId: "original", revision: 7 };
  first.handle.set({ dirty: true, saving: true }); first.handle.handoff!.checkpoint(snapshot);
  snapshot.inputs.notes = "Later mutation";
  controller.abort("reload");
  expect(registry.state()).toEqual({ dirty: true, saving: false });
  first.handle.handoff!.checkpoint({ notes: "Stale" }); first.dispose();
  expect(first.handle.handoff!.take()).toBeUndefined();
  const second = registry.open(active(new AbortController().signal), slot);
  const restored = second.handle.handoff!.take() as typeof snapshot;
  expect(restored).toEqual({ version: 1, inputs: { notes: "Pending" }, operationId: "original", revision: 7 });
  restored.inputs.notes = "Detached";
  expect(second.handle.handoff!.take()).toBeUndefined();
  expect(registry.state()).toEqual({ dirty: true, saving: false });
  second.handle.set({ dirty: false, saving: false }); second.handle.handoff!.checkpoint(undefined);
  expect(registry.state().dirty).toBe(false);
});

it("does not transfer snapshots through another slot, normal removal, disable or authority loss", () => {
  for (const reason of [undefined, "disabled", "uninstalled", "authority-changed", "activation-failed"]) {
    const registry = new BrowserContributionEdits(), controller = new AbortController(), slot = Symbol();
    const first = registry.open(active(controller.signal), slot);
    first.handle.set({ dirty: true, saving: false }); first.handle.handoff!.checkpoint({ draft: true });
    if (reason === undefined) first.dispose(); else controller.abort(reason);
    expect(registry.pending(slot)).toBe(false);
    expect(registry.open(active(new AbortController().signal), slot).handle.handoff!.take()).toBeUndefined();
  }
  const registry = new BrowserContributionEdits(), controller = new AbortController(), slot = Symbol();
  const first = registry.open(active(controller.signal), slot);
  first.handle.set({ dirty: true, saving: false }); first.handle.handoff!.checkpoint({ draft: true });
  controller.abort("updated");
  expect(registry.open(active(new AbortController().signal), Symbol()).handle.handoff!.take()).toBeUndefined();
  expect(registry.state().dirty).toBe(true);
  registry.forget(slot); expect(registry.state().dirty).toBe(false);
});

it("rejects executable, lossy, circular and excessive checkpoints without replacing the last valid one", () => {
  const registry = new BrowserContributionEdits(), controller = new AbortController(), slot = Symbol();
  const view = registry.open(active(controller.signal), slot);
  view.handle.set({ dirty: true, saving: false }); view.handle.handoff!.checkpoint({ safe: true });
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const value of [() => 1, { run: () => 1 }, { missing: undefined }, { n: NaN }, Symbol(), new Date(),
    cycle, { get data() { throw new Error("getter ran"); } }, Array(2), { text: "x".repeat(2 * 1024 * 1024) }]) {
    expect(() => view.handle.handoff!.checkpoint(value)).toThrow("bounded plain JSON");
  }
  controller.abort("reload");
  expect(registry.open(active(new AbortController().signal), slot).handle.handoff!.take()).toEqual({ safe: true });
});

it("retains input after a failed replacement mount but clears it when the graph removes the owner", () => {
  const registry = new BrowserContributionEdits(), controller = new AbortController(), slot = Symbol();
  const first = registry.open(active(controller.signal), slot);
  first.handle.set({ dirty: true, saving: false }); first.handle.handoff!.checkpoint({ draft: "Keep" });
  controller.abort("reload");
  const second = registry.open(active(new AbortController().signal), slot);
  expect(second.handle.handoff!.take()).toEqual({ draft: "Keep" });
  second.dispose("mount-failed");
  expect(registry.pending(slot)).toBe(true);
  registry.retain(new Set(["dm-tools:planner"]));
  expect(registry.state().dirty).toBe(true);
  const stale = registry.open(active(controller.signal), slot);
  expect(stale.handle.handoff!.take()).toBeUndefined();
  expect(registry.pending(slot)).toBe(true);
  registry.retain(new Set(["other:planner"]));
  expect(registry.state().dirty).toBe(false);
});

it("keeps an unclaimed handoff guarded when a replacement only understands edit flags", () => {
  const registry = new BrowserContributionEdits(), controller = new AbortController(), slot = Symbol();
  const first = registry.open(active(controller.signal), slot);
  first.handle.set({ dirty: true, saving: false }); first.handle.handoff!.checkpoint({ draft: "Keep through rollback" });
  controller.abort("updated");
  const replacementController = new AbortController(), second = registry.open(active(replacementController.signal), slot);
  second.handle.set({ dirty: false, saving: false });
  expect(registry.state().dirty).toBe(true);
  expect(registry.pending(slot)).toBe(true);
  replacementController.abort("updated");
  const third = registry.open(active(new AbortController().signal), slot);
  expect(third.handle.handoff!.take()).toEqual({ draft: "Keep through rollback" });
  third.handle.handoff!.checkpoint(undefined); third.handle.set({ dirty: false, saving: false });
  expect(registry.state().dirty).toBe(false);
  expect(registry.pending(slot)).toBe(false);
});
