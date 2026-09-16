import { folded, messages, onFormReset, setAttribute, type ControlHandle } from "./messages.js";

let sequence = 0;

/** Enhance a native single select: its value, form association and events remain authoritative. */
export function enhanceCombobox(select: HTMLSelectElement): ControlHandle {
  const document = select.ownerDocument, window = document.defaultView!, scope = new AbortController(), signal = scope.signal;
  const id = `codex-options-${++sequence}`, wrapper = document.createElement("div"), input = document.createElement("input"), toggle = document.createElement("button");
  const popup = document.createElement("div"), list = document.createElement("div"), status = document.createElement("p"), error = document.createElement("small");
  const labels = [...select.labels ?? []].map(label => ({ label, forValue: label.getAttribute("for") }));
  const hidden = select.hidden, tabIndex = select.getAttribute("tabindex"), ariaHidden = select.getAttribute("aria-hidden");
  wrapper.className = "ui-combobox"; wrapper.dataset["uiGenerated"] = "";
  input.className = "ui-control"; input.id = `${id}-input`; input.type = "text"; input.autocomplete = "off"; input.spellcheck = false;
  input.dataset["uiGenerated"] = "";
  input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-controls", id); input.setAttribute("aria-expanded", "false");
  toggle.className = "ui-button ui-combo-toggle"; toggle.type = "button"; toggle.tabIndex = -1; toggle.textContent = "▾";
  popup.className = "ui-popup"; popup.popover = "manual"; popup.hidden = true; popup.dataset["uiGenerated"] = "";
  list.id = id; list.setAttribute("role", "listbox");
  status.className = "ui-help"; status.setAttribute("role", "status"); status.setAttribute("aria-atomic", "true");
  error.id = `${id}-error`; error.className = "ui-error"; error.hidden = true; error.setAttribute("role", "alert");
  popup.append(list, status); wrapper.append(input, toggle, error, popup); select.after(wrapper);
  // Keep the real select successful for FormData/required/reset; invalid focus is redirected below.
  select.hidden = true; select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
  for (const { label } of labels) label.htmlFor = input.id;
  let open = false, disposed = false, composing = false, query = "", active = -1, shown: HTMLOptionElement[] = [], openScope: AbortController | undefined;
  const blocked = (): boolean => select.matches(":disabled") || ["loading", "error"].includes(select.dataset["uiOptionsState"] ?? "");
  const selectedLabel = (): string => select.selectedOptions[0]?.label ?? "";
  const position = (): void => {
    if (!open) return;
    const rect = input.getBoundingClientRect(), viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0, width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
    const below = top + height - rect.bottom - 8, above = rect.top - top - 8, upward = below < Math.min(240, above);
    const available = Math.max(40, upward ? above : below), popupWidth = Math.min(Math.max(rect.width + toggle.offsetWidth, 240), width - 16);
    popup.style.width = `${popupWidth}px`; popup.style.maxHeight = `${Math.min(360, available)}px`;
    popup.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - popupWidth - 8))}px`;
    popup.style.top = `${upward ? Math.max(top + 8, rect.top - Math.min(popup.scrollHeight, 360, available) - 4) : rect.bottom + 4}px`;
  };
  const close = (): void => {
    open = false; active = -1; query = ""; openScope?.abort(); openScope = undefined;
    if (popup.matches(":popover-open")) popup.hidePopover(); popup.hidden = true;
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); input.value = selectedLabel();
  };
  const highlight = (index: number): void => {
    active = index;
    [...list.children].forEach((row, at) => { row.classList.toggle("ui-active", at === active); row.setAttribute("aria-selected", String(at === active)); });
    const row = list.children[index];
    if (row) { input.setAttribute("aria-activedescendant", row.id); row.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const disabledOption = (option: HTMLOptionElement): boolean => option.disabled || option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled;
  const choose = (option: HTMLOptionElement): void => {
    if (blocked() || disabledOption(option) || !select.contains(option)) return;
    const changed = select.selectedIndex !== option.index; select.selectedIndex = option.index;
    error.hidden = true; close(); refresh(); input.focus({ preventScroll: true });
    if (changed) { select.dispatchEvent(new Event("input", { bubbles: true })); select.dispatchEvent(new Event("change", { bubbles: true })); }
  };
  const render = (): void => {
    const previous = shown[active], state = select.dataset["uiOptionsState"], all = [...select.options].filter(option => !option.hidden && !option.closest('optgroup[hidden]') && folded(`${option.label} ${option.dataset["uiKeywords"] ?? ""}`).includes(folded(query)));
    const labelCounts = new Map<string, number>(); for (const option of select.options) labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
    shown = blocked() ? [] : all.slice(0, 100); list.replaceChildren();
    shown.forEach((option, index) => {
      const row = document.createElement("div"); row.id = `${id}-${option.index}`; row.className = "ui-option"; row.setAttribute("role", "option");
      row.setAttribute("aria-label", option.label); row.setAttribute("aria-disabled", String(disabledOption(option))); row.append(document.createTextNode(option.label));
      const description = option.title || ((labelCounts.get(option.label) ?? 0) > 1 ? option.value : "");
      if (description) { const detail = document.createElement("small"); detail.textContent = description; detail.id = `${row.id}-description`; row.append(detail); row.setAttribute("aria-describedby", detail.id); }
      row.addEventListener("pointerdown", event => event.preventDefault()); row.addEventListener("click", () => choose(option));
      row.addEventListener("pointermove", () => { if (!disabledOption(option)) highlight(index); }); list.append(row);
    });
    status.textContent = state === "loading" ? messages(select).loading : state === "error" ? select.dataset["uiOptionsMessage"] ?? messages(select).empty : !shown.length ? messages(select).empty : all.length > 100 ? messages(select).narrow : "";
    status.hidden = !status.textContent;
    highlight(previous && !disabledOption(previous) ? shown.indexOf(previous) : -1); position();
  };
  const show = (filter = ""): void => {
    if (select.matches(":disabled") || disposed) return;
    query = filter;
    if (!open) {
      open = true; popup.hidden = false; popup.showPopover(); input.setAttribute("aria-expanded", "true");
      openScope = new AbortController(); const signal = openScope.signal;
      document.addEventListener("pointerdown", event => { if (!wrapper.contains(event.target as Node)) close(); }, { signal });
      window.addEventListener("resize", position, { signal }); document.addEventListener("scroll", position, { capture: true, signal });
      window.visualViewport?.addEventListener("resize", position, { signal }); window.visualViewport?.addEventListener("scroll", position, { signal });
    }
    render();
  };
  const refresh = (): void => {
    if (disposed) return;
    input.disabled = toggle.disabled = select.matches(":disabled"); toggle.setAttribute("aria-label", messages(select).show);
    const labelText = labels.map(({ label }) => {
      const copy = label.cloneNode(true) as HTMLElement;
      for (const child of copy.querySelectorAll('input, select, textarea, button, small, [data-ui-generated], [data-ui-help], [data-ui-error]')) child.remove();
      return copy.textContent?.trim() ?? "";
    }).join(" ");
    setAttribute(input, "aria-label", select.getAttribute("aria-label") ?? (labelText || null));
    setAttribute(input, "aria-labelledby", select.getAttribute("aria-labelledby"));
    setAttribute(list, "aria-label", input.getAttribute("aria-label")); setAttribute(list, "aria-labelledby", input.getAttribute("aria-labelledby"));
    setAttribute(input, "aria-describedby", [select.getAttribute("aria-describedby"), !error.hidden ? error.id : ""].filter(Boolean).join(" ") || null);
    setAttribute(input, "aria-required", select.required ? "true" : null); setAttribute(input, "aria-invalid", !error.hidden ? "true" : select.getAttribute("aria-invalid"));
    setAttribute(input, "aria-busy", select.dataset["uiOptionsState"] === "loading" ? "true" : null);
    if (input.disabled && open) close();
    if (!open) input.value = selectedLabel(); else render();
  };
  input.addEventListener("input", event => { event.stopPropagation(); if (!composing && !(event as InputEvent).isComposing) show(input.value); }, { signal });
  input.addEventListener("change", event => event.stopPropagation(), { signal });
  input.addEventListener("compositionstart", () => { composing = true; }, { signal });
  input.addEventListener("compositionend", () => { composing = false; show(input.value); }, { signal });
  input.addEventListener("click", () => { if (!open) { show(); input.select(); } }, { signal });
  toggle.addEventListener("pointerdown", event => event.preventDefault(), { signal });
  toggle.addEventListener("click", () => { if (open) close(); else show(); input.focus(); }, { signal });
  input.addEventListener("keydown", event => {
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { close(); return; }
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); if (event.altKey && event.key === "ArrowUp") { close(); return; }
      if (!open) show();
      const step = event.key === "ArrowDown" ? 1 : -1; let next = active < 0 ? step > 0 ? 0 : shown.length - 1 : active + step;
      while (next >= 0 && next < shown.length && disabledOption(shown[next]!)) next += step;
      if (next >= 0 && next < shown.length) highlight(next);
    } else if (event.key === "Enter" && open) { event.preventDefault(); event.stopPropagation(); const option = shown[active]; if (option) choose(option); }
  }, { signal });
  wrapper.addEventListener("focusout", event => { if (!wrapper.contains(event.relatedTarget as Node | null)) close(); }, { signal });
  select.addEventListener("change", () => { error.hidden = true; close(); refresh(); }, { signal });
  select.addEventListener("invalid", event => { event.preventDefault(); error.textContent = select.validationMessage || messages(select).required; error.hidden = select.closest("[data-ui-field]") !== null; refresh(); input.focus(); }, { signal });
  onFormReset(select.form, signal, () => { error.hidden = true; close(); refresh(); });
  refresh();
  return { refresh, dispose: () => {
    if (disposed) return; disposed = true; close(); scope.abort(); wrapper.remove(); select.hidden = hidden;
    setAttribute(select, "tabindex", tabIndex); setAttribute(select, "aria-hidden", ariaHidden);
    for (const { label, forValue } of labels) if (label.htmlFor === input.id) setAttribute(label, "for", forValue);
  } };
}
