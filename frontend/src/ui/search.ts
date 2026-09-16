import { messages, onFormReset, type ControlHandle } from "./messages.js";

/** Only settled user input publishes a query; IME fragments never filter the view. */
export function enhanceSearch(input: HTMLInputElement): ControlHandle {
  const scope = new AbortController(), signal = scope.signal;
  const clear = input.ownerDocument.createElement("button"); clear.type = "button"; clear.className = "ui-button ui-search-clear"; clear.textContent = "×";
  const field = input.parentElement?.matches("[data-ui-field]") && !input.closest("label") ? input.parentElement : null;
  field?.classList.add("ui-search-field");
  clear.dataset["uiGenerated"] = ""; (input.closest("label") ?? input).after(clear);
  let composing = false, last = input.value, disposed = false;
  const paint = (): void => { clear.setAttribute("aria-label", messages(input).clear); clear.title = messages(input).clear; clear.disabled = input.matches(":disabled") || input.readOnly; clear.hidden = input.value === ""; };
  const refresh = (): void => { if (!composing) last = input.value; paint(); };
  const publish = (): void => {
    paint(); if (disposed || composing || input.value === last) return;
    last = input.value; input.dispatchEvent(new CustomEvent("codex-query", { detail: { value: last }, bubbles: true, composed: true }));
  };
  input.addEventListener("compositionstart", () => { composing = true; }, { signal });
  input.addEventListener("compositionend", () => { composing = false; queueMicrotask(publish); }, { signal });
  input.addEventListener("input", event => { if (!(event as InputEvent).isComposing) publish(); }, { signal });
  clear.addEventListener("click", () => { input.value = ""; input.focus(); input.dispatchEvent(new Event("input", { bubbles: true })); }, { signal });
  onFormReset(input.form, signal, () => { last = input.value; refresh(); });
  refresh(); return { refresh, dispose: () => { disposed = true; scope.abort(); clear.remove(); field?.classList.remove("ui-search-field"); } };
}
