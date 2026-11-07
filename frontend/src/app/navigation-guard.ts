import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import { browserAddonRouteHref, parseBrowserAddonLocation } from "../addons/navigation.js";
import { isPlayerPreview } from "../core/player-preview.js";
import {
  addressFor,
  appNavigationHref,
  currentAppHref,
  navigationRequestEvent,
  type NavigationRequest,
} from "./address.js";
import { canonicalAppHref } from "./routes.js";
import { uiText } from "./ui-localization.js";
import {
  confirmDiscardUnsavedEdit,
  EditStateTracker,
  protectUnsavedEditBeforeUnload,
  type EditState,
} from "./unsaved-edit.js";

export interface NavigationGuardOptions {
  /** The app is busy, so nothing may be left. */
  busy(): boolean;
  /** The running add-ons, whose views report their own edits. */
  registry(): BrowserContributionRegistry | undefined;
  /** The address changed to `href`, already in its canonical form. */
  navigated(href: string): void;
  /** An editor reported an unsaved change. */
  edited(): void;
  /** Leaving was refused for a reason the user should read. */
  refused(message: string): void;
}

/**
 * Owns the address bar. It opens same-origin page links in place, accepts or
 * puts back Back and Forward, keeps open edits from being left by accident,
 * warns before the page unloads, and lets an action such as signing out ask
 * first. Host editors report with `reportEditState`; add-on views report
 * through their registry.
 */
export class NavigationGuard implements ReactiveController {
  readonly #host: ReactiveControllerHost & HTMLElement;
  readonly #options: NavigationGuardOptions;
  readonly #edits = new EditStateTracker();
  #accepted = "/";

  constructor(host: ReactiveControllerHost & HTMLElement, options: NavigationGuardOptions) {
    this.#host = host;
    this.#options = options;
    host.addController(this);
  }

