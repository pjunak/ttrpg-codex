import { describe, expect, it, vi } from "vitest";
import {
  confirmDiscardUnsavedEdit,
  EditStateTracker,
  protectUnsavedEditBeforeUnload,
  reportEditState,
  unsavedEditMessage,
  type EditState,
} from "../src/app/unsaved-edit.js";

describe("unsaved campaign edits", () => {
  it("navigates without prompting when the form is clean", () => {
    const confirm = vi.fn(() => false);
    expect(confirmDiscardUnsavedEdit(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("requires an explicit choice before discarding dirty work", () => {
    const keepEditing = vi.fn(() => false);
    const discard = vi.fn(() => true);
    expect(confirmDiscardUnsavedEdit(true, keepEditing)).toBe(false);
    expect(confirmDiscardUnsavedEdit(true, discard)).toBe(true);
    expect(discard).toHaveBeenCalledWith(unsavedEditMessage);
  });

  it("marks only dirty forms as unsafe to unload", () => {
    const clean = {
      preventDefault: vi.fn(),
      returnValue: "original",
    } as unknown as BeforeUnloadEvent;
    const dirty = {
      preventDefault: vi.fn(),
      returnValue: "original",
    } as unknown as BeforeUnloadEvent;
    protectUnsavedEditBeforeUnload(false, clean);
    protectUnsavedEditBeforeUnload(true, dirty);
    // oxlint-disable-next-line typescript/unbound-method -- This matcher inspects the spy without invoking it.
    expect(clean.preventDefault).not.toHaveBeenCalled();
    expect(clean.returnValue).toBe("original");
    // oxlint-disable-next-line typescript/unbound-method -- This matcher inspects the spy without invoking it.
    expect(dirty.preventDefault).toHaveBeenCalledOnce();
    expect(dirty.returnValue).toBe("");
  });
});

describe("edit state tracking", () => {
  const editors = (tracker: EditStateTracker, count: number): EventTarget[] =>
    Array.from({ length: count }, () => {
      const editor = new EventTarget();
      editor.addEventListener("campaign-edit-dirty", (event) =>
        tracker.record(event as CustomEvent<EditState>),
      );
      return editor;
    });

  it("keeps each editor's unsaved state until that editor clears it", () => {
    const tracker = new EditStateTracker();
    const [first, second] = editors(tracker, 2) as [EventTarget, EventTarget];
    reportEditState(first, { dirty: true });
    reportEditState(second, { dirty: true });
    reportEditState(first, { dirty: false });
    expect(tracker.dirty).toBe(true);
    reportEditState(second, { dirty: false, saving: true });
    expect([tracker.dirty, tracker.saving]).toEqual([false, true]);
  });

  it("settles only the editor that requested a save", () => {
    const tracker = new EditStateTracker();
    const [saved, other] = editors(tracker, 2) as [EventTarget, EventTarget];
    let settle = (): void => undefined;
    saved.addEventListener("save", (event) => {
      settle = tracker.settler(event);
    });
    reportEditState(saved, { dirty: true });
    reportEditState(other, { dirty: true });
    saved.dispatchEvent(new Event("save"));
    settle();
    expect(tracker.dirty).toBe(true);
    reportEditState(other, { dirty: false });
    expect(tracker.dirty).toBe(false);
  });
});
