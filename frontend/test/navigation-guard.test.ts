import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import { NavigationGuard, type NavigationGuardOptions } from "../src/app/navigation-guard.js";
import { reportEditState } from "../src/app/unsaved-edit.js";

/** A window whose address changes the way the browser's does. */
function browserWindow(hash: string) {
  const location = { hash, pathname: "/", search: "" };
  return Object.assign(new EventTarget(), {
    location,
    history: {
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        const at = url.indexOf("#");
        location.hash = at === -1 ? "" : url.slice(at);
      }),
    },
    confirm: vi.fn(() => true),
  });
}

interface Lifecycle {
  hostConnected?: () => void;
  hostDisconnected?: () => void;
}

/** An add-on page at `#/addons/dm-tools/planner` with unsaved edits. */
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

function guarded(hash = "#/", options: Partial<NavigationGuardOptions> = {}) {
  const window = browserWindow(hash);
  vi.stubGlobal("window", window);
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
  const go = (next: string) => {
    window.location.hash = next;
    window.dispatchEvent(new Event("hashchange"));
  };
  const disconnect = () => controllers.forEach((controller) => controller.hostDisconnected?.());
  return { window, host, guard, navigated, refused, edited, go, disconnect };
}

afterEach(() => vi.unstubAllGlobals());

describe("NavigationGuard", () => {
  it("shows an empty address as the overview and follows address changes", () => {
    const { guard, navigated, go, window } = guarded("");
    expect(guard.hash).toBe("#/");
    go("#/party");
    expect(navigated).toHaveBeenCalledWith("#/party");
    expect(guard.hash).toBe("#/party");
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("puts the address back when the user keeps an unsaved change", () => {
    const { guard, host, navigated, edited, go, window } = guarded("#/characters");
    reportEditState(host, { dirty: true });
    expect(edited).toHaveBeenCalledOnce();
    window.confirm.mockReturnValueOnce(false);
    go("#/party");
    expect(window.location.hash).toBe("#/characters");
    expect(navigated).not.toHaveBeenCalled();
    go("#/party");
    expect(navigated).toHaveBeenCalledWith("#/party");
    // The discarded change no longer holds the next navigation.
    expect(guard.editing).toBe(false);
  });

  it("refuses to leave while a save runs, without asking", () => {
    const { host, navigated, go, window, guard } = guarded("#/characters");
    reportEditState(host, { dirty: true, saving: true });
    go("#/party");
    expect(window.location.hash).toBe("#/characters");
    expect(window.confirm).not.toHaveBeenCalled();
    expect(navigated).not.toHaveBeenCalled();
    reportEditState(host, { dirty: false });
    expect(guard.confirmDiscard()).toBe(true);
  });

  it("refuses while the app is busy", () => {
    const { navigated, go, window } = guarded("#/", { busy: () => true });
    go("#/party");
    expect(window.location.hash).toBe("#/");
    expect(navigated).not.toHaveBeenCalled();
  });

  it("says why an add-on save keeps the user on the page", () => {
    const { guard, refused } = guarded("#/", { registry: () => addonEdits({ saving: true }) });
    expect(guard.confirmDiscard()).toBe(false);
    expect(refused).toHaveBeenCalledWith(
      "Wait for the add-on save to finish before leaving this view.",
    );
  });

  it("keeps an add-on page's edits through a change of its own query only", () => {
    const { go, navigated, window } = guarded("#/addons/dm-tools/planner?view=board", {
      registry: () => addonEdits({ dirty: true }),
    });
    go("#/addons/dm-tools/planner?view=list");
    expect(window.confirm).not.toHaveBeenCalled();
    expect(navigated).toHaveBeenCalledWith("#/addons/dm-tools/planner?view=list");
    window.confirm.mockReturnValueOnce(false);
    go("#/party");
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#/addons/dm-tools/planner?view=list");
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
    const { guard, navigated, go, window } = guarded("#/characters");
    guard.replace("#/characters?sort=name");
    expect(window.location.hash).toBe("#/characters?sort=name");
    go("#/characters?sort=name");
    expect(navigated).not.toHaveBeenCalled();
  });

  it("stops listening when the app leaves the page", () => {
    const { navigated, go, disconnect } = guarded("#/");
    disconnect();
    go("#/party");
    expect(navigated).not.toHaveBeenCalled();
  });
});
