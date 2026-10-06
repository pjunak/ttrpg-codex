import { folded, messages } from "./messages.js";

export interface ContextMenuItem {
  readonly label: string;
  /** Short emoji or symbol shown before the label. */
  readonly icon?: string;
  /** Secondary text shown at the end of the row (a current value or hint). */
  readonly detail?: string;
  /** True, or a reason shown as the row's tooltip. */
  readonly disabled?: boolean | string;
  /** Present for toggles; renders a check mark and menuitemcheckbox semantics. */
  readonly checked?: boolean;
  readonly danger?: boolean;
  /** Draws a divider above this row. */
  readonly separator?: boolean;
  readonly run?: () => void;
  /** A nested menu; a function is evaluated when the submenu opens. */
  readonly children?: readonly ContextMenuItem[] | (() => readonly ContextMenuItem[]);
  /** Long submenus get a filter field. */
  readonly searchable?: boolean;
}

export interface ContextMenuOptions {
  readonly title?: string;
  /** Focus returns here when the menu closes without navigating. */
  readonly returnFocus?: HTMLElement | null;
}

export interface ContextMenuHandle {
  close(): void;
}

let sequence = 0;
let current: ContextMenuHandle | undefined;

/**
 * Open a nested, keyboard-accessible menu at a point. One menu is open at a
 * time; opening another closes the first. The caller supplies plain items and
 * keeps all application authority in their `run` callbacks.
 */
