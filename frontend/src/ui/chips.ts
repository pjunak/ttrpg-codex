import { folded, messages, onFormReset, setAttribute, type ControlHandle } from "./messages.js";
import { highlightRow, labelWords, placePopup, trackPopup } from "./popup.js";

let sequence = 0;
const shownLimit = 100;

function labelText(select: HTMLSelectElement): string | null {
  const label = select.labels?.[0];
  return label ? labelWords(label) || null : null;
}

/**
 * Enhance a native multiple select into removable chips plus a searchable
 * "add" field. The select keeps its options, selection, form value, reset and
 * events; the chips only mirror it and set option.selected on the user's behalf.
 */
export function enhanceChips(select: HTMLSelectElement): ControlHandle {
  const document = select.ownerDocument,
    window = document.defaultView!,
    scope = new AbortController(),
    signal = scope.signal;
  const id = `codex-chips-${++sequence}`,
    wrapper = document.createElement("div"),
    chips = document.createElement("ul"),
    input = document.createElement("input"),
    popup = document.createElement("div"),
    list = document.createElement("div"),
    status = document.createElement("p");
  const labels = [...(select.labels ?? [])].map((label) => ({
    label,
    forValue: label.getAttribute("for"),
  }));
  const hidden = select.hidden,
    tabIndex = select.getAttribute("tabindex"),
    ariaHidden = select.getAttribute("aria-hidden");
  wrapper.className = "ui-chips";
  wrapper.dataset["uiGenerated"] = "";
  chips.className = "ui-chip-list";
  input.className = "ui-control ui-chip-input";
  input.id = `${id}-input`;
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", id);
  input.setAttribute("aria-expanded", "false");
  popup.className = "ui-popup";
  popup.popover = "manual";
  popup.hidden = true;
  list.id = id;
  list.setAttribute("role", "listbox");
  status.className = "ui-help";
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  popup.append(list, status);
  wrapper.append(chips, input, popup);
  select.after(wrapper);
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  for (const { label } of labels) label.htmlFor = input.id;
  let open = false,
    disposed = false,
    composing = false,
    active = -1,
    shown: HTMLOptionElement[] = [],
    openScope: AbortController | undefined;

  const blocked = (): boolean => select.matches(":disabled");
  const usable = (option: HTMLOptionElement): boolean =>
    !option.disabled &&
    !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
  const notify = (): void => {
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const position = (): void => {
    if (!open) return;
    const rect = input.getBoundingClientRect();
    placePopup(window, rect, popup, { width: rect.width, maxHeight: 320 });
  };
  const close = (): void => {
    open = false;
    active = -1;
    openScope?.abort();
    openScope = undefined;
    if (popup.matches(":popover-open")) popup.hidePopover();
    popup.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const highlight = (index: number): void => {
    active = index;
    highlightRow(list, input, index);
  };
  const renderList = (): void => {
    const query = folded(input.value.trim());
    const candidates = [...select.options].filter(
      (option) =>
        !option.selected &&
        usable(option) &&
        (query === "" ||
          folded(`${option.label} ${option.dataset["uiKeywords"] ?? ""}`).includes(query)),
    );
    shown = candidates.slice(0, shownLimit);
    list.replaceChildren(
      ...shown.map((option, index) => {
        const row = document.createElement("div");
        row.id = `${id}-option-${index}`;
        row.className = "ui-option";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        row.textContent = option.label;
        if (option.title) {
          const detail = document.createElement("small");
          detail.textContent = option.title;
          row.append(detail);
        }
        row.addEventListener("pointerdown", (event) => event.preventDefault());
        row.addEventListener("click", () => add(option));
        return row;
      }),
    );
    status.textContent = shown.length
      ? candidates.length > shownLimit
        ? messages(input).narrow
        : ""
      : messages(input).empty;
    status.hidden = status.textContent === "";
    // Nothing is highlighted until the user types or navigates, so Enter never adds by surprise.
    highlight(active >= 0 && shown.length ? Math.min(active, shown.length - 1) : -1);
    position();
  };
  const show = (): void => {
    if (blocked()) return;
    if (!open) {
      open = true;
      active = -1;
      openScope = new AbortController();
      popup.hidden = false;
      if (!popup.matches(":popover-open")) popup.showPopover();
      input.setAttribute("aria-expanded", "true");
      trackPopup(wrapper, position, close, openScope.signal);
    }
    renderList();
  };
  const add = (option: HTMLOptionElement): void => {
    if (blocked() || !usable(option) || !select.contains(option) || option.selected) return;
    option.selected = true;
    input.value = "";
    active = -1;
    notify();
    paint();
    if (open) renderList();
    input.focus();
  };
  const remove = (option: HTMLOptionElement): void => {
    if (blocked() || !select.contains(option)) return;
    option.selected = false;
    notify();
    paint();
    if (open) renderList();
    input.focus();
  };
  const paint = (): void => {
    const disabled = blocked();
    const text = messages(input);
    chips.replaceChildren(
      ...[...select.selectedOptions].map((option) => {
        const item = document.createElement("li");
        item.className = "ui-chip";
        const label = document.createElement("span");
        label.textContent = option.label;
        item.append(label);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ui-chip-remove";
        button.textContent = "×";
        button.disabled = disabled;
        button.setAttribute("aria-label", text.remove.replace("{0}", option.label));
        button.title = button.getAttribute("aria-label")!;
        button.addEventListener("click", () => remove(option));
        item.append(button);
        return item;
      }),
    );
    chips.hidden = select.selectedOptions.length === 0;
    input.disabled = disabled;
    input.placeholder = text.add;
    for (const name of ["aria-describedby", "aria-required", "aria-invalid"])
      setAttribute(input, name, select.getAttribute(name));
    // The visible field carries the select's accessible name.
    setAttribute(input, "aria-label", select.getAttribute("aria-label") ?? labelText(select));
    if (disabled && open) close();
  };

  input.addEventListener("focus", () => show(), { signal });
  input.addEventListener("click", () => show(), { signal });
  input.addEventListener(
    "compositionstart",
    () => {
      composing = true;
    },
    { signal },
  );
  input.addEventListener(
    "compositionend",
    () => {
      composing = false;
      show();
    },
    { signal },
  );
  input.addEventListener(
    "input",
    (event) => {
      event.stopPropagation();
      if (!(event as InputEvent).isComposing && !composing) {
        active = 0;
        show();
      }
    },
    { signal },
  );
  // The generated field is not a form value; only the select reports changes.
  input.addEventListener("change", (event) => event.stopPropagation(), { signal });
  input.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") close();
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) show();
        const step = event.key === "ArrowDown" ? 1 : -1;
        if (shown.length)
          highlight(
            active < 0
              ? step > 0
                ? 0
                : shown.length - 1
              : (active + step + shown.length) % shown.length,
          );
      } else if (event.key === "Enter" && open && shown[active]) {
        event.preventDefault();
        event.stopPropagation();
        add(shown[active]!);
      } else if (event.key === "Backspace" && input.value === "") {
        const last = [...select.selectedOptions].at(-1);
        if (last) {
          event.preventDefault();
          remove(last);
        }
      }
    },
    { signal },
  );
  wrapper.addEventListener(
    "focusout",
    (event) => {
      if (!wrapper.contains(event.relatedTarget as Node | null)) {
        close();
        input.value = "";
      }
    },
    { signal },
  );
  wrapper.addEventListener(
    "click",
    (event) => {
      if (event.target === wrapper || event.target === chips) input.focus();
    },
    { signal },
  );
  select.addEventListener("change", paint, { signal });
  onFormReset(select.form, signal, paint);
  paint();
  return {
    refresh: () => {
      if (disposed) return;
      paint();
      if (open) renderList();
    },
    dispose: () => {
      disposed = true;
      close();
      scope.abort();
      wrapper.remove();
      select.hidden = hidden;
      if (tabIndex === null) select.removeAttribute("tabindex");
      else select.setAttribute("tabindex", tabIndex);
      if (ariaHidden === null) select.removeAttribute("aria-hidden");
      else select.setAttribute("aria-hidden", ariaHidden);
      for (const { label, forValue } of labels)
        if (forValue === null) label.removeAttribute("for");
        else label.setAttribute("for", forValue);
    },
  };
}
