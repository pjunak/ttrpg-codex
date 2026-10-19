import type { ReactiveController, ReactiveControllerHost } from "lit";
import { browserDiagnostics } from "../addons/browser-diagnostics.js";
import { waitForSignal } from "../core/abort-signal.js";
import {
  createPlayerPreview,
  getAuth,
  getHealth,
  login as loginSession,
  logout as logoutSession,
  switchRole as switchSessionRole,
  type AuthState,
  type Health,
} from "../core/api.js";
import { SharedEventStream, type EventRefresh } from "../core/event-stream.js";
import {
  authorityRejectedEvent,
  isPlayerPreview,
  playerPreviewURL,
} from "../core/player-preview.js";
import type { AddonOutletsController } from "./addon-outlets-controller.js";
import type { BusyLeases } from "./busy-lease.js";
import type { CampaignController } from "./campaign-controller.js";
import type { NavigationGuard } from "./navigation-guard.js";
import { uiRequestError } from "./ui-errors.js";
import { uiText } from "./ui-localization.js";

export type Readiness =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly health: Health }
  | { readonly state: "unavailable"; readonly message: string };

export type Authority =
  { readonly state: "checking" } | { readonly state: "known"; readonly auth: AuthState };

export type LiveState = "connecting" | "connected" | "reconnecting";

export interface SessionControllerOptions {
  readonly campaign: CampaignController;
  readonly addons: AddonOutletsController;
  readonly busy: BusyLeases;
  readonly guard: NavigationGuard;
  /** Shows a problem in the app-wide alert, or clears it with "". `append` adds to it. */
  report(message: string, append?: boolean): void;
  /** The viewer signed out; a page that needed the session has nothing left to show. */
  signedOut(): void;
  /** The expired session was resumed and the campaign is shown again. */
  resumed(): void;
  /** Live updates; tests may replace the browser's event source. */
  readonly events?: SharedEventStream;
}

/**
 * The viewer's session: who they are, whether the host answers, and the live
 * updates. It signs in and out, switches the DM's view, and when a signed-in
 * session expires it keeps the open views and their drafts mounted until the
 * same role signs in again. Each change of authority reloads the campaign and
 * restarts the add-ons for it.
 */
export class SessionController implements ReactiveController {
  readiness: Readiness = { state: "checking" };
  authority: Authority = { state: "checking" };
  liveState: LiveState = "connecting";
  /** The signed-in session expired and waits to be resumed. */
  recovering = false;
  recoveryError = "";
  /** The session was resumed, until the authority changes again. */
  restored = false;
  readonly #host: ReactiveControllerHost;
  readonly #options: SessionControllerOptions;
  readonly #events: SharedEventStream;
  #request: AbortController | undefined;
  #check: Promise<boolean> | undefined;
  #checkController: AbortController | undefined;

  constructor(host: ReactiveControllerHost, options: SessionControllerOptions) {
    this.#host = host;
    this.#options = options;
    this.#events = options.events ?? new SharedEventStream();
    host.addController(this);
  }

