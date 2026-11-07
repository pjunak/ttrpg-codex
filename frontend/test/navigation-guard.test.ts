import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import { requestNavigation } from "../src/app/address.js";
import { NavigationGuard, type NavigationGuardOptions } from "../src/app/navigation-guard.js";
import { reportEditState } from "../src/app/unsaved-edit.js";

const origin = "https://codex.test";

/** A window whose address and history change the way the browser's do. */
function browserWindow(start: string) {
  const location = { origin, href: "", pathname: "/", search: "", hash: "" };
  const show = (url: string) => {
    const next = new URL(url, location.href || origin);
    Object.assign(location, {
      href: next.href,
      pathname: next.pathname,
      search: next.search,
      hash: next.hash,
    });
  };
  show(start);
  return Object.assign(new EventTarget(), {
    location,
    show,
    history: {
      pushState: vi.fn((_state: unknown, _title: string, url: string) => show(url)),
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => show(url)),
    },
    confirm: vi.fn(() => true),
    open: vi.fn(),
  });
}

/** Just enough of an anchor for the guard's link handling. */
class FakeAnchor {
  isContentEditable = false;
  constructor(readonly attributes: Record<string, string>) {}
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name: string) {
    return name in this.attributes;
  }
}

function click(anchor: FakeAnchor, init: Partial<MouseEvent> = {}) {
  return Object.assign(new Event("click", { cancelable: true }), {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    composedPath: () => [anchor],
    ...init,
  });
}

interface Lifecycle {
  hostConnected?: () => void;
  hostDisconnected?: () => void;
}

/** An add-on page at `/addons/dm-tools/planner` with unsaved edits. */
const plannerPage = {
  addonId: "dm-tools",
  descriptor: { surface: "route", config: { path: "planner" } },
};

function addonEdits(state: { dirty?: boolean; saving?: boolean }) {
  return {
    edits: {
      // An add-on page kept open through the change keeps its edits.
      state: (kept?: (active: typeof plannerPage) => boolean) => ({
        dirty: state.dirty === true && kept?.(plannerPage) !== true,
        saving: state.saving === true,
      }),
    },
  } as unknown as BrowserContributionRegistry;
}

function guarded(start = "/", options: Partial<NavigationGuardOptions> = {}) {
  const window = browserWindow(start);
  vi.stubGlobal("window", window);
  vi.stubGlobal("HTMLAnchorElement", FakeAnchor);
  vi.stubGlobal("HTMLElement", FakeAnchor);
  vi.stubGlobal("SVGAElement", class {});
  const controllers: Lifecycle[] = [];
  const host = Object.assign(new EventTarget(), {
    addController: (controller: Lifecycle) => controllers.push(controller),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  });
  const navigated = vi.fn();
  const refused = vi.fn();
  const edited = vi.fn();
  const guard = new NavigationGuard(host as unknown as HTMLElement & typeof host, {
    busy: () => false,
    registry: () => undefined,
    navigated,
    edited,
    refused,
    ...options,
  });
  for (const controller of controllers) controller.hostConnected?.();
  /** Back or Forward to `next`: the browser moves first, then reports it. */
  const traverse = (next: string) => {
    window.show(next);
    window.dispatchEvent(new Event("popstate"));
  };
  const disconnect = () => controllers.forEach((controller) => controller.hostDisconnected?.());
  return { window, host, guard, navigated, refused, edited, traverse, disconnect };
}

afterEach(() => vi.unstubAllGlobals());

