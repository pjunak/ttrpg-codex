import { LitElement, css, html, nothing } from "lit";
import {
  getAuth,
  getHealth,
  login as loginSession,
  logout as logoutSession,
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
} from "../core/campaign-mutations.js";
import { SharedEventStream } from "../core/event-stream.js";
import {
  type CampaignIdentitySaveDetail,
} from "./campaign-overview.js";
import "./campaign-overview.js";
import {
  type CampaignRecordDeleteDetail,
  type CampaignRecordSaveDetail,
} from "./campaign-record-browser.js";
import "./campaign-record-browser.js";
import { isRecord } from "../core/boundary.js";
import {
  CampaignRecordEditError,
  prepareCampaignRecordDelete,
  prepareCampaignRecordSave,
  type PreparedCampaignRecordMutation,
} from "./campaign-record-editor.js";
import {
  createBrowserAddonComposition,
  type BrowserAddonComposition,
} from "./browser-addons.js";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import {
  BrowserNavigationOutlet,
  browserAddonRouteHash,
  isBrowserAddonRouteHash,
} from "../addons/navigation.js";
import {
  campaignCollectionHash,
  campaignPages,
  campaignRecordHash,
  parseCoreRoute,
} from "./core-navigation.js";

type Readiness =
  | { state: "checking" }
  | { state: "ready"; health: Health }
  | { state: "unavailable"; message: string };

type Authority =
  | { state: "checking" }
  | { state: "known"; auth: AuthState };

type CampaignState =
  | { state: "loading" }
  | { state: "ready"; dataset: CampaignDataset }
  | { state: "unavailable"; message: string };

type AddonState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; active: number; revision: string; failures: number }
  | { state: "degraded"; message: string };

