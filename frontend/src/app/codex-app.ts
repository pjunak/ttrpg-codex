import type { CampaignTwinRequest } from "./codex-record-twins.js";
import { uiText } from "./ui-localization.js";
import { attachCharacterPortrait } from "./character-portrait.js";
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
import {
  campaignCollection,
  CampaignDataClient,
  type CampaignDataset,
} from "../core/campaign-data.js";
import {
  CampaignMutationClient,
  CampaignMutationHTTPError,
  type CampaignEnumDeleteMutation,
  type CampaignMutation,
} from "../core/campaign-mutations.js";
import {
  applyCampaignTheme,
  CampaignAppearanceEditError,
  prepareCampaignAppearanceSave,
  type CampaignAppearanceSaveDetail,
} from "./campaign-appearance.js";
import { SharedEventStream, type EventRefresh } from "../core/event-stream.js";
import { isPlayerPreview, playerPreviewURL, previewResourceURL } from "../core/player-preview.js";
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
import { applyBrandingFavicon, BrandingEditError, campaignBranding, defaultLogo, prepareBrandingSave, type BrandingSaveDetail } from "./campaign-branding.js";
import {
  CampaignRecordEditError,
  prepareCampaignRecordDelete,
  prepareCampaignRecordSave,
  prepareCharacterPatch,
  type CampaignCharacterSaveRequest,
  type CampaignEditDirtyDetail,
  type CampaignRecordDeleteDetail,
  type CampaignRecordSaveDetail,
  type PreparedCampaignRecordTransaction,
} from "./campaign-record-editor.js";
import {
  CampaignSettingsEditError,
  prepareCampaignEnumDelete,
  prepareCampaignEnumSave,
  type CampaignEnumSaveDetail,
} from "./campaign-settings.js";
import {
  confirmDiscardUnsavedEdit,
  protectUnsavedEditBeforeUnload,
} from "./unsaved-edit.js";
import {
  collectionHash,
  parseAppRoute, canonicalAppHash,
  recordHash,
  type AppRoute,
} from "./routes.js";
import {
  UiLocalizationController,
  type MessageKey,
} from "./ui-localization.js";
import "./codex-dashboard.js";
import { type DmAddonHealth } from "./codex-dm-dashboard.js";
import "./codex-dm-dashboard.js";
import "./codex-record-page.js";
import { AddonLinksController } from "./addon-links-controller.js";
import { bindRuleDetails } from "./codex-addon-rule-details.js";
import "./codex-search.js";
import { rememberRecentRecord } from "./recent-records.js";
import { creationBackHash, creationSource } from "./context-creation.js";
import { containDialogTab } from "./dialog-focus.js";
import "./codex-settings.js";
import "./codex-addon-markdown.js";
import { CampaignPartyEditError, prepareCampaignPartySave, type CampaignPartySaveDetail } from "./campaign-party.js";
import { CampaignIdentityEditError, prepareCampaignIdentitySave, type CampaignIdentitySaveDetail } from "./campaign-identity.js";
import { MediaClient } from "../core/media.js";
import { CampaignMapEditError, mapLocationRecord, prepareMapSave, prepareLocalMapImage, type MapSaveDetail, type MapUploadDetail } from "./campaign-map.js";
import "./codex-map.js";
import "./codex-timeline.js";
import "./codex-campaign-graph.js";
import { prepareTimelineReorder, TimelineEditError, type TimelineDraft } from "./campaign-timeline.js";
import { campaignSidebar, defaultSidebarLayout, prepareSidebarSave, sidebarPage, SidebarEditError, type SidebarSection, type SidebarSaveDetail } from "./campaign-sidebar.js";
import { addonSidebarKey, addonSidebarMode, prepareAddonSidebarSave } from "./campaign-sidebar.js";

type Readiness =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly health: Health }
  | { readonly state: "unavailable"; readonly message: string };

type Authority =
  | { readonly state: "checking" }
  | { readonly state: "known"; readonly auth: AuthState };