describe("NavigationGuard", () => {
  it("opens page links in place and follows Back and Forward", () => {
    const { guard, navigated, traverse, window } = guarded("/");
    expect(guard.href).toBe("/");
    const event = click(new FakeAnchor({ href: "/party" }));
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(window.history.pushState).toHaveBeenCalledWith(null, "", "/party");
    expect(navigated).toHaveBeenCalledWith("/party");
    traverse("/");
    expect(navigated).toHaveBeenLastCalledWith("/");
    expect(guard.href).toBe("/");
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("leaves links that open elsewhere to the browser", () => {
    const { navigated, window } = guarded("/");
    const links = [
      { href: "/api/backup" },
      { href: "/assets/app.js" },
      { href: "#campaign-content" },
      { href: "https://example.com/" },
      { href: "/party", target: "_blank" },
      { href: "/party", download: "" },
    ];
    for (const attributes of links) {
      const event = click(new FakeAnchor(attributes));
      window.dispatchEvent(event);
      expect(event.defaultPrevented, JSON.stringify(attributes)).toBe(false);
    }
    const editing = new FakeAnchor({ href: "/party" });
    editing.isContentEditable = true;
    const modified = click(new FakeAnchor({ href: "/party" }), { ctrlKey: true });
    window.dispatchEvent(click(editing));
    window.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(navigated).not.toHaveBeenCalled();
  });

  it("compares addresses in the URL parser's spelling", () => {
    const { navigated } = guarded("/search?q=Ryn%27s");
    expect(requestNavigation("/search?q=Ryn's")).toBe(true);
    expect(navigated).not.toHaveBeenCalled();
  });

  it("puts the address back when the user keeps an unsaved change", () => {
    const { guard, host, navigated, edited, traverse, window } = guarded("/characters");
    reportEditState(host, { dirty: true });
    expect(edited).toHaveBeenCalledOnce();
    window.confirm.mockReturnValueOnce(false);
    traverse("/party");
    expect(window.location.pathname).toBe("/characters");
    expect(navigated).not.toHaveBeenCalled();
    window.confirm.mockReturnValueOnce(false);
    expect(requestNavigation("/party")).toBe(false);
    expect(window.history.pushState).not.toHaveBeenCalled();
    expect(guard.navigate("/party")).toBe(true);
    expect(navigated).toHaveBeenCalledWith("/party");
    // The discarded change no longer holds the next navigation.
    expect(guard.editing).toBe(false);
  });

  it("refuses to leave while a save runs, without asking", () => {
    const { host, navigated, traverse, window, guard } = guarded("/characters");
    reportEditState(host, { dirty: true, saving: true });
    traverse("/party");
    expect(window.location.pathname).toBe("/characters");
    expect(window.confirm).not.toHaveBeenCalled();
    expect(navigated).not.toHaveBeenCalled();
    reportEditState(host, { dirty: false });
    expect(guard.confirmDiscard()).toBe(true);
  });

  it("refuses while the app is busy unless the caller already asked", () => {
    const { navigated, traverse, window, guard } = guarded("/", { busy: () => true });
    traverse("/party");
    expect(window.location.pathname).toBe("/");
    expect(navigated).not.toHaveBeenCalled();
    expect(guard.navigate("/party", { confirmed: true })).toBe(true);
    expect(navigated).toHaveBeenCalledWith("/party");
  });

  it("says why an add-on save keeps the user on the page", () => {
    const { guard, refused } = guarded("/", { registry: () => addonEdits({ saving: true }) });
    expect(guard.confirmDiscard()).toBe(false);
    expect(refused).toHaveBeenCalledWith(
      "Wait for the add-on save to finish before leaving this view.",
    );
  });

  it("keeps an add-on page's edits through a change of its own query only", () => {
    const { traverse, navigated, window } = guarded("/addons/dm-tools/planner?view=board", {
      registry: () => addonEdits({ dirty: true }),
    });
    traverse("/addons/dm-tools/planner?view=list");
    expect(window.confirm).not.toHaveBeenCalled();
    expect(navigated).toHaveBeenCalledWith("/addons/dm-tools/planner?view=list");
    window.confirm.mockReturnValueOnce(false);
    traverse("/party");
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(window.location.pathname + window.location.search).toBe(
      "/addons/dm-tools/planner?view=list",
    );
  });

  it("lets a page change only its own query in place", () => {
    const { guard, navigated, window } = guarded("/addons/dm-tools/planner");
    expect(requestNavigation("/addons/dm-tools/planner?item=a", { replace: true })).toBe(true);
    expect(guard.href).toBe("/addons/dm-tools/planner?item=a");
    expect(window.history.replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/addons/dm-tools/planner?item=a",
    );
    expect(requestNavigation("/party", { replace: true })).toBe(false);
    expect(requestNavigation("/api/backup")).toBe(false);
    expect(navigated).not.toHaveBeenCalled();
  });

  it("warns before the page unloads with open edits", () => {
    const { host, window } = guarded();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    reportEditState(host, { dirty: true });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("shows a replaced address without navigating to it", () => {
    const { guard, navigated, traverse, window } = guarded("/characters");
    guard.replace("/characters?sort=name");
    expect(window.location.search).toBe("?sort=name");
    traverse("/characters?sort=name");
    expect(navigated).not.toHaveBeenCalled();
  });

  it("drops a stray fragment from the starting address", () => {
    const { guard, window } = guarded("/#/locations");
    expect(guard.href).toBe("/");
    expect(window.location.hash).toBe("");
  });

  it("stops listening when the app leaves the page", () => {
    const { navigated, traverse, disconnect, window } = guarded("/");
    disconnect();
    traverse("/party");
    window.dispatchEvent(click(new FakeAnchor({ href: "/party" })));
    expect(navigated).not.toHaveBeenCalled();
  });
});
