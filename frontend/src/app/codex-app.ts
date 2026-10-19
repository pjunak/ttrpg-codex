import { formText } from "../core/forms.js";
import { bindLongPress, openContextMenu } from "../ui/context-menu.js";
import { recordContextMenu } from "./record-context-menu.js";
import { waitForSignal } from "../core/abort-signal.js";
import { BusyLeases, busyLeaseRequestEvent, type BusyLeaseRequest } from "./busy-lease.js";
import { CampaignWriteController } from "./campaign-write-controller.js";
import type { CampaignRecordSavedDetail } from "./codex-record-page.js";
import { uiRequestError } from "./ui-errors.js";
import { isRecord } from "../core/boundary.js";
import { browserDiagnostics } from "../addons/browser-diagnostics.js";
import { LitElement, html, nothing } from "lit";
import { routeRecordReferences } from "./route-record-references.js";
import {
  getAuth,
  getHealth,
  createPlayerPreview,
  login as loginSession,
  logout as logoutSession,
  switchRole as switchSessionRole,
  type AuthState,
  type Health,
} from "../core/api.js";
import { campaignCollection } from "../core/campaign-data.js";
import { CampaignController, type CampaignState } from "./campaign-controller.js";
import { applyCampaignTheme } from "./campaign-appearance.js";
import { SharedEventStream, type EventRefresh } from "../core/event-stream.js";
import {
  authorityRejectedEvent,
  isPlayerPreview,
  playerPreviewURL,
  previewResourceURL,
} from "../core/player-preview.js";
import {
  createBrowserAddonComposition,
  type BrowserAddonComposition,
} from "../addons/browser-composition.js";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import { contributionLabel } from "../addons/contribution-label.js";
import {
  BrowserNavigationOutlet,
  browserAddonRouteHash,
  parseBrowserAddonLocation,
  listBrowserNavigation,
} from "../addons/navigation.js";
import { applyBrandingFavicon, campaignBranding, defaultLogo } from "./campaign-branding.js";
import {
  confirmDiscardUnsavedEdit,
  EditStateTracker,
  protectUnsavedEditBeforeUnload,
  type EditState,
} from "./unsaved-edit.js";
import { parseAppRoute, canonicalAppHash, type AppRoute } from "./routes.js";
import { UiLocalizationController, uiText, type MessageKey } from "./ui-localization.js";
import "./codex-dashboard.js";
import { type DmAddonHealth } from "./codex-dm-dashboard.js";
import "./codex-dm-dashboard.js";
import "./codex-record-page.js";
import { AddonLinksController } from "./addon-links-controller.js";
import { bindRuleDetails } from "./codex-addon-rule-details.js";
import "./codex-search.js";
import { rememberRecentRecord } from "./recent-records.js";
import { containDialogTab, navigateTabs } from "../ui/focus.js";
import "./codex-settings.js";
import "./codex-addon-markdown.js";
import "./codex-map.js";
import "./codex-timeline.js";
import "./codex-campaign-graph.js";
import {
  campaignSidebar,
  defaultSidebarLayout,
  sidebarPage,
  type SidebarSection,
  addonSidebarKey,
  addonSidebarMode,
} from "./campaign-sidebar.js";

type Readiness =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly health: Health }
  | { readonly state: "unavailable"; readonly message: string };

type Authority =
  { readonly state: "checking" } | { readonly state: "known"; readonly auth: AuthState };

type AddonState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | {
      readonly state: "ready";
      readonly active: number;
      readonly revision: string;
      readonly failures: number;
    }
  | { readonly state: "degraded"; readonly message: string };

type LiveState = "connecting" | "connected" | "reconnecting";

export class CodexApp extends LitElement {
  static override properties = {
    readiness: { state: true },
    authority: { state: true },
    addonState: { state: true },
    liveState: { state: true },
    route: { state: true },
    errorMessage: { state: true },
    recordSaved: { state: true },
    contributionCount: { state: true },
    navigationCount: { state: true },
    routeCount: { state: true },
    articleCount: { state: true },
    characterView: { state: true },
    menuOpen: { state: true },
    mobileViewport: { state: true },
    quickSearchOpen: { state: true },
    sessionRecovery: { state: true },
    sessionRecoveryError: { state: true },
    sessionRestored: { state: true },
    contextNotice: { state: true },
  };

  declare private readiness: Readiness;
  declare private authority: Authority;
  declare private addonState: AddonState;
  declare private liveState: LiveState;
  declare private route: AppRoute;
  declare private errorMessage: string;
  /** A confirmed record save, shown until the next edit or another page. */
  declare private recordSaved: boolean;
  declare private contextNotice: string;
  #contextNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  #recordSaveDestination = "";
  declare private contributionCount: number;
  declare private navigationCount: number;
  declare private routeCount: number;
  declare private articleCount: number;
  declare private characterView: "profile" | "addons";
  readonly #busy = new BusyLeases(() => this.requestUpdate());

