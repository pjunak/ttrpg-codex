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
