import { describe, expect, it, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { isMarkdownDraft, markdownDraftTarget, type MarkdownDraft, type MarkdownDraftContext, type MarkdownDraftStore } from "../src/core/markdown-drafts.js";
import { MarkdownDraftController } from "../src/app/markdown-draft-controller.js";

const context: MarkdownDraftContext = { role: "dm", collection: "characters", record: "ryn", field: "description", revision: 2, baseValue: "Saved" };
const draft = (id: string, value: string): MarkdownDraft => ({ id, value, target: markdownDraftTarget(context), baseRevision: 1, baseValue: "Older", savedAt: 1234 });
function fixture() {
  const records = new Map<string, MarkdownDraft>();
  const store: MarkdownDraftStore = {
    async list(target) { return [...records.values()].filter(draft => draft.target === target); },
    async put(draft) { records.set(draft.id, draft); },
    async remove(drafts) { for (const draft of drafts) if (records.get(draft.id)?.value === draft.value) records.delete(draft.id); },
  };
  const host: ReactiveControllerHost = { addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) };
  const controller = new MarkdownDraftController(host, store);
  controller.configure(context);
  return { controller, store, records };
}

describe("Markdown recovery ownership", () => {
  it("separates role, record, field, and unsaved entries and validates bounded stored data", () => {
    const scopes = [context, { ...context, role: "player" as const }, { ...context, record: null }, { ...context, record: "new" }, { ...context, field: "history" }];
    expect(new Set(scopes.map(markdownDraftTarget)).size).toBe(scopes.length);
    expect(isMarkdownDraft(draft("a", "Text"))).toBe(true);
    expect(isMarkdownDraft({ ...draft("a", "Text"), baseRevision: -1 })).toBe(false);
    expect(isMarkdownDraft(draft("a", "x".repeat(200_001)))).toBe(false);
  });

  it("serializes writes and confirmed save cleanup without resurrecting the pending copy", async () => {
    const { controller, records } = fixture();
    controller.changed("First"); controller.flush();
    controller.changed("Second"); controller.flush();
    controller.saved("Second");
    await vi.waitFor(() => expect(controller.status).toBe("idle"));
    expect(records.size).toBe(0);
    controller.flush();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(records.size).toBe(0);
  });

  it("cleans an older own copy when Save is faster than the debounce", async () => {
    const { controller, records } = fixture();
    controller.changed("First"); controller.flush();
    await vi.waitFor(() => expect(controller.status).toBe("saved"));
    controller.changed("Final"); controller.saved("Final");
    await vi.waitFor(() => expect(records.size).toBe(0));
  });

  it("checkpoints continuous typing without waiting for a pause", async () => {
    vi.useFakeTimers();
    try {
      const { controller, records } = fixture();
      for (let index = 0; index < 10; index++) {
        controller.changed(`Text ${index}`);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect([...records.values()].map(draft => draft.value)).toEqual(["Text 9"]);
      controller.changed("Finished");
      await vi.advanceTimersByTimeAsync(250);
      expect([...records.values()].map(draft => draft.value)).toEqual(["Finished"]);
      controller.saved("Finished");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(records.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("cleans an in-flight copy when editing returns to the saved text", async () => {
    const { controller, records } = fixture();
    controller.changed("Temporary"); controller.flush();
    controller.changed(context.baseValue); controller.flush();
    await vi.waitFor(() => expect(controller.status).toBe("idle"));
    expect(records.size).toBe(0);
  });

  it("keeps other tabs' drafts when accepting and saving one recovered copy", async () => {
    const { controller, records } = fixture();
    const first = draft("first", "First tab"), second = draft("second", "Second tab");
    records.set(first.id, first); records.set(second.id, second);
    await controller.refresh();
    expect(controller.candidates).toHaveLength(2);
    expect(await controller.recover(first)).toBe("First tab");
    controller.flush(); controller.saved("First tab");
    await vi.waitFor(() => expect(records.size).toBe(1));
    expect(records.get(second.id)).toEqual(second);
  });

  it("preserves currently authored text before loading a different recovery copy", async () => {
    const { controller, records } = fixture();
    controller.changed("Current unsaved work");
    expect(await controller.recover(draft("other", "Recovered work"))).toBe("Recovered work");
    controller.flush();
    await vi.waitFor(() => expect([...records.values()].map(draft => draft.value)).toContain("Recovered work"));
    expect([...records.values()].map(draft => draft.value)).toContain("Current unsaved work");
  });

  it("does not replace unsaved work if the protective copy cannot be stored", async () => {
    const { controller, store } = fixture();
    store.put = async () => { throw new Error("Quota exceeded"); };
    controller.changed("Current unsaved work");
    expect(await controller.recover(draft("other", "Recovered work"))).toBeUndefined();
    expect(controller.status).toBe("unavailable");
    controller.discardCurrent();
  });

  it("explicit discard cannot be undone by a pending write or page-hide flush", async () => {
    const { controller, records } = fixture();
    controller.changed("Discard me"); controller.flush(); controller.discardCurrent(); controller.flush();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(records.size).toBe(0);
  });
});