export function openContextMenu(
  document: Document,
  point: { readonly x: number; readonly y: number },
  items: readonly ContextMenuItem[],
  options: ContextMenuOptions = {},
): ContextMenuHandle {
  current?.close();
  const window = document.defaultView!;
  const scope = new AbortController(),
    signal = scope.signal;
  const levels: HTMLElement[] = [];
  let closed = false;

  const close = (restore = true): void => {
    if (closed) return;
    closed = true;
    scope.abort();
    for (const level of levels) {
      if (level.matches(":popover-open")) level.hidePopover();
      level.remove();
    }
    levels.length = 0;
    if (current === handle) current = undefined;
    if (restore && options.returnFocus?.isConnected)
      options.returnFocus.focus({ preventScroll: true });
  };
  const handle: ContextMenuHandle = { close: () => close() };
  current = handle;

  const rows = (menu: HTMLElement): HTMLElement[] =>
    [...menu.querySelectorAll<HTMLElement>(":scope > .ui-menu-list > [role^='menuitem']")].filter(
      (row) => !row.hidden,
    );
  const place = (menu: HTMLElement, x: number, y: number, parent?: DOMRect): void => {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0,
      width = viewport?.width ?? window.innerWidth,
      height = viewport?.height ?? window.innerHeight;
    const box = menu.getBoundingClientRect();
    let nextX = x,
      nextY = y;
    if (parent && nextX + box.width > left + width - 8) nextX = parent.left - box.width + 4;
    nextX = Math.max(left + 8, Math.min(nextX, left + width - box.width - 8));
    nextY = Math.max(top + 8, Math.min(nextY, top + height - box.height - 8));
    menu.style.left = `${nextX}px`;
    menu.style.top = `${nextY}px`;
  };
  const closeFrom = (depth: number): void => {
    while (levels.length > depth) {
      const level = levels.pop()!;
      if (level.matches(":popover-open")) level.hidePopover();
      level.remove();
    }
    const parent = levels[depth - 1];
    parent
      ?.querySelectorAll("[aria-expanded='true']")
      .forEach((row) => row.setAttribute("aria-expanded", "false"));
  };

  const build = (
    entries: readonly ContextMenuItem[],
    depth: number,
    label: string,
    searchable: boolean,
  ): HTMLElement => {
    const menu = document.createElement("div");
    menu.className = "ui-menu";
    menu.popover = "manual";
    menu.dataset["uiGenerated"] = "";
    const list = document.createElement("div");
    list.className = "ui-menu-list";
    list.setAttribute("role", "menu");
    list.setAttribute("aria-label", label);
    list.id = `codex-menu-${++sequence}`;
    if (depth === 0 && options.title) {
      const title = document.createElement("p");
      title.className = "ui-menu-title";
      title.textContent = options.title;
      menu.append(title);
    }
    let filter: HTMLInputElement | undefined;
    if (searchable) {
      filter = document.createElement("input");
      filter.type = "search";
      filter.className = "ui-control ui-menu-filter";
      filter.placeholder = messages(document.documentElement).filter;
      filter.setAttribute("aria-label", messages(document.documentElement).filter);
      filter.setAttribute("aria-controls", list.id);
      menu.append(filter);
    }
    const empty = document.createElement("p");
    empty.className = "ui-help ui-menu-empty";
    empty.textContent = messages(document.documentElement).empty;
    empty.hidden = entries.length > 0;
    entries.forEach((entry, index) => {
      if (entry.separator && index > 0) {
        const line = document.createElement("div");
        line.className = "ui-menu-separator";
        line.setAttribute("role", "separator");
        list.append(line);
      }
      const row = document.createElement("div");
      row.className = "ui-menu-item";
      row.tabIndex = -1;
      row.dataset["search"] = folded(entry.label);
      row.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemcheckbox");
      if (entry.checked !== undefined) row.setAttribute("aria-checked", String(entry.checked));
      if (entry.danger) row.classList.add("is-danger");
      const disabled = entry.disabled === true || typeof entry.disabled === "string";
      if (disabled) {
        row.setAttribute("aria-disabled", "true");
        if (typeof entry.disabled === "string") row.title = entry.disabled;
      }
      const mark = document.createElement("span");
      mark.className = "ui-menu-icon";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = entry.checked ? "✓" : (entry.icon ?? "");
      const text = document.createElement("span");
      text.className = "ui-menu-label";
      text.textContent = entry.label;
      row.append(mark, text);
      if (entry.detail) {
        const detail = document.createElement("span");
        detail.className = "ui-menu-detail";
        detail.textContent = entry.detail;
        row.append(detail);
      }
      if (entry.children) {
        row.setAttribute("aria-haspopup", "menu");
        row.setAttribute("aria-expanded", "false");
        const arrow = document.createElement("span");
        arrow.className = "ui-menu-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "›";
        row.append(arrow);
      }
      const activate = (focusFirst: boolean): void => {
        if (disabled) return;
        if (entry.children) {
          openSubmenu(row, entry, depth, focusFirst);
          return;
        }
        close(false);
        entry.run?.();
      };
      row.addEventListener("click", () => activate(true), { signal });
      row.addEventListener(
        // Movement, not entry: a menu opening under a resting pointer stays put.
        "pointermove",
        () => {
          if (document.activeElement === row) return;
          row.focus({ preventScroll: true });
          if (entry.children && !disabled) openSubmenu(row, entry, depth, false);
          else closeFrom(depth + 1);
        },
        { signal },
      );
      row.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") {
            if (event.key === "ArrowRight" && !entry.children) return;
            event.preventDefault();
            activate(true);
          }
        },
        { signal },
      );
      list.append(row);
    });
    menu.append(list, empty);
    filter?.addEventListener(
      "input",
      () => {
        const query = folded(filter.value.trim());
        let shown = 0;
        for (const row of list.querySelectorAll<HTMLElement>(".ui-menu-item")) {
          row.hidden = query !== "" && !(row.dataset["search"] ?? "").includes(query);
          if (!row.hidden) shown++;
        }
        for (const line of list.querySelectorAll<HTMLElement>(".ui-menu-separator"))
          line.hidden = query !== "";
        empty.hidden = shown > 0;
      },
      { signal },
    );
    menu.addEventListener(
      "keydown",
      (event) => {
        if (event.isComposing) return;
        const available = rows(menu).filter((row) => row.getAttribute("aria-disabled") !== "true");
        const all = rows(menu);
        const index = all.indexOf(document.activeElement as HTMLElement);
        const move = (next: HTMLElement | undefined) => {
          if (!next) return;
          event.preventDefault();
          next.focus({ preventScroll: true });
          next.scrollIntoView({ block: "nearest" });
        };
        if (event.key === "ArrowDown")
          move(all.slice(index + 1).find((row) => available.includes(row)) ?? available[0]);
        else if (event.key === "ArrowUp") {
          if (index <= 0 && filter) {
            event.preventDefault();
            filter.focus();
          } else
            move(
              all
                .slice(0, Math.max(index, 0))
                .reverse()
                .find((row) => available.includes(row)) ?? available.at(-1),
            );
        } else if (event.key === "Home") move(available[0]);
        else if (event.key === "End") move(available.at(-1));
        else if (event.key === "Escape" || (event.key === "ArrowLeft" && depth > 0)) {
          event.preventDefault();
          event.stopPropagation();
          if (depth === 0) close();
          else {
            const owner = levels[depth - 1]?.querySelector<HTMLElement>("[aria-expanded='true']");
            closeFrom(depth);
            owner?.focus({ preventScroll: true });
          }
        } else if (event.key === "Tab") {
          event.preventDefault();
          close();
        } else if (
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          event.target !== filter
        ) {
          // Type-ahead: jump to the next row starting with the typed letter.
          const letter = folded(event.key);
          const ordered = [...all.slice(index + 1), ...all.slice(0, index + 1)];
          move(ordered.find((row) => (row.dataset["search"] ?? "").startsWith(letter)));
        }
      },
      { signal },
    );
    document.body.append(menu);
    menu.showPopover();
    levels[depth] = menu;
    return menu;
  };

  const openSubmenu = (
    row: HTMLElement,
    entry: ContextMenuItem,
    depth: number,
    focusFirst: boolean,
  ): void => {
    if (row.getAttribute("aria-expanded") === "true" && levels.length > depth + 1) {
      if (focusFirst) focusInto(levels[depth + 1]!);
      return;
    }
    closeFrom(depth + 1);
    const children = typeof entry.children === "function" ? entry.children() : entry.children!;
    row.setAttribute("aria-expanded", "true");
    const menu = build(children, depth + 1, entry.label, entry.searchable === true);
    const rect = row.getBoundingClientRect();
    place(menu, rect.right - 4, rect.top - 4, rect);
    if (focusFirst) focusInto(menu);
  };
  const focusInto = (menu: HTMLElement): void => {
    const filter = menu.querySelector<HTMLInputElement>(".ui-menu-filter");
    if (filter) filter.focus();
    else
      rows(menu)
        .find((row) => row.getAttribute("aria-disabled") !== "true")
        ?.focus({ preventScroll: true });
  };

  const root = build(items, 0, options.title ?? messages(document.documentElement).menu, false);
  place(root, point.x, point.y);
  focusInto(root);
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.composedPath().some((node) => levels.includes(node as HTMLElement))) close(false);
    },
    { signal, capture: true },
  );
  window.addEventListener("resize", () => close(false), { signal });
  window.addEventListener("blur", () => close(false), { signal });
  // Close on the user's own scrolling, not on programmatic scroll restoration.
  for (const type of ["wheel", "touchmove"] as const)
    document.addEventListener(
      type,
      (event) => {
        if (!levels.some((level) => level.contains(event.target as Node))) close(false);
      },
      { signal, capture: true, passive: true },
    );
  return handle;
}

/** Long-press on touch opens the same menu as a right-click. */
export function bindLongPress(
  root: HTMLElement,
  open: (target: Element, point: { x: number; y: number }) => boolean,
  signal: AbortSignal,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined,
    start: { x: number; y: number } | undefined,
    fired = false;
  const cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  root.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch") return;
      fired = false;
      start = { x: event.clientX, y: event.clientY };
      const target = event.target as Element;
      timer = setTimeout(() => {
        fired = open(target, start!);
      }, 550);
    },
    { signal },
  );
  root.addEventListener(
    "pointermove",
    (event) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
    },
    { signal },
  );
  for (const type of ["pointerup", "pointercancel"] as const)
    root.addEventListener(type, cancel, { signal });
  // A long-press that opened a menu must not also follow the link.
  root.addEventListener(
    "click",
    (event) => {
      if (fired) {
        event.preventDefault();
        event.stopPropagation();
        fired = false;
      }
    },
    { signal, capture: true },
  );
  signal.addEventListener("abort", cancel, { once: true });
}
