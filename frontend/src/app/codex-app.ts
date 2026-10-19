import { bindLongPress, openContextMenu } from "../ui/context-menu.js";
import { recordContextMenu } from "./record-context-menu.js";
import { BusyLeases, busyLeaseRequestEvent, type BusyLeaseRequest } from "./busy-lease.js";
import { CampaignWriteController } from "./campaign-write-controller.js";
import type { CampaignRecordSavedDetail } from "./codex-record-page.js";
import { uiRequestError } from "./ui-errors.js";
import { isRecord } from "../core/boundary.js";
import { LitElement, html, nothing } from "lit";
import { CampaignController, type CampaignState } from "./campaign-controller.js";
import { applyCampaignTheme } from "./campaign-appearance.js";
import { isPlayerPreview, previewResourceURL } from "../core/player-preview.js";
import { contributionLabel } from "../addons/contribution-label.js";
import { listBrowserNavigation } from "../addons/navigation.js";
import { applyBrandingFavicon, campaignBranding, defaultLogo } from "./campaign-branding.js";
import { parseAppRoute, canonicalAppHash, type AppRoute } from "./routes.js";
import { UiLocalizationController, uiText } from "./ui-localization.js";
import "./codex-dashboard.js";
import "./codex-dm-dashboard.js";
import "./codex-record-page.js";
import { AddonLinksController } from "./addon-links-controller.js";
import { AddonOutletsController, type AddonState } from "./addon-outlets-controller.js";
import { bindRuleDetails } from "./codex-addon-rule-details.js";
import "./codex-search.js";
import { rememberRecentRecord } from "./recent-records.js";
import { navigateTabs } from "../ui/focus.js";
import "./codex-settings.js";
import "./codex-addon-markdown.js";
import "./codex-map.js";
import "./codex-timeline.js";
import "./codex-campaign-graph.js";
import type { CodexAccountMenu } from "./codex-account-menu.js";
import "./codex-account-menu.js";
import type { CodexQuickSearch } from "./codex-quick-search.js";
import "./codex-quick-search.js";
import { coreRouteActive, mobileNavigation } from "./codex-shell-navigation.js";
import { NavigationGuard } from "./navigation-guard.js";
import { SessionController, type Authority, type LiveState } from "./session-controller.js";
import { sessionRecovery } from "./session-recovery.js";

/**
 * The campaign shell: sidebar, page, alerts and the record context menu. The
 * session, the add-ons, campaign loading, writes and leaving open edits each
 * have their own controller; this element routes between pages and wires
 * them together.
 */
export class CodexApp extends LitElement {
  static override properties = {
    route: { state: true },
    errorMessage: { state: true },
    recordSaved: { state: true },
    characterView: { state: true },
    menuOpen: { state: true },
    mobileViewport: { state: true },
    contextNotice: { state: true },
  };