export class CodexApp extends LitElement {
  static override styles = css`
    :host {
      display: grid;
      min-height: 100vh;
      place-items: center;
      padding: 2rem;
      background:
        linear-gradient(115deg, rgb(195 164 100 / 6%), transparent 38%),
        #15171c;
    }

    main {
      position: relative;
      width: min(42rem, 100%);
      padding: clamp(1.5rem, 5vw, 3rem) clamp(1.5rem, 6vw, 3.5rem);
      overflow: hidden;
      border: 1px solid #494941;
      border-radius: 0.45rem;
      background: #252933;
      box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 36%);
    }

    main.wide {
      width: min(72rem, 100%);
    }

    main::before {
      position: absolute;
      inset: 0 auto 0 0.8rem;
      width: 0.5rem;
      background: radial-gradient(circle, #c3a464 0 1.5px, transparent 2px) center / 0.5rem 1.1rem repeat-y;
      content: "";
      opacity: 0.62;
      pointer-events: none;
    }

    p {
      color: #c9c6ba;
      line-height: 1.6;
    }

    .intro {
      max-width: 42rem;
    }

    h1 {
      margin: 0;
      color: #ded4bc;
      font-family: Palatino, "Palatino Linotype", Georgia, serif;
      font-size: clamp(2rem, 7vw, 4rem);
      font-weight: 500;
      letter-spacing: -0.04em;
    }

    .eyebrow {
      margin: 0 0 0.75rem;
      color: #c3a464;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .status,
    .account {
      display: flex;
      gap: 0.65rem;
      align-items: center;
      margin-top: 1rem;
      color: #d5d2c8;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.9rem;
    }

    .host-status {
      margin-top: 2rem;
      padding-top: 1.25rem;
      border-top: 1px solid #41433f;
    }

    .core-navigation {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid #41433f;
    }

    .core-navigation a {
      min-height: 2.35rem;
      padding: 0.5rem 0.7rem;
      border: 1px solid #4a4d48;
      border-radius: 0.3rem;
      color: #c9c6ba;
      background: #1b1e25;
      text-decoration: none;
    }

    .core-navigation a:hover {
      border-color: #7b704f;
      color: #f0e4c5;
    }

    .core-navigation a[aria-current="page"] {
      border-color: #a88e55;
      color: #211d15;
      background: #c3a464;
    }

    .core-navigation a:focus-visible {
      outline: 2px solid #ded4bc;
      outline-offset: 3px;
    }

    .indicator {
      width: 0.65rem;
      height: 0.65rem;
      flex: 0 0 auto;
      border-radius: 50%;
      background: #918f87;
      box-shadow: 0 0 0 0.25rem rgb(145 143 135 / 12%);
    }

    .indicator.ready {
      background: #8ca982;
    }

    .indicator.unavailable {
      background: #c87768;
    }

    form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.75rem;
      margin-top: 1.5rem;
    }

    input,
    button {
      min-height: 2.75rem;
      border: 1px solid #55584f;
      border-radius: 0.3rem;
      font: inherit;
    }

    input {
      min-width: 0;
      padding: 0.65rem 0.8rem;
      color: #f0eadb;
      background: #191c23;
    }

    button {
      padding: 0.65rem 1rem;
      color: #211d15;
      background: #c3a464;
      cursor: pointer;
    }

    button.secondary {
      min-height: 2.25rem;
      margin-left: auto;
      padding: 0.35rem 0.75rem;
      color: #d5d2c8;
      background: transparent;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.6;
    }

    input:focus-visible,
    button:focus-visible {
      outline: 2px solid #ded4bc;
      outline-offset: 3px;
    }

    .error {
      margin: 0.75rem 0 0;
      color: #e6a298;
      font-size: 0.9rem;
    }

    .tools {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid #55534a;
    }

    .tools-title {
      display: flex;
      gap: 1rem;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 1rem;
    }

    h2 {
      margin: 0;
      color: #ded4bc;
      font-family: Palatino, "Palatino Linotype", Georgia, serif;
      font-size: 1.35rem;
      font-weight: 500;
    }

    .tools-title span,
    .empty-tools,
    .addon-contribution-heading span {
      color: #9d9b92;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.76rem;
    }

    .empty-tools {
      margin: 0;
      padding: 1rem 0;
    }

    .addon-navigation {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .addon-navigation-link {
      min-height: 2.5rem;
      padding: 0.58rem 0.8rem;
      border: 1px solid #4a4d48;
      border-radius: 0.3rem;
      color: #d5d2c8;
      background: #1b1e25;
      text-decoration: none;
    }

    .addon-navigation-link:hover {
      border-color: #7b704f;
      color: #f0e4c5;
    }

    .addon-navigation-link[aria-current="page"] {
      border-color: #a88e55;
      color: #211d15;
      background: #c3a464;
    }

    .addon-navigation-link:focus-visible {
      outline: 2px solid #ded4bc;
      outline-offset: 3px;
    }

    .addon-dashboard[hidden] {
      display: none;
    }

    .addon-outlet {
      display: grid;
      gap: 1rem;
    }

    .addon-contribution {
      min-width: 0;
      overflow: hidden;
      border: 1px solid #484b48;
      border-radius: 0.3rem;
      background: #1c1f27;
    }

    .addon-contribution-heading {
      display: flex;
      gap: 1rem;
      align-items: center;
      justify-content: space-between;
      padding: 0.65rem 0.85rem;
      border-bottom: 1px solid #3f423f;
      color: #d8c99f;
      background: #20242c;
    }

    .addon-contribution > :not(.addon-contribution-heading) {
      display: block;
      padding: 1rem;
    }

    .addon-isolated-frame {
      padding: 0 !important;
      background: #15171c;
    }

    .codex-isolated-addon-frame {
      display: block;
      width: 100%;
      height: 24rem;
      border: 0;
      background: #fff;
    }

    @media (max-width: 32rem) {
      form {
        grid-template-columns: 1fr;
      }
    }
  `;

