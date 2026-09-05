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
