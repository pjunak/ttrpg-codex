import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import { browserAddonRouteHash, parseBrowserAddonLocation } from "../addons/navigation.js";
import { canonicalAppHash } from "./routes.js";
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
  /** The address changed to `hash`, already in its canonical form. */
  navigated(hash: string): void;
  /** An editor reported an unsaved change. */
  edited(): void;
  /** Leaving was refused for a reason the user should read. */
  refused(message: string): void;
}

/**
 * Keeps open edits from being left by accident. It accepts or puts back each
 * address change, warns before the page unloads, and lets an action such as
 * signing out ask first. Host editors report with `reportEditState`; add-on
 * views report through their registry.
 */
export class NavigationGuard implements ReactiveController {
  readonly #host: ReactiveControllerHost & HTMLElement;
  readonly #options: NavigationGuardOptions;
  readonly #edits = new EditStateTracker();
  #accepted = "#/";

  constructor(host: ReactiveControllerHost & HTMLElement, options: NavigationGuardOptions) {
    this.#host = host;
    this.#options = options;
    host.addController(this);
  }

  hostConnected(): void {
    this.#accepted = canonicalAppHash(window.location.hash);
    if (window.location.hash && this.#accepted !== window.location.hash)
      window.history.replaceState(null, "", this.#accepted);
    window.addEventListener("hashchange", this.#onHashChange);
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    this.#host.addEventListener("campaign-edit-dirty", this.#onEditState);
  }

  hostDisconnected(): void {
    window.removeEventListener("hashchange", this.#onHashChange);
    window.removeEventListener("beforeunload", this.#onBeforeUnload);
    this.#host.removeEventListener("campaign-edit-dirty", this.#onEditState);
  }

  /** The address the app shows. */
  get hash(): string {
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

  /** Shows `hash` without navigating, as a collection view's query does. */
  replace(hash: string): void {
    window.history.replaceState(null, "", hash);
    this.#accepted = hash;
  }

  /**
   * Asks before unsaved changes are left and refuses while a save runs.
   * `nextHash` is where the user is going, if anywhere: an add-on page that
   * stays open through a query change keeps its edits.
   */
  confirmDiscard(nextHash?: string): boolean {
    if (this.#options.busy() || this.#edits.saving) return false;
    const currentRoute = parseBrowserAddonLocation(this.#accepted)?.routeHash;
    const nextRoute =
      nextHash === undefined ? undefined : parseBrowserAddonLocation(nextHash)?.routeHash;
    const addons = this.#options
      .registry()
      ?.edits.state(
        (active) =>
          currentRoute !== undefined &&
          currentRoute === nextRoute &&
          active.descriptor.surface === "route" &&
          browserAddonRouteHash(active) === currentRoute,
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

  readonly #onHashChange = (): void => {
    const nextHash = canonicalAppHash(window.location.hash);
    if (nextHash !== this.#accepted && !this.confirmDiscard(nextHash)) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${this.#accepted}`,
      );
      return;
    }
    if (window.location.hash && nextHash !== window.location.hash)
      window.history.replaceState(null, "", nextHash);
    if (nextHash === this.#accepted) return;
    this.#accepted = nextHash;
    this.#options.navigated(nextHash);
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