type CampaignState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly campaign: CampaignDataset }
  | { readonly state: "unavailable"; readonly message: string };

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
    campaignState: { state: true },
    addonState: { state: true },
    liveState: { state: true },
    route: { state: true },
    busy: { state: true },
    errorMessage: { state: true },
    recordSaveState: { state: true },
    contributionCount: { state: true },
    navigationCount: { state: true },
    routeCount: { state: true },
    articleCount: { state: true },
    characterView: { state: true },
    editCompletion: { state: true },
    menuOpen: { state: true },
    mobileViewport: { state: true },
    quickSearchOpen: { state: true },
  };

  declare private readiness: Readiness;
  declare private authority: Authority;
  declare private campaignState: CampaignState;
  declare private addonState: AddonState;
  declare private liveState: LiveState;
  declare private route: AppRoute;
  declare private busy: boolean;
  declare private errorMessage: string;
  declare private recordSaveState: "idle" | "saved" | "failed";
  #recordSaveDestination = "";
  declare private contributionCount: number;
  declare private navigationCount: number;
  declare private routeCount: number;
  declare private articleCount: number;
  declare private characterView: "profile" | "addons";
  declare private editCompletion: number;

  declare private menuOpen: boolean;
  declare private mobileViewport: boolean;
  declare private quickSearchOpen: boolean;
  #searchReturnFocus: HTMLElement | undefined;
  readonly #mobileMedia = window.matchMedia("(max-width: 768px)");
  #request: AbortController | undefined;
  readonly #campaignData = new CampaignDataClient();
  readonly #campaignMutations = new CampaignMutationClient();
  readonly #events = new SharedEventStream();
  readonly #ui = new UiLocalizationController(this);
  #addons: BrowserAddonComposition | undefined;
  readonly #links = new AddonLinksController(this, () => ({ registry: this.#addons?.contributions,
    role: this.authority.state === "known" ? this.authority.auth.role ?? undefined : undefined }));
  #disposeRuleDetails: (() => void) | undefined;
  #dmAddonHealth: readonly DmAddonHealth[] = [];
  #outletLocale = "";
  #dashboardOutlet: BrowserContributionOutlet | undefined;
  #articleOutlet: BrowserContributionOutlet | undefined;
  #navigationOutlet: BrowserNavigationOutlet | undefined;
  #routeOutlet: BrowserContributionOutlet | undefined;
  #addonOwner = 0;
  #editDirty = false;
  #editSaving = false;
  #acceptedHash = "#/";

  constructor() {
    super();
    this.readiness = { state: "checking" };
    this.authority = { state: "checking" };
    this.campaignState = { state: "loading" };
    this.addonState = { state: "idle" };
    this.liveState = "connecting";
    this.route = { kind: "dashboard" };
    this.busy = false;
    this.errorMessage = "";
    this.contributionCount = 0;
    this.navigationCount = 0;
    this.routeCount = 0;
    this.articleCount = 0;
    this.characterView = preferredCharacterView(window.location.hash);
    this.editCompletion = 0;
    this.recordSaveState = "idle";
    this.menuOpen = false;
    this.quickSearchOpen = false;
    this.mobileViewport = this.#mobileMedia.matches;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#disposeRuleDetails = bindRuleDetails(this, this.#links);
    this.#acceptedHash = normalizedHash(window.location.hash);
    if (window.location.hash && this.#acceptedHash !== window.location.hash) window.history.replaceState(null, "", this.#acceptedHash);
    this.route = parseAppRoute(this.#acceptedHash);
    window.addEventListener("hashchange", this.#onHashChange);
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    window.addEventListener("keydown", this.#onKeyDown);
    this.#mobileMedia.addEventListener("change", this.#onViewportChange);
    this.#request = new AbortController();
    void this.#bootstrap(this.#request.signal);
  }

  override disconnectedCallback(): void {
    this.#disposeRuleDetails?.(); this.#disposeRuleDetails = undefined;
    this.#request?.abort("component-disconnected");
    this.#request = undefined;
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
    const branding = campaignBranding(this.campaignState.state === "ready" ? this.campaignState.campaign : undefined);
    return html`
      <a class="skip-link" href="#campaign-content" @click=${this.#focusContent}>${this.#ui.t("shell.skip")}</a>
      <div class="codex-shell">
        <aside id="campaign-sidebar" class=${`campaign-sidebar ${this.menuOpen ? "is-open" : ""}`} .inert=${this.mobileViewport && !this.menuOpen}>
          <header class="campaign-brand">
            <a href="#/" aria-label=${this.#ui.t("shell.openOverview")}>
              <img class="campaign-sigil" src=${previewResourceURL(branding.logoUrl || defaultLogo)} alt="" @error=${(event: Event) => {
                const image = event.currentTarget as HTMLImageElement; if (image.getAttribute("src") !== defaultLogo) image.src = defaultLogo;
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
            <a href="#/settings" aria-current=${this.#coreRouteActive("settings") ? "page" : nothing}>⚙ ${this.#ui.t("shell.settings")}</a>
            <details class="account-menu">
              <summary>${this.#mobileAccountLabel()}</summary>
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
          ${isPlayerPreview() ? html`<div class="player-preview-notice" role="status">
            ${this.#ui.t(this.authority.state === "checking" ? "shell.checkingSession" : this.#authenticated() ? "preview.notice" : "preview.unavailable")}
            <button class="text-button" type="button" @click=${this.#closePreview}>${this.#ui.t("preview.close")}</button>
          </div>` : nothing}
          ${this.liveState === "reconnecting" ? html`<p class="connection-alert" role="status">${this.#ui.t("shell.reconnecting")}</p>` : nothing}
          ${this.errorMessage === "" ? nothing : html`
            <p class="application-alert" role="alert">
              <span>${this.errorMessage}</span>
              <button type="button" @click=${this.#dismissError}>${this.#ui.t("shell.dismiss")}</button>
            </p>
          `}
          ${this.recordSaveState === "saved" && this.#canEdit() ? html`<p class="record-save-confirmation" role="status">${uiText("save.entrySaved")}</p>` : nothing}
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
            ${this.#hasCharacterTabs ? html`<header class="character-sheet-heading"><h1>${this.#characterName}</h1></header>` : nothing}
            <section class="addon-article" data-addon-article hidden aria-label=${this.#ui.t("shell.recordAddons")}></section>
          </div>
          <section class="addon-route" data-addon-route-outlet hidden aria-label=${this.#ui.t("shell.addonPage")}></section>
        </main>

        ${this.#mobileNavigationTemplate()}
      </div>
      ${this.quickSearchOpen && this.campaignState.state === "ready" ? html`<dialog class="quick-search-dialog" aria-labelledby="quick-search-title"
        @keydown=${(event: KeyboardEvent) => containDialogTab(event.currentTarget as HTMLDialogElement, event)}
        @click=${(event: MouseEvent) => {
          const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
          if (link?.hash === this.#acceptedHash && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); this.#closeQuickSearch(); }
        }}
        @cancel=${(event: Event) => { event.preventDefault(); this.#closeQuickSearch(); }}>
        <button type="button" class="record-action quick-search-close" @click=${() => this.#closeQuickSearch()}>${this.#ui.t("jump.close")}</button>
        <codex-search .quick=${true} .campaign=${this.campaignState.campaign} .registry=${this.#addons?.contributions}
          .actorRole=${this.authority.state === "known" ? this.authority.auth.role ?? undefined : undefined}></codex-search>
      </dialog>` : nothing}
    `;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("authority") || this.campaignState.state !== "ready") this.quickSearchOpen = false;
  }

  protected override updated(): void {
    const searchDialog = this.querySelector<HTMLDialogElement>(".quick-search-dialog");
    if (searchDialog && !searchDialog.open) searchDialog.showModal();
    if (this.campaignState.state === "ready") rememberRecentRecord(this.campaignState.campaign, this.route,
      this.authority.state === "known" ? this.authority.auth.role ?? "public" : "public");
    if (this.isConnected && this.route.kind === "not-found") {
      const target = this.#links.resolve({ path: window.location.hash });
      if (target.status === "resolved") {
        window.history.replaceState(null, "", target.href);
        this.#onHashChange();
      }
    }
    if (this.isConnected && this.#outletLocale !== this.#ui.locale) {
      this.#outletLocale = this.#ui.locale;
      this.#routeOutlet?.refresh();
      this.#articleOutlet?.refresh();
      this.#navigationOutlet?.refresh();
    }
  }

  get #hasCharacterTabs(): boolean {
    return this.route.kind === "record" && this.route.page.collection === "characters" && this.articleCount > 0 && this.#recordContext() !== null;
  }

  get #characterName(): string {
    const context = this.#recordContext();
    return isRecord(context) && isRecord(context["value"]) && typeof context["value"]["name"] === "string"
      ? context["value"]["name"] : uiText("Character");
  }

  #characterTabs() {
    if (!this.#hasCharacterTabs) return nothing;
    const role = this.authority.state === "known" ? this.authority.auth.role : null;
    const contributions = role ? this.#addons?.contributions.list("article-section", role)
      .filter(active => active.descriptor.config["collection"] === "characters") ?? [] : [];
    const addonLabel = contributions.length === 1 ? contributionLabel(contributions[0]!.descriptor, this.#ui.locale) : this.#ui.t("shell.recordAddons");
    return html`<nav class="character-view-tabs record-tabs" role="tablist" aria-label=${uiText("Character view")}>
      ${(["profile", "addons"] as const).map(view => html`<button type="button" role="tab" id=${`character-view-${view}`}
        aria-controls=${`character-${view}-panel`} aria-selected=${this.characterView === view}
        tabindex=${this.characterView === view ? 0 : -1}
        @click=${() => this.#selectCharacterView(view)} @keydown=${this.#characterTabKey}>
        ${view === "profile" ? uiText("Profile") : addonLabel}
      </button>`)}
    </nav>`;
  }

  #selectCharacterView(view: "profile" | "addons"): void {
    this.characterView = view;
    if (this.route.kind === "record") {
      try { window.sessionStorage.setItem(`codex:character-view:${this.route.key}`, view); } catch { /* The active view still works without storage. */ }
    }
  }

  readonly #characterTabKey = (event: KeyboardEvent): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const view = event.key === "Home" ? "profile" : event.key === "End" ? "addons" : this.characterView === "profile" ? "addons" : "profile";
    this.#selectCharacterView(view);
    void this.updateComplete.then(() => this.querySelector<HTMLButtonElement>(`#character-view-${view}`)?.focus());
  };

  async #bootstrap(signal: AbortSignal): Promise<void> {
    try {
      this.readiness = { state: "ready", health: await getHealth(signal) };
    } catch (cause: unknown) {
      if (signal.aborted) return;
      this.readiness = { state: "unavailable", message: errorMessage(cause) };
    }

    try {
      this.authority = { state: "known", auth: await getAuth(signal) };
    } catch (cause: unknown) {
      if (signal.aborted) return;
      this.authority = { state: "known", auth: anonymousAuth() };
        browserDiagnostics.enable(false);
      this.errorMessage = uiText("Session check failed: {0}", { "0": errorMessage(cause) });
    }

    await this.#loadCampaign(signal);
    if (signal.aborted) return;
    this.#startEventStream();
    if (this.#authenticated()) {
      try {
        await this.#startAddons();
      } catch (cause: unknown) {
        if (!signal.aborted) this.errorMessage = uiText("Add-ons could not start: {0}", { "0": errorMessage(cause) });
      }
    }
  }

  async #loadCampaign(signal: AbortSignal, retainCurrent = false): Promise<void> {
    if (!retainCurrent || this.campaignState.state !== "ready") {
      this.campaignState = { state: "loading" };
    }
    try {
      const campaign = await this.#campaignData.refresh(signal);
      if (!signal.aborted) {
        applyCampaignTheme(campaign);
        applyBrandingFavicon(campaignBranding(campaign));
        this.campaignState = { state: "ready", campaign };
        await this.updateComplete;
        this.#articleOutlet?.refresh();
        this.#navigationOutlet?.refresh();
        this.#routeOutlet?.refresh();
      }
    } catch (cause: unknown) {
      if (signal.aborted) return;
      const current = this.#campaignData.current();
      if (retainCurrent && current !== undefined) {
        applyCampaignTheme(current);
        this.campaignState = { state: "ready", campaign: current };
        this.errorMessage = uiText("Campaign refresh failed: {0}", { "0": errorMessage(cause) });
      } else {
        this.campaignState = { state: "unavailable", message: errorMessage(cause) };
      }
    }
  }

  #startEventStream(): void {
    this.liveState = "connecting";
    this.#events.open({
      onRefresh: (event) => {
        this.liveState = "connected";
        void this.#handleEvent(event);
      },
      onBoundaryError: (cause) => {
        this.errorMessage = uiText("Live update was rejected: {0}", { "0": errorMessage(cause) });
      },
      onConnectionError: () => {
        this.liveState = "reconnecting";
      },
    });
  }

  async #handleEvent(event: EventRefresh): Promise<void> {
    this.#addons?.dataChanges.handleEvent(event);
    if (event.cause === "addon-data-changed") return;
    if (event.cause === "campaign-restored" && this.#request !== undefined) {
      const edits = this.#addons?.contributions.edits.state();
      this.#campaignData.reset();
      await this.#loadCampaign(this.#request.signal, true);
      if (this.#editDirty || edits?.dirty || edits?.saving) {
        this.errorMessage = this.#ui.t("recovery.openEdits");
      } else {
        await this.#recoverAddons();
      }
      return;
    }
    if ((event.cause === "campaign-data-changed" || event.cause === "reset") &&
      this.#request !== undefined) {
      await this.#loadCampaign(this.#request.signal, true);
    }
    await this.#addons?.session.handleEvent(event);
  }

  async #login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.busy || this.#request === undefined) return;
    const form = event.currentTarget as HTMLFormElement;
    const password = String(new FormData(form).get("password") ?? "");
    this.busy = true;
    this.errorMessage = "";
    try {
      const auth = await loginSession(password, this.#request.signal);
      if (!auth.authenticated) throw new Error("sign-in did not create a session");
      this.authority = { state: "known", auth };
      form.reset();
      await this.#reloadForAuthority();
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) this.errorMessage = uiText("Sign-in failed: {0}", { "0": errorMessage(cause) });
    } finally {
      this.busy = false;
    }
  }

  async #logout(): Promise<void> {
    if (this.busy || this.#request === undefined || !this.#confirmDiscardEdit()) return;
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#stopAddons();
      await logoutSession(this.#request.signal);
      this.authority = { state: "known", auth: anonymousAuth() };
        browserDiagnostics.enable(false);
      this.#campaignData.reset();
      await this.#loadCampaign(this.#request.signal);
      this.#startEventStream();
      if (this.route.kind === "addon") window.location.hash = "#/";
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = uiText("Sign-out failed: {0}", { "0": errorMessage(cause) });
        await this.#recoverAddons();
      }
    } finally {
      this.busy = false;
    }
  }

  async #switchRole(): Promise<void> {
    if (this.busy || this.#request === undefined || this.authority.state !== "known" ||
      !this.authority.auth.authenticated || this.authority.auth.realRole !== "dm" ||
      !this.#confirmDiscardEdit()) return;
    const auth = this.authority.auth;
    const role = auth.role === "dm" ? "player" : "dm";
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#stopAddons();
      const next = await switchSessionRole(role, auth.csrfToken, this.#request.signal);
      if (!next.authenticated) throw new Error("role switch ended the session");
      this.authority = { state: "known", auth: next };
      await this.#reloadForAuthority();
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = uiText("View switch failed: {0}", { "0": errorMessage(cause) });
        await this.#recoverAddons();
      }
    } finally {
      this.busy = false;
    }
  }

  async #reloadForAuthority(): Promise<void> {
    browserDiagnostics.enable(false);
    if (this.#request === undefined) return;
    this.#campaignData.reset();
    await this.#loadCampaign(this.#request.signal);
    this.#startEventStream();
    try {
      await this.#startAddons();
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = uiText("Add-ons could not start: {0}", { "0": errorMessage(cause) });
      }
    }
  }

  async #recoverAddons(): Promise<void> {
    if (!this.#authenticated() || this.#request === undefined || this.#request.signal.aborted) return;
    try {
      await this.#startAddons();
    } catch (cause: unknown) {
      this.errorMessage += uiText(" Add-on recovery also failed: {0}", { "0": errorMessage(cause) });
    }
  }

  async #startAddons(): Promise<void> {
    await this.#stopAddons();
    const owner = ++this.#addonOwner;
    const auth = this.authority.state === "known" ? this.authority.auth : anonymousAuth();
    browserDiagnostics.enable(auth.authenticated && auth.role === "dm" && auth.realRole === "dm");
    if (!auth.authenticated) return;
    this.addonState = { state: "loading" };
    const composition = createBrowserAddonComposition(document, auth.csrfToken, {
      onRefresh: (_cause, result) => {
        if (owner !== this.#addonOwner) return;
        for (const failure of result.lifecycle.activationFailures) browserDiagnostics.record(failure.kind, failure);
        for (const failure of result.lifecycle.disposalFailures) browserDiagnostics.record("disposal", failure);
        this.#dmAddonHealth = [
          ...result.lifecycle.active.map(addon => ({ id: addon.addonId, version: addon.addonVersion, state: "ready" as const })),
          ...result.lifecycle.activationFailures.map(failure => ({ id: failure.addonId,
            version: result.transport.graph.addons.find(addon => addon.addonId === failure.addonId)?.addonVersion ?? "",
            state: failure.kind === "dependency" ? "blocked" as const : "failed" as const })),
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
      onAuthorityLost: () => {
        if (owner !== this.#addonOwner) return;
        this.#addons = undefined;
        this.#disposeOutlets();
        this.authority = { state: "known", auth: anonymousAuth() };
        browserDiagnostics.enable(false);
        this.addonState = { state: "idle" };
        this.#campaignData.reset();
        this.#startEventStream();
        if (this.#request !== undefined) void this.#loadCampaign(this.#request.signal);
      },
    });
    this.#addons = composition;
    try {
      await this.updateComplete;
      const navigationRoot = this.querySelector<HTMLElement>("[data-addon-navigation]");
      const dashboardRoot = this.querySelector<HTMLElement>("[data-addon-slot]");
      const articleRoot = this.querySelector<HTMLElement>("[data-addon-article]");
      const routeRoot = this.querySelector<HTMLElement>("[data-addon-route-outlet]");
      if (navigationRoot === null || dashboardRoot === null ||
        articleRoot === null || routeRoot === null) {
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
        include: entry => {
          const mode = addonSidebarMode(this.campaignState.state === "ready" ? this.campaignState.campaign : undefined, addonSidebarKey(entry));
          return mode === "everyone" || mode === "dm" && auth.role === "dm";
        },
        onError,
        onCountChange: (count) => { if (owner === this.#addonOwner) { this.navigationCount = count; this.requestUpdate(); } },
      });
      this.#dashboardOutlet = new BrowserContributionOutlet({
        document,
        root: dashboardRoot,
        registry: composition.contributions,
        surface: "slot",
        role: auth.role,
        include: active => this.route.kind === "dashboard" && active.descriptor.config["slot"] === undefined,
        onError,
        onCountChange: (count) => { if (owner === this.#addonOwner) this.contributionCount = count; },
      });
      this.#articleOutlet = new BrowserContributionOutlet({
        document,
        root: articleRoot,
        registry: composition.contributions,
        surface: "article-section",
        compact: true,
        role: auth.role,
        include: (active) => this.route.kind === "record" &&
          active.descriptor.config["collection"] === this.route.page.collection,
        hostContext: () => this.#recordContext(),
        onError,
        onCountChange: (count) => { if (owner === this.#addonOwner) this.articleCount = count; },
      });
      this.#routeOutlet = new BrowserContributionOutlet({
        document,
        root: routeRoot,
        registry: composition.contributions,
        surface: "route",
        role: auth.role,
        include: (active) => browserAddonRouteHash(active) === parseBrowserAddonLocation(window.location.hash)?.routeHash,
        isolatedHostContext: true,
        hostContext: active => {
          const recordReferences = routeRecordReferences(this.campaignState.state === "ready" ? this.campaignState.campaign : undefined, active);
          return { contractVersion: "addon-route-context.v1", locale: this.#ui.locale,
            query: parseBrowserAddonLocation(window.location.hash)?.query ?? [], ...(recordReferences ? { recordReferences } : {}) };
        },
        onError,
        onCountChange: (count) => { if (owner === this.#addonOwner) this.routeCount = count; },
      });
      await composition.session.start();
    } catch (cause: unknown) {
      if (owner === this.#addonOwner) await this.#stopAddons();
      throw cause;
    }
  }

  async #stopAddons(): Promise<void> {
    this.#addonOwner += 1;
    this.#disposeOutlets();
    const addons = this.#addons;
    this.#addons = undefined;
    this.#dmAddonHealth = [];
    this.addonState = { state: "idle" };
    if (addons !== undefined) {
      const failures = await addons.session.stop();
      for (const failure of failures) browserDiagnostics.record("disposal", failure);
      if (failures.length > 0) {
        this.errorMessage = uiText("Failed to clean up {0} browser add-on resource(s).", { "0": failures.length });
      }
    }
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
    try { layout = campaignSidebar(this.campaignState.state === "ready" ? this.campaignState.campaign : undefined); }
    catch { layout = defaultSidebarLayout(); }
    return html`
      <nav class="core-navigation" aria-label=${this.#ui.t("shell.campaignArchive")}>
        ${layout.sections.map(group => {
          if (group.role === "dm" && !this.#canManageCampaign()) return nothing;
          const entries = group.pages.flatMap(route => { const page = sidebarPage(route); return page === undefined ? [] : [page]; });
          if (entries.length === 0) return nothing;
          const colorGroup = group.id === "kampan" ? "campaign" : group.id === "svet" ? "world" : group.id;
          const open = !group.collapsible || this.#sidebarSectionOpen(group);
          return html`<section class=${`navigation-${colorGroup}`} data-navigation-section=${group.id}>
            <h2>${group.collapsible ? html`<button class="sidebar-section-toggle" aria-expanded=${open} @click=${() => this.#toggleSidebarSection(group)}>
              <span aria-hidden="true">${open ? "▾" : "▸"}</span> ${group.icon} ${group.label}</button>` : html`${group.icon} ${group.label}`}</h2>
            <div ?hidden=${!open}>${entries.map((entry) => html`
              <a href=${`#${entry.route}`} aria-current=${this.#coreRouteActive(entry.id) ? "page" : nothing}>
                <span aria-hidden="true">${entry.icon}</span>${entry.label}
              </a>
            `)}</div>
          </section>`;
        })}
      </nav>
    `;
  }

  async #openPreview(): Promise<void> {
    if (this.busy || this.#request === undefined || this.authority.state !== "known" ||
      !this.authority.auth.authenticated || this.authority.auth.role !== "dm") return;
    const popup = window.open("about:blank", "_blank");
    if (popup === null) { this.errorMessage = this.#ui.t("preview.blocked"); return; }
    popup.opener = null;
    this.busy = true;
    this.errorMessage = "";
    try {
      const token = await createPlayerPreview(this.authority.auth.csrfToken, this.#request.signal);
      if (!popup.closed) popup.location.replace(playerPreviewURL(token));
    } catch {
      popup.close();
      if (!this.#request?.signal.aborted) this.errorMessage = this.#ui.t("preview.failed");
    } finally { this.busy = false; }
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
    const cached = this.#sidebarOpen.get(section.id); if (cached !== undefined) return cached;
    try { const saved = localStorage.getItem(`sidebar_section_open:${section.id}`); if (saved === "0" || saved === "1") return saved === "1"; } catch { /* Optional browser preference. */ }
    return section.defaultOpen;
  }
  #toggleSidebarSection(section: SidebarSection): void {
    const open = !this.#sidebarSectionOpen(section); this.#sidebarOpen.set(section.id, open);
    try { localStorage.setItem(`sidebar_section_open:${section.id}`, open ? "1" : "0"); } catch { /* Keep the in-memory preference. */ }
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
    if (this.menuOpen) { this.#closeMenu(); return; }
    this.menuOpen = true;
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".sidebar-search")?.focus());
  };

  readonly #closeMenu = (): void => {
    this.menuOpen = false;
    void this.updateComplete.then(() => this.querySelector<HTMLElement>("[data-menu-toggle]")?.focus());
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape" && this.menuOpen) {
      event.preventDefault();
      this.#closeMenu();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (this.quickSearchOpen) this.#closeQuickSearch(); else this.#openQuickSearch();
    }
  };

  readonly #openQuickSearch = (event?: MouseEvent): void => {
    if (event && (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    if (this.campaignState.state !== "ready") return;
    event?.preventDefault();
    this.#searchReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.menuOpen = false; this.quickSearchOpen = true;
  };

  #closeQuickSearch(restoreFocus = true): void {
    this.querySelector<HTMLDialogElement>(".quick-search-dialog")?.close();
    this.quickSearchOpen = false;
    if (restoreFocus) {
      const previous = this.#searchReturnFocus;
      void this.updateComplete.then(() => {
        if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
        else this.querySelector<HTMLElement>(this.mobileViewport ? "[data-menu-toggle]" : ".sidebar-search")?.focus();
      });
    }
    this.#searchReturnFocus = undefined;
  }

  #accountTemplate() {
    if (isPlayerPreview()) return html`<section class="account-panel"><p>${this.#ui.t("shell.viewingAs")} <strong>${this.#ui.t("shell.player")}</strong></p>
      <button class="text-button" type="button" @click=${this.#closePreview}>${this.#ui.t("preview.close")}</button></section>`;
    if (this.authority.state === "checking") {
      return html`<section class="account-panel"><p class="loading-line">${this.#ui.t("shell.checkingSession")}</p></section>`;
    }
    if (!this.authority.auth.authenticated) {
      return html`
        <section class="account-panel">
          <h2>${this.#ui.t("shell.privateArchive")}</h2>
          <form @submit=${this.#login}>
            <label>
              <span class="visually-hidden">${this.#ui.t("shell.passwordLabel")}</span>
              <input name="password" type="password" minlength="4" autocomplete="current-password" placeholder=${this.#ui.t("shell.passwordPlaceholder")} required />
            </label>
            <button type="submit" ?disabled=${this.busy}>${this.#ui.t("shell.signIn")}</button>
          </form>
        </section>
      `;
    }
    const auth = this.authority.auth;
    return html`
      <section class="account-panel signed-in">
        <p><span class="authority-mark" aria-hidden="true"></span>${this.#ui.t("shell.viewingAs")} <strong>${auth.role === "dm" ? uiText("DM") : this.#ui.t("shell.player")}</strong></p>
        ${auth.realRole === "dm" ? html`
          <button class="text-button" type="button" @click=${auth.role === "dm" ? this.#openPreview : this.#switchRole} ?disabled=${this.busy}
            title=${auth.role === "dm" ? this.#ui.t("preview.openHint") : nothing}>
            ${this.#ui.t("shell.viewAs", { role: auth.role === "dm" ? this.#ui.t("shell.player") : uiText("DM") })}
          </button>
        ` : nothing}
        <button class="text-button" type="button" @click=${this.#logout} ?disabled=${this.busy}>${this.#ui.t("shell.signOut")}</button>
        <small title=${this.#addonStateTitle()}>${this.#addonStateLabel()}</small>
      </section>
    `;
  }

  #addonStateLabel(): string {
    const state = this.addonState;
    switch (state.state) {
      case "idle": return this.#ui.t("shell.addonsIdle");
      case "loading": return this.#ui.t("shell.addonsLoading");
      case "ready": return state.failures === 0
        ? this.#ui.plural("shell.addonGenerationsActive", state.active)
        : this.#ui.t("shell.addonsActiveFailed", { active: state.active, failed: state.failures });
      case "degraded": return this.#ui.t("shell.addonsAttention");
    }
  }

  #addonStateTitle(): string {
    if (this.addonState.state === "ready") return this.addonState.revision;
    if (this.addonState.state === "degraded") return this.addonState.message;
    return this.#addonStateLabel();
  }

  #mobileAccountLabel(): string {
    if (this.authority.state === "checking") return this.#ui.t("shell.menu");
    if (!this.authority.auth.authenticated) return this.#ui.t("shell.signIn");
    return this.authority.auth.role === "dm" ? this.#ui.t("shell.dmMenu") : this.#ui.t("shell.playerMenu");
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
          .degraded=${this.addonState.state === "degraded" || this.addonState.state === "ready" && this.addonState.failures > 0}
          @dm-retry-addons=${this.#retryDmAddons}></codex-dm-dashboard>`;
      case "campaign-graph":
        return html`<codex-campaign-graph .campaign=${campaign} .mode=${this.route.mode}
          .registry=${this.#addons?.contributions} .actorRole=${this.authority.state === "known" ? this.authority.auth.role ?? undefined : undefined}></codex-campaign-graph>`;
      case "timeline":
        return html`<codex-timeline .campaign=${campaign} .canEdit=${this.#canEdit()} .saving=${this.busy}
          .registry=${this.#addons?.contributions} .actorRole=${this.authority.state === "known" ? this.authority.auth.role ?? undefined : undefined}
          .editCompletion=${this.editCompletion} .errorMessage=${this.errorMessage}
          @campaign-edit-dirty=${this.#onEditDirty} @campaign-timeline-save=${this.#saveTimeline}
          @campaign-timeline-reset=${() => { this.errorMessage = ""; }}></codex-timeline>`;
      case "map":
        return html`<codex-map .campaign=${campaign} .route=${this.route} .canEdit=${this.#canEdit()}
          .registry=${this.#addons?.contributions}
          .actorRole=${this.authority.state === "known" ? this.authority.auth.role ?? undefined : undefined}
          .canManageCampaign=${this.#canManageCampaign()} .saving=${this.busy} .editCompletion=${this.editCompletion}
          .errorMessage=${this.errorMessage} @campaign-edit-dirty=${this.#onEditDirty}
          @campaign-map-save=${this.#saveMap} @campaign-map-upload=${this.#uploadMap}></codex-map>`;
      case "dashboard":
      case "party":
        return html`<codex-dashboard .campaign=${campaign} .partyOnly=${this.route.kind === "party"}
          .authenticated=${this.#authenticated()} .canManageCampaign=${this.#canManageCampaign()} .canEdit=${this.#canEdit()}
          .saving=${this.busy} .editCompletion=${this.editCompletion}
          @campaign-edit-dirty=${this.#onEditDirty} @campaign-identity-save=${this.#saveCampaignIdentity}
          @campaign-sign-in=${this.#showSignIn}
        ></codex-dashboard>`;
      case "search":
        return html`<codex-search .campaign=${campaign} .query=${this.route.query ?? ""} .registry=${this.#addons?.contributions}
          .actorRole=${this.authority.state === "known" ? this.authority.auth.role ?? undefined : undefined}></codex-search>`;
      case "settings":
        return html`<codex-settings
          .registry=${this.#addons?.contributions}
          .actorRole=${this.authority.state === "known" ? this.authority.auth.role ?? undefined : undefined}
          .addonTarget=${this.route.addonId}
          .addonGeneration=${this.route.generationId}
          .addonPages=${this.#canManageCampaign() && this.#addons !== undefined ? listBrowserNavigation(this.#addons.contributions, "dm", this.#ui.locale) : []}
          .csrfToken=${this.authority.state === "known" && this.authority.auth.authenticated ? this.authority.auth.csrfToken : ""}
          @addon-admin-busy=${(event: CustomEvent<boolean>) => { this.busy = event.detail; }}
          .campaign=${campaign}
          .mapTarget=${this.route.mapParentId}
          .canManageCampaign=${this.#canManageCampaign()}
          .saving=${this.busy}
          .editCompletion=${this.editCompletion}
          @campaign-edit-dirty=${this.#onEditDirty}
          @campaign-enum-save=${this.#saveCampaignEnum}
          @campaign-enum-delete=${this.#deleteCampaignEnum}
          @campaign-appearance-save=${this.#saveCampaignAppearance}
          @campaign-party-save=${this.#saveCampaignParty}
          @campaign-branding-save=${this.#saveBranding}
          @campaign-sidebar-save=${this.#saveSidebar}
          @campaign-map-save=${this.#saveMap} @campaign-map-upload=${this.#uploadMap}
        ></codex-settings>`;
      case "collection":
      case "record":
      case "create":
        return html`<codex-record-page
          .campaign=${campaign}
          .registry=${this.#addons?.contributions}
          .actorRole=${this.authority.state === "known" ? this.authority.auth.role ?? undefined : undefined}
          .route=${this.route}
          .canEdit=${this.#canEdit()}
          .canManageVisibility=${this.#canManageCampaign()}
          .saving=${this.busy}
          .editCompletion=${this.editCompletion}
          @campaign-edit-dirty=${this.#onEditDirty}
          .saveState=${this.recordSaveState}
          @campaign-record-reset=${() => { this.errorMessage = ""; this.recordSaveState = "idle"; }}
          @campaign-record-save=${this.#saveCampaignRecord}
          @campaign-twin=${this.#mutateTwin}
          @campaign-collection-view=${(event: CustomEvent<{ hash: string }>) => {
            const route = parseAppRoute(event.detail.hash);
            if (route.kind !== "collection" || this.route.kind !== "collection" || route.page.id !== this.route.page.id) return;
            window.history.replaceState(null, "", event.detail.hash);
            this.#acceptedHash = event.detail.hash;
            this.route = route;
          }}
          @campaign-character-save=${this.#saveCharacterPatch}
          @campaign-record-delete=${this.#deleteCampaignRecord}
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
        if (this.#links.resolve({ path: window.location.hash }).status === "loading") {
          return html`<section class="loading-page" role="status"><p>${this.#ui.t("shell.openingAddon")}</p></section>`;
        }
        if (this.#links.resolve({ path: window.location.hash }).status === "failed") {
          return html`<section class="unavailable-page" role="status"><p>${this.#ui.t("wiki.failed")}</p>
            <button type="button" @click=${this.#links.retry}>${this.#ui.t("wiki.retry")}</button></section>`;
        }
        return html`<section class="unavailable-page"><p class="page-kicker">${this.#ui.t("shell.campaignArchive")}</p><h1>${this.#ui.t("shell.pageMissing")}</h1><p>${this.#ui.t("shell.pageMissingHint")}</p><a class="primary-link" href="#/">${this.#ui.t("shell.returnOverview")}</a></section>`;
    }
  }

  #coreRouteActive(id: string): boolean {
    if (id.startsWith("graph-")) return this.route.kind === "campaign-graph" && id === `graph-${this.route.mode}`;
    if (id === "map") return this.route.kind === "map";
    if (id === "dashboard") return this.route.kind === "dashboard";
    if (id === "search") return this.route.kind === "search";
    if (id === "party") return this.route.kind === "party" || this.route.kind === "create" && this.route.preset === "party";
    if (id === "timeline") return this.route.kind === "timeline" || this.route.kind === "create" && this.route.preset === "event";
    if (id === "settings") return this.route.kind === "settings";
    return (this.route.kind === "collection" || this.route.kind === "record") && this.route.page.id === id;
  }

  #authenticated(): boolean {
    return this.authority.state === "known" && this.authority.auth.authenticated;
  }

  #canEdit(): boolean {
    return this.#authenticated();
  }

  #canManageCampaign(): boolean {
    return this.authority.state === "known" && this.authority.auth.authenticated &&
      this.authority.auth.role === "dm";
  }

  readonly #saveCharacterPatch = async (event: CustomEvent<CampaignCharacterSaveRequest>): Promise<void> => {
    event.preventDefault();
    const { respond, ...patch } = event.detail;
    if (this.busy || this.#request === undefined || !this.#canEdit() || this.authority.state !== "known" ||
      !this.authority.auth.authenticated || this.campaignState.state !== "ready") {
      respond({ ok: false, message: uiText("The entry cannot be saved right now. Your draft is kept.") }); return;
    }
    this.busy = true;
    const signal = this.#request.signal;
    try {
      let prepared = prepareCharacterPatch(this.campaignState.campaign, patch, this.#canManageCampaign());
      prepared = await attachCharacterPortrait(prepared, {
        collection: "characters", key: patch.base.key, expectedRevision: patch.base.revision,
        creating: false, fields: patch.fields, ...(patch.portrait !== undefined ? { portrait: patch.portrait } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      }, this.authority.auth.csrfToken, signal);
      const receipt = await this.#campaignMutations.commit(prepared.mutations, this.authority.auth.csrfToken, signal);
      await this.#loadCampaign(signal, true);
      const campaign = this.campaignState.state === "ready" ? this.campaignState.campaign : undefined;
      const record = campaign && campaignCollection(campaign, "characters").records.find(item => item.key === patch.base.key);
      const committed = receipt.results.find(item => item.collection === "characters" && item.key === patch.base.key);
      if (!campaign || !record || !committed || record.revision < committed.afterRevision || signal.aborted) {
        respond({ ok: false, message: uiText("The change was saved, but could not be refreshed. Your draft is kept. Refresh before retrying.") }); return;
      }
      const written = prepared.mutations[0];
      if (record.revision > committed.afterRevision && written?.operation === "put") {
        // A later author may have committed between our write and its readback.
        prepareCharacterPatch(campaign, {
          base: { ...record, value: written.value }, fields: patch.fields,
          ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
          ...(patch.portrait !== undefined ? { portrait: patch.portrait } : {}),
        }, this.#canManageCampaign());
      }
      respond({ ok: true, campaign, record });
    } catch (cause: unknown) {
      const conflict = cause instanceof CampaignRecordEditError && cause.kind === "stale" || cause instanceof CampaignMutationHTTPError && cause.status === 409;
      if (cause instanceof CampaignMutationHTTPError && cause.status === 409) await this.#loadCampaign(signal, true);
      respond({ ok: false, conflict, message: conflict
        ? uiText("This field changed elsewhere. Your draft is kept. Review the current value before retrying.")
        : uiText("The entry could not be saved: {0}", { "0": errorMessage(cause) }) });
    } finally { this.busy = false; }
  };

  readonly #mutateTwin = async (event: CustomEvent<CampaignTwinRequest>): Promise<void> => {
    event.preventDefault();
    const { mutation, respond } = event.detail;
    if (this.busy || !this.#request || !this.#canManageCampaign() || this.authority.state !== "known" ||
      !this.authority.auth.authenticated || this.campaignState.state !== "ready") {
      respond({ ok: false, message: uiText("twins.failed") }); return;
    }
    if (this.#editDirty || this.#editSaving || this.#addons?.contributions.edits.state().dirty || this.#addons?.contributions.edits.state().saving) {
      respond({ ok: false, message: uiText("twins.finishEdits") }); return;
    }
    this.busy = true;
    const signal = this.#request.signal;
    try {
      const receipt = await this.#campaignMutations.mutateTwin(mutation, this.authority.auth.csrfToken, signal);
      await this.#loadCampaign(signal, true);
      const campaign = this.campaignState.state === "ready" ? this.campaignState.campaign : undefined;
      const verified = campaign && receipt.results.every(result => campaignCollection(campaign, result.collection).records.some(record => record.key === result.key && record.revision >= result.afterRevision));
      respond({ ok: !!verified && !signal.aborted, message: uiText(verified && !signal.aborted ? "twins.saved" : "twins.failed") });
    } catch (cause: unknown) {
      if (!signal.aborted) await this.#loadCampaign(signal, true);
      respond({ ok: false, message: uiText(cause instanceof CampaignMutationHTTPError && cause.status === 409 ? "twins.stale" : "twins.failed") });
    } finally { this.busy = false; }
  };

  readonly #saveCampaignRecord = async (
    event: CustomEvent<CampaignRecordSaveDetail>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEdit() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") return;
    this.recordSaveState = "idle";
    const creationRoute = this.route.kind === "create" && this.route.context ? this.route : undefined;
    const returnTo = this.route.kind === "record" && this.route.editing ? this.route.returnTo : undefined;
    if (creationRoute && !creationSource(creationRoute, this.campaignState.campaign)?.record) {
      this.errorMessage = uiText("creation.unavailable"); this.recordSaveState = "failed"; return;
    }
    let prepared: PreparedCampaignRecordTransaction;
    try {
      prepared = prepareCampaignRecordSave(
        this.campaignState.campaign,
        event.detail,
        this.#canManageCampaign(),
      );
    } catch (cause: unknown) {
      this.errorMessage = cause instanceof CampaignRecordEditError && cause.kind === "stale"
        ? uiText("The entry or its relationships changed. Your draft is kept; copy any notes you need, then cancel and reopen to review the current version.")
        : cause instanceof CampaignRecordEditError && cause.kind === "portrait-visibility"
          ? uiText("Save visibility changes first, then replace the portrait. Your draft is kept.")
          : uiText("The entry contains a value that cannot be saved.");
      this.recordSaveState = "failed";
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      prepared = await attachCharacterPortrait(prepared, event.detail,
        this.authority.auth.csrfToken, this.#request.signal);
      await this.#campaignMutations.commit(
        prepared.mutations,
        this.authority.auth.csrfToken,
        this.#request.signal,
      );
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false;
      this.editCompletion += 1;
      this.recordSaveState = "saved";
      this.#recordSaveDestination = creationRoute && this.campaignState.state === "ready" ? creationBackHash(creationRoute, this.campaignState.campaign) : returnTo ?? recordHash(prepared.page, event.detail.key);
      if (!this.#addons?.contributions.edits.state().dirty && !this.#addons?.contributions.edits.state().saving) window.location.hash = this.#recordSaveDestination;
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = cause instanceof CampaignMutationHTTPError && cause.status === 409
          ? uiText("The entry changed while saving. Reload its current version and try again.")
          : uiText("The entry could not be saved: {0}", { "0": errorMessage(cause) });
        this.recordSaveState = "failed";
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #deleteCampaignRecord = async (
    event: CustomEvent<CampaignRecordDeleteDetail>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEdit() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") return;
    let prepared: PreparedCampaignRecordTransaction;
    try {
      prepared = prepareCampaignRecordDelete(this.campaignState.campaign, event.detail);
    } catch (cause: unknown) {
      this.errorMessage = cause instanceof CampaignRecordEditError && cause.kind === "stale"
        ? uiText("The entry changed before it could be deleted. Refresh and try again.")
        : uiText("The delete request is no longer valid.");
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#campaignMutations.commit(
        prepared.mutations,
        this.authority.auth.csrfToken,
        this.#request.signal,
      );
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false;
      this.editCompletion += 1;
      window.location.hash = prepared.page.collection === "events" ? "#/timeline" : collectionHash(prepared.page);
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = cause instanceof CampaignMutationHTTPError && cause.status === 409
          ? uiText("The entry changed while deleting. Reload its current version and try again.")
          : uiText("The entry could not be deleted: {0}", { "0": errorMessage(cause) });
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #saveCampaignEnum = async (
    event: CustomEvent<CampaignEnumSaveDetail>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canManageCampaign() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") return;
    let mutation: CampaignMutation;
    try {
      mutation = prepareCampaignEnumSave(this.campaignState.campaign, event.detail);
    } catch (cause: unknown) {
      this.errorMessage = cause instanceof CampaignSettingsEditError
        ? cause.kind === "stale"
          ? uiText("The definition changed. Your draft is kept; copy any notes you need, then cancel and reopen to review the current version.")
          : uiText("The definition contains a value that cannot be saved.")
        : uiText("The definition could not be prepared: {0}", { "0": errorMessage(cause) });
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#campaignMutations.commit([mutation], this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false;
      this.editCompletion += 1;
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = cause instanceof CampaignMutationHTTPError && cause.status === 409
          ? uiText("Settings changed while saving. Reload the current definition and try again.")
          : uiText("The definition could not be saved: {0}", { "0": errorMessage(cause) });
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #deleteCampaignEnum = async (
    event: CustomEvent<CampaignEnumDeleteMutation>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canManageCampaign() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") return;
    let mutation: CampaignEnumDeleteMutation;
    try {
      mutation = prepareCampaignEnumDelete(this.campaignState.campaign, event.detail);
    } catch (cause: unknown) {
      this.errorMessage = cause instanceof CampaignSettingsEditError
        ? uiText("The definition changed before it could be deleted.")
        : uiText("The deletion could not be prepared: {0}", { "0": errorMessage(cause) });
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#campaignMutations.deleteEnumItem(mutation, this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false;
      this.editCompletion += 1;
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = cause instanceof CampaignMutationHTTPError && cause.status === 409
          ? mutation.mode === "reject-if-used"
            ? uiText("The definition is now in use or settings changed. Review the category and try again.")
            : uiText("Settings changed while deleting. Review the category and try again.")
          : uiText("The definition could not be deleted: {0}", { "0": errorMessage(cause) });
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #saveMap = async (event: CustomEvent<MapSaveDetail>): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEdit() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated || this.campaignState.state !== "ready" ||
      ((event.detail.kind === "view" || event.detail.kind === "config") && !this.#canManageCampaign())) return;
    let mutation: CampaignMutation;
    try { mutation = prepareMapSave(this.campaignState.campaign, event.detail); }
    catch (cause) { this.#mapError(cause); return; }
    this.busy = true; this.errorMessage = "";
    try {
      await this.#campaignMutations.commit([mutation], this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false; this.editCompletion += 1;
    } catch (cause) { if (!this.#request.signal.aborted) this.#mapError(cause); }
    finally { this.busy = false; }
  };

  readonly #saveTimeline = async (event: CustomEvent<TimelineDraft>): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEdit() || this.authority.state !== "known" ||
      !this.authority.auth.authenticated || this.campaignState.state !== "ready") return;
    let mutations: readonly CampaignMutation[];
    try { mutations = prepareTimelineReorder(this.campaignState.campaign, event.detail); }
    catch (cause) {
      this.errorMessage = this.#ui.t(cause instanceof TimelineEditError && cause.kind === "stale" ? "timeline.stale"
        : cause instanceof TimelineEditError && cause.kind === "limit" ? "timeline.limit" : "timeline.invalid");
      return;
    }
    if (mutations.length === 0) { this.#editDirty = false; this.editCompletion++; return; }
    this.busy = true; this.errorMessage = "";
    try {
      await this.#campaignMutations.commit(mutations, this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false; this.editCompletion++;
    } catch (cause) {
      if (!this.#request.signal.aborted) this.errorMessage = this.#ui.t(cause instanceof CampaignMutationHTTPError && cause.status === 409 ? "timeline.stale" : "timeline.failed");
    } finally { this.busy = false; }
  };

  readonly #uploadMap = async (event: CustomEvent<MapUploadDetail>): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEdit() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated || this.campaignState.state !== "ready") return;
    const { parentId, expectedRevision, file } = event.detail;
    if (parentId === null && !this.#canManageCampaign()) return;
    if (parentId !== null && mapLocationRecord(this.campaignState.campaign, parentId)?.revision !== expectedRevision) {
      this.#mapError(new CampaignMapEditError("stale")); return;
    }
    this.busy = true; this.errorMessage = "";
    try {
      const media = await new MediaClient().upload(parentId === null ? "world-map" : "location-map", parentId ?? "main",
        file, file.name, this.authority.auth.csrfToken, this.#request.signal);
      if (parentId !== null) {
        const mutation = prepareLocalMapImage(this.campaignState.campaign, parentId, expectedRevision, media.url);
        await this.#campaignMutations.commit([mutation], this.authority.auth.csrfToken, this.#request.signal);
      }
      await this.#loadCampaign(this.#request.signal, true);
      this.editCompletion += 1;
    } catch (cause) { if (!this.#request.signal.aborted) this.#mapError(cause); }
    finally { this.busy = false; }
  };

  #mapError(cause: unknown): void {
    this.errorMessage = this.#ui.t((cause instanceof CampaignMapEditError && cause.kind === "stale") ||
      (cause instanceof CampaignMutationHTTPError && cause.status === 409) ? "map.stale" : "map.saveFailed");
  }

  readonly #retryDmAddons = async (): Promise<void> => {
    if (!this.#canManageCampaign() || this.busy || this.addonState.state === "loading") return;
    try { await this.#startAddons(); }
    catch { this.addonState = { state: "degraded", message: this.#ui.t("dm.failed") }; }
  };

  readonly #showSignIn = async (): Promise<void> => {
    if (this.#authenticated()) return;
    if (this.mobileViewport) this.menuOpen = true;
    await this.updateComplete;
    const account = this.querySelector<HTMLDetailsElement>(".account-menu");
    if (account !== null) account.open = true;
    this.querySelector<HTMLInputElement>('.account-panel input[name="password"]')?.focus();
  };

  readonly #saveCampaignIdentity = async (event: CustomEvent<CampaignIdentitySaveDetail>): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canManageCampaign() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") return;
    let mutation: CampaignMutation;
    try {
      mutation = prepareCampaignIdentitySave(this.campaignState.campaign, event.detail);
    } catch (cause: unknown) {
      this.errorMessage = this.#ui.t(cause instanceof CampaignIdentityEditError && cause.kind === "stale"
        ? "dashboard.identityStale" : "dashboard.identityInvalid");
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#campaignMutations.commit([mutation], this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false;
      this.editCompletion += 1;
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = this.#ui.t(cause instanceof CampaignMutationHTTPError && cause.status === 409
          ? "dashboard.identityStale" : "dashboard.identityFailed");
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #saveSidebar = async (event: CustomEvent<SidebarSaveDetail>): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canManageCampaign() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated || this.campaignState.state !== "ready") return;
    this.busy = true; this.errorMessage = "";
    try {
      const mutation = prepareSidebarSave(this.campaignState.campaign, event.detail);
      const mutations = [mutation];
      if (event.detail.addonVisibility !== undefined) mutations.push(prepareAddonSidebarSave(this.campaignState.campaign, event.detail.addonVisibility));
      await this.#campaignMutations.commit(mutations, this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false; this.editCompletion += 1;
    } catch (cause) {
      if (!this.#request.signal.aborted) this.errorMessage = this.#ui.t(
        (cause instanceof SidebarEditError && cause.kind === "stale") || (cause instanceof CampaignMutationHTTPError && cause.status === 409)
          ? "sidebar.stale" : cause instanceof SidebarEditError ? "sidebar.invalid" : "sidebar.failed");
    } finally { this.busy = false; }
  };

  readonly #saveBranding = async (event: CustomEvent<BrandingSaveDetail>): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canManageCampaign() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated || this.campaignState.state !== "ready") return;
    this.busy = true; this.errorMessage = "";
    try {
      let mutation = prepareBrandingSave(this.campaignState.campaign, event.detail);
      if (event.detail.file !== undefined) {
        const file = event.detail.file;
        const media = await new MediaClient().upload("branding-logo", "main", file, file.name, this.authority.auth.csrfToken, this.#request.signal);
        mutation = prepareBrandingSave(this.campaignState.campaign, { ...event.detail, logoUrl: media.url });
      }
      await this.#campaignMutations.commit([mutation], this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false; this.editCompletion += 1;
    } catch (cause) {
      if (!this.#request.signal.aborted) this.errorMessage = this.#ui.t(
        (cause instanceof BrandingEditError && cause.kind === "stale") || (cause instanceof CampaignMutationHTTPError && cause.status === 409)
          ? "branding.stale" : cause instanceof BrandingEditError ? "branding.invalid" : "branding.failed");
    } finally { this.busy = false; }
  };

  readonly #saveCampaignParty = async (event: CustomEvent<CampaignPartySaveDetail>): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canManageCampaign() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated || this.campaignState.state !== "ready") return;
    let mutation: CampaignMutation;
    try {
      mutation = prepareCampaignPartySave(this.campaignState.campaign, event.detail);
    } catch (cause: unknown) {
      this.errorMessage = this.#ui.t(cause instanceof CampaignPartyEditError && cause.kind === "stale"
        ? "settings.partyStale" : "settings.partyInvalid");
      return;
    }
    this.busy = true; this.errorMessage = "";
    try {
      await this.#campaignMutations.commit([mutation], this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false; this.editCompletion += 1;
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) this.errorMessage = this.#ui.t(
        cause instanceof CampaignMutationHTTPError && cause.status === 409 ? "settings.partyStale" : "settings.partyFailed");
    } finally { this.busy = false; }
  };

  readonly #saveCampaignAppearance = async (
    event: CustomEvent<CampaignAppearanceSaveDetail>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canManageCampaign() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") return;
    let mutation: CampaignMutation;
    try {
      mutation = prepareCampaignAppearanceSave(this.campaignState.campaign, event.detail);
    } catch (cause: unknown) {
      this.errorMessage = cause instanceof CampaignAppearanceEditError
        ? cause.kind === "stale"
          ? uiText("Appearance changed. Your choice is kept; reopen Appearance to review the current theme before saving.")
          : uiText("The appearance setting is invalid.")
        : uiText("The appearance setting could not be prepared: {0}", { "0": errorMessage(cause) });
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#campaignMutations.commit([mutation], this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
      this.#editDirty = false;
      this.editCompletion += 1;
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = cause instanceof CampaignMutationHTTPError && cause.status === 409
          ? uiText("Appearance changed while saving. Review the current theme and try again.")
          : uiText("Appearance could not be saved: {0}", { "0": errorMessage(cause) });
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #onHashChange = (): void => {
    const nextHash = normalizedHash(window.location.hash);
    if (nextHash !== this.#acceptedHash && !this.#confirmDiscardEdit(nextHash)) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${this.#acceptedHash}`);
      return;
    }
    if (window.location.hash && nextHash !== window.location.hash) window.history.replaceState(null, "", nextHash);
    if (nextHash === this.#acceptedHash) return;
    this.menuOpen = false;
    this.#acceptedHash = nextHash;
    if (nextHash !== this.#recordSaveDestination) this.recordSaveState = "idle";
    if (this.quickSearchOpen) this.#closeQuickSearch(false);
    this.route = parseAppRoute(nextHash);
    this.characterView = preferredCharacterView(nextHash);
    void this.updateComplete.then(() => this.#refreshOutlets());
  };

  readonly #onEditDirty = (event: CustomEvent<CampaignEditDirtyDetail>): void => {
    if (typeof event.detail?.dirty === "boolean") this.#editDirty = event.detail.dirty;
    this.#editSaving = event.detail?.saving === true;
    if (event.detail?.dirty && this.recordSaveState === "saved") this.recordSaveState = "idle";
  };

  readonly #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    const edits = this.#addons?.contributions.edits.state();
    protectUnsavedEditBeforeUnload(this.#editDirty || this.#editSaving || this.busy || edits?.dirty === true || edits?.saving === true, event);
  };

  #confirmDiscardEdit(nextHash?: string): boolean {
    if (this.busy || this.#editSaving) return false;
    const currentRoute = parseBrowserAddonLocation(this.#acceptedHash)?.routeHash;
    const nextRoute = nextHash === undefined ? undefined : parseBrowserAddonLocation(nextHash)?.routeHash;
    const edits = this.#addons?.contributions.edits.state(active =>
      currentRoute !== undefined && currentRoute === nextRoute && active.descriptor.surface === "route" && browserAddonRouteHash(active) === currentRoute);
    if (edits?.saving) {
      this.errorMessage = uiText("Wait for the add-on save to finish before leaving this view.");
      return false;
    }
    if (!confirmDiscardUnsavedEdit(this.#editDirty || edits?.dirty === true, (message) => window.confirm(message))) return false;
    this.#editDirty = false;
    return true;
  }

  readonly #dismissError = (): void => {
    this.errorMessage = "";
  };

  readonly #retryCampaign = (): void => {
    if (this.#request === undefined) return;
    this.#campaignData.reset();
    void this.#loadCampaign(this.#request.signal);
  };
}

function anonymousAuth(): AuthState {
  return { authenticated: false, role: null, realRole: null };
}

function preferredCharacterView(hash: string): "profile" | "addons" {
  const route = parseAppRoute(hash);
  if (route.kind === "record" && route.editing) return "profile";
  try {
    if (route.kind === "record" && route.page.collection === "characters" &&
      window.sessionStorage.getItem(`codex:character-view:${route.key}`) === "addons") return "addons";
  } catch { /* Default to the profile when browser storage is unavailable. */ }
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
    case "connecting": return "shell.connecting";
    case "connected": return "shell.live";
    case "reconnecting": return "shell.reconnecting";
  }
}

if (!customElements.get("codex-app")) {
  customElements.define("codex-app", CodexApp);
}
