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
import { projectCampaignIdentity } from "./campaign-projection.js";
import {
  campaignPages,
  collectionHash,
  parseAppRoute,
  type AppRoute,
} from "./routes.js";
import "./codex-dashboard.js";
import "./codex-record-page.js";
import "./codex-search.js";

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

  #request: AbortController | undefined;
  readonly #campaignData = new CampaignDataClient();
  readonly #events = new SharedEventStream();
  #addons: BrowserAddonComposition | undefined;
  #dashboardOutlet: BrowserContributionOutlet | undefined;
  #articleOutlet: BrowserContributionOutlet | undefined;
  #navigationOutlet: BrowserNavigationOutlet | undefined;
  #mobileNavigationOutlet: BrowserNavigationOutlet | undefined;
  #routeOutlet: BrowserContributionOutlet | undefined;
  #addonOwner = 0;

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
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.route = parseAppRoute(window.location.hash);
    window.addEventListener("hashchange", this.#onHashChange);
    this.#request = new AbortController();
    void this.#bootstrap(this.#request.signal);
  }

  override disconnectedCallback(): void {
    this.#request?.abort("component-disconnected");
    this.#request = undefined;
    this.#events.close();
    window.removeEventListener("hashchange", this.#onHashChange);
    void this.#stopAddons();
    super.disconnectedCallback();
  }

  protected override render() {
    const identity = this.campaignState.state === "ready"
      ? projectCampaignIdentity(this.campaignState.campaign)
      : { name: "TTRPG Codex", tagline: "Campaign archive" };
    return html`
      <a class="skip-link" href="#campaign-content">Skip to campaign content</a>
      <div class="codex-shell">
        <aside class="campaign-sidebar">
          <header class="campaign-brand">
            <a href="#/" aria-label="Open campaign overview">
              <span class="campaign-sigil" aria-hidden="true">C</span>
              <span>
                <small>Campaign archive</small>
                <strong>${identity.name}</strong>
              </span>
            </a>
            <details class="mobile-archive-menu">
              <summary>${this.#mobileAccountLabel()}</summary>
              <div class="mobile-core-navigation">${this.#navigationTemplate()}</div>
              <section class="mobile-addon-navigation" aria-labelledby="mobile-addon-navigation-title">
                <h2 id="mobile-addon-navigation-title">Add-ons</h2>
                <nav class="addon-navigation" data-addon-navigation-mobile hidden></nav>
                <p class="addon-navigation-empty" ?hidden=${this.navigationCount > 0 || !this.#authenticated()}>
                  ${this.#authenticated() ? "No add-on pages are active." : "Sign in to open campaign tools."}
                </p>
              </section>
              ${this.#accountTemplate()}
            </details>
          </header>
          ${this.#navigationTemplate()}
          <section class="addon-navigation-section" aria-labelledby="addon-navigation-title">
            <h2 id="addon-navigation-title">Add-ons</h2>
            <nav class="addon-navigation" data-addon-navigation hidden></nav>
            <p class="addon-navigation-empty" ?hidden=${this.navigationCount > 0 || !this.#authenticated()}>
              ${this.#authenticated() ? "No add-on pages are active." : "Sign in to open campaign tools."}
            </p>
          </section>
          ${this.#accountTemplate()}
        </aside>

        <main id="campaign-content" class=${`campaign-content route-${this.route.kind}`} tabindex="-1">
          <header class="content-statusbar">
            ${this.#hostStatusTemplate()}
            <span class=${`live-state live-${this.liveState}`}>
              <span aria-hidden="true"></span>${liveLabel(this.liveState)}
            </span>
          </header>
          ${this.errorMessage === "" ? nothing : html`
            <p class="application-alert" role="alert">
              <span>${this.errorMessage}</span>
              <button type="button" @click=${this.#dismissError}>Dismiss</button>
            </p>
          `}
          ${this.#campaignTemplate()}
          <section class="addon-dashboard" data-addon-slot hidden aria-label="Campaign add-ons"></section>
          <section class="addon-article" data-addon-article hidden aria-label="Record add-ons"></section>
          <section class="addon-route" data-addon-route-outlet hidden aria-label="Add-on page"></section>
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
        this.campaignState = { state: "ready", campaign };
        await this.updateComplete;
        this.#articleOutlet?.refresh();
      }
    } catch (cause: unknown) {
      if (signal.aborted) return;
      const current = this.#campaignData.current();
      if (retainCurrent && current !== undefined) {
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
    if (this.busy || this.#request === undefined) return;
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
      !this.authority.auth.authenticated || this.authority.auth.realRole !== "dm") return;
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
      const mobileNavigationRoot = this.querySelector<HTMLElement>("[data-addon-navigation-mobile]");
      const dashboardRoot = this.querySelector<HTMLElement>("[data-addon-slot]");
      const articleRoot = this.querySelector<HTMLElement>("[data-addon-article]");
      const routeRoot = this.querySelector<HTMLElement>("[data-addon-route-outlet]");
      if (navigationRoot === null || mobileNavigationRoot === null || dashboardRoot === null ||
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
      this.#mobileNavigationOutlet = new BrowserNavigationOutlet({
        document,
        root: mobileNavigationRoot,
        registry: composition.contributions,
        role: auth.role,
        currentHash: () => window.location.hash,
        onError,
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
    this.#mobileNavigationOutlet?.dispose();
    this.#routeOutlet?.dispose();
    this.#dashboardOutlet = undefined;
    this.#articleOutlet = undefined;
    this.#navigationOutlet = undefined;
    this.#mobileNavigationOutlet = undefined;
    this.#routeOutlet = undefined;
    this.contributionCount = 0;
    this.navigationCount = 0;
    this.routeCount = 0;
    this.articleCount = 0;
  }

  #refreshOutlets(): void {
    this.#navigationOutlet?.refresh();
    this.#mobileNavigationOutlet?.refresh();
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
    const groups = [
      {
        label: "Campaign",
        entries: [
          { id: "dashboard", label: "Overview", icon: "⌂", hash: "#/" },
          { id: "search", label: "Search", icon: "⌕", hash: "#/search" },
          { id: "party", label: "The party", icon: "♜", hash: "#/party" },
          ...campaignPages.filter(({ group }) => group === "campaign").map((page) => ({
            id: page.id, label: page.plural, icon: page.icon, hash: collectionHash(page),
          })),
        ],
      },
      {
        label: "World",
        entries: campaignPages.filter(({ group }) => group === "world").map((page) => ({
          id: page.id, label: page.plural, icon: page.icon, hash: collectionHash(page),
        })),
      },
    ];
    return html`
      <nav class="core-navigation" aria-label="Campaign archive">
        ${groups.map((group) => html`
          <section>
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
    const characters = campaignPages.find(({ id }) => id === "characters");
    const locations = campaignPages.find(({ id }) => id === "locations");
    return html`
      <nav class="mobile-navigation" aria-label="Primary campaign navigation">
        <a href="#/" aria-current=${this.#coreRouteActive("dashboard") ? "page" : nothing}><span>⌂</span>Overview</a>
        <a href="#/search" aria-current=${this.#coreRouteActive("search") ? "page" : nothing}><span>⌕</span>Search</a>
        <a href="#/party" aria-current=${this.#coreRouteActive("party") ? "page" : nothing}><span>♜</span>Party</a>
        ${characters === undefined ? nothing : html`<a href=${collectionHash(characters)} aria-current=${this.#coreRouteActive("characters") ? "page" : nothing}><span>♟</span>People</a>`}
        ${locations === undefined ? nothing : html`<a href=${collectionHash(locations)} aria-current=${this.#coreRouteActive("locations") ? "page" : nothing}><span>⌖</span>Places</a>`}
      </nav>
    `;
  }

  #accountTemplate() {
    if (this.authority.state === "checking") {
      return html`<section class="account-panel"><p class="loading-line">Checking session…</p></section>`;
    }
    if (!this.authority.auth.authenticated) {
      return html`
        <section class="account-panel">
          <h2>Private archive</h2>
          <form @submit=${this.#login}>
            <label>
              <span class="visually-hidden">DM or player password</span>
              <input name="password" type="password" minlength="4" autocomplete="current-password" placeholder="Campaign password" required />
            </label>
            <button type="submit" ?disabled=${this.busy}>Sign in</button>
          </form>
        </section>
      `;
    }
    const auth = this.authority.auth;
    return html`
      <section class="account-panel signed-in">
        <p><span class="authority-mark" aria-hidden="true"></span>Viewing as <strong>${auth.role === "dm" ? "DM" : "player"}</strong></p>
        ${auth.realRole === "dm" ? html`
          <button class="text-button" type="button" @click=${this.#switchRole} ?disabled=${this.busy}>
            View as ${auth.role === "dm" ? "player" : "DM"}
          </button>
        ` : nothing}
        <button class="text-button" type="button" @click=${this.#logout} ?disabled=${this.busy}>Sign out</button>
        <small title=${addonStateTitle(this.addonState)}>${addonStateLabel(this.addonState)}</small>
      </section>
    `;
  }

  #mobileAccountLabel(): string {
    if (this.authority.state === "checking") return "Menu";
    if (!this.authority.auth.authenticated) return "Sign in";
    return this.authority.auth.role === "dm" ? "DM menu" : "Player menu";
  }

  #hostStatusTemplate() {
    if (this.readiness.state === "checking") {
      return html`<span class="host-state"><span aria-hidden="true"></span>Checking host</span>`;
    }
    if (this.readiness.state === "unavailable") {
      return html`<span class="host-state host-unavailable" title=${this.readiness.message}><span aria-hidden="true"></span>Host unavailable</span>`;
    }
    return html`<span class="host-state" title=${`Codex ${this.readiness.health.version}`}><span aria-hidden="true"></span>Codex ${this.readiness.health.version}</span>`;
  }

  #campaignTemplate() {
    if (this.campaignState.state === "loading") {
      return html`<section class="loading-page" aria-live="polite"><span aria-hidden="true">✦</span><p>Opening the campaign chronicle…</p></section>`;
    }
    if (this.campaignState.state === "unavailable") {
      return html`
        <section class="unavailable-page">
          <p class="page-kicker">Campaign archive</p>
          <h1>The chronicle could not be opened.</h1>
          <p>${this.campaignState.message}</p>
          <button type="button" @click=${this.#retryCampaign} ?disabled=${this.busy}>Try again</button>
        </section>
      `;
    }
    const campaign = this.campaignState.campaign;
    switch (this.route.kind) {
      case "dashboard":
        return html`<codex-dashboard .campaign=${campaign}></codex-dashboard>`;
      case "search":
        return html`<codex-search .campaign=${campaign}></codex-search>`;
      case "party":
        return html`<codex-dashboard .campaign=${campaign} .partyOnly=${true}></codex-dashboard>`;
      case "collection":
      case "record":
        return html`<codex-record-page .campaign=${campaign} .route=${this.route}></codex-record-page>`;
      case "addon":
        if (!this.#authenticated()) {
          return html`<section class="unavailable-page"><p class="page-kicker">Campaign add-on</p><h1>Sign in to open this page.</h1><p>Add-on tools inherit your current campaign role.</p></section>`;
        }
        if (this.routeCount === 0) {
          return html`<section class="loading-page"><span aria-hidden="true">✦</span><p>Opening add-on page…</p></section>`;
        }
        return nothing;
      case "not-found":
        return html`<section class="unavailable-page"><p class="page-kicker">Campaign archive</p><h1>This page is not in the index.</h1><p>The address may be old or incomplete.</p><a class="primary-link" href="#/">Return to overview</a></section>`;
    }
  }

  #coreRouteActive(id: string): boolean {
    if (id === "dashboard") return this.route.kind === "dashboard";
    if (id === "search") return this.route.kind === "search";
    if (id === "party") return this.route.kind === "party";
    return (this.route.kind === "collection" || this.route.kind === "record") && this.route.page.id === id;
  }

  #authenticated(): boolean {
    return this.authority.state === "known" && this.authority.auth.authenticated;
  }

  #canEdit(): boolean {
    return this.authority.state === "known" && this.authority.auth.authenticated &&
      this.authority.auth.role === "dm";
  }

  readonly #onHashChange = (): void => {
    this.route = parseAppRoute(window.location.hash);
    void this.updateComplete.then(() => this.#refreshOutlets());
  };

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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown application failure";
}

function liveLabel(state: LiveState): string {
  switch (state) {
    case "connecting": return "Connecting";
    case "connected": return "Live";
    case "reconnecting": return "Reconnecting";
  }
}

function addonStateLabel(state: AddonState): string {
  switch (state.state) {
    case "idle": return "Add-ons are idle";
    case "loading": return "Loading add-ons…";
    case "ready": return state.failures === 0
      ? `${state.active} add-on generation${state.active === 1 ? "" : "s"} active`
      : `${state.active} active · ${state.failures} failed`;
    case "degraded": return "Add-ons need attention";
  }
}

function addonStateTitle(state: AddonState): string {
  if (state.state === "ready") return state.revision;
  if (state.state === "degraded") return state.message;
  return addonStateLabel(state);
}

if (!customElements.get("codex-app")) {
  customElements.define("codex-app", CodexApp);
}