  declare private menuOpen: boolean;
  declare private mobileViewport: boolean;
  declare private quickSearchOpen: boolean;
  declare private sessionRecovery: boolean;
  declare private sessionRecoveryError: string;
  declare private sessionRestored: boolean;
  #sessionCheck: Promise<boolean> | undefined;
  #sessionCheckController: AbortController | undefined;
  #searchReturnFocus: HTMLElement | undefined;
  readonly #mobileMedia = window.matchMedia("(max-width: 768px)");
  #request: AbortController | undefined;
  #addonCleanup: Promise<void> = Promise.resolve();
  readonly #campaign = new CampaignController(this, {
    mayRefresh: (retainCurrent) => {
      if (this.sessionRecovery) return false;
      // Live refresh first confirms a signed-in session is still valid.
      if (retainCurrent && this.#authenticated() && !isPlayerPreview()) return this.#checkSession();
      return true;
    },
    apply: (campaign) => {
      applyCampaignTheme(campaign);
      applyBrandingFavicon(campaignBranding(campaign));
    },
    accepted: () => {
      this.#articleOutlet?.refresh();
      this.#navigationOutlet?.refresh();
      this.#routeOutlet?.refresh();
    },
    refreshFailed: (cause) => {
      this.errorMessage = uiText("Campaign refresh failed: {0}", { "0": errorMessage(cause) });
    },
  });
  readonly #events = new SharedEventStream();
  private get campaignState(): CampaignState {
    return this.#campaign.state;
  }
  readonly #ui = new UiLocalizationController(this);
  #addons: BrowserAddonComposition | undefined;
  readonly #links = new AddonLinksController(this, () => ({
    registry: this.#addons?.contributions,
    role: this.#actorRole,
  }));
  #disposeRuleDetails: (() => void) | undefined;
  #dmAddonHealth: readonly DmAddonHealth[] = [];
  #outletLocale = "";
  #dashboardOutlet: BrowserContributionOutlet | undefined;
  #articleOutlet: BrowserContributionOutlet | undefined;
  #navigationOutlet: BrowserNavigationOutlet | undefined;
  #routeOutlet: BrowserContributionOutlet | undefined;
  #addonOwner = 0;
  readonly #edits = new EditStateTracker();
  readonly #writes = new CampaignWriteController(this, {
    campaign: this.#campaign,
    busy: this.#busy,
    writer: () =>
      this.#request !== undefined &&
      this.authority.state === "known" &&
      this.authority.auth.authenticated
        ? { csrfToken: this.authority.auth.csrfToken, canManage: this.#canManageCampaign() }
        : undefined,
    editing: () => {
      const edits = this.#addons?.contributions.edits.state();
      return (
        this.#edits.dirty || this.#edits.saving || edits?.dirty === true || edits?.saving === true
      );
    },
  });
  #acceptedHash = "#/";

  constructor() {
    super();
    this.readiness = { state: "checking" };
    this.authority = { state: "checking" };
    this.addonState = { state: "idle" };
    this.liveState = "connecting";
    this.route = { kind: "dashboard" };
    this.errorMessage = "";
    this.contributionCount = 0;
    this.navigationCount = 0;
    this.routeCount = 0;
    this.articleCount = 0;
    this.characterView = preferredCharacterView(window.location.hash);
    this.recordSaved = false;
    this.contextNotice = "";
    this.menuOpen = false;
    this.quickSearchOpen = false;
    this.sessionRecovery = false;
    this.sessionRecoveryError = "";
    this.sessionRestored = false;
    this.mobileViewport = this.#mobileMedia.matches;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#disposeRuleDetails = bindRuleDetails(this, this.#links);
    this.#acceptedHash = normalizedHash(window.location.hash);
    if (window.location.hash && this.#acceptedHash !== window.location.hash)
      window.history.replaceState(null, "", this.#acceptedHash);
    this.route = parseAppRoute(this.#acceptedHash);
    window.addEventListener("hashchange", this.#onHashChange);
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    window.addEventListener("keydown", this.#onKeyDown);
    this.#mobileMedia.addEventListener("change", this.#onViewportChange);
    this.#request = new AbortController();
    this.authority = { state: "checking" };
    this.sessionRecovery = false;
    this.sessionRecoveryError = "";
    this.sessionRestored = false;
    window.addEventListener(authorityRejectedEvent, this.#onAuthorityRejected, {
      signal: this.#request.signal,
    });
    this.addEventListener(busyLeaseRequestEvent, this.#onBusyLeaseRequest, {
      signal: this.#request.signal,
    });
    this.addEventListener("contextmenu", this.#onContextMenu, { signal: this.#request.signal });
    bindLongPress(
      this,
      (target, point) => {
        const opened = this.#openRecordMenu(target, point);
        if (opened) this.#longPressAt = Date.now();
        return opened;
      },
      this.#request.signal,
    );
    void this.#bootstrap(this.#request.signal);
  }

  override disconnectedCallback(): void {
    clearTimeout(this.#contextNoticeTimer);
    this.#disposeRuleDetails?.();
    this.#disposeRuleDetails = undefined;
    this.#request?.abort("component-disconnected");
    this.#cancelSessionCheck();
    this.#request = undefined;
    this.#busy.clear();
    this.#events.close();
    window.removeEventListener("hashchange", this.#onHashChange);
    window.removeEventListener("beforeunload", this.#onBeforeUnload);
    window.removeEventListener("keydown", this.#onKeyDown);
    this.#mobileMedia.removeEventListener("change", this.#onViewportChange);
    browserDiagnostics.enable(false);
    void this.#stopAddons();
    super.disconnectedCallback();
  }

  protected override render() {
    const branding = campaignBranding(
      this.campaignState.state === "ready" ? this.campaignState.campaign : undefined,
    );
    return html`
      <a class="skip-link" href="#campaign-content" @click=${this.#focusContent}>${this.#ui.t("shell.skip")}</a>
      <div class="codex-shell">
        <aside id="campaign-sidebar" class=${`campaign-sidebar ${this.menuOpen ? "is-open" : ""}`} .inert=${this.mobileViewport && !this.menuOpen}>
          <header class="campaign-brand">
            <a href="#/" aria-label=${this.#ui.t("shell.openOverview")}>
              <img class="campaign-sigil" src=${previewResourceURL(branding.logoUrl || defaultLogo)} alt="" @error=${(
                event: Event,
              ) => {
                const image = event.currentTarget as HTMLImageElement;
                if (image.getAttribute("src") !== defaultLogo) image.src = defaultLogo;
              }} />
              <span><strong>${branding.title}</strong><small>${branding.subtitle}</small></span>
            </a>
          </header>
          <a class="sidebar-search" href="#/search" aria-haspopup="dialog" @click=${this.#openQuickSearch}><span aria-hidden="true">🔍</span>${this.#ui.t("shell.search")}…<kbd>Ctrl K</kbd></a>
          ${this.#navigationTemplate()}
          <section class="addon-navigation-section" aria-labelledby="addon-navigation-title" ?hidden=${this.navigationCount === 0}>
            <h2 id="addon-navigation-title">${this.#ui.t("shell.addons")}</h2>
            <nav class="addon-navigation" data-addon-navigation hidden></nav>
          </section>
          <footer class="sidebar-footer">
            ${this.#canManageCampaign() ? html`<a href="#/dm" aria-current=${this.route.kind === "dm" ? "page" : nothing}>🛡 ${this.#ui.t("dm.title")}</a>` : nothing}
            ${this.#viewAsTemplate()}
            <a href="#/settings" aria-current=${this.#coreRouteActive("settings") ? "page" : nothing}>⚙ ${this.#ui.t("shell.settings")}</a>
            <details class="account-menu">
              <summary>${this.#accountMenuLabel()}</summary>
              ${this.#accountTemplate()}
              <div class="content-statusbar">
                ${this.#hostStatusTemplate()}
                <span class=${`live-state live-${this.liveState}`}><span aria-hidden="true"></span>${this.#ui.t(liveMessageKey(this.liveState))}</span>
              </div>
            </details>
          </footer>
        </aside>
        <button class="sidebar-backdrop" aria-label=${this.#ui.t("shell.closeMenu")} ?hidden=${!this.mobileViewport || !this.menuOpen} @click=${this.#closeMenu}></button>
        <main id="campaign-content" class=${`campaign-content route-${this.route.kind}`} tabindex="-1" .inert=${this.mobileViewport && this.menuOpen}>
          ${
            isPlayerPreview()
              ? html`<div class="player-preview-notice" role="status">
            ${this.#ui.t(this.authority.state === "checking" ? "shell.checkingSession" : this.#authenticated() ? "preview.notice" : "preview.unavailable")}
            <button class="text-button" type="button" @click=${() => this.#closePreview()}>${this.#ui.t("preview.close")}</button>
          </div>`
              : nothing
          }
          ${this.liveState === "reconnecting" ? html`<p class="connection-alert" role="status">${this.#ui.t("shell.reconnecting")}</p>` : nothing}
          ${this.#sessionRecoveryTemplate()}
          ${this.sessionRestored && !this.recordSaved ? html`<p class="record-save-confirmation" role="status">${this.#ui.t("session.restored")}</p>` : nothing}
          ${
            this.errorMessage === ""
              ? nothing
              : html`
            <p class="application-alert" role="alert">
              <span>${this.errorMessage}</span>
              <button type="button" @click=${this.#dismissError}>${this.#ui.t("shell.dismiss")}</button>
            </p>
          `
          }
          ${this.recordSaved && this.#canEdit() ? html`<p class="record-save-confirmation record-save-toast" role="status">${uiText("save.entrySaved")}</p>` : nothing}
          <p class="context-notice" role="status" ?hidden=${this.contextNotice === ""}>${this.contextNotice}</p>
          ${this.#characterTabs()}
          <div id="character-profile-panel" role=${this.#hasCharacterTabs ? "tabpanel" : nothing}
            aria-labelledby=${this.#hasCharacterTabs ? "character-view-profile" : nothing}
            ?hidden=${this.#hasCharacterTabs && this.characterView === "addons"}>
            ${this.#campaignTemplate()}
          </div>
          <section class="addon-dashboard" data-addon-slot hidden aria-label=${this.#ui.t("shell.campaignAddons")}></section>
          <div id="character-addons-panel" role=${this.#hasCharacterTabs ? "tabpanel" : nothing}
            aria-labelledby=${this.#hasCharacterTabs ? "character-view-addons" : nothing}
            ?hidden=${this.#hasCharacterTabs && this.characterView === "profile"}>
            ${this.#hasCharacterTabs ? html`<h1 class="visually-hidden">${this.#characterName}</h1>` : nothing}
            <section class="addon-article" data-addon-article hidden aria-label=${this.#ui.t("shell.recordAddons")}></section>
          </div>
          <section class="addon-route" data-addon-route-outlet hidden aria-label=${this.#ui.t("shell.addonPage")}></section>
        </main>

        ${this.#mobileNavigationTemplate()}
      </div>
      ${
        this.quickSearchOpen && this.campaignState.state === "ready"
          ? html`<dialog class="quick-search-dialog" aria-labelledby="quick-search-title"
        @keydown=${(event: KeyboardEvent) => containDialogTab(event.currentTarget as HTMLDialogElement, event)}
        @click=${(event: MouseEvent) => {
          const link =
            event.target instanceof Element
              ? event.target.closest<HTMLAnchorElement>("a[href]")
              : null;
          if (
            link?.hash === this.#acceptedHash &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            this.#closeQuickSearch();
          }
        }}
        @cancel=${(event: Event) => {
          event.preventDefault();
          this.#closeQuickSearch();
        }}>
        <button type="button" class="record-action quick-search-close" @click=${() => this.#closeQuickSearch()}>${this.#ui.t("jump.close")}</button>
        <codex-search .quick=${true} .campaign=${this.campaignState.campaign} .registry=${this.#addons?.contributions}
          .actorRole=${this.#actorRole}></codex-search>
      </dialog>`
          : nothing
      }
    `;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("authority") || this.campaignState.state !== "ready")
      this.quickSearchOpen = false;
  }

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    const searchDialog = this.querySelector<HTMLDialogElement>(".quick-search-dialog");
    if (searchDialog && !searchDialog.open) searchDialog.showModal();
    if (
      this.campaignState.state === "ready" &&
      (changed.has("route") || changed.has("campaignState") || changed.has("authority"))
    )
      rememberRecentRecord(this.campaignState.campaign, this.route, this.#actorRole ?? "public");
    if (this.isConnected && this.#outletLocale !== this.#ui.locale) {
      this.#outletLocale = this.#ui.locale;
      this.#routeOutlet?.refresh();
      this.#articleOutlet?.refresh();
      this.#navigationOutlet?.refresh();
    }
  }

  /** A write, a sign-in or view change, or an add-on administration request is running. */
  get busy(): boolean {
    return this.#busy.busy;
  }

  readonly #onBusyLeaseRequest = (event: Event): void => {
    if (!this.isConnected) return;
    event.stopPropagation();
    (event as CustomEvent<BusyLeaseRequest>).detail.grant(this.#busy.acquire());
  };

  /** The signed-in viewer's current role, or undefined before sign-in is known. */
  get #actorRole(): "dm" | "player" | undefined {
    return this.authority.state === "known" ? (this.authority.auth.role ?? undefined) : undefined;
  }

  get #hasCharacterTabs(): boolean {
    return (
      this.route.kind === "record" &&
      this.route.page.collection === "characters" &&
      this.articleCount > 0 &&
      this.#recordContext() !== null
    );
  }

  /** The add-on tab's page heading; the add-ons show the name in their own layout. */
  get #characterName(): string {
    const context = this.#recordContext();
    return isRecord(context) &&
      isRecord(context["value"]) &&
      typeof context["value"]["name"] === "string"
      ? context["value"]["name"]
      : uiText("Character");
  }

  #characterTabs() {
    if (!this.#hasCharacterTabs) return nothing;
    const role = this.#actorRole ?? null;
    const contributions = role
      ? (this.#addons?.contributions
          .list("article-section", role)
          .filter((active) => active.descriptor.config["collection"] === "characters") ?? [])
      : [];
    const addonLabel =
      contributions.length === 1
        ? contributionLabel(contributions[0]!.descriptor, this.#ui.locale)
        : this.#ui.t("shell.recordAddons");
    return html`<nav class="character-view-tabs record-tabs" role="tablist" aria-label=${uiText("Character view")}>
      ${(["profile", "addons"] as const).map(
        (view) => html`<button type="button" role="tab" id=${`character-view-${view}`}
        aria-controls=${`character-${view}-panel`} aria-selected=${this.characterView === view}
        tabindex=${this.characterView === view ? 0 : -1}
        @click=${() => this.#selectCharacterView(view)} @keydown=${this.#characterTabKey}>
        ${view === "profile" ? uiText("Profile") : addonLabel}
      </button>`,
      )}
    </nav>`;
  }

  #selectCharacterView(view: "profile" | "addons"): void {
    this.characterView = view;
    if (this.route.kind === "record") {
      try {
        window.sessionStorage.setItem(`codex:character-view:${this.route.key}`, view);
      } catch {
        /* The active view still works without storage. */
      }
    }
  }

  readonly #characterTabKey = (event: KeyboardEvent): void => {
    const list = (event.currentTarget as HTMLElement).closest<HTMLElement>('[role="tablist"]');
    if (list) navigateTabs(list, event);
  };

  async #checkHealth(signal: AbortSignal): Promise<void> {
    this.readiness = { state: "checking" };
    try {
      const health = await waitForSignal(getHealth(signal), signal);
      if (!signal.aborted) this.readiness = { state: "ready", health };
    } catch (cause: unknown) {
      if (signal.aborted) return;
      this.readiness = { state: "unavailable", message: errorMessage(cause) };
    }
  }

  async #bootstrap(signal: AbortSignal): Promise<void> {
    void this.#checkHealth(signal);
    try {
      const auth = await waitForSignal(getAuth(signal), signal);
      if (signal.aborted) return;
      this.#acceptAuthority(auth);
    } catch (cause: unknown) {
      if (signal.aborted) return;
      this.#acceptAuthority(anonymousAuth());
      browserDiagnostics.enable(false);
      this.errorMessage = uiText("Session check failed: {0}", { "0": errorMessage(cause) });
    }

    const authority = this.authority;
    await this.#campaign.load(signal);
    if (signal.aborted || this.authority !== authority) return;
    this.#startEventStream();
    if (this.#authenticated()) {
      try {
        await this.#startAddons(signal);
      } catch (cause: unknown) {
        if (!signal.aborted)
          this.errorMessage = uiText("Add-ons could not start: {0}", { "0": errorMessage(cause) });
      }
    }
  }

  #startEventStream(): void {
    const application = this.#request?.signal;
    if (application === undefined || application.aborted) return;
    this.liveState = "connecting";
    this.#events.open({
      onRefresh: (event, source) => {
        const signal = AbortSignal.any([application, source]);
        if (signal.aborted) return;
        this.liveState = "connected";
        void this.#handleEvent(event, signal);
      },
      onBoundaryError: (cause) => {
        this.errorMessage = uiText("Live update was rejected: {0}", { "0": errorMessage(cause) });
      },
      onConnectionError: () => {
        this.liveState = "reconnecting";
      },
    });
  }

  async #handleEvent(event: EventRefresh, signal: AbortSignal): Promise<void> {
    const addons = this.#addons;
    const owner = this.#addonOwner;
    const isCurrent = () =>
      !signal.aborted && owner === this.#addonOwner && addons === this.#addons;
    if (!isCurrent()) return;
    try {
      addons?.dataChanges.handleEvent(event);
      if (event.cause === "addon-data-changed") return;
      if (event.cause === "campaign-restored") {
        const latest = await waitForSignal(this.#campaign.restored(signal), signal);
        // A newer restore owns the recovery decision, even when its read has
        // invalidated this request without replacing the add-on composition.
        if (!isCurrent() || !latest) return;
        const edits = addons?.contributions.edits.state();
        if (this.#edits.dirty || this.#edits.saving || edits?.dirty || edits?.saving) {
          this.errorMessage = this.#ui.t("recovery.openEdits");
        } else {
          await this.#recoverAddons(signal);
        }
        return;
      }
      // A hello cursor can include writes made after our HTTP snapshot but before
      // subscription. Reconcile on every connection, including reconnects.
      if (
        event.cause === "hello" ||
        event.cause === "campaign-data-changed" ||
        event.cause === "reset"
      )
        await waitForSignal(this.#campaign.load(signal, true), signal);
      if (isCurrent()) await addons?.session.handleEvent(event);
    } catch (cause: unknown) {
      if (isCurrent())
        this.errorMessage = uiText("Live update was rejected: {0}", { "0": errorMessage(cause) });
    }
  }

  readonly #onAuthorityRejected = (): void => {
    void this.#checkSession();
  };

  #checkSession(): Promise<boolean> {
    if (this.#sessionCheck) return this.#sessionCheck;
    if (
      isPlayerPreview() ||
      this.sessionRecovery ||
      !this.#request ||
      this.authority.state !== "known" ||
      !this.authority.auth.authenticated
    )
      return Promise.resolve(false);
    const previous = this.authority.auth;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.#request.signal, controller.signal]);
    this.#sessionCheckController = controller;
    const check: Promise<boolean> = (async () => {
      try {
        const current = await waitForSignal(getAuth(signal), signal);
        if (signal.aborted || this.authority.state !== "known" || this.authority.auth !== previous)
          return false;
        if (
          current.authenticated &&
          current.realRole === previous.realRole &&
          current.role === previous.role
        ) {
          if (current.csrfToken !== previous.csrfToken) {
            this.#acceptAuthority(current);
            this.#addons?.renewCsrfToken(current.csrfToken);
          }
          return true;
        }
      } catch {
        if (signal.aborted) return false;
      }
      if (this.authority.state !== "known" || this.authority.auth !== previous) return false;
      // Keep core components and their opening revisions mounted. A public
      // refresh here could remove a private record underneath its unsaved form.
      this.sessionRecovery = true;
      this.sessionRestored = false;
      this.#events.close();
      this.liveState = "reconnecting";
      browserDiagnostics.enable(false);
      return false;
    })().finally(() => {
      if (this.#sessionCheck === check) {
        this.#sessionCheck = undefined;
        this.#sessionCheckController = undefined;
      }
    });
    this.#sessionCheck = check;
    return check;
  }

  #cancelSessionCheck(): void {
    const controller = this.#sessionCheckController;
    this.#sessionCheck = undefined;
    this.#sessionCheckController = undefined;
    controller?.abort("authority-changed");
  }

  #acceptAuthority(auth: AuthState): void {
    if (
      this.authority.state === "known" &&
      (this.authority.auth.role !== auth.role || this.authority.auth.realRole !== auth.realRole)
    )
      this.#events.close();
    this.#cancelSessionCheck();
    this.authority = { state: "known", auth };
  }

  #sessionRecoveryTemplate() {
    if (!this.sessionRecovery) return nothing;
    return html`<section class="session-recovery" data-codex-ui data-ui-state="error" aria-labelledby="session-recovery-title">
      <h2 id="session-recovery-title">${this.#ui.t("session.recoverTitle")}</h2>
      <p role="status">${this.#ui.t("session.recoverHint")}</p>
      <form @submit=${this.#resumeSession}>
        <div data-ui-toolbar>
          <div data-ui-field>
            <label for="session-recovery-password">${this.#ui.t("shell.passwordLabel")}</label>
            <input class="ui-control" id="session-recovery-password" name="password" type="password"
              autocomplete="current-password" required ?disabled=${this.busy} />
          </div>
          <button class="ui-button" data-ui-variant="primary" type="submit" ?disabled=${this.busy}>${this.#ui.t("session.resume")}</button>
        </div>
      </form>
      ${this.sessionRecoveryError ? html`<p role="alert">${this.sessionRecoveryError}</p>` : nothing}
    </section>`;
  }

  readonly #resumeSession = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (
      this.busy ||
      !this.sessionRecovery ||
      !this.#request ||
      this.authority.state !== "known" ||
      !this.authority.auth.authenticated
    )
      return;
    const previous = this.authority.auth,
      signal = this.#request.signal;
    const form = event.currentTarget as HTMLFormElement;
    const lease = this.#busy.acquire();
    this.sessionRecoveryError = "";
    try {
      let current = await waitForSignal(
        loginSession(formText(new FormData(form), "password"), signal),
        signal,
      );
      if (signal.aborted) return;
      if (!current.authenticated || current.realRole !== previous.realRole) {
        this.sessionRecoveryError = this.#ui.t("session.sameRole");
        return;
      }
      if (current.role !== previous.role)
        current = await waitForSignal(
          switchSessionRole(previous.role, current.csrfToken, signal),
          signal,
        );
      if (signal.aborted) return;
      if (
        !current.authenticated ||
        current.realRole !== previous.realRole ||
        current.role !== previous.role
      ) {
        this.sessionRecoveryError = this.#ui.t("session.sameRole");
        return;
      }
      this.#acceptAuthority(current);
      this.#addons?.renewCsrfToken(current.csrfToken);
      this.sessionRecovery = false;
      this.sessionRestored = true;
      this.errorMessage = "";
      form.reset();
      await this.#campaign.load(signal, true);
      if (!signal.aborted && !this.sessionRecovery) {
        this.#startEventStream();
        if (this.#addons) await this.#addons.session.start();
        else await this.#recoverAddons(signal);
      }
    } catch {
      if (!signal.aborted) this.sessionRecoveryError = this.#ui.t("session.resumeFailed");
    } finally {
      lease.release();
    }
    if (!signal.aborted && !this.sessionRecovery) {
      await this.updateComplete;
      if (!signal.aborted) this.querySelector<HTMLElement>("#campaign-content")?.focus();
    }
  };

  async #login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.busy || this.#request === undefined) return;
    const form = event.currentTarget as HTMLFormElement;
    const password = formText(new FormData(form), "password");
    const signal = this.#request.signal;
    const lease = this.#busy.acquire();
    this.errorMessage = "";
    try {
      const auth = await waitForSignal(loginSession(password, signal), signal);
      if (signal.aborted) return;
      if (!auth.authenticated) throw new Error("sign-in did not create a session");
      this.#acceptAuthority(auth);
      form.reset();
      // The account menu opened only to sign in; give its room back to the navigation.
      const account = this.querySelector<HTMLDetailsElement>(".account-menu");
      if (account !== null) account.open = false;
      await this.#reloadForAuthority(signal);
    } catch (cause: unknown) {
      if (!signal.aborted)
        this.errorMessage = uiText("Sign-in failed: {0}", { "0": errorMessage(cause) });
    } finally {
      lease.release();
    }
  }

  async #logout(): Promise<void> {
    if (this.busy || this.#request === undefined || !this.#confirmDiscardEdit()) return;
    const signal = this.#request.signal;
    this.#cancelSessionCheck();
    const lease = this.#busy.acquire();
    this.errorMessage = "";
    try {
      await this.#stopAddons();
      if (signal.aborted) return;
      await waitForSignal(logoutSession(signal), signal);
      if (signal.aborted) return;
      this.#acceptAuthority(anonymousAuth());
      this.sessionRecovery = false;
      this.sessionRecoveryError = "";
      this.sessionRestored = false;
      browserDiagnostics.enable(false);
      await this.#campaign.reload(signal);
      if (signal.aborted) return;
      this.#startEventStream();
      if (this.route.kind === "addon") window.location.hash = "#/";
    } catch (cause: unknown) {
      if (!signal.aborted) {
        this.errorMessage = uiText("Sign-out failed: {0}", { "0": errorMessage(cause) });
        await this.#recoverAddons(signal);
      }
    } finally {
      lease.release();
    }
  }

  async #switchRole(): Promise<void> {
    if (
      this.busy ||
      this.#request === undefined ||
      this.authority.state !== "known" ||
      !this.authority.auth.authenticated ||
      this.authority.auth.realRole !== "dm" ||
      !this.#confirmDiscardEdit()
    )
      return;
    const auth = this.authority.auth;
    const signal = this.#request.signal;
    const role = auth.role === "dm" ? "player" : "dm";
    this.#cancelSessionCheck();
    const lease = this.#busy.acquire();
    this.errorMessage = "";
    try {
      await this.#stopAddons();
      if (signal.aborted) return;
      const next = await waitForSignal(switchSessionRole(role, auth.csrfToken, signal), signal);
      if (signal.aborted) return;
      if (!next.authenticated) throw new Error("role switch ended the session");
      this.#acceptAuthority(next);
      await this.#reloadForAuthority(signal);
    } catch (cause: unknown) {
      if (!signal.aborted) {
        this.errorMessage = uiText("View switch failed: {0}", { "0": errorMessage(cause) });
        await this.#recoverAddons(signal);
      }
    } finally {
      lease.release();
    }
  }

  async #reloadForAuthority(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.#events.close();
    this.sessionRestored = false;
    browserDiagnostics.enable(false);
    await this.#campaign.reload(signal);
    if (signal.aborted) return;
    this.#startEventStream();
    try {
      await this.#startAddons(signal);
    } catch (cause: unknown) {
      if (!signal.aborted) {
        this.errorMessage = uiText("Add-ons could not start: {0}", { "0": errorMessage(cause) });
      }
    }
  }

  async #recoverAddons(signal = this.#request?.signal): Promise<void> {
    if (!this.#authenticated() || signal === undefined || signal.aborted) return;
    try {
      await this.#startAddons(signal);
    } catch (cause: unknown) {
      if (signal.aborted) return;
      this.errorMessage += uiText(" Add-on recovery also failed: {0}", {
        "0": errorMessage(cause),
      });
    }
  }

  async #startAddons(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const stopping = this.#stopAddons();
    const owner = this.#addonOwner;
    await stopping;
    if (signal.aborted || owner !== this.#addonOwner) return;
    const auth = this.authority.state === "known" ? this.authority.auth : anonymousAuth();
    browserDiagnostics.enable(auth.authenticated && auth.role === "dm" && auth.realRole === "dm");
    if (!auth.authenticated) return;
    this.addonState = { state: "loading" };
    const composition = createBrowserAddonComposition(document, auth.csrfToken, {
      onRefresh: (_cause, result) => {
        if (owner !== this.#addonOwner) return;
        for (const failure of result.lifecycle.activationFailures)
          browserDiagnostics.record(failure.kind, failure);
        for (const failure of result.lifecycle.disposalFailures)
          browserDiagnostics.record("disposal", failure);
        this.#dmAddonHealth = [
          ...result.lifecycle.active.map((addon) => ({
            id: addon.addonId,
            name: addon.addonName ?? "",
            version: addon.addonVersion,
            state: "ready" as const,
          })),
          ...result.lifecycle.activationFailures.map((failure) => ({
            id: failure.addonId,
            name:
              result.transport.graph.addons.find((addon) => addon.addonId === failure.addonId)
                ?.addonName ?? "",
            version:
              result.transport.graph.addons.find((addon) => addon.addonId === failure.addonId)
                ?.addonVersion ?? "",
            state: failure.kind === "dependency" ? ("blocked" as const) : ("failed" as const),
          })),
        ];
        this.addonState = {
          state: "ready",
          active: result.lifecycle.active.length,
          revision: result.lifecycle.graphRevision,
          failures: result.lifecycle.activationFailures.length,
        };
        this.#refreshOutlets();
      },
      onDiagnostic: (cause) => {
        if (owner === this.#addonOwner) {
          browserDiagnostics.record("refresh", cause);
          this.addonState = { state: "degraded", message: this.#ui.t("dm.failed") };
        }
      },
      onRecoveryRequested: async () => {
        if (owner !== this.#addonOwner || isPlayerPreview()) return false;
        await this.#checkSession();
        return owner === this.#addonOwner && this.sessionRecovery;
      },
      onAuthorityLost: () => {
        if (owner !== this.#addonOwner) return;
        this.#addons = undefined;
        this.#disposeOutlets();
        if (!isPlayerPreview() && (this.#edits.dirty || this.#edits.saving)) {
          this.addonState = { state: "idle" };
          void this.#checkSession().then((available) => {
            if (available && !signal.aborted && owner === this.#addonOwner)
              void this.#recoverAddons(signal);
          });
          return;
        }
        this.#acceptAuthority(anonymousAuth());
        browserDiagnostics.enable(false);
        this.addonState = { state: "idle" };
        this.#campaign.reset();
        this.#startEventStream();
        if (this.#request !== undefined) void this.#campaign.load(this.#request.signal);
      },
    });
    this.#addons = composition;
    try {
      await this.updateComplete;
      if (signal.aborted || owner !== this.#addonOwner) return;
      const navigationRoot = this.querySelector<HTMLElement>("[data-addon-navigation]");
      const dashboardRoot = this.querySelector<HTMLElement>("[data-addon-slot]");
      const articleRoot = this.querySelector<HTMLElement>("[data-addon-article]");
      const routeRoot = this.querySelector<HTMLElement>("[data-addon-route-outlet]");
      if (
        navigationRoot === null ||
        dashboardRoot === null ||
        articleRoot === null ||
        routeRoot === null
      ) {
        throw new Error("browser add-on mounting surfaces are unavailable");
      }
      const onError = (cause: unknown): void => {
        if (owner === this.#addonOwner) {
          browserDiagnostics.record("contribution", cause);
          this.addonState = { state: "degraded", message: this.#ui.t("dm.failed") };
        }
      };
      this.#navigationOutlet = new BrowserNavigationOutlet({
        document,
        root: navigationRoot,
        registry: composition.contributions,
        role: auth.role,
        currentHash: () => window.location.hash,
        locale: () => this.#ui.locale,
        include: (entry) => {
          const mode = addonSidebarMode(
            this.campaignState.state === "ready" ? this.campaignState.campaign : undefined,
            addonSidebarKey(entry),
          );
          return mode === "everyone" || (mode === "dm" && auth.role === "dm");
        },
        onError,
        onCountChange: (count) => {
          if (owner === this.#addonOwner) {
            this.navigationCount = count;
            this.requestUpdate();
          }
        },
      });
      this.#dashboardOutlet = new BrowserContributionOutlet({
        document,
        root: dashboardRoot,
        registry: composition.contributions,
        surface: "slot",
        role: auth.role,
        locale: () => this.#ui.locale,
        include: (active) =>
          this.route.kind === "dashboard" && active.descriptor.config["slot"] === undefined,
        onError,
        onCountChange: (count) => {
          if (owner === this.#addonOwner) this.contributionCount = count;
        },
      });
      this.#articleOutlet = new BrowserContributionOutlet({
        document,
        root: articleRoot,
        registry: composition.contributions,
        surface: "article-section",
        compact: true,
        role: auth.role,
        locale: () => this.#ui.locale,
        include: (active) =>
          this.route.kind === "record" &&
          active.descriptor.config["collection"] === this.route.page.collection,
        hostContext: () => this.#recordContext(),
        handoffKey: () =>
          this.route.kind === "record" && this.#recordContext() !== null
            ? JSON.stringify([this.route.page.collection, this.route.key])
            : undefined,
        onError,
        onCountChange: (count) => {
          if (owner === this.#addonOwner) this.articleCount = count;
        },
      });
      this.#routeOutlet = new BrowserContributionOutlet({
        document,
        root: routeRoot,
        registry: composition.contributions,
        surface: "route",
        // Add-on pages carry their own title; the sidebar already names their add-on.
        compact: true,
        role: auth.role,
        locale: () => this.#ui.locale,
        include: (active) =>
          browserAddonRouteHash(active) ===
          parseBrowserAddonLocation(window.location.hash)?.routeHash,
        hostContext: (active) => {
          const recordReferences = routeRecordReferences(
            this.campaignState.state === "ready" ? this.campaignState.campaign : undefined,
            active,
          );
          return {
            contractVersion: "addon-route-context.v1",
            locale: this.#ui.locale,
            query: parseBrowserAddonLocation(window.location.hash)?.query ?? [],
            ...(recordReferences ? { recordReferences } : {}),
          };
        },
        onError,
        onCountChange: (count) => {
          if (owner === this.#addonOwner) this.routeCount = count;
        },
      });
      await composition.session.start();
    } catch (cause: unknown) {
      if (owner === this.#addonOwner) await this.#stopAddons();
      throw cause;
    }
  }

  #stopAddons(): Promise<void> {
    const owner = ++this.#addonOwner;
    this.#disposeOutlets();
    const addons = this.#addons;
    this.#addons = undefined;
    this.#dmAddonHealth = [];
    this.addonState = { state: "idle" };
    if (addons === undefined) return this.#addonCleanup;
    const stopping = addons.session.stop();
    this.#addonCleanup = (async () => {
      const failures = await stopping;
      for (const failure of failures) browserDiagnostics.record("disposal", failure);
      if (owner === this.#addonOwner && failures.length > 0) {
        this.errorMessage = uiText("Failed to clean up {0} browser add-on resource(s).", {
          "0": failures.length,
        });
      }
    })();
    return this.#addonCleanup;
  }

  #disposeOutlets(): void {
    this.#dashboardOutlet?.dispose();
    this.#articleOutlet?.dispose();
    this.#navigationOutlet?.dispose();
    this.#routeOutlet?.dispose();
    this.#dashboardOutlet = undefined;
    this.#articleOutlet = undefined;
    this.#navigationOutlet = undefined;
    this.#routeOutlet = undefined;
    this.contributionCount = 0;
    this.navigationCount = 0;
    this.routeCount = 0;
    this.articleCount = 0;
  }

  #refreshOutlets(): void {
    this.#navigationOutlet?.refresh();
    this.#dashboardOutlet?.refresh();
    this.#articleOutlet?.refresh();
    this.#routeOutlet?.refresh();
  }

  #recordContext(): unknown {
    if (this.route.kind !== "record" || this.campaignState.state !== "ready") return null;
    const collection = campaignCollection(this.campaignState.campaign, this.route.page.collection);
    const recordKey = this.route.key;
    const record = collection.records.find(({ key }) => key === recordKey);
    if (record === undefined) return null;
    return {
      kind: "campaign-record",
      locale: this.#ui.locale,
      collection: this.route.page.collection,
      key: record.key,
      revision: record.revision,
      value: record.value,
      canEdit: this.#canEdit(),
    };
  }

  #navigationTemplate() {
    let layout;
    try {
      layout = campaignSidebar(
        this.campaignState.state === "ready" ? this.campaignState.campaign : undefined,
      );
    } catch {
      layout = defaultSidebarLayout();
    }
    return html`
      <nav class="core-navigation" aria-label=${this.#ui.t("shell.campaignArchive")}>
        ${layout.sections.map((group) => {
          if (group.role === "dm" && !this.#canManageCampaign()) return nothing;
          const entries = group.pages.flatMap((route) => {
            const page = sidebarPage(route);
            return page === undefined ? [] : [page];
          });
          if (entries.length === 0) return nothing;
          const open = !group.collapsible || this.#sidebarSectionOpen(group);
          return html`<section class=${`navigation-${group.id}`} data-navigation-section=${group.id}>
            <h2>${
              group.collapsible
                ? html`<button class="sidebar-section-toggle" aria-expanded=${open} @click=${() => this.#toggleSidebarSection(group)}>
              <span aria-hidden="true">${open ? "▾" : "▸"}</span> ${group.icon} ${group.label}</button>`
                : html`${group.icon} ${group.label}`
            }</h2>
            <div ?hidden=${!open}>${entries.map(
              (entry) => html`
              <a href=${`#${entry.route}`} aria-current=${this.#coreRouteActive(entry.id) ? "page" : nothing}>
                <span aria-hidden="true">${entry.icon}</span>${entry.label}
              </a>
            `,
            )}</div>
          </section>`;
        })}
      </nav>
    `;
  }

  async #openPreview(): Promise<void> {
    if (
      this.busy ||
      this.#request === undefined ||
      this.authority.state !== "known" ||
      !this.authority.auth.authenticated ||
      this.authority.auth.role !== "dm"
    )
      return;
    const popup = window.open("about:blank", "_blank");
    if (popup === null) {
      this.errorMessage = this.#ui.t("preview.blocked");
      return;
    }
    popup.opener = null;
    const signal = this.#request.signal;
    const closePendingPreview = () => popup.close();
    signal.addEventListener("abort", closePendingPreview, { once: true });
    const lease = this.#busy.acquire();
    this.errorMessage = "";
    try {
      const token = await waitForSignal(
        createPlayerPreview(this.authority.auth.csrfToken, signal),
        signal,
      );
      if (signal.aborted) return;
      if (!popup.closed) popup.location.replace(playerPreviewURL(token));
    } catch {
      popup.close();
      if (!signal.aborted) this.errorMessage = this.#ui.t("preview.failed");
    } finally {
      signal.removeEventListener("abort", closePendingPreview);
      lease.release();
    }
  }

  async #closePreview(): Promise<void> {
    if (!isPlayerPreview() || !this.#confirmDiscardEdit()) return;
    if (this.#request !== undefined) await logoutSession(this.#request.signal).catch(() => {});
    window.close();
    // A manually opened tab may not be script-closable; keep it in expired preview mode.
    if (!window.closed) window.location.reload();
  }

  readonly #sidebarOpen = new Map<string, boolean>();
  #sidebarSectionOpen(section: SidebarSection): boolean {
    const cached = this.#sidebarOpen.get(section.id);
    if (cached !== undefined) return cached;
    try {
      const saved = localStorage.getItem(`sidebar_section_open:${section.id}`);
      if (saved === "0" || saved === "1") return saved === "1";
    } catch {
      /* Optional browser preference. */
    }
    return section.defaultOpen;
  }
  #toggleSidebarSection(section: SidebarSection): void {
    const open = !this.#sidebarSectionOpen(section);
    this.#sidebarOpen.set(section.id, open);
    try {
      localStorage.setItem(`sidebar_section_open:${section.id}`, open ? "1" : "0");
    } catch {
      /* Keep the in-memory preference. */
    }
    this.requestUpdate();
  }

  #mobileNavigationTemplate() {
    return html`
      <nav class="mobile-navigation" aria-label=${this.#ui.t("shell.primaryNavigation")}>
        <a href="#/" aria-current=${this.#coreRouteActive("dashboard") ? "page" : nothing}><span aria-hidden="true">🏠</span>${this.#ui.t("shell.overview")}</a>
        <a href="#/party" aria-current=${this.#coreRouteActive("party") ? "page" : nothing}><span aria-hidden="true">🛡</span>${this.#ui.t("shell.party")}</a>
        <a href="#/search" aria-current=${this.#coreRouteActive("search") ? "page" : nothing}><span aria-hidden="true">🔍</span>${this.#ui.t("shell.search")}</a>
        <a href="#/timeline" aria-current=${this.#coreRouteActive("timeline") ? "page" : nothing}><span aria-hidden="true">⏳</span>${this.#ui.t("timeline.title")}</a>
        <button type="button" data-menu-toggle aria-expanded=${this.menuOpen} aria-controls="campaign-sidebar" @click=${this.#toggleMenu}><span aria-hidden="true">☰</span>${this.#ui.t("shell.menu")}</button>
      </nav>
    `;
  }

  readonly #onViewportChange = (): void => {
    this.mobileViewport = this.#mobileMedia.matches;
    if (!this.mobileViewport) this.menuOpen = false;
  };

  readonly #focusContent = (event: Event): void => {
    event.preventDefault();
    this.menuOpen = false;
    void this.updateComplete.then(() => {
      const content = this.querySelector<HTMLElement>("#campaign-content");
      content?.focus();
      content?.scrollIntoView();
    });
  };

  readonly #toggleMenu = (): void => {
    if (this.menuOpen) {
      this.#closeMenu();
      return;
    }
    this.menuOpen = true;
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(".sidebar-search")?.focus(),
    );
  };

  readonly #closeMenu = (): void => {
    this.menuOpen = false;
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>("[data-menu-toggle]")?.focus(),
    );
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape" && this.menuOpen) {
      event.preventDefault();
      this.#closeMenu();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (this.quickSearchOpen) this.#closeQuickSearch();
      else this.#openQuickSearch();
    }
  };

  readonly #openQuickSearch = (event?: MouseEvent): void => {
    if (
      event &&
      (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
    )
      return;
    if (this.campaignState.state !== "ready") return;
    event?.preventDefault();
    this.#searchReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.menuOpen = false;
    this.quickSearchOpen = true;
  };

  #closeQuickSearch(restoreFocus = true): void {
    this.querySelector<HTMLDialogElement>(".quick-search-dialog")?.close();
    this.quickSearchOpen = false;
    if (restoreFocus) {
      const previous = this.#searchReturnFocus;
      void this.updateComplete.then(() => {
        if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
        else
          this.querySelector<HTMLElement>(
            this.mobileViewport ? "[data-menu-toggle]" : ".sidebar-search",
          )?.focus();
      });
    }
    this.#searchReturnFocus = undefined;
  }

  #accountTemplate() {
    if (isPlayerPreview())
      return html`<section class="account-panel"><p>${this.#ui.t("shell.viewingAs")} <strong>${this.#ui.t("shell.player")}</strong></p>
      <button class="text-button" type="button" @click=${() => this.#closePreview()}>${this.#ui.t("preview.close")}</button></section>`;
    if (this.authority.state === "checking") {
      return html`<section class="account-panel"><p class="loading-line">${this.#ui.t("shell.checkingSession")}</p></section>`;
    }
    if (!this.authority.auth.authenticated) {
      return html`
        <section class="account-panel">
          <h2>${this.#ui.t("shell.privateArchive")}</h2>
          <form @submit=${(event: SubmitEvent) => this.#login(event)}>
            <label>
              <span class="visually-hidden">${this.#ui.t("shell.passwordLabel")}</span>
              <input name="password" type="password" minlength="4" autocomplete="current-password" placeholder=${this.#ui.t("shell.passwordPlaceholder")} required />
            </label>
            <button type="submit" ?disabled=${this.busy}>${this.#ui.t("shell.signIn")}</button>
          </form>
        </section>
      `;
    }
    return html`
      <section class="account-panel signed-in">
        <button class="text-button" type="button" @click=${() => this.#logout()} ?disabled=${this.busy}>${this.#ui.t("shell.signOut")}</button>
        <small title=${this.#addonStateTitle()}>${this.#addonStateLabel()}</small>
      </section>
    `;
  }

  /** Role switching stays outside the account menu because DMs use it during play. */
  #viewAsTemplate() {
    if (isPlayerPreview() || this.authority.state !== "known") return nothing;
    const auth = this.authority.auth;
    if (!auth.authenticated || auth.realRole !== "dm") return nothing;
    const toPlayer = auth.role === "dm";
    return html`<button class="sidebar-footer-action" type="button"
      @click=${() => (toPlayer ? this.#openPreview() : this.#switchRole())} ?disabled=${this.busy}
      title=${toPlayer ? this.#ui.t("preview.openHint") : nothing}>
      <span aria-hidden="true">👁</span>${this.#ui.t("shell.viewAs", { role: toPlayer ? this.#ui.t("shell.player") : uiText("DM") })}
    </button>`;
  }

  #addonStateLabel(): string {
    const state = this.addonState;
    switch (state.state) {
      case "idle":
        return this.#ui.t("shell.addonsIdle");
      case "loading":
        return this.#ui.t("shell.addonsLoading");
      case "ready":
        return state.failures === 0
          ? this.#ui.plural("shell.browserAddonsRunning", state.active)
          : this.#ui.t("shell.addonsActiveFailed", {
              active: state.active,
              failed: state.failures,
            });
      case "degraded":
        return this.#ui.t("shell.addonsAttention");
    }
  }

  #addonStateTitle(): string {
    if (this.addonState.state === "ready") return this.addonState.revision;
    if (this.addonState.state === "degraded") return this.addonState.message;
    return this.#addonStateLabel();
  }

  #accountMenuLabel(): string {
    if (this.authority.state === "checking") return this.#ui.t("shell.menu");
    if (!this.authority.auth.authenticated) return this.#ui.t("shell.signIn");
    return this.authority.auth.role === "dm"
      ? this.#ui.t("shell.signedInDm")
      : this.#ui.t("shell.signedInPlayer");
  }

  #hostStatusTemplate() {
    if (this.readiness.state === "checking") {
      return html`<span class="host-state"><span aria-hidden="true"></span>${this.#ui.t("shell.checkingHost")}</span>`;
    }
    if (this.readiness.state === "unavailable") {
      return html`<span class="host-state host-unavailable" title=${this.readiness.message}><span aria-hidden="true"></span>${this.#ui.t("shell.hostUnavailable")}</span>`;
    }
    return html`<span class="host-state" title=${`Codex ${this.readiness.health.version}`}><span aria-hidden="true"></span>Codex ${this.readiness.health.version}</span>`;
  }

  #campaignTemplate() {
    if (this.campaignState.state === "loading") {
      return html`<section class="loading-page" aria-live="polite"><span aria-hidden="true">✦</span><p>${this.#ui.t("shell.openingCampaign")}</p></section>`;
    }
    if (this.campaignState.state === "unavailable") {
      return html`
        <section class="unavailable-page">
          <p class="page-kicker">${this.#ui.t("shell.campaignArchive")}</p>
          <h1>${this.#ui.t("shell.campaignOpenFailed")}</h1>
          <p>${this.campaignState.message}</p>
          <button type="button" @click=${this.#retryCampaign} ?disabled=${this.busy}>${this.#ui.t("shell.tryAgain")}</button>
        </section>
      `;
    }
    const campaign = this.campaignState.campaign;
    switch (this.route.kind) {
      case "dm":
        return html`<codex-dm-dashboard .campaign=${campaign} .canManage=${this.#canManageCampaign()}
          .registry=${this.#addons?.contributions} .health=${this.#dmAddonHealth}
          .loading=${this.addonState.state === "loading"}
          .degraded=${this.addonState.state === "degraded" || (this.addonState.state === "ready" && this.addonState.failures > 0)}
          @dm-retry-addons=${this.#retryDmAddons}></codex-dm-dashboard>`;
      case "campaign-graph":
        return html`<codex-campaign-graph .campaign=${campaign} .mode=${this.route.mode}
          .registry=${this.#addons?.contributions} .actorRole=${this.#actorRole}></codex-campaign-graph>`;
      case "timeline":
        return html`<codex-timeline .campaign=${campaign} .canEdit=${this.#canEdit()} .busy=${this.busy}
          .registry=${this.#addons?.contributions} .actorRole=${this.#actorRole}
          @campaign-edit-dirty=${this.#onEditDirty}></codex-timeline>`;
      case "map":
        return html`<codex-map .campaign=${campaign} .route=${this.route} .canEdit=${this.#canEdit()}
          .registry=${this.#addons?.contributions}
          .actorRole=${this.#actorRole}
          .canManageCampaign=${this.#canManageCampaign()} .busy=${this.busy}
          @campaign-edit-dirty=${this.#onEditDirty}></codex-map>`;
      case "dashboard":
      case "party":
        return html`<codex-dashboard .campaign=${campaign} .partyOnly=${this.route.kind === "party"}
          .authenticated=${this.#authenticated()} .canManageCampaign=${this.#canManageCampaign()} .canEdit=${this.#canEdit()}
          .busy=${this.busy} @campaign-edit-dirty=${this.#onEditDirty}
          @campaign-sign-in=${this.#showSignIn}
        ></codex-dashboard>`;
      case "search":
        return html`<codex-search .campaign=${campaign} .query=${this.route.query ?? ""} .registry=${this.#addons?.contributions}
          .actorRole=${this.#actorRole}></codex-search>`;
      case "settings":
        return html`<codex-settings
          .registry=${this.#addons?.contributions}
          .actorRole=${this.#actorRole}
          .addonTarget=${this.route.addonId}
          .category=${this.route.category}
          .addonPages=${this.#canManageCampaign() && this.#addons !== undefined ? listBrowserNavigation(this.#addons.contributions, "dm", this.#ui.locale) : []}
          .csrfToken=${this.authority.state === "known" && this.authority.auth.authenticated ? this.authority.auth.csrfToken : ""}
          .campaign=${campaign}
          .mapTarget=${this.route.mapParentId}
          .canManageCampaign=${this.#canManageCampaign()}
          .busy=${this.busy}
          @campaign-edit-dirty=${this.#onEditDirty}
        ></codex-settings>`;
      case "collection":
      case "record":
      case "create":
        return html`<codex-record-page
          .campaign=${campaign}
          .registry=${this.#addons?.contributions}
          .actorRole=${this.#actorRole}
          .route=${this.route}
          .canEdit=${this.#canEdit()}
          .canManageVisibility=${this.#canManageCampaign()}
          .busy=${this.busy}
          @campaign-edit-dirty=${this.#onEditDirty}
          @campaign-record-saved=${this.#onRecordSaved}
          @campaign-collection-view=${(event: CustomEvent<{ hash: string }>) => {
            const route = parseAppRoute(event.detail.hash);
            if (
              route.kind !== "collection" ||
              this.route.kind !== "collection" ||
              route.page.id !== this.route.page.id
            )
              return;
            window.history.replaceState(null, "", event.detail.hash);
            this.#acceptedHash = event.detail.hash;
            this.route = route;
          }}
          @campaign-sign-in=${this.#showSignIn}
        ></codex-record-page>`;
      case "addon":
        if (!this.#authenticated()) {
          return html`<section class="unavailable-page"><p class="page-kicker">${this.#ui.t("shell.addonPage")}</p><h1>${this.#ui.t("shell.signInAddon")}</h1><p>${this.#ui.t("shell.addonRoleHint")}</p></section>`;
        }
        if (this.routeCount === 0) {
          return html`<section class="loading-page"><span aria-hidden="true">✦</span><p>${this.#ui.t("shell.openingAddon")}</p></section>`;
        }
        return nothing;
      case "not-found":
        return html`<section class="unavailable-page"><p class="page-kicker">${this.#ui.t("shell.campaignArchive")}</p><h1>${this.#ui.t("shell.pageMissing")}</h1><p>${this.#ui.t("shell.pageMissingHint")}</p><a class="primary-link" href="#/">${this.#ui.t("shell.returnOverview")}</a></section>`;
    }
  }

  #coreRouteActive(id: string): boolean {
    if (id.startsWith("graph-"))
      return this.route.kind === "campaign-graph" && id === `graph-${this.route.mode}`;
    if (id === "map") return this.route.kind === "map";
    if (id === "dashboard") return this.route.kind === "dashboard";
    if (id === "search") return this.route.kind === "search";
    if (id === "party")
      return (
        this.route.kind === "party" ||
        (this.route.kind === "create" && this.route.preset === "party")
      );
    if (id === "timeline")
      return (
        this.route.kind === "timeline" ||
        (this.route.kind === "create" && this.route.preset === "event")
      );
    if (id === "settings") return this.route.kind === "settings";
    return (
      (this.route.kind === "collection" || this.route.kind === "record") &&
      this.route.page.id === id
    );
  }

  #authenticated(): boolean {
    return this.authority.state === "known" && this.authority.auth.authenticated;
  }

  #canEdit(): boolean {
    return this.#authenticated();
  }

  #canManageCampaign(): boolean {
    return (
      this.authority.state === "known" &&
      this.authority.auth.authenticated &&
      this.authority.auth.role === "dm"
    );
  }

  #longPressAt = 0;

  readonly #onContextMenu = (event: MouseEvent): void => {
    // Shift keeps the browser's own menu for copying, inspecting and the like.
    if (event.shiftKey || event.defaultPrevented) return;
    // Touch long-press can also fire a native contextmenu; the menu is already open.
    if (Date.now() - this.#longPressAt < 700) {
      event.preventDefault();
      return;
    }
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const target = event.target as Element;
    const anchor = keyboard ? target.getBoundingClientRect() : undefined;
    if (
      this.#openRecordMenu(
        target,
        anchor ? { x: anchor.left, y: anchor.bottom } : { x: event.clientX, y: event.clientY },
      )
    )
      event.preventDefault();
  };

  /** Opens the record menu for a record link or the current record's header. */
  #openRecordMenu(target: Element, point: { x: number; y: number }): boolean {
    if (this.campaignState.state !== "ready") return false;
    if (target.closest("input, textarea, select, [contenteditable], .ui-menu, dialog"))
      return false;
    const link = target.closest<HTMLAnchorElement>("a[href^='#/']");
    let route = link ? parseAppRoute(link.getAttribute("href") ?? "") : undefined;
    if (
      route?.kind !== "record" &&
      this.route.kind === "record" &&
      target.closest(".record-masthead, .character-page-heading")
    )
      route = this.route;
    if (route?.kind !== "record") return false;
    const editing = this.#addons?.contributions.edits.state();
    const menu = recordContextMenu(this.campaignState.campaign, route.page, route.key, {
      canEdit: this.#canEdit(),
      current:
        this.route.kind === "record" &&
        this.route.page.id === route.page.id &&
        this.route.key === route.key,
      writeBlocked:
        this.busy || this.#edits.dirty || this.#edits.saving || editing?.dirty || editing?.saving
          ? uiText("menu.blocked")
          : "",
      navigate: (hash) => {
        window.location.hash = hash;
      },
      openInNewTab: (hash) => {
        window.open(new URL(hash, window.location.href).href, "_blank", "noopener");
      },
      copy: (text, done) => {
        navigator.clipboard.writeText(text).then(
          () => this.#notify(done),
          () => this.#notify(uiText("menu.copyFailed")),
        );
      },
      patch: (collection, record, fields, done) => {
        void this.#writes
          .save("record-patch", { collection, base: record, fields })
          .then((result) => this.#notify(result.ok ? done : result.message));
      },
    });
    if (!menu) return false;
    openContextMenu(document, point, menu.items, {
      title: menu.title,
      returnFocus: link ?? target.closest<HTMLElement>("[tabindex], button, a"),
    });
    return true;
  }

  #notify(message: string): void {
    clearTimeout(this.#contextNoticeTimer);
    this.contextNotice = message;
    this.#contextNoticeTimer = setTimeout(() => {
      this.contextNotice = "";
    }, 4000);
  }

  readonly #retryDmAddons = async (): Promise<void> => {
    if (!this.#canManageCampaign() || this.busy || this.addonState.state === "loading") return;
    const signal = this.#request?.signal;
    if (signal === undefined || signal.aborted) return;
    try {
      await this.#startAddons(signal);
    } catch {
      if (!signal.aborted)
        this.addonState = { state: "degraded", message: this.#ui.t("dm.failed") };
    }
  };

  readonly #showSignIn = async (): Promise<void> => {
    if (this.#authenticated()) return;
    if (this.mobileViewport) this.menuOpen = true;
    await this.updateComplete;
    const account = this.querySelector<HTMLDetailsElement>(".account-menu");
    if (account !== null) account.open = true;
    this.querySelector<HTMLInputElement>('.account-panel input[name="password"]')?.focus();
  };

  readonly #onHashChange = (): void => {
    const nextHash = normalizedHash(window.location.hash);
    if (nextHash !== this.#acceptedHash && !this.#confirmDiscardEdit(nextHash)) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${this.#acceptedHash}`,
      );
      return;
    }
    if (window.location.hash && nextHash !== window.location.hash)
      window.history.replaceState(null, "", nextHash);
    if (nextHash === this.#acceptedHash) return;
    this.menuOpen = false;
    this.#acceptedHash = nextHash;
    if (nextHash !== this.#recordSaveDestination) this.recordSaved = false;
    if (this.quickSearchOpen) this.#closeQuickSearch(false);
    this.route = parseAppRoute(nextHash);
    this.characterView = preferredCharacterView(nextHash);
    void this.updateComplete.then(() => this.#refreshOutlets());
  };

  readonly #onEditDirty = (event: CustomEvent<EditState>): void => {
    this.#edits.record(event);
    if (event.detail?.dirty) this.recordSaved = false;
  };

  /** The confirmation stays visible on the page the saved form returns to. */
  readonly #onRecordSaved = (event: CustomEvent<CampaignRecordSavedDetail>): void => {
    this.#recordSaveDestination = normalizedHash(event.detail.destination);
    this.recordSaved = true;
  };

  readonly #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    const edits = this.#addons?.contributions.edits.state();
    protectUnsavedEditBeforeUnload(
      this.#edits.dirty ||
        this.#edits.saving ||
        this.busy ||
        edits?.dirty === true ||
        edits?.saving === true,
      event,
    );
  };

  #confirmDiscardEdit(nextHash?: string): boolean {
    if (this.busy || this.#edits.saving) return false;
    const currentRoute = parseBrowserAddonLocation(this.#acceptedHash)?.routeHash;
    const nextRoute =
      nextHash === undefined ? undefined : parseBrowserAddonLocation(nextHash)?.routeHash;
    const edits = this.#addons?.contributions.edits.state(
      (active) =>
        currentRoute !== undefined &&
        currentRoute === nextRoute &&
        active.descriptor.surface === "route" &&
        browserAddonRouteHash(active) === currentRoute,
    );
    if (edits?.saving) {
      this.errorMessage = uiText("Wait for the add-on save to finish before leaving this view.");
      return false;
    }
    if (
      !confirmDiscardUnsavedEdit(this.#edits.dirty || edits?.dirty === true, (message) =>
        window.confirm(message),
      )
    )
      return false;
    this.#edits.clear();
    return true;
  }

  readonly #dismissError = (): void => {
    this.errorMessage = "";
  };

  readonly #retryCampaign = (): void => {
    if (this.#request === undefined) return;
    void this.#campaign.reload(this.#request.signal);
  };
}

function anonymousAuth(): AuthState {
  return { authenticated: false, role: null, realRole: null };
}

function preferredCharacterView(hash: string): "profile" | "addons" {
  const route = parseAppRoute(hash);
  if (route.kind === "record" && route.editing) return "profile";
  try {
    if (
      route.kind === "record" &&
      route.page.collection === "characters" &&
      window.sessionStorage.getItem(`codex:character-view:${route.key}`) === "addons"
    )
      return "addons";
  } catch {
    /* Default to the profile when browser storage is unavailable. */
  }
  return "profile";
}

function normalizedHash(value: string): string {
  return canonicalAppHash(value);
}

function errorMessage(cause: unknown): string {
  return uiRequestError(cause);
}

function liveMessageKey(state: LiveState): MessageKey {
  switch (state) {
    case "connecting":
      return "shell.connecting";
    case "connected":
      return "shell.live";
    case "reconnecting":
      return "shell.reconnecting";
  }
}

if (!customElements.get("codex-app")) {
  customElements.define("codex-app", CodexApp);
}
