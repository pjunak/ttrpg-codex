import { LitElement, html, nothing } from "lit";
import {
  getAuth,
  getHealth,
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
import {
  createBrowserAddonComposition,
  type BrowserAddonComposition,
} from "../addons/browser-composition.js";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import {
  BrowserNavigationOutlet,
  browserAddonRouteHash,
} from "../addons/navigation.js";
import logoURL from "../assets/logo-default.svg";
import {
  CampaignRecordEditError,
  prepareCampaignRecordDelete,
  prepareCampaignRecordSave,
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
  campaignPages,
  collectionHash,
  parseAppRoute,
  recordHash,
  type AppRoute,
} from "./routes.js";
import {
  UiLocalizationController,
  uiCollectionLabel,
  type MessageKey,
} from "./ui-localization.js";
import "./codex-dashboard.js";
import "./codex-record-page.js";
import "./codex-search.js";
import "./codex-settings.js";
import { CampaignIdentityEditError, prepareCampaignIdentitySave, type CampaignIdentitySaveDetail } from "./campaign-identity.js";
import { MediaClient } from "../core/media.js";
import { CampaignMapEditError, mapLocationRecord, prepareMapSave, prepareLocalMapImage, type MapSaveDetail, type MapUploadDetail } from "./campaign-map.js";
import "./codex-map.js";

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
    contributionCount: { state: true },
    navigationCount: { state: true },
    routeCount: { state: true },
    articleCount: { state: true },
    editCompletion: { state: true },
    menuOpen: { state: true },
    mobileViewport: { state: true },
  };

  declare private readiness: Readiness;
  declare private authority: Authority;
  declare private campaignState: CampaignState;
  declare private addonState: AddonState;
  declare private liveState: LiveState;
  declare private route: AppRoute;
  declare private busy: boolean;
  declare private errorMessage: string;
  declare private contributionCount: number;
  declare private navigationCount: number;
  declare private routeCount: number;
  declare private articleCount: number;
  declare private editCompletion: number;

  declare private menuOpen: boolean;
  declare private mobileViewport: boolean;
  readonly #mobileMedia = window.matchMedia("(max-width: 768px)");
  #request: AbortController | undefined;
  readonly #campaignData = new CampaignDataClient();
  readonly #campaignMutations = new CampaignMutationClient();
  readonly #events = new SharedEventStream();
  readonly #ui = new UiLocalizationController(this);
  #addons: BrowserAddonComposition | undefined;
  #dashboardOutlet: BrowserContributionOutlet | undefined;
  #articleOutlet: BrowserContributionOutlet | undefined;
  #navigationOutlet: BrowserNavigationOutlet | undefined;
  #routeOutlet: BrowserContributionOutlet | undefined;
  #addonOwner = 0;
  #editDirty = false;
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
    this.editCompletion = 0;
    this.menuOpen = false;
    this.mobileViewport = this.#mobileMedia.matches;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#acceptedHash = normalizedHash(window.location.hash);
    this.route = parseAppRoute(window.location.hash);
    window.addEventListener("hashchange", this.#onHashChange);
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    window.addEventListener("keydown", this.#onKeyDown);
    this.#mobileMedia.addEventListener("change", this.#onViewportChange);
    this.#request = new AbortController();
    void this.#bootstrap(this.#request.signal);
  }

  override disconnectedCallback(): void {
    this.#request?.abort("component-disconnected");
    this.#request = undefined;
    this.#events.close();
    window.removeEventListener("hashchange", this.#onHashChange);
    window.removeEventListener("beforeunload", this.#onBeforeUnload);
    window.removeEventListener("keydown", this.#onKeyDown);
    this.#mobileMedia.removeEventListener("change", this.#onViewportChange);
    void this.#stopAddons();
    super.disconnectedCallback();
  }

  protected override render() {
    return html`
      <a class="skip-link" href="#campaign-content" @click=${this.#focusContent}>${this.#ui.t("shell.skip")}</a>
      <div class="codex-shell">
        <aside id="campaign-sidebar" class=${`campaign-sidebar ${this.menuOpen ? "is-open" : ""}`} .inert=${this.mobileViewport && !this.menuOpen}>
          <header class="campaign-brand">
            <a href="#/" aria-label=${this.#ui.t("shell.openOverview")}>
              <img class="campaign-sigil" src=${logoURL} alt="" />
              <span><strong>TTRPG Codex</strong><small>Wiki &amp; World Atlas</small></span>
            </a>
          </header>
          <a class="sidebar-search" href="#/search"><span aria-hidden="true">🔍</span>${this.#ui.t("shell.search")}…<kbd>Ctrl K</kbd></a>
          ${this.#navigationTemplate()}
          <section class="addon-navigation-section" aria-labelledby="addon-navigation-title" ?hidden=${this.navigationCount === 0}>
            <h2 id="addon-navigation-title">${this.#ui.t("shell.addons")}</h2>
            <nav class="addon-navigation" data-addon-navigation hidden></nav>
          </section>
          <footer class="sidebar-footer">
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
          ${this.liveState === "reconnecting" ? html`<p class="connection-alert" role="status">${this.#ui.t("shell.reconnecting")}</p>` : nothing}
          ${this.errorMessage === "" ? nothing : html`
            <p class="application-alert" role="alert">
              <span>${this.errorMessage}</span>
              <button type="button" @click=${this.#dismissError}>${this.#ui.t("shell.dismiss")}</button>
            </p>
          `}
          ${this.#campaignTemplate()}
          <section class="addon-dashboard" data-addon-slot hidden aria-label=${this.#ui.t("shell.campaignAddons")}></section>
          <section class="addon-article" data-addon-article hidden aria-label=${this.#ui.t("shell.recordAddons")}></section>
          <section class="addon-route" data-addon-route-outlet hidden aria-label=${this.#ui.t("shell.addonPage")}></section>
        </main>

        ${this.#mobileNavigationTemplate()}
      </div>
    `;
  }

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
      this.errorMessage = `Session check failed: ${errorMessage(cause)}`;
    }

    await this.#loadCampaign(signal);
    if (signal.aborted) return;
    this.#startEventStream();
    if (this.#authenticated()) {
      try {
        await this.#startAddons();
      } catch (cause: unknown) {
        if (!signal.aborted) this.errorMessage = `Add-ons could not start: ${errorMessage(cause)}`;
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
        this.campaignState = { state: "ready", campaign };
        await this.updateComplete;
        this.#articleOutlet?.refresh();
      }
    } catch (cause: unknown) {
      if (signal.aborted) return;
      const current = this.#campaignData.current();
      if (retainCurrent && current !== undefined) {
        applyCampaignTheme(current);
        this.campaignState = { state: "ready", campaign: current };
        this.errorMessage = `Campaign refresh failed: ${errorMessage(cause)}`;
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
        this.errorMessage = `Live update was rejected: ${errorMessage(cause)}`;
      },
      onConnectionError: () => {
        this.liveState = "reconnecting";
      },
    });
  }

  async #handleEvent(event: EventRefresh): Promise<void> {
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
      if (!this.#request.signal.aborted) this.errorMessage = `Sign-in failed: ${errorMessage(cause)}`;
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
      this.#campaignData.reset();
      await this.#loadCampaign(this.#request.signal);
      this.#startEventStream();
      if (this.route.kind === "addon") window.location.hash = "#/";
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = `Sign-out failed: ${errorMessage(cause)}`;
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
        this.errorMessage = `View switch failed: ${errorMessage(cause)}`;
        await this.#recoverAddons();
      }
    } finally {
      this.busy = false;
    }
  }

  async #reloadForAuthority(): Promise<void> {
    if (this.#request === undefined) return;
    this.#campaignData.reset();
    await this.#loadCampaign(this.#request.signal);
    this.#startEventStream();
    try {
      await this.#startAddons();
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = `Add-ons could not start: ${errorMessage(cause)}`;
      }
    }
  }

  async #recoverAddons(): Promise<void> {
    if (!this.#authenticated() || this.#request === undefined || this.#request.signal.aborted) return;
    try {
      await this.#startAddons();
    } catch (cause: unknown) {
      this.errorMessage += ` Add-on recovery also failed: ${errorMessage(cause)}`;
    }
  }

  async #startAddons(): Promise<void> {
    await this.#stopAddons();
    const owner = ++this.#addonOwner;
    const auth = this.authority.state === "known" ? this.authority.auth : anonymousAuth();
    if (!auth.authenticated) return;
    this.addonState = { state: "loading" };
    const composition = createBrowserAddonComposition(document, auth.csrfToken, {
      onRefresh: (_cause, result) => {
        if (owner !== this.#addonOwner) return;
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
          this.addonState = { state: "degraded", message: errorMessage(cause) };
        }
      },
      onAuthorityLost: () => {
        if (owner !== this.#addonOwner) return;
        this.#addons = undefined;
        this.#disposeOutlets();
        this.authority = { state: "known", auth: anonymousAuth() };
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
          this.addonState = { state: "degraded", message: errorMessage(cause) };
        }
      };
      this.#navigationOutlet = new BrowserNavigationOutlet({
        document,
        root: navigationRoot,
        registry: composition.contributions,
        role: auth.role,
        currentHash: () => window.location.hash,
        onError,
        onCountChange: (count) => { if (owner === this.#addonOwner) this.navigationCount = count; },
      });
      this.#dashboardOutlet = new BrowserContributionOutlet({
        document,
        root: dashboardRoot,
        registry: composition.contributions,
        surface: "slot",
        role: auth.role,
        include: () => this.route.kind === "dashboard",
        onError,
        onCountChange: (count) => { if (owner === this.#addonOwner) this.contributionCount = count; },
      });
      this.#articleOutlet = new BrowserContributionOutlet({
        document,
        root: articleRoot,
        registry: composition.contributions,
        surface: "article-section",
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
        include: (active) => browserAddonRouteHash(active) === window.location.hash,
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
    this.addonState = { state: "idle" };
    if (addons !== undefined) {
      const failures = await addons.session.stop();
      if (failures.length > 0) {
        this.errorMessage = `Failed to clean up ${failures.length} browser add-on resource(s).`;
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
      collection: this.route.page.collection,
      key: record.key,
      revision: record.revision,
      value: record.value,
      canEdit: this.#canEdit(),
    };
  }

  #navigationTemplate() {
    const entries = (ids: readonly string[]) => ids.flatMap(id => {
      const page = campaignPages.find(page => page.id === id);
      return page === undefined ? [] : [{ id, label: uiCollectionLabel(id, "other"), icon: page.icon, hash: collectionHash(page) }];
    });
    const groups = [
      { id: "overview", label: this.#ui.t("shell.overview"), entries: [
        { id: "dashboard", label: this.#ui.t("shell.overview"), icon: "🏠", hash: "#/" },
        { id: "party", label: this.#ui.t("shell.party"), icon: "🛡", hash: "#/party" },
      ] },
      { id: "campaign", label: this.#ui.t("shell.campaign"), entries: entries(["events", "mysteries"]) },
      { id: "world", label: this.#ui.t("shell.world"), entries: [
        { id: "map", label: this.#ui.t("map.world"), icon: "🗺", hash: "#/map/world" },
        ...entries(["locations", "characters", "factions", "companions"]),
      ] },
      { id: "compendium", label: this.#ui.t("shell.compendium"), entries: entries(["pantheon", "artifacts", "history"]) },
    ];
    return html`
      <nav class="core-navigation" aria-label=${this.#ui.t("shell.campaignArchive")}>
        ${groups.map((group) => html`
          <section class=${`navigation-${group.id}`}>
            <h2>${group.label}</h2>
            ${group.entries.map((entry) => html`
              <a href=${entry.hash} aria-current=${this.#coreRouteActive(entry.id) ? "page" : nothing}>
                <span aria-hidden="true">${entry.icon}</span>${entry.label}
              </a>
            `)}
          </section>
        `)}
      </nav>
    `;
  }

  #mobileNavigationTemplate() {
    return html`
      <nav class="mobile-navigation" aria-label=${this.#ui.t("shell.primaryNavigation")}>
        <a href="#/" aria-current=${this.#coreRouteActive("dashboard") ? "page" : nothing}><span aria-hidden="true">🏠</span>${this.#ui.t("shell.overview")}</a>
        <a href="#/party" aria-current=${this.#coreRouteActive("party") ? "page" : nothing}><span aria-hidden="true">🛡</span>${this.#ui.t("shell.party")}</a>
        <a href="#/search" aria-current=${this.#coreRouteActive("search") ? "page" : nothing}><span aria-hidden="true">🔍</span>${this.#ui.t("shell.search")}</a>
        <a href="#/events" aria-current=${this.#coreRouteActive("events") ? "page" : nothing}><span aria-hidden="true">⏳</span>${uiCollectionLabel("events", "other")}</a>
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
    if (event.key === "Escape" && this.menuOpen) {
      event.preventDefault();
      this.#closeMenu();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      window.location.hash = "#/search";
    }
  };

  #accountTemplate() {
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
        <p><span class="authority-mark" aria-hidden="true"></span>${this.#ui.t("shell.viewingAs")} <strong>${auth.role === "dm" ? "DM" : this.#ui.t("shell.player")}</strong></p>
        ${auth.realRole === "dm" ? html`
          <button class="text-button" type="button" @click=${this.#switchRole} ?disabled=${this.busy}>
            ${this.#ui.t("shell.viewAs", { role: auth.role === "dm" ? this.#ui.t("shell.player") : "DM" })}
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
      case "map":
        return html`<codex-map .campaign=${campaign} .route=${this.route} .canEdit=${this.#canEdit()}
          .canManageCampaign=${this.#canManageCampaign()} .saving=${this.busy} .editCompletion=${this.editCompletion}
          .errorMessage=${this.errorMessage} @campaign-edit-dirty=${this.#onEditDirty}
          @campaign-map-save=${this.#saveMap} @campaign-map-upload=${this.#uploadMap}></codex-map>`;
      case "dashboard":
      case "party":
        return html`<codex-dashboard .campaign=${campaign} .partyOnly=${this.route.kind === "party"}
          .authenticated=${this.#authenticated()} .canManageCampaign=${this.#canManageCampaign()}
          .saving=${this.busy} .editCompletion=${this.editCompletion}
          @campaign-edit-dirty=${this.#onEditDirty} @campaign-identity-save=${this.#saveCampaignIdentity}
          @campaign-sign-in=${this.#showSignIn}
        ></codex-dashboard>`;
      case "search":
        return html`<codex-search .campaign=${campaign}></codex-search>`;
      case "settings":
        return html`<codex-settings
          .campaign=${campaign}
          .canManageCampaign=${this.#canManageCampaign()}
          .saving=${this.busy}
          .editCompletion=${this.editCompletion}
          @campaign-edit-dirty=${this.#onEditDirty}
          @campaign-enum-save=${this.#saveCampaignEnum}
          @campaign-enum-delete=${this.#deleteCampaignEnum}
          @campaign-appearance-save=${this.#saveCampaignAppearance}
        ></codex-settings>`;
      case "collection":
      case "record":
      case "create":
        return html`<codex-record-page
          .campaign=${campaign}
          .route=${this.route}
          .canEdit=${this.#canEdit()}
          .canManageVisibility=${this.#canManageCampaign()}
          .saving=${this.busy}
          .editCompletion=${this.editCompletion}
          @campaign-edit-dirty=${this.#onEditDirty}
          @campaign-record-save=${this.#saveCampaignRecord}
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
        return html`<section class="unavailable-page"><p class="page-kicker">${this.#ui.t("shell.campaignArchive")}</p><h1>${this.#ui.t("shell.pageMissing")}</h1><p>${this.#ui.t("shell.pageMissingHint")}</p><a class="primary-link" href="#/">${this.#ui.t("shell.returnOverview")}</a></section>`;
    }
  }

  #coreRouteActive(id: string): boolean {
    if (id === "map") return this.route.kind === "map";
    if (id === "dashboard") return this.route.kind === "dashboard";
    if (id === "search") return this.route.kind === "search";
    if (id === "party") return this.route.kind === "party" || this.route.kind === "create";
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

  readonly #saveCampaignRecord = async (
    event: CustomEvent<CampaignRecordSaveDetail>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEdit() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") return;
    let prepared: PreparedCampaignRecordTransaction;
    try {
      prepared = prepareCampaignRecordSave(
        this.campaignState.campaign,
        event.detail,
        this.#canManageCampaign(),
      );
    } catch (cause: unknown) {
      this.errorMessage = cause instanceof CampaignRecordEditError && cause.kind === "stale"
        ? "The entry or its relationships changed. Your draft is kept; copy any notes you need, then cancel and reopen to review the current version."
        : "The entry contains a value that cannot be saved.";
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
      window.location.hash = recordHash(prepared.page, event.detail.key);
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = cause instanceof CampaignMutationHTTPError && cause.status === 409
          ? "The entry changed while saving. Reload its current version and try again."
          : `The entry could not be saved: ${errorMessage(cause)}`;
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
        ? "The entry changed before it could be deleted. Refresh and try again."
        : "The delete request is no longer valid.";
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
      window.location.hash = collectionHash(prepared.page);
    } catch (cause: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = cause instanceof CampaignMutationHTTPError && cause.status === 409
          ? "The entry changed while deleting. Reload its current version and try again."
          : `The entry could not be deleted: ${errorMessage(cause)}`;
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
          ? "The definition changed. Your draft is kept; copy any notes you need, then cancel and reopen to review the current version."
          : "The definition contains a value that cannot be saved."
        : `The definition could not be prepared: ${errorMessage(cause)}`;
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
          ? "Settings changed while saving. Reload the current definition and try again."
          : `The definition could not be saved: ${errorMessage(cause)}`;
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
        ? "The definition changed before it could be deleted."
        : `The deletion could not be prepared: ${errorMessage(cause)}`;
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
            ? "The definition is now in use or settings changed. Review the category and try again."
            : "Settings changed while deleting. Review the category and try again."
          : `The definition could not be deleted: ${errorMessage(cause)}`;
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #saveMap = async (event: CustomEvent<MapSaveDetail>): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEdit() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated || this.campaignState.state !== "ready" ||
      (event.detail.kind === "view" && !this.#canManageCampaign())) return;
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
          ? "Appearance changed. Your choice is kept; reopen Appearance to review the current theme before saving."
          : "The appearance setting is invalid."
        : `The appearance setting could not be prepared: ${errorMessage(cause)}`;
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
          ? "Appearance changed while saving. Review the current theme and try again."
          : `Appearance could not be saved: ${errorMessage(cause)}`;
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #onHashChange = (): void => {
    const nextHash = normalizedHash(window.location.hash);
    if (nextHash !== this.#acceptedHash && !this.#confirmDiscardEdit()) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${this.#acceptedHash}`);
      return;
    }
    this.menuOpen = false;
    this.#acceptedHash = nextHash;
    this.route = parseAppRoute(nextHash);
    void this.updateComplete.then(() => this.#refreshOutlets());
  };

  readonly #onEditDirty = (event: CustomEvent<CampaignEditDirtyDetail>): void => {
    if (typeof event.detail?.dirty === "boolean") this.#editDirty = event.detail.dirty;
  };

  readonly #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    protectUnsavedEditBeforeUnload(this.#editDirty, event);
  };

  #confirmDiscardEdit(): boolean {
    if (!confirmDiscardUnsavedEdit(this.#editDirty, (message) => window.confirm(message))) return false;
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

function normalizedHash(value: string): string {
  return value === "" ? "#/" : value;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown application failure";
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