  declare private route: AppRoute;
  declare private errorMessage: string;
  /** A confirmed record save, shown until the next edit or another page. */
  declare private recordSaved: boolean;
  declare private contextNotice: string;
  declare private characterView: "profile" | "addons";
  declare private menuOpen: boolean;
  declare private mobileViewport: boolean;
  #contextNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  #recordSaveDestination = "";
  /** The authority the last render showed, to notice when it changes. */
  #shownAuthority: Authority | undefined;
  #longPressAt = 0;
  #listening: AbortController | undefined;
  #disposeRuleDetails: (() => void) | undefined;
  readonly #mobileMedia = window.matchMedia("(max-width: 768px)");
  readonly #ui = new UiLocalizationController(this);
  readonly #busy = new BusyLeases(() => this.requestUpdate());
  readonly #campaign = new CampaignController(this, {
    mayRefresh: (retainCurrent) => {
      if (this.#session.recovering) return false;
      // Live refresh first confirms a signed-in session is still valid.
      if (retainCurrent && this.#session.authenticated && !isPlayerPreview())
        return this.#session.check();
      return true;
    },
    apply: (campaign) => {
      applyCampaignTheme(campaign);
      applyBrandingFavicon(campaignBranding(campaign));
    },
    accepted: () => this.#addons.campaignShown(),
    refreshFailed: (cause) => {
      this.errorMessage = uiText("Campaign refresh failed: {0}", { "0": uiRequestError(cause) });
    },
  });
  readonly #addons = new AddonOutletsController(this, {
    auth: () => this.#session.auth,
    route: () => this.route,
    campaign: () => this.#campaign.campaign,
    locale: () => this.#ui.locale,
    canEdit: () => this.#session.authenticated,
    recoveryRequested: async () => {
      await this.#session.check();
      return this.#session.recovering;
    },
    authorityLost: (signal, current) => this.#session.addonAuthorityLost(signal, current),
    cleanupFailed: (message) => {
      this.errorMessage = message;
    },
  });
  readonly #guard = new NavigationGuard(this, {
    busy: () => this.busy,
    registry: () => this.#addons.contributions,
    navigated: (hash) => this.#navigated(hash),
    edited: () => {
      this.recordSaved = false;
    },
    refused: (message) => {
      this.errorMessage = message;
    },
  });
  readonly #session = new SessionController(this, {
    campaign: this.#campaign,
    addons: this.#addons,
    busy: this.#busy,
    guard: this.#guard,
    report: (message, append = false) => {
      this.errorMessage = append ? this.errorMessage + message : message;
    },
    signedOut: () => {
      if (this.route.kind === "addon") window.location.hash = "#/";
    },
    resumed: () => {
      void this.updateComplete.then(() => {
        if (this.#session.signal?.aborted === false)
          this.querySelector<HTMLElement>("#campaign-content")?.focus();
      });
    },
  });
  readonly #writes = new CampaignWriteController(this, {
    campaign: this.#campaign,
    busy: this.#busy,
    writer: () => {
      const auth = this.#session.auth;
      return this.#session.signal !== undefined && auth?.authenticated
        ? { csrfToken: auth.csrfToken, canManage: this.#session.canManage }
        : undefined;
    },
    editing: () => this.#guard.editing,
  });
  readonly #links = new AddonLinksController(this, () => ({
    registry: this.#addons.contributions,
    role: this.#session.role,
  }));

  constructor() {
    super();
    this.route = { kind: "dashboard" };
    this.errorMessage = "";
    this.characterView = preferredCharacterView(window.location.hash);
    this.recordSaved = false;
    this.contextNotice = "";
    this.menuOpen = false;
    this.mobileViewport = this.#mobileMedia.matches;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#disposeRuleDetails = bindRuleDetails(this, this.#links);
    this.route = parseAppRoute(this.#guard.hash);
    window.addEventListener("keydown", this.#onKeyDown);
    this.#mobileMedia.addEventListener("change", this.#onViewportChange);
    const listening = new AbortController();
    this.#listening = listening;
    this.addEventListener(busyLeaseRequestEvent, this.#onBusyLeaseRequest, {
      signal: listening.signal,
    });
    this.addEventListener("contextmenu", this.#onContextMenu, { signal: listening.signal });
    bindLongPress(
      this,
      (target, point) => {
        const opened = this.#openRecordMenu(target, point);
        if (opened) this.#longPressAt = Date.now();
        return opened;
      },
      listening.signal,
    );
  }

  override disconnectedCallback(): void {
    clearTimeout(this.#contextNoticeTimer);
    this.#disposeRuleDetails?.();
    this.#disposeRuleDetails = undefined;
    this.#listening?.abort();
    this.#listening = undefined;
    this.#busy.clear();
    window.removeEventListener("keydown", this.#onKeyDown);
    this.#mobileMedia.removeEventListener("change", this.#onViewportChange);
    super.disconnectedCallback();
  }

  /** A write, a sign-in or view change, or an add-on administration request is running. */
  get busy(): boolean {
    return this.#busy.busy;
  }

  /** The shell's progress, which the browser tests wait for. */
  get campaignState(): CampaignState {
    return this.#campaign.state;
  }
  get liveState(): LiveState {
    return this.#session.liveState;
  }
  get addonState(): AddonState {
    return this.#addons.state;
  }

  protected override render() {
    const campaign = this.#campaign.campaign;
    const session = this.#session;
    const branding = campaignBranding(campaign);
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
          <codex-shell-navigation .campaign=${campaign} .route=${this.route} .canManage=${session.canManage}></codex-shell-navigation>
          <section class="addon-navigation-section" aria-labelledby="addon-navigation-title" ?hidden=${this.#addons.navigationCount === 0}>
            <h2 id="addon-navigation-title">${this.#ui.t("shell.addons")}</h2>
            <nav class="addon-navigation" data-addon-navigation hidden></nav>
          </section>
          <footer class="sidebar-footer">
            ${session.canManage ? html`<a href="#/dm" aria-current=${this.route.kind === "dm" ? "page" : nothing}>🛡 ${this.#ui.t("dm.title")}</a>` : nothing}
            ${this.#viewAs()}
            <a href="#/settings" aria-current=${coreRouteActive(this.route, "settings") ? "page" : nothing}>⚙ ${this.#ui.t("shell.settings")}</a>
            <codex-account-menu .authority=${session.authority} .readiness=${session.readiness}
              .liveState=${session.liveState} .addonState=${this.#addons.state} .busy=${this.busy}
              .signIn=${(password: string) => session.login(password)}
              .signOut=${() => void session.logout()}
              .closePreview=${() => void session.closePreview()}></codex-account-menu>
          </footer>
        </aside>
        <button class="sidebar-backdrop" aria-label=${this.#ui.t("shell.closeMenu")} ?hidden=${!this.mobileViewport || !this.menuOpen} @click=${this.#closeMenu}></button>
        <main id="campaign-content" class=${`campaign-content route-${this.route.kind}`} tabindex="-1" .inert=${this.mobileViewport && this.menuOpen}>
          ${
            isPlayerPreview()
              ? html`<div class="player-preview-notice" role="status">
            ${this.#ui.t(session.authority.state === "checking" ? "shell.checkingSession" : session.authenticated ? "preview.notice" : "preview.unavailable")}
            <button class="text-button" type="button" @click=${() => void session.closePreview()}>${this.#ui.t("preview.close")}</button>
          </div>`
              : nothing
          }
          ${session.liveState === "reconnecting" ? html`<p class="connection-alert" role="status">${this.#ui.t("shell.reconnecting")}</p>` : nothing}
          ${
            session.recovering
              ? sessionRecovery({
                  busy: this.busy,
                  error: session.recoveryError,
                  resume: (password) => session.resume(password),
                })
              : nothing
          }
          ${session.restored && !this.recordSaved ? html`<p class="record-save-confirmation" role="status">${this.#ui.t("session.restored")}</p>` : nothing}
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
          ${this.recordSaved && session.authenticated ? html`<p class="record-save-confirmation record-save-toast" role="status">${uiText("save.entrySaved")}</p>` : nothing}
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

        ${mobileNavigation(this.route, this.menuOpen, this.#toggleMenu)}
      </div>
      <codex-quick-search .campaign=${campaign} .registry=${this.#addons.contributions}
        .actorRole=${session.role} .currentHash=${this.#guard.hash}
        .fallbackFocus=${this.#searchFallbackFocus}></codex-quick-search>
    `;
  }

  protected override willUpdate(): void {
    // A different viewer must not keep a search over what the previous one saw.
    if (this.#session.authority !== this.#shownAuthority) this.#quickSearch?.hide(false);
  }

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    const campaign = this.#campaign.campaign,
      authority = this.#session.authority;
    if (campaign !== undefined && (changed.has("route") || authority !== this.#shownAuthority))
      rememberRecentRecord(campaign, this.route, this.#session.role ?? "public");
    this.#shownAuthority = authority;
  }

  readonly #onBusyLeaseRequest = (event: Event): void => {
    if (!this.isConnected) return;
    event.stopPropagation();
    (event as CustomEvent<BusyLeaseRequest>).detail.grant(this.#busy.acquire());
  };

  get #quickSearch(): CodexQuickSearch | null {
    return this.querySelector<CodexQuickSearch>("codex-quick-search");
  }

  get #hasCharacterTabs(): boolean {
    return (
      this.route.kind === "record" &&
      this.route.page.collection === "characters" &&
      this.#addons.articleCount > 0 &&
      this.#addons.recordContext !== null
    );
  }

  /** The add-on tab's page heading; the add-ons show the name in their own layout. */
  get #characterName(): string {
    const context = this.#addons.recordContext;
    return isRecord(context) &&
      isRecord(context["value"]) &&
      typeof context["value"]["name"] === "string"
      ? context["value"]["name"]
      : uiText("Character");
  }

  #characterTabs() {
    if (!this.#hasCharacterTabs) return nothing;
    const role = this.#session.role ?? null;
    const contributions = role
      ? (this.#addons.contributions
          ?.list("article-section", role)
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

  /** Role switching stays outside the account menu because DMs use it during play. */
  #viewAs() {
    const auth = this.#session.auth;
    if (isPlayerPreview() || !auth?.authenticated || auth.realRole !== "dm") return nothing;
    const toPlayer = auth.role === "dm";
    return html`<button class="sidebar-footer-action" type="button"
      @click=${() => void (toPlayer ? this.#session.openPreview() : this.#session.switchRole())} ?disabled=${this.busy}
      title=${toPlayer ? this.#ui.t("preview.openHint") : nothing}>
      <span aria-hidden="true">👁</span>${this.#ui.t("shell.viewAs", { role: toPlayer ? this.#ui.t("shell.player") : uiText("DM") })}
    </button>`;
  }

  #campaignTemplate() {
    const state = this.#campaign.state;
    if (state.state === "loading") {
      return html`<section class="loading-page" aria-live="polite"><span aria-hidden="true">✦</span><p>${this.#ui.t("shell.openingCampaign")}</p></section>`;
    }
    if (state.state === "unavailable") {
      return html`
        <section class="unavailable-page">
          <p class="page-kicker">${this.#ui.t("shell.campaignArchive")}</p>
          <h1>${this.#ui.t("shell.campaignOpenFailed")}</h1>
          <p>${state.message}</p>
          <button type="button" @click=${this.#retryCampaign} ?disabled=${this.busy}>${this.#ui.t("shell.tryAgain")}</button>
        </section>
      `;
    }
    const campaign = state.campaign;
    const session = this.#session;
    const registry = this.#addons.contributions;
    const addons = this.#addons.state;
    switch (this.route.kind) {
      case "dm":
        return html`<codex-dm-dashboard .campaign=${campaign} .canManage=${session.canManage}
          .registry=${registry} .health=${this.#addons.health}
          .loading=${addons.state === "loading"}
          .degraded=${addons.state === "degraded" || (addons.state === "ready" && addons.failures > 0)}
          @dm-retry-addons=${this.#retryDmAddons}></codex-dm-dashboard>`;
      case "campaign-graph":
        return html`<codex-campaign-graph .campaign=${campaign} .mode=${this.route.mode}
          .registry=${registry} .actorRole=${session.role}></codex-campaign-graph>`;
      case "timeline":
        return html`<codex-timeline .campaign=${campaign} .canEdit=${session.authenticated} .busy=${this.busy}
          .registry=${registry} .actorRole=${session.role}></codex-timeline>`;
      case "map":
        return html`<codex-map .campaign=${campaign} .route=${this.route} .canEdit=${session.authenticated}
          .registry=${registry}
          .actorRole=${session.role}
          .canManageCampaign=${session.canManage} .busy=${this.busy}></codex-map>`;
      case "dashboard":
      case "party":
        return html`<codex-dashboard .campaign=${campaign} .partyOnly=${this.route.kind === "party"}
          .authenticated=${session.authenticated} .canManageCampaign=${session.canManage} .canEdit=${session.authenticated}
          .busy=${this.busy} @campaign-sign-in=${this.#showSignIn}
        ></codex-dashboard>`;
      case "search":
        return html`<codex-search .campaign=${campaign} .query=${this.route.query ?? ""} .registry=${registry}
          .actorRole=${session.role}></codex-search>`;
      case "settings":
        return html`<codex-settings
          .registry=${registry}
          .actorRole=${session.role}
          .addonTarget=${this.route.addonId}
          .category=${this.route.category}
          .addonPages=${session.canManage && registry !== undefined ? listBrowserNavigation(registry, "dm", this.#ui.locale) : []}
          .csrfToken=${session.auth?.authenticated ? session.auth.csrfToken : ""}
          .campaign=${campaign}
          .mapTarget=${this.route.mapParentId}
          .canManageCampaign=${session.canManage}
          .busy=${this.busy}
        ></codex-settings>`;
      case "collection":
      case "record":
      case "create":
        return html`<codex-record-page
          .campaign=${campaign}
          .registry=${registry}
          .actorRole=${session.role}
          .route=${this.route}
          .canEdit=${session.authenticated}
          .canManageVisibility=${session.canManage}
          .busy=${this.busy}
          @campaign-record-saved=${this.#onRecordSaved}
          @campaign-collection-view=${this.#onCollectionView}
          @campaign-sign-in=${this.#showSignIn}
        ></codex-record-page>`;
      case "addon":
        if (!session.authenticated) {
          return html`<section class="unavailable-page"><p class="page-kicker">${this.#ui.t("shell.addonPage")}</p><h1>${this.#ui.t("shell.signInAddon")}</h1><p>${this.#ui.t("shell.addonRoleHint")}</p></section>`;
        }
        if (this.#addons.routeCount === 0) {
          return html`<section class="loading-page"><span aria-hidden="true">✦</span><p>${this.#ui.t("shell.openingAddon")}</p></section>`;
        }
        return nothing;
      case "not-found":
        return html`<section class="unavailable-page"><p class="page-kicker">${this.#ui.t("shell.campaignArchive")}</p><h1>${this.#ui.t("shell.pageMissing")}</h1><p>${this.#ui.t("shell.pageMissingHint")}</p><a class="primary-link" href="#/">${this.#ui.t("shell.returnOverview")}</a></section>`;
    }
  }

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
    const campaign = this.#campaign.campaign;
    if (campaign === undefined) return false;
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
    const menu = recordContextMenu(campaign, route.page, route.key, {
      canEdit: this.#session.authenticated,
      current:
        this.route.kind === "record" &&
        this.route.page.id === route.page.id &&
        this.route.key === route.key,
      writeBlocked: this.busy || this.#guard.editing ? uiText("menu.blocked") : "",
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

  /** The guard accepted a new address. */
  #navigated(hash: string): void {
    this.menuOpen = false;
    if (hash !== this.#recordSaveDestination) this.recordSaved = false;
    if (this.#quickSearch?.isOpen) this.#quickSearch.hide(false);
    this.route = parseAppRoute(hash);
    this.characterView = preferredCharacterView(hash);
    void this.updateComplete.then(() => this.#addons.refresh());
  }

  /** The confirmation stays visible on the page the saved form returns to. */
  readonly #onRecordSaved = (event: CustomEvent<CampaignRecordSavedDetail>): void => {
    this.#recordSaveDestination = canonicalAppHash(event.detail.destination);
    this.recordSaved = true;
  };

  /** A collection's filters changed; the address follows without a navigation. */
  readonly #onCollectionView = (event: CustomEvent<{ hash: string }>): void => {
    const route = parseAppRoute(event.detail.hash);
    if (
      route.kind !== "collection" ||
      this.route.kind !== "collection" ||
      route.page.id !== this.route.page.id
    )
      return;
    this.#guard.replace(event.detail.hash);
    this.route = route;
  };

  readonly #retryDmAddons = (): void => {
    const signal = this.#session.signal;
    if (!this.#session.canManage || this.busy || signal === undefined) return;
    void this.#addons.retry(signal);
  };

  readonly #showSignIn = async (): Promise<void> => {
    if (this.#session.authenticated) return;
    if (this.mobileViewport) this.menuOpen = true;
    await this.updateComplete;
    await this.querySelector<CodexAccountMenu>("codex-account-menu")?.openSignIn();
  };

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
      if (this.#quickSearch?.isOpen) this.#quickSearch.hide();
      else this.#openQuickSearch();
    }
  };

  readonly #openQuickSearch = (event?: MouseEvent): void => {
    if (
      event &&
      (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
    )
      return;
    if (this.#campaign.campaign === undefined) return;
    event?.preventDefault();
    this.#quickSearch?.show();
    this.menuOpen = false;
  };

  readonly #searchFallbackFocus = (): HTMLElement | null =>
    this.querySelector<HTMLElement>(this.mobileViewport ? "[data-menu-toggle]" : ".sidebar-search");

  readonly #dismissError = (): void => {
    this.errorMessage = "";
  };

  readonly #retryCampaign = (): void => {
    const signal = this.#session.signal;
    if (signal !== undefined) void this.#campaign.reload(signal);
  };
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

if (!customElements.get("codex-app")) {
  customElements.define("codex-app", CodexApp);
}
