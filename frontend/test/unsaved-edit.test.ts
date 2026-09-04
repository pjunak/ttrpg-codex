import { describe, expect, it, vi } from "vitest";
import {
  confirmDiscardUnsavedEdit,
  protectUnsavedEditBeforeUnload,
  unsavedEditMessage,
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
    const clean = { preventDefault: vi.fn(), returnValue: "original" } as unknown as BeforeUnloadEvent;
    const dirty = { preventDefault: vi.fn(), returnValue: "original" } as unknown as BeforeUnloadEvent;
    protectUnsavedEditBeforeUnload(false, clean);
    protectUnsavedEditBeforeUnload(true, dirty);
    expect(clean.preventDefault).not.toHaveBeenCalled();
    expect(clean.returnValue).toBe("original");
    expect(dirty.preventDefault).toHaveBeenCalledOnce();
    expect(dirty.returnValue).toBe("");
  });
});