  static override properties = {
    readiness: { state: true },
    authority: { state: true },
    campaignState: { state: true },
    addonState: { state: true },
    busy: { state: true },
    errorMessage: { state: true },
    contributionCount: { state: true },
    navigationCount: { state: true },
    routeCount: { state: true },
  };

  declare private readiness: Readiness;
  declare private authority: Authority;
  declare private campaignState: CampaignState;
  declare private addonState: AddonState;
  declare private busy: boolean;
  declare private errorMessage: string;
  declare private contributionCount: number;
  declare private navigationCount: number;
  declare private routeCount: number;
  #request: AbortController | undefined;
  readonly #campaignData = new CampaignDataClient();
  readonly #campaignMutations = new CampaignMutationClient();
  readonly #events = new SharedEventStream();
  #addons: BrowserAddonComposition | undefined;
  #contributionOutlet: BrowserContributionOutlet | undefined;
  #navigationOutlet: BrowserNavigationOutlet | undefined;
  #routeOutlet: BrowserContributionOutlet | undefined;
  #addonOwner = 0;

  constructor() {
    super();
    this.readiness = { state: "checking" };
    this.authority = { state: "checking" };
    this.campaignState = { state: "loading" };
    this.addonState = { state: "idle" };
    this.busy = false;
    this.errorMessage = "";
    this.contributionCount = 0;
    this.navigationCount = 0;
    this.routeCount = 0;
  }

  override connectedCallback(): void {
    super.connectedCallback();
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
    const authenticated = this.authority.state === "known" && this.authority.auth.authenticated;
    const wide = authenticated || this.campaignState.state === "ready";
    return html`
      <main class=${wide ? "wide" : ""}>
        <div class="intro">
          <p class="eyebrow">Campaign archive</p>
          <h1>TTRPG Codex</h1>
          <p>
            Browse the public campaign archive. Sign in to open the private view and
            the tools available to your role.
          </p>
          ${this.#hostStatusTemplate()}
          ${this.#authorityTemplate()}
        </div>
        ${this.#coreNavigationTemplate()}
        ${this.#campaignTemplate()}
        ${this.#toolsTemplate()}
        ${this.errorMessage === "" ? null : html`<p class="error" role="alert">${this.errorMessage}</p>`}
      </main>
    `;
  }