  hostConnected(): void {
    const request = new AbortController();
    this.#request = request;
    this.authority = { state: "checking" };
    this.recovering = false;
    this.recoveryError = "";
    this.restored = false;
    this.#host.requestUpdate();
    window.addEventListener(authorityRejectedEvent, this.#onAuthorityRejected, {
      signal: request.signal,
    });
    void this.#bootstrap(request.signal);
  }

  hostDisconnected(): void {
    this.#request?.abort("component-disconnected");
    this.#cancelCheck();
    this.#request = undefined;
    this.#events.close();
    browserDiagnostics.enable(false);
  }

  /** Aborted when the app leaves the page; every request of the session uses it. */
  get signal(): AbortSignal | undefined {
    return this.#request?.signal;
  }

  get auth(): AuthState | undefined {
    return this.authority.state === "known" ? this.authority.auth : undefined;
  }

  get authenticated(): boolean {
    return this.auth?.authenticated === true;
  }

  /** The signed-in viewer's current role, or undefined before sign-in is known. */
  get role(): "dm" | "player" | undefined {
    return this.auth?.role ?? undefined;
  }

  /** A DM is signed in and viewing as DM. */
  get canManage(): boolean {
    return this.authenticated && this.role === "dm";
  }

  /**
   * Confirms that the signed-in session still holds. Resolves false when it
   * does not; the session then waits to be resumed.
   */
  check(): Promise<boolean> {
    if (this.#check) return this.#check;
    const request = this.#request,
      previous = this.auth;
    if (
      isPlayerPreview() ||
      this.recovering ||
      request === undefined ||
      previous?.authenticated !== true
    )
      return Promise.resolve(false);
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    this.#checkController = controller;
    const check: Promise<boolean> = (async () => {
      try {
        const current = await waitForSignal(getAuth(signal), signal);
        if (signal.aborted || this.auth !== previous) return false;
        if (
          current.authenticated &&
          current.realRole === previous.realRole &&
          current.role === previous.role
        ) {
          if (current.csrfToken !== previous.csrfToken) {
            this.#accept(current);
            this.#options.addons.renewCsrfToken(current.csrfToken);
          }
          return true;
        }
      } catch {
        if (signal.aborted) return false;
      }
      if (this.auth !== previous) return false;
      // Keep core components and their opening revisions mounted. A public
      // refresh here could remove a private record underneath its unsaved form.
      this.recovering = true;
      this.restored = false;
      this.#events.close();
      this.liveState = "reconnecting";
      browserDiagnostics.enable(false);
      this.#host.requestUpdate();
      return false;
    })().finally(() => {
      if (this.#check === check) {
        this.#check = undefined;
        this.#checkController = undefined;
      }
    });
    this.#check = check;
    return check;
  }

  /** Signs in again as the same role after the session expired. True once resumed. */
  async resume(password: string): Promise<boolean> {
    const request = this.#request,
      previous = this.auth;
    if (
      this.#options.busy.busy ||
      !this.recovering ||
      request === undefined ||
      previous?.authenticated !== true
    )
      return false;
    const signal = request.signal;
    const lease = this.#options.busy.acquire();
    this.recoveryError = "";
    this.#host.requestUpdate();
    let resumed = false;
    try {
      let current = await waitForSignal(loginSession(password, signal), signal);
      if (signal.aborted) return false;
      if (!current.authenticated || current.realRole !== previous.realRole) {
        this.recoveryError = uiText("session.sameRole");
        return false;
      }
      if (current.role !== previous.role)
        current = await waitForSignal(
          switchSessionRole(previous.role, current.csrfToken, signal),
          signal,
        );
      if (signal.aborted) return false;
      if (
        !current.authenticated ||
        current.realRole !== previous.realRole ||
        current.role !== previous.role
      ) {
        this.recoveryError = uiText("session.sameRole");
        return false;
      }
      this.#accept(current);
      this.#options.addons.renewCsrfToken(current.csrfToken);
      this.recovering = false;
      this.restored = true;
      this.#options.report("");
      resumed = true;
      await this.#options.campaign.load(signal, true);
      if (!signal.aborted && !this.recovering) {
        this.#startEventStream();
        const composition = this.#options.addons.composition;
        if (composition) await composition.session.start();
        else await this.recoverAddons(signal);
      }
    } catch {
      if (!signal.aborted) this.recoveryError = uiText("session.resumeFailed");
    } finally {
      lease.release();
      this.#host.requestUpdate();
    }
    if (!signal.aborted && !this.recovering) this.#options.resumed();
    return resumed;
  }

  async login(password: string): Promise<void> {
    const request = this.#request;
    if (this.#options.busy.busy || request === undefined) return;
    const signal = request.signal;
    const lease = this.#options.busy.acquire();
    this.#options.report("");
    try {
      const auth = await waitForSignal(loginSession(password, signal), signal);
      if (signal.aborted) return;
      if (!auth.authenticated) throw new Error("sign-in did not create a session");
      this.#accept(auth);
      await this.#reloadForAuthority(signal);
    } catch (cause: unknown) {
      if (!signal.aborted)
        this.#options.report(uiText("Sign-in failed: {0}", { "0": uiRequestError(cause) }));
    } finally {
      lease.release();
    }
  }

  async logout(): Promise<void> {
    const request = this.#request;
    if (this.#options.busy.busy || request === undefined || !this.#options.guard.confirmDiscard())
      return;
    const signal = request.signal;
    this.#cancelCheck();
    const lease = this.#options.busy.acquire();
    this.#options.report("");
    try {
      await this.#options.addons.stop();
      if (signal.aborted) return;
      await waitForSignal(logoutSession(signal), signal);
      if (signal.aborted) return;
      this.#accept(anonymousAuth());
      this.recovering = false;
      this.recoveryError = "";
      this.restored = false;
      browserDiagnostics.enable(false);
      await this.#options.campaign.reload(signal);
      if (signal.aborted) return;
      this.#startEventStream();
      this.#options.signedOut();
    } catch (cause: unknown) {
      if (!signal.aborted) {
        this.#options.report(uiText("Sign-out failed: {0}", { "0": uiRequestError(cause) }));
        await this.recoverAddons(signal);
      }
    } finally {
      lease.release();
    }
  }

  /** Switches a DM between the DM and player views. */
  async switchRole(): Promise<void> {
    const request = this.#request,
      auth = this.auth;
    if (
      this.#options.busy.busy ||
      request === undefined ||
      auth?.authenticated !== true ||
      auth.realRole !== "dm" ||
      !this.#options.guard.confirmDiscard()
    )
      return;
    const signal = request.signal;
    const role = auth.role === "dm" ? "player" : "dm";
    this.#cancelCheck();
    const lease = this.#options.busy.acquire();
    this.#options.report("");
    try {
      await this.#options.addons.stop();
      if (signal.aborted) return;
      const next = await waitForSignal(switchSessionRole(role, auth.csrfToken, signal), signal);
      if (signal.aborted) return;
      if (!next.authenticated) throw new Error("role switch ended the session");
      this.#accept(next);
      await this.#reloadForAuthority(signal);
    } catch (cause: unknown) {
      if (!signal.aborted) {
        this.#options.report(uiText("View switch failed: {0}", { "0": uiRequestError(cause) }));
        await this.recoverAddons(signal);
      }
    } finally {
      lease.release();
    }
  }

  /** Opens the player preview of this campaign in a new tab. */
  async openPreview(): Promise<void> {
    const request = this.#request,
      auth = this.auth;
    if (
      this.#options.busy.busy ||
      request === undefined ||
      auth?.authenticated !== true ||
      auth.role !== "dm"
    )
      return;
    const popup = window.open("about:blank", "_blank");
    if (popup === null) {
      this.#options.report(uiText("preview.blocked"));
      return;
    }
    popup.opener = null;
    const signal = request.signal;
    const closePendingPreview = () => popup.close();
    signal.addEventListener("abort", closePendingPreview, { once: true });
    const lease = this.#options.busy.acquire();
    this.#options.report("");
    try {
      const token = await waitForSignal(createPlayerPreview(auth.csrfToken, signal), signal);
      if (signal.aborted) return;
      if (!popup.closed) popup.location.replace(playerPreviewURL(token));
    } catch {
      popup.close();
      if (!signal.aborted) this.#options.report(uiText("preview.failed"));
    } finally {
      signal.removeEventListener("abort", closePendingPreview);
      lease.release();
    }
  }

  /** Ends the player preview this tab shows. */
  async closePreview(): Promise<void> {
    if (!isPlayerPreview() || !this.#options.guard.confirmDiscard()) return;
    if (this.#request !== undefined) await logoutSession(this.#request.signal).catch(() => {});
    window.close();
    // A manually opened tab may not be script-closable; keep it in expired preview mode.
    if (!window.closed) window.location.reload();
  }

  /** Starts the add-ons again after something stopped them; a failure adds to the alert. */
  async recoverAddons(signal = this.signal): Promise<void> {
    if (!this.authenticated || signal === undefined || signal.aborted) return;
    try {
      await this.#options.addons.start(signal);
    } catch (cause: unknown) {
      if (signal.aborted) return;
      this.#options.report(
        uiText(" Add-on recovery also failed: {0}", { "0": uiRequestError(cause) }),
        true,
      );
    }
  }

  /**
   * The add-ons found the session gone. Open host edits keep it until the
   * session is checked; otherwise the viewer continues signed out.
   */
  addonAuthorityLost(signal: AbortSignal, current: () => boolean): void {
    if (!isPlayerPreview() && this.#options.guard.hostEditing) {
      void this.check().then((available) => {
        if (available && !signal.aborted && current()) void this.recoverAddons(signal);
      });
      return;
    }
    this.#accept(anonymousAuth());
    browserDiagnostics.enable(false);
    this.#options.campaign.reset();
    this.#startEventStream();
    if (this.#request !== undefined) void this.#options.campaign.load(this.#request.signal);
  }

  readonly #onAuthorityRejected = (): void => {
    void this.check();
  };

  async #bootstrap(signal: AbortSignal): Promise<void> {
    void this.#checkHealth(signal);
    try {
      const auth = await waitForSignal(getAuth(signal), signal);
      if (signal.aborted) return;
      this.#accept(auth);
    } catch (cause: unknown) {
      if (signal.aborted) return;
      this.#accept(anonymousAuth());
      browserDiagnostics.enable(false);
      this.#options.report(uiText("Session check failed: {0}", { "0": uiRequestError(cause) }));
    }
    const authority = this.authority;
    await this.#options.campaign.load(signal);
    if (signal.aborted || this.authority !== authority) return;
    this.#startEventStream();
    if (!this.authenticated) return;
    try {
      await this.#options.addons.start(signal);
    } catch (cause: unknown) {
      if (!signal.aborted)
        this.#options.report(
          uiText("Add-ons could not start: {0}", { "0": uiRequestError(cause) }),
        );
    }
  }

  async #checkHealth(signal: AbortSignal): Promise<void> {
    this.readiness = { state: "checking" };
    this.#host.requestUpdate();
    try {
      const health = await waitForSignal(getHealth(signal), signal);
      if (!signal.aborted) this.readiness = { state: "ready", health };
    } catch (cause: unknown) {
      if (signal.aborted) return;
      this.readiness = { state: "unavailable", message: uiRequestError(cause) };
    }
    this.#host.requestUpdate();
  }

  async #reloadForAuthority(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.#events.close();
    this.restored = false;
    browserDiagnostics.enable(false);
    await this.#options.campaign.reload(signal);
    if (signal.aborted) return;
    this.#startEventStream();
    try {
      await this.#options.addons.start(signal);
    } catch (cause: unknown) {
      if (!signal.aborted)
        this.#options.report(
          uiText("Add-ons could not start: {0}", { "0": uiRequestError(cause) }),
        );
    }
  }

  #startEventStream(): void {
    const application = this.#request?.signal;
    if (application === undefined || application.aborted) return;
    this.liveState = "connecting";
    this.#host.requestUpdate();
    this.#events.open({
      onRefresh: (event, source) => {
        const signal = AbortSignal.any([application, source]);
        if (signal.aborted) return;
        this.liveState = "connected";
        this.#host.requestUpdate();
        void this.#handleEvent(event, signal);
      },
      onBoundaryError: (cause) => {
        this.#options.report(
          uiText("Live update was rejected: {0}", { "0": uiRequestError(cause) }),
        );
      },
      onConnectionError: () => {
        this.liveState = "reconnecting";
        this.#host.requestUpdate();
      },
    });
  }

  async #handleEvent(event: EventRefresh, signal: AbortSignal): Promise<void> {
    const addons = this.#options.addons;
    const composition = addons.composition,
      generation = addons.generation;
    const isCurrent = () =>
      !signal.aborted && generation === addons.generation && composition === addons.composition;
    if (!isCurrent()) return;
    try {
      composition?.dataChanges.handleEvent(event);
      if (event.cause === "addon-data-changed") return;
      if (event.cause === "campaign-restored") {
        const latest = await waitForSignal(this.#options.campaign.restored(signal), signal);
        // A newer restore owns the recovery decision, even when its read has
        // invalidated this request without replacing the add-on composition.
        if (!isCurrent() || !latest) return;
        if (this.#options.guard.editing) this.#options.report(uiText("recovery.openEdits"));
        else await this.recoverAddons(signal);
        return;
      }
      // A hello cursor can include writes made after our HTTP snapshot but before
      // subscription. Reconcile on every connection, including reconnects.
      if (
        event.cause === "hello" ||
        event.cause === "campaign-data-changed" ||
        event.cause === "reset"
      )
        await waitForSignal(this.#options.campaign.load(signal, true), signal);
      if (isCurrent()) await composition?.session.handleEvent(event);
    } catch (cause: unknown) {
      if (isCurrent())
        this.#options.report(
          uiText("Live update was rejected: {0}", { "0": uiRequestError(cause) }),
        );
    }
  }

  #accept(auth: AuthState): void {
    const previous = this.auth;
    if (
      previous !== undefined &&
      (previous.role !== auth.role || previous.realRole !== auth.realRole)
    )
      this.#events.close();
    this.#cancelCheck();
    this.authority = { state: "known", auth };
    this.#host.requestUpdate();
  }

  #cancelCheck(): void {
    const controller = this.#checkController;
    this.#check = undefined;
    this.#checkController = undefined;
    controller?.abort("authority-changed");
  }
}

function anonymousAuth(): AuthState {
  return { authenticated: false, role: null, realRole: null };
}
