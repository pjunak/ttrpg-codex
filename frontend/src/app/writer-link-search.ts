import { uiText } from "./ui-localization.js";

export interface WriterLinkChoice {
  readonly label: string;
  /** `kind:id` (or a campaign `collection:key`); empty links by label alone. */
  readonly hint: string;
  readonly description?: string;
}
export interface WriterLinkGroup {
  readonly label: string;
  readonly choices: readonly WriterLinkChoice[];
  readonly failed?: boolean;
}

/** Bubbles from a writer to the view that owns the add-on wiki providers. */
export const linkSearchEvent = "codex-wiki-search";
export interface LinkSearchRequest {
  readonly query: string;
  readonly signal: AbortSignal;
  respond(groups: readonly WriterLinkGroup[]): void;
}

/** Asks the surrounding view to search add-on wiki providers; no listener means no providers. */
export function requestAddonLinks(
  from: HTMLElement,
  query: string,
  signal: AbortSignal,
): Promise<readonly WriterLinkGroup[]> {
  return new Promise((resolve) => {
    const event = new CustomEvent<LinkSearchRequest>(linkSearchEvent, {
      bubbles: true,
      composed: true,
      cancelable: true,
      detail: { query, signal, respond: resolve },
    });
    if (from.dispatchEvent(event)) resolve([]);
  });
}

/** A wiki label must survive `[[label|hint]]`. */
export function validLinkLabel(label: string): boolean {
  return /^[^[\]|\n]{1,200}$/u.test(label);
}

export interface LinkSearchOptions {
  readonly query: string;
  /** The words being linked, shown in the title. */
  readonly subject?: string;
  readonly search: (query: string, signal: AbortSignal) => Promise<readonly WriterLinkGroup[]>;
  readonly choose: (choice: WriterLinkChoice) => void;
  /** Called when the picker closes without a choice. */
  readonly dismissed?: () => void;
  readonly returnFocus?: HTMLElement | null;
}
export interface LinkSearchHandle {
  close(): void;
}

let sequence = 0;
let current: LinkSearchHandle | undefined;

/**
 * Open the link picker below a point (or above it when there is no room). One
 * picker is open at a time. Focus stays in its search field; arrows move
 * through the results, Enter links, Escape closes.
 */