  async #bootstrap(signal: AbortSignal): Promise<void> {
    try {
      const health = await getHealth(signal);
      this.readiness = { state: "ready", health };
    } catch (error: unknown) {
      if (signal.aborted) {
        return;
      }
      this.readiness = { state: "unavailable", message: errorMessage(error) };
      this.authority = { state: "known", auth: anonymousAuth() };
      return;
    }
    await this.#loadCampaign(signal);
    try {
      const auth = await getAuth(signal);
      this.authority = { state: "known", auth };
      this.#startEventStream();
      if (auth.authenticated) {
        await this.#startAddons();
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        return;
      }
      this.authority = { state: "known", auth: anonymousAuth() };
      this.errorMessage = errorMessage(error);
      this.#startEventStream();
    }
  }

  async #login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.busy || this.#request === undefined) {
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const password = String(new FormData(form).get("password") ?? "");
    this.busy = true;
    this.errorMessage = "";
    try {
      const auth = await loginSession(password, this.#request.signal);
      this.authority = { state: "known", auth };
      form.reset();
      this.#campaignData.reset();
      await this.#loadCampaign(this.#request.signal);
      this.#startEventStream();
      await this.#startAddons();
    } catch (error: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = errorMessage(error);
      }
    } finally {
      this.busy = false;
    }
  }

  async #logout(): Promise<void> {
    if (this.busy || this.#request === undefined) {
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#stopAddons();
      await logoutSession(this.#request.signal);
      this.authority = { state: "known", auth: anonymousAuth() };
      this.#campaignData.reset();
      await this.#loadCampaign(this.#request.signal);
      this.#startEventStream();
    } catch (error: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = errorMessage(error);
      }
    } finally {
      this.busy = false;
    }
  }

  async #startAddons(): Promise<void> {
    await this.#stopAddons();
    const owner = ++this.#addonOwner;
    this.addonState = { state: "loading" };
    const auth = this.authority.state === "known" ? this.authority.auth : anonymousAuth();
    if (!auth.authenticated) {
      throw new Error("authenticated browser add-on authority is unavailable");
    }
    const composition = createBrowserAddonComposition(document, auth.csrfToken, {
      onRefresh: (_cause, result) => {
        if (owner !== this.#addonOwner) {
          return;
        }
        this.addonState = {
          state: "ready",
          active: result.lifecycle.active.length,
          revision: result.lifecycle.graphRevision,
          failures: result.lifecycle.activationFailures.length,
        };
        this.#contributionOutlet?.refresh();
        this.#navigationOutlet?.refresh();
        this.#routeOutlet?.refresh();
      },
      onDiagnostic: (error) => {
        if (owner === this.#addonOwner) {
          this.addonState = { state: "degraded", message: errorMessage(error) };
        }
      },
      onAuthorityLost: () => {
        if (owner !== this.#addonOwner) {
          return;
        }
        this.#addons = undefined;
        this.#contributionOutlet?.dispose();
        this.#contributionOutlet = undefined;
        this.#navigationOutlet?.dispose();
        this.#navigationOutlet = undefined;
        this.#routeOutlet?.dispose();
        this.#routeOutlet = undefined;
        this.contributionCount = 0;
        this.navigationCount = 0;
        this.routeCount = 0;
        this.authority = { state: "known", auth: anonymousAuth() };
        this.addonState = { state: "idle" };
        this.#campaignData.reset();
        this.#startEventStream();
        if (this.#request !== undefined) {
          void this.#loadCampaign(this.#request.signal);
        }
      },
    });
    this.#addons = composition;
    try {
      await this.updateComplete;
      const outletRoot = this.renderRoot.querySelector<HTMLElement>("[data-addon-outlet]");
      const navigationRoot = this.renderRoot.querySelector<HTMLElement>("[data-addon-navigation]");
      const routeRoot = this.renderRoot.querySelector<HTMLElement>("[data-addon-route-outlet]");
      if (outletRoot === null || navigationRoot === null || routeRoot === null) {
        throw new Error("authenticated browser add-on outlet is unavailable");
      }
      const onOutletError = (cause: unknown): void => {
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
        onError: onOutletError,
        onCountChange: (count) => {
          if (owner === this.#addonOwner) {
            this.navigationCount = count;
          }
        },
      });
      this.#routeOutlet = new BrowserContributionOutlet({
        document,
        root: routeRoot,
        registry: composition.contributions,
        surface: "route",
        role: auth.role,
        include: (active) => browserAddonRouteHash(active) === window.location.hash,
        onError: onOutletError,
        onCountChange: (count) => {
          if (owner === this.#addonOwner) {
            this.routeCount = count;
          }
        },
      });
      this.#contributionOutlet = new BrowserContributionOutlet({
        document,
        root: outletRoot,
        registry: composition.contributions,
        surface: "slot",
        role: auth.role,
        onError: onOutletError,
        onCountChange: (count) => {
          if (owner === this.#addonOwner) {
            this.contributionCount = count;
          }
        },
      });
      await composition.session.start();
    } catch (cause: unknown) {
      if (owner === this.#addonOwner) {
        await this.#stopAddons();
      }
      throw cause;
    }
  }

  async #stopAddons(): Promise<void> {
    this.#addonOwner += 1;
    this.#contributionOutlet?.dispose();
    this.#contributionOutlet = undefined;
    this.#navigationOutlet?.dispose();
    this.#navigationOutlet = undefined;
    this.#routeOutlet?.dispose();
    this.#routeOutlet = undefined;
    this.contributionCount = 0;
    this.navigationCount = 0;
    this.routeCount = 0;
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

  #hostStatusTemplate() {
    switch (this.readiness.state) {
      case "checking":
        return html`<div class="status host-status"><span class="indicator"></span>Checking host…</div>`;
      case "ready":
        return html`<div class="status host-status">
          <span class="indicator ready"></span>Host ${this.readiness.health.version} ready
        </div>`;
      case "unavailable":
        return html`<div class="status host-status" title=${this.readiness.message}>
          <span class="indicator unavailable"></span>Host is not reachable
        </div>`;
    }
  }

  #campaignTemplate() {
    switch (this.campaignState.state) {
      case "loading":
        return html`<div class="status"><span class="indicator"></span>Loading campaign…</div>`;
      case "ready":
        return this.#readyCampaignTemplate(this.campaignState.dataset);
      case "unavailable":
        return html`<p class="error" role="alert" title=${this.campaignState.message}>
          The campaign archive could not be loaded.
        </p>`;
    }
  }

  #readyCampaignTemplate(dataset: CampaignDataset) {
    const route = parseCoreRoute(window.location.hash);
    switch (route.kind) {
      case "overview":
        return html`<campaign-overview
          .campaign=${dataset}
          .canEdit=${this.#canEditCampaign()}
          .saving=${this.busy}
          @campaign-identity-save=${this.#saveCampaignIdentity}
        ></campaign-overview>`;
      case "collection":
      case "record":
        return html`<campaign-record-browser
          .campaign=${dataset}
          .page=${route.page}
          .recordKey=${route.kind === "record" ? route.key : undefined}
          .canEdit=${this.#canEditRecord()}
          .canManageVisibility=${this.#canEditCampaign()}
          .saving=${this.busy}
          .addonRegistry=${this.#addons?.contributions}
          .addonRole=${this.authority.state === "known" && this.authority.auth.authenticated
            ? this.authority.auth.role
            : "player"}
          @campaign-record-save=${this.#saveCampaignRecord}
          @campaign-record-delete=${this.#deleteCampaignRecord}
          @browser-addon-diagnostic=${this.#browserAddonDiagnostic}
        ></campaign-record-browser>`;
      case "addon":
        return null;
      case "not-found":
        return html`<section>
          <p class="error" role="alert">The page ${route.path} does not exist.</p>
        </section>`;
    }
  }

  #coreNavigationTemplate() {
    if (this.campaignState.state !== "ready") {
      return null;
    }
    const route = parseCoreRoute(window.location.hash);
    return html`
      <nav class="core-navigation" aria-label="Campaign archive">
        <a href="#/" aria-current=${route.kind === "overview" ? "page" : nothing}>Overview</a>
        ${campaignPages.map((page) => html`
          <a
            href=${campaignCollectionHash(page)}
            aria-current=${(route.kind === "collection" || route.kind === "record") &&
              route.page.collection === page.collection ? "page" : nothing}
          >${page.pluralLabel}</a>
        `)}
      </nav>
    `;
  }

  #canEditCampaign(): boolean {
    return this.authority.state === "known" && this.authority.auth.authenticated &&
      this.authority.auth.role === "dm";
  }

  #canEditRecord(): boolean {
    return this.authority.state === "known" && this.authority.auth.authenticated;
  }

  readonly #saveCampaignIdentity = async (
    event: CustomEvent<CampaignIdentitySaveDetail>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEditCampaign() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") {
      return;
    }
    const detail = event.detail;
    if (detail.name === "" || detail.name.length > 200 || detail.tagline.length > 500 ||
      !Number.isSafeInteger(detail.expectedRevision) || detail.expectedRevision < 0) {
      return;
    }
    const collection = campaignCollection(this.campaignState.dataset, "campaign");
    const record = collection.records.find((candidate) => candidate.key === "main");
    if ((record?.revision ?? 0) !== detail.expectedRevision) {
      this.errorMessage = "The campaign changed before this edit could be saved. Please try again.";
      return;
    }
    const current = isRecord(record?.value) ? record.value : {};
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#campaignMutations.commit([{
        operation: "put",
        collection: "campaign",
        key: "main",
        expectedRevision: detail.expectedRevision,
        value: { ...current, name: detail.name, tagline: detail.tagline },
      }], this.authority.auth.csrfToken, this.#request.signal);
      await this.#loadCampaign(this.#request.signal, true);
    } catch (error: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = error instanceof CampaignMutationHTTPError && error.status === 409
          ? "The campaign changed while saving. Refresh and try the edit again."
          : errorMessage(error);
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #saveCampaignRecord = async (
    event: CustomEvent<CampaignRecordSaveDetail>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEditRecord() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") {
      return;
    }
    const detail = event.detail;
    let prepared: PreparedCampaignRecordMutation;
    try {
      prepared = prepareCampaignRecordSave(
        this.campaignState.dataset, detail, this.#canEditCampaign(),
      );
    } catch (error: unknown) {
      if (error instanceof CampaignRecordEditError && error.kind === "stale") {
        this.errorMessage = "The record changed before this edit could be saved. Refresh and try again.";
      }
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#campaignMutations.commit(
        [prepared.mutation], this.authority.auth.csrfToken, this.#request.signal,
      );
      await this.#loadCampaign(this.#request.signal, true);
      window.location.hash = campaignRecordHash(prepared.page, detail.key);
    } catch (error: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = error instanceof CampaignMutationHTTPError && error.status === 409
          ? "The record changed while saving. Refresh and try the edit again."
          : errorMessage(error);
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #deleteCampaignRecord = async (
    event: CustomEvent<CampaignRecordDeleteDetail>,
  ): Promise<void> => {
    if (this.busy || this.#request === undefined || !this.#canEditRecord() ||
      this.authority.state !== "known" || !this.authority.auth.authenticated ||
      this.campaignState.state !== "ready") {
      return;
    }
    const detail = event.detail;
    let prepared: PreparedCampaignRecordMutation;
    try {
      prepared = prepareCampaignRecordDelete(this.campaignState.dataset, detail);
    } catch (error: unknown) {
      if (error instanceof CampaignRecordEditError && error.kind === "stale") {
        this.errorMessage = "The record changed before it could be deleted. Refresh and try again.";
      }
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#campaignMutations.commit(
        [prepared.mutation], this.authority.auth.csrfToken, this.#request.signal,
      );
      await this.#loadCampaign(this.#request.signal, true);
      window.location.hash = campaignCollectionHash(prepared.page);
    } catch (error: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = error instanceof CampaignMutationHTTPError && error.status === 409
          ? "The record changed while deleting. Refresh and try again."
          : errorMessage(error);
      }
    } finally {
      this.busy = false;
    }
  };

  readonly #browserAddonDiagnostic = (event: CustomEvent<unknown>): void => {
    this.addonState = { state: "degraded", message: errorMessage(event.detail) };
  };

  async #loadCampaign(signal: AbortSignal, retainCurrent = false): Promise<void> {
    if (!retainCurrent || this.campaignState.state !== "ready") {
      this.campaignState = { state: "loading" };
    }
    try {
      const dataset = await this.#campaignData.refresh(signal);
      if (!signal.aborted) {
        this.campaignState = { state: "ready", dataset };
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        const current = this.#campaignData.current();
        if (retainCurrent && current !== undefined) {
          this.campaignState = { state: "ready", dataset: current };
          this.errorMessage = `Campaign refresh failed: ${errorMessage(error)}`;
        } else {
          this.campaignState = { state: "unavailable", message: errorMessage(error) };
        }
      }
    }
  }

  #startEventStream(): void {
    this.#events.open({
      onRefresh: (event) => {
        if ((event.cause === "campaign-data-changed" || event.cause === "reset") &&
          this.#request !== undefined) {
          void this.#loadCampaign(this.#request.signal, true);
        }
        void this.#addons?.session.handleEvent(event);
      },
      onBoundaryError: (error) => {
        this.errorMessage = errorMessage(error);
      },
      onConnectionError: () => {
        if (this.#addons !== undefined && this.addonState.state === "loading") {
          this.addonState = { state: "degraded", message: "Live updates are reconnecting." };
        }
      },
    });
  }

  #authorityTemplate() {
    if (this.authority.state === "checking") {
      return html`<div class="status"><span class="indicator"></span>Checking session…</div>`;
    }
    if (!this.authority.auth.authenticated) {
      return html`
        <form @submit=${this.#login}>
          <input
            name="password"
            type="password"
            minlength="4"
            autocomplete="current-password"
            aria-label="Password"
            placeholder="DM or player password"
            required
          />
          <button type="submit" ?disabled=${this.busy}>Sign in</button>
        </form>
      `;
    }
    return html`
      <div class="account">
        <span class="indicator ready"></span>
        Signed in as ${this.authority.auth.role === "dm" ? "DM" : "player"}
        <button class="secondary" type="button" @click=${this.#logout} ?disabled=${this.busy}>
          Sign out
        </button>
      </div>
      ${this.#addonStatusTemplate()}
    `;
  }

  #addonStatusTemplate() {
    switch (this.addonState.state) {
      case "idle":
        return null;
      case "loading":
        return html`<div class="status"><span class="indicator"></span>Loading browser add-ons…</div>`;
      case "ready":
        return html`<div class="status" title=${this.addonState.revision}>
          <span class=${`indicator ${this.addonState.failures === 0 ? "ready" : "unavailable"}`}></span>
          ${this.addonState.active} browser add-on generation(s) active
          ${this.addonState.failures === 0 ? "" : `; ${this.addonState.failures} failed`}
        </div>`;
      case "degraded":
        return html`<div class="status" title=${this.addonState.message}>
          <span class="indicator unavailable"></span>Browser add-ons need attention
        </div>`;
    }
  }

  #toolsTemplate() {
    if (this.authority.state !== "known" || !this.authority.auth.authenticated) {
      return null;
    }
    const addonRouteRequested = isBrowserAddonRouteHash(window.location.hash);
    const coreRoute = parseCoreRoute(window.location.hash);
    const showingRoute = this.routeCount > 0;
    return html`
      <section class="tools" aria-labelledby="campaign-tools-title">
        <div class="tools-title">
          <h2 id="campaign-tools-title">Campaign tools</h2>
          <span>${this.addonState.state === "loading"
            ? "Loading"
            : `${this.navigationCount} ${this.navigationCount === 1 ? "add-on page" : "add-on pages"}`}</span>
        </div>
        <nav class="addon-navigation" data-addon-navigation aria-label="Add-on pages"></nav>
        <div class="addon-outlet" data-addon-route-outlet></div>
        ${addonRouteRequested && !showingRoute && this.addonState.state !== "loading"
          ? html`<p class="empty-tools">This add-on page is not available for the current role.</p>`
          : null}
        <div class="addon-dashboard" ?hidden=${showingRoute || addonRouteRequested || coreRoute.kind !== "overview"}>
          ${this.contributionCount === 0
            ? html`<p class="empty-tools">${this.addonState.state === "loading"
              ? "Loading the add-on panels available to this role…"
              : "No add-on panels are active for this role."}</p>`
            : null}
          <div class="addon-outlet" data-addon-outlet></div>
        </div>
      </section>
    `;
  }

  readonly #onHashChange = (): void => {
    this.#navigationOutlet?.refresh();
    this.#routeOutlet?.refresh();
    this.requestUpdate();
  };
}

function anonymousAuth(): AuthState {
  return { authenticated: false, role: null, realRole: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown application failure";
}

if (!customElements.get("codex-app")) {
  customElements.define("codex-app", CodexApp);
}