  hostConnected(): void {
    this.#accepted = currentAppHref();
    const wanted = addressFor(this.#accepted);
    const { pathname, search, hash } = window.location;
    if (`${pathname}${search}${hash}` !== wanted) window.history.replaceState(null, "", wanted);
    window.addEventListener("popstate", this.#onPopState);
    window.addEventListener("click", this.#onClick);
    window.addEventListener("auxclick", this.#onAuxClick);
    window.addEventListener(navigationRequestEvent, this.#onNavigationRequest);
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    this.#host.addEventListener("campaign-edit-dirty", this.#onEditState);
  }

  hostDisconnected(): void {
    window.removeEventListener("popstate", this.#onPopState);
    window.removeEventListener("click", this.#onClick);
    window.removeEventListener("auxclick", this.#onAuxClick);
    window.removeEventListener(navigationRequestEvent, this.#onNavigationRequest);
    window.removeEventListener("beforeunload", this.#onBeforeUnload);
    this.#host.removeEventListener("campaign-edit-dirty", this.#onEditState);
  }

  /** The address the app shows. */
  get href(): string {
    return this.#accepted;
  }

  /** A host editor or an add-on view has unsaved or saving changes. */
  get editing(): boolean {
    const addons = this.#options.registry()?.edits.state();
    return this.hostEditing || addons?.dirty === true || addons?.saving === true;
  }

  /** A host editor has unsaved or saving changes. */
  get hostEditing(): boolean {
    return this.#edits.dirty || this.#edits.saving;
  }

  /**
   * Opens `href` as a new history entry after asking about unsaved changes,
   * unless the caller already did (`confirmed`). Returns false when refused.
   */
  navigate(href: string, { confirmed = false }: { confirmed?: boolean } = {}): boolean {
    const next = canonicalAppHref(href);
    if (next === this.#accepted) return true;
    if (!confirmed && !this.confirmDiscard(next)) return false;
    window.history.pushState(null, "", addressFor(next));
    this.#accepted = next;
    this.#options.navigated(next);
    return true;
  }

  /** Shows `href` without navigating, as a collection view's query does. */
  replace(href: string): void {
    this.#accepted = canonicalAppHref(href);
    window.history.replaceState(null, "", addressFor(this.#accepted));
  }

  /**
   * Asks before unsaved changes are left and refuses while a save runs.
   * `nextHref` is where the user is going, if anywhere: an add-on page that
   * stays open through a query change keeps its edits.
   */
  confirmDiscard(nextHref?: string): boolean {
    if (this.#options.busy() || this.#edits.saving) {
      this.#options.refused(uiText("Wait for the save to finish before leaving this view."));
      return false;
    }
    const currentRoute = parseBrowserAddonLocation(this.#accepted)?.routePath;
    const nextRoute =
      nextHref === undefined ? undefined : parseBrowserAddonLocation(nextHref)?.routePath;
    const addons = this.#options
      .registry()
      ?.edits.state(
        (active) =>
          currentRoute !== undefined &&
          currentRoute === nextRoute &&
          active.descriptor.surface === "route" &&
          browserAddonRouteHref(active) === currentRoute,
      );
    if (addons?.saving) {
      this.#options.refused(uiText("Wait for the add-on save to finish before leaving this view."));
      return false;
    }
    if (
      !confirmDiscardUnsavedEdit(this.#edits.dirty || addons?.dirty === true, (message) =>
        window.confirm(message),
      )
    )
      return false;
    this.#edits.clear();
    return true;
  }

  readonly #onPopState = (): void => {
    const next = currentAppHref();
    if (next === this.#accepted) return;
    if (!this.confirmDiscard(next)) {
      // Back and Forward have already moved; show the page that stayed open.
      window.history.replaceState(null, "", addressFor(this.#accepted));
      return;
    }
    this.#accepted = next;
    this.#options.navigated(next);
  };

  readonly #onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0) return;
    const href = pageLinkTarget(event);
    if (href === undefined) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      openPreviewTab(event, href);
      return;
    }
    event.preventDefault();
    this.navigate(href);
  };

  readonly #onAuxClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 1) return;
    const href = pageLinkTarget(event);
    if (href !== undefined) openPreviewTab(event, href);
  };

  readonly #onNavigationRequest = (event: Event): void => {
    const request = (event as CustomEvent<NavigationRequest>).detail;
    const href = typeof request?.href === "string" ? appNavigationHref(request.href) : undefined;
    if (href === undefined) {
      event.preventDefault();
      return;
    }
    if (request.replace === true) {
      // Only the query of the page that is showing may change in place.
      const current = parseBrowserAddonLocation(this.#accepted)?.routePath;
      if (current === undefined || parseBrowserAddonLocation(href)?.routePath !== current)
        event.preventDefault();
      else this.replace(href);
      return;
    }
    if (!this.navigate(href, { confirmed: request.confirmed === true })) event.preventDefault();
  };

  readonly #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    protectUnsavedEditBeforeUnload(this.editing || this.#options.busy(), event);
  };

  readonly #onEditState = (event: Event): void => {
    const report = event as CustomEvent<EditState>;
    this.#edits.record(report);
    if (report.detail?.dirty) this.#options.edited();
  };
}

/**
 * The page address of the link a click landed on, when the app should open it
 * itself. Links that open elsewhere, download, or sit inside an editor (whose
 * links are text being edited) keep the browser's behaviour.
 */
function pageLinkTarget(event: MouseEvent): string | undefined {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLAnchorElement || node instanceof SVGAElement)) continue;
    const href = node.getAttribute("href");
    const target = node.getAttribute("target");
    if (
      href === null ||
      node.hasAttribute("download") ||
      (target !== null && target !== "" && target !== "_self") ||
      (node instanceof HTMLElement && node.isContentEditable)
    )
      return undefined;
    return appNavigationHref(href);
  }
  return undefined;
}

/**
 * A preview tab opens links in a new tab itself, so the new tab keeps the
 * preview marker instead of falling back to the signed-in session. Without
 * `noopener` the browser copies this tab's session storage, and with it the
 * preview token, into the new tab.
 */
function openPreviewTab(event: MouseEvent, href: string): void {
  if (!isPlayerPreview()) return;
  event.preventDefault();
  window.open(addressFor(href), "_blank");
}