export function openLinkSearch(
  document: Document,
  anchor: { readonly x: number; readonly top: number; readonly bottom: number },
  options: LinkSearchOptions,
): LinkSearchHandle {
  current?.close();
  const window = document.defaultView!;
  const scope = new AbortController(),
    id = `writer-link-search-${++sequence}`;
  let request: AbortController | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    closed = false,
    rows: { element: HTMLElement; choice: WriterLinkChoice }[] = [],
    activeIndex = -1;

  const panel = document.createElement("div");
  panel.className = "ui-menu writer-link-search";
  panel.popover = "manual";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", uiText("Link to…"));
  const title = document.createElement("p");
  title.className = "ui-menu-title";
  title.textContent = options.subject
    ? uiText("Link “{text}” to", { text: options.subject })
    : uiText("Link to…");
  const field = document.createElement("input");
  field.type = "search";
  field.className = "ui-control ui-menu-filter";
  field.value = options.query;
  field.setAttribute("role", "combobox");
  field.setAttribute("aria-label", uiText("Search rules and records"));
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-expanded", "true");
  field.setAttribute("aria-controls", `${id}-list`);
  field.autocomplete = "off";
  const list = document.createElement("div");
  list.className = "ui-menu-list";
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", uiText("Matches"));
  const status = document.createElement("p");
  status.className = "ui-help ui-menu-empty";
  status.setAttribute("role", "status");
  panel.append(title, field, list, status);

  const close = (chosen = false): void => {
    if (closed) return;
    closed = true;
    scope.abort();
    request?.abort();
    clearTimeout(timer);
    if (panel.matches(":popover-open")) panel.hidePopover();
    panel.remove();
    if (current === handle) current = undefined;
    if (!chosen) {
      options.dismissed?.();
      if (options.returnFocus?.isConnected) options.returnFocus.focus({ preventScroll: true });
    }
  };
  const handle: LinkSearchHandle = { close: () => close() };
  current = handle;

  const activate = (index: number): void => {
    rows[activeIndex]?.element.classList.remove("is-active");
    activeIndex = rows.length ? (index + rows.length) % rows.length : -1;
    const row = rows[activeIndex];
    if (!row) {
      field.removeAttribute("aria-activedescendant");
      return;
    }
    row.element.classList.add("is-active");
    field.setAttribute("aria-activedescendant", row.element.id);
    row.element.scrollIntoView({ block: "nearest" });
  };
  const pick = (choice: WriterLinkChoice): void => {
    close(true);
    options.choose(choice);
  };
  const option = (choice: WriterLinkChoice, detail = ""): HTMLElement => {
    const row = document.createElement("div");
    row.className = "ui-menu-item";
    row.id = `${id}-option-${rows.length}`;
    row.setAttribute("role", "option");
    const icon = document.createElement("span");
    icon.className = "ui-menu-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = choice.hint ? "⌕" : "✎";
    const label = document.createElement("span");
    label.className = "ui-menu-label";
    label.textContent = choice.label;
    row.append(icon, label);
    if (detail) {
      const extra = document.createElement("span");
      extra.className = "ui-menu-detail";
      extra.textContent = detail;
      row.append(extra);
    }
    if (choice.description) row.title = choice.description;
    const index = rows.length;
    rows.push({ element: row, choice });
    row.addEventListener("pointermove", () => activeIndex !== index && activate(index), {
      signal: scope.signal,
    });
    row.addEventListener("pointerdown", (event) => event.preventDefault(), {
      signal: scope.signal,
    });
    row.addEventListener("click", () => pick(choice), { signal: scope.signal });
    return row;
  };
  const render = (groups: readonly WriterLinkGroup[], loading: boolean): void => {
    const query = field.value.trim();
    list.replaceChildren();
    rows = [];
    activeIndex = -1;
    let failed = false;
    for (const group of groups) {
      failed ||= group.failed === true;
      if (!group.choices.length) continue;
      const section = document.createElement("div");
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group.label);
      const heading = document.createElement("p");
      heading.className = "writer-link-group";
      heading.setAttribute("aria-hidden", "true");
      heading.textContent = group.label;
      section.append(heading, ...group.choices.map((choice) => option(choice, group.label)));
      list.append(section);
    }
    if (validLinkLabel(query)) {
      const typed = document.createElement("div");
      typed.setAttribute("role", "group");
      typed.append(option({ label: query, hint: "" }, uiText("Link as typed")));
      list.append(typed);
    }
    status.textContent = loading
      ? uiText("Searching…")
      : failed
        ? uiText("Some sources could not be searched.")
        : rows.length <= (validLinkLabel(query) ? 1 : 0) && query
          ? uiText("No matches.")
          : query
            ? ""
            : uiText("Type to search rules and records.");
    status.hidden = status.textContent === "";
    activate(0);
  };
  const search = (): void => {
    request?.abort();
    clearTimeout(timer);
    const query = field.value.trim().slice(0, 200);
    if (!query) {
      render([], false);
      return;
    }
    render([], true);
    const controller = new AbortController();
    request = controller;
    timer = setTimeout(() => {
      void options
        .search(query, controller.signal)
        .catch(() => [{ label: "", choices: [], failed: true }])
        .then((groups) => {
          if (!controller.signal.aborted && !closed) {
            render(groups, false);
            place();
          }
        });
    }, 150);
  };
  const place = (): void => {
    const viewport = window.visualViewport,
      left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0,
      width = viewport?.width ?? window.innerWidth,
      height = viewport?.height ?? window.innerHeight,
      box = panel.getBoundingClientRect();
    const x = Math.max(left + 8, Math.min(anchor.x, left + width - box.width - 8));
    const below = anchor.bottom + 6,
      above = anchor.top - 6 - box.height;
    const y =
      below + box.height <= top + height - 8 || above < top + 8
        ? Math.max(top + 8, Math.min(below, top + height - box.height - 8))
        : above;
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  };

  field.addEventListener("input", search, { signal: scope.signal });
  field.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        activate(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const row = rows[activeIndex];
        if (row) pick(row.choice);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") close();
    },
    { signal: scope.signal },
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!(event.target instanceof Node && panel.contains(event.target))) close();
    },
    { capture: true, signal: scope.signal },
  );
  window.addEventListener("resize", () => close(), { signal: scope.signal });
  window.addEventListener("blur", () => close(), { signal: scope.signal });

  // A modal dialog makes everything outside it inert, so open inside the writer's dialog.
  (options.returnFocus?.closest("dialog[open]") ?? document.body).append(panel);
  panel.showPopover();
  search();
  place();
  field.focus({ preventScroll: true });
  field.select();
  return handle;
}
