/**
 * Places a list popup under its field, or above when there is clearly more
 * room there, inside the visual viewport so a phone keyboard or pinch zoom
 * never hides it.
 */
export function placePopup(
  window: Window,
  anchor: DOMRect,
  popup: HTMLElement,
  { width: anchorWidth, maxHeight }: { readonly width: number; readonly maxHeight: number },
): void {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0,
    top = viewport?.offsetTop ?? 0,
    width = viewport?.width ?? window.innerWidth,
    height = viewport?.height ?? window.innerHeight;
  const below = top + height - anchor.bottom - 8,
    above = anchor.top - top - 8,
    upward = below < Math.min(240, above);
  const available = Math.max(40, upward ? above : below),
    popupWidth = Math.min(Math.max(anchorWidth, 240), width - 16);
  popup.style.width = `${popupWidth}px`;
  popup.style.maxHeight = `${Math.min(maxHeight, available)}px`;
  popup.style.left = `${Math.max(left + 8, Math.min(anchor.left, left + width - popupWidth - 8))}px`;
  popup.style.top = `${upward ? Math.max(top + 8, anchor.top - Math.min(popup.scrollHeight, maxHeight, available) - 4) : anchor.bottom + 4}px`;
}

/**
 * Keeps an open popup placed while the page, the window or the visual
 * viewport moves, and closes it on a press outside its owner. Listeners end
 * with the signal.
 */
export function trackPopup(
  owner: HTMLElement,
  position: () => void,
  close: () => void,
  signal: AbortSignal,
): void {
  const document = owner.ownerDocument,
    window = document.defaultView!;
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!owner.contains(event.target as Node)) close();
    },
    { signal },
  );
  window.addEventListener("resize", position, { signal });
  document.addEventListener("scroll", position, { capture: true, signal });
  window.visualViewport?.addEventListener("resize", position, { signal });
  window.visualViewport?.addEventListener("scroll", position, { signal });
}

/**
 * One listbox row for a native option. The row shows only the label and, for
 * duplicate labels, a short identifier; the option's description is announced
 * from a hidden node and shown in the shared details area instead.
 */
export function optionRow(
  document: Document,
  id: string,
  option: HTMLOptionElement,
  identifier = "",
): HTMLElement {
  const row = document.createElement("div"),
    described: string[] = [];
  row.id = id;
  row.className = "ui-option";
  row.setAttribute("role", "option");
  row.setAttribute("aria-label", option.label);
  row.append(document.createTextNode(option.label));
  if (identifier) {
    const small = document.createElement("small");
    small.id = `${id}-identifier`;
    small.textContent = identifier;
    row.append(small);
    described.push(small.id);
  }
  if (option.title) {
    const description = document.createElement("span");
    description.id = `${id}-description`;
    description.hidden = true;
    description.textContent = option.title;
    row.append(description);
    described.push(description.id);
  }
  if (described.length) row.setAttribute("aria-describedby", described.join(" "));
  row.addEventListener("pointerdown", (event) => event.preventDefault());
  return row;
}

export interface OptionDetails {
  readonly element: HTMLElement;
  /** Describes `subject`, or shows the hint while any shown option has a description. */
  update(shown: readonly HTMLOptionElement[], subject: HTMLOptionElement | undefined): void;
}

/**
 * A fixed area under a listbox that describes the highlighted option, so long
 * descriptions never push the other options out of view. Rows carry their own
 * descriptions for assistive technology; this area is visual only.
 */
export function optionDetails(document: Document, hint: () => string): OptionDetails {
  const element = document.createElement("div"),
    title = document.createElement("strong"),
    text = document.createElement("p");
  element.className = "ui-option-details";
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
  element.append(title, text);
  return {
    element,
    update(shown, subject) {
      element.hidden = !shown.some((option) => option.title);
      if (element.hidden) return;
      title.textContent = subject?.label ?? "";
      title.hidden = subject === undefined;
      text.textContent = subject ? subject.title : hint();
      element.classList.toggle("ui-option-hint", subject === undefined);
      element.scrollTop = 0;
    },
  };
}

/** Marks one listbox row active for an input that owns the list. */
export function highlightRow(list: HTMLElement, input: HTMLElement, index: number): void {
  [...list.children].forEach((row, at) => {
    row.classList.toggle("ui-active", at === index);
    row.setAttribute("aria-selected", String(at === index));
  });
  const row = list.children[index];
  if (row) {
    input.setAttribute("aria-activedescendant", row.id);
    row.scrollIntoView({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
}

/** A label's own words, without the controls, hints and errors inside it. */
export function labelWords(label: HTMLLabelElement): string {
  const copy = label.cloneNode(true) as HTMLElement;
  for (const child of copy.querySelectorAll(
    "input, select, textarea, button, small, ul, [data-ui-generated], [data-ui-help], [data-ui-error]",
  ))
    child.remove();
  return copy.textContent?.trim() ?? "";
}
