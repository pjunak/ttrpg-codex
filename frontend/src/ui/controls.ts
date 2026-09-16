import { enhanceCombobox } from "./combobox.js";
import { enhanceField } from "./fields.js";
import { containDialogTab, navigateTabs } from "./focus.js";
import { setAttribute, type ControlHandle } from "./messages.js";
import { enhanceSearch } from "./search.js";

export type { UIControlsHandle } from "../../../contracts/addons/v3/ui-controls.js";
import type { UIControlsHandle } from "../../../contracts/addons/v3/ui-controls.js";
export interface UIControlsOptions { readonly signal?: AbortSignal }

/** ui.controls.v1. Enhances only the caller-owned tree; never reads application state. */
export function enhanceControls(root: HTMLElement, options: UIControlsOptions = {}): UIControlsHandle {
  options.signal?.throwIfAborted();
  if (root.hasAttribute("data-codex-ui")) throw new Error("This UI root is already enhanced.");
  root.setAttribute("data-codex-ui", "v1");
  const scope = new AbortController(), signal = scope.signal, controls = new Map<HTMLElement, ControlHandle>();
  const nativeClasses = new Set<HTMLElement>(), fieldControls = new Map<HTMLElement, Element>();
  const fieldControl = (field: HTMLElement): Element | null => field.querySelector('input:not([data-ui-generated]), select, textarea');
  let disposed = false;
  const owned = (node: Element): boolean => node.closest("[data-codex-ui]") === root && !node.closest("[data-ui-skip]");
  let lastFocus: { node: HTMLElement; key: string } | undefined;
  root.addEventListener("focusin", event => { const node = event.target as HTMLElement, key = node.closest<HTMLElement>("[data-ui-key]")?.dataset["uiKey"]; lastFocus = key && owned(node) ? { node, key } : undefined; }, { signal });
  const observer = new MutationObserver(() => refresh());
  const observe = (): void => observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["disabled", "required", "multiple", "selected", "label", "title", "lang", "type", "readonly", "min", "max", "step", "minlength", "maxlength", "pattern", "for", "aria-label", "aria-labelledby", "aria-describedby", "aria-invalid", "data-ui", "data-ui-field", "data-ui-skip", "data-ui-keywords", "data-ui-options-state", "data-ui-options-message", "data-ui-state", "hidden"] });
  const refresh = (): void => {
    if (disposed) return;
    observer.disconnect();
    try {
      for (const [node, handle] of controls) {
        const replacedField = fieldControls.has(node) && (!node.hasAttribute("data-ui-field") || fieldControls.get(node) !== fieldControl(node));
        const retiredSelect = node instanceof HTMLSelectElement && (node.multiple || node.dataset["ui"] !== "combobox");
        const retiredSearch = node instanceof HTMLInputElement && (node.type !== "search" || node.dataset["ui"] !== "search");
        if (!root.contains(node) || !owned(node) || replacedField || retiredSelect || retiredSearch) { handle.dispose(); controls.delete(node); fieldControls.delete(node); }
      }
      for (const node of nativeClasses) if (!root.contains(node) || !owned(node)) { node.classList.remove("ui-button", "ui-control"); nativeClasses.delete(node); }
      for (const field of root.querySelectorAll<HTMLElement>("[data-ui-field]")) {
        const control = fieldControl(field);
        if (owned(field) && !controls.has(field) && control) { fieldControls.set(field, control); controls.set(field, enhanceField(field)); }
      }
      for (const node of root.querySelectorAll<HTMLElement>('input, select, textarea, button')) {
        if (!owned(node) || node.closest('[data-ui-generated]')) continue;
        node.classList.add(node instanceof HTMLButtonElement ? "ui-button" : "ui-control"); nativeClasses.add(node);
        if (node instanceof HTMLSelectElement && node.dataset["ui"] === "combobox" && !node.multiple && !controls.has(node)) controls.set(node, enhanceCombobox(node));
        if (node instanceof HTMLInputElement && node.type === "search" && node.dataset["ui"] === "search" && !controls.has(node)) controls.set(node, enhanceSearch(node));
      }
      for (const node of root.querySelectorAll<HTMLElement>("[data-ui-state]")) if (owned(node)) {
        const state = node.dataset["uiState"];
        setAttribute(node, "role", state === "error" ? "alert" : state === "empty" || state === "unavailable" ? "note" : "status");
        setAttribute(node, "aria-atomic", "true");
      }
      for (const handle of controls.values()) handle.refresh();
      if (lastFocus && !lastFocus.node.isConnected && root.isConnected && root.ownerDocument.activeElement === root.ownerDocument.body) {
        const field = [...root.querySelectorAll<HTMLElement>("[data-ui-key]")].find(node => node.dataset["uiKey"] === lastFocus!.key);
        field?.querySelector<HTMLElement>('input:not([hidden]):not(:disabled), select:not([hidden]):not(:disabled), textarea:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
      }
    } finally { if (!disposed) observe(); }
  };
  let firstInvalid: HTMLElement | undefined, invalidTimer: ReturnType<typeof setTimeout> | undefined;
  root.addEventListener("invalid", event => {
    const target = event.target as HTMLElement;
    if (!owned(target)) return;
    if (!firstInvalid) {
      firstInvalid = target;
      invalidTimer = setTimeout(() => {
        invalidTimer = undefined;
        const source = firstInvalid; firstInvalid = undefined;
        if (!disposed && source?.matches('select[data-ui="combobox"]'))
          source.nextElementSibling?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus();
      });
    }
    if (firstInvalid.matches('select[data-ui="combobox"]')) event.preventDefault();
  }, { signal, capture: true });
  root.addEventListener("keydown", event => {
    const target = event.target as Element;
    if (!owned(target)) return;
    const list = target.closest<HTMLElement>('[role="tablist"][data-ui-tabs]'); if (list) navigateTabs(list, event);
    const dialog = target.closest<HTMLDialogElement>('dialog[data-ui-dialog]'); if (dialog) containDialogTab(dialog, event);
  }, { signal });
  root.addEventListener("click", event => {
    const button = (event.target as Element).closest("button");
    if (button && owned(button) && (button.getAttribute("aria-busy") === "true" || button.getAttribute("aria-disabled") === "true")) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true, signal });
  const dispose = (): void => {
    if (disposed) return; disposed = true; clearTimeout(invalidTimer); observer.disconnect(); scope.abort(); options.signal?.removeEventListener("abort", dispose);
    // Restore the native select before restoring field descriptions.
    for (const handle of [...controls.values()].reverse()) handle.dispose(); controls.clear(); fieldControls.clear();
    for (const node of nativeClasses) node.classList.remove("ui-button", "ui-control"); nativeClasses.clear(); root.removeAttribute("data-codex-ui");
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  refresh(); return Object.freeze({ refresh, dispose });
}
