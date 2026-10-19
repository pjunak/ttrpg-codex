import type { ReactiveController, ReactiveControllerHost } from "lit";
import { browserDiagnostics } from "../addons/browser-diagnostics.js";
import {
  createBrowserAddonComposition,
  type BrowserAddonComposition,
} from "../addons/browser-composition.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import {
  BrowserNavigationOutlet,
  browserAddonRouteHash,
  parseBrowserAddonLocation,
} from "../addons/navigation.js";
import type { AuthState } from "../core/api.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { isPlayerPreview } from "../core/player-preview.js";
import { addonSidebarKey, addonSidebarMode } from "./campaign-sidebar.js";
import type { DmAddonHealth } from "./codex-dm-dashboard.js";
import { routeRecordReferences } from "./route-record-references.js";
import type { AppRoute } from "./routes.js";
import { uiText } from "./ui-localization.js";

export type AddonState =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | {
      readonly state: "ready";
      readonly active: number;
      readonly revision: string;
      readonly failures: number;
    }
  | { readonly state: "degraded"; readonly message: string };

export interface AddonOutletsOptions {
  /** The session the add-ons run for, once known; they start only when it is signed in. */
  auth(): AuthState | undefined;
  route(): AppRoute;
  campaign(): CampaignDataset | undefined;
  locale(): string;
  canEdit(): boolean;
  /**
   * The add-ons met an expired session. Resolves true when the host offers to
   * resume it, so the add-ons wait instead of giving up.
   */
  recoveryRequested(): Promise<boolean>;
  /**
   * The add-ons lost their authority and have stopped. `current` stays true
   * until they start or stop again.
   */
  authorityLost(signal: AbortSignal, current: () => boolean): void;
  /** Stopping left browser add-on resources behind. */
  cleanupFailed(message: string): void;
}

/**
 * Runs the browser add-ons for the signed-in session: their composition, the
 * four places their contributions mount (navigation, dashboard, record
 * article and add-on page) and the DM's view of their health. Each start
 * replaces the previous add-ons; leaving the page stops them.
 */
export class AddonOutletsController implements ReactiveController {
  state: AddonState = { state: "idle" };
  health: readonly DmAddonHealth[] = [];
  /** Contributions mounted in each place. */
  dashboardCount = 0;
  navigationCount = 0;
  articleCount = 0;
  routeCount = 0;
  readonly #host: ReactiveControllerHost & HTMLElement;
  readonly #options: AddonOutletsOptions;
  #composition: BrowserAddonComposition | undefined;
  /** Changes on every start and stop, so callbacks of replaced add-ons do nothing. */
  #owner = 0;
  #cleanup: Promise<void> = Promise.resolve();
  #dashboard: BrowserContributionOutlet | undefined;
  #article: BrowserContributionOutlet | undefined;
  #navigation: BrowserNavigationOutlet | undefined;
  #route: BrowserContributionOutlet | undefined;
  #locale = "";

  constructor(host: ReactiveControllerHost & HTMLElement, options: AddonOutletsOptions) {
    this.#host = host;
    this.#options = options;
    host.addController(this);
  }

  hostUpdated(): void {
    if (!this.#host.isConnected || this.#locale === this.#options.locale()) return;
    this.#locale = this.#options.locale();
    this.#route?.refresh();
    this.#article?.refresh();
    this.#navigation?.refresh();
  }

  hostDisconnected(): void {
    void this.stop();
  }

  get composition(): BrowserAddonComposition | undefined {
    return this.#composition;
  }

  /** Changes whenever the add-ons start or stop. */
  get generation(): number {
    return this.#owner;
  }

  get contributions(): BrowserContributionRegistry | undefined {
    return this.#composition?.contributions;
  }

  /** The shown record as add-on article sections receive it, or null. */
  get recordContext(): unknown {
    const route = this.#options.route(),
      campaign = this.#options.campaign();
    if (route.kind !== "record" || campaign === undefined) return null;
    const record = campaignCollection(campaign, route.page.collection).records.find(
      ({ key }) => key === route.key,
    );
    if (record === undefined) return null;
    return {
      kind: "campaign-record",
      locale: this.#options.locale(),
      collection: route.page.collection,
      key: record.key,
      revision: record.revision,
      value: record.value,
      canEdit: this.#options.canEdit(),
    };
  }

  /** Every place shows the current route's contributions again. */
  refresh(): void {
    this.#navigation?.refresh();
    this.#dashboard?.refresh();
    this.#article?.refresh();
    this.#route?.refresh();
  }

  /** A new campaign snapshot is shown; the places that read it refresh. */
  campaignShown(): void {
    this.#article?.refresh();
    this.#navigation?.refresh();
    this.#route?.refresh();
  }

  renewCsrfToken(token: string): void {
    this.#composition?.renewCsrfToken(token);
  }

  /** Stops the running add-ons and starts them for the current session. */
  async start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const stopping = this.stop();
    const owner = this.#owner;
    await stopping;
    if (signal.aborted || owner !== this.#owner) return;
    const auth = this.#options.auth();
    browserDiagnostics.enable(
      auth?.authenticated === true && auth.role === "dm" && auth.realRole === "dm",
    );
    if (auth?.authenticated !== true) return;
    this.#set({ state: "loading" });
    const current = () => owner === this.#owner;
    const composition = createBrowserAddonComposition(document, auth.csrfToken, {
      onRefresh: (_cause, result) => {
        if (!current()) return;
        for (const failure of result.lifecycle.activationFailures)
          browserDiagnostics.record(failure.kind, failure);
        for (const failure of result.lifecycle.disposalFailures)
          browserDiagnostics.record("disposal", failure);
        const graph = result.transport.graph.addons;
        this.health = [
          ...result.lifecycle.active.map((addon) => ({
            id: addon.addonId,
            name: addon.addonName ?? "",
            version: addon.addonVersion,
            state: "ready" as const,
          })),
          ...result.lifecycle.activationFailures.map((failure) => ({
            id: failure.addonId,
            name: graph.find((addon) => addon.addonId === failure.addonId)?.addonName ?? "",
            version: graph.find((addon) => addon.addonId === failure.addonId)?.addonVersion ?? "",
            state: failure.kind === "dependency" ? ("blocked" as const) : ("failed" as const),
          })),
        ];
        this.#set({
          state: "ready",
          active: result.lifecycle.active.length,
          revision: result.lifecycle.graphRevision,
          failures: result.lifecycle.activationFailures.length,
        });
        this.refresh();
      },
      onDiagnostic: (cause) => {
        if (!current()) return;
        browserDiagnostics.record("refresh", cause);
        this.#set({ state: "degraded", message: uiText("dm.failed") });
      },
      onRecoveryRequested: async () => {
        if (!current() || isPlayerPreview()) return false;
        return (await this.#options.recoveryRequested()) && current();
      },
      onAuthorityLost: () => {
        if (!current()) return;
        this.#composition = undefined;
        this.#disposeOutlets();
        this.#set({ state: "idle" });
        this.#options.authorityLost(signal, current);
      },
    });
    this.#composition = composition;
    try {
      await this.#host.updateComplete;
      if (signal.aborted || !current()) return;
      this.#mount(composition, auth, current);
      await composition.session.start();
    } catch (cause: unknown) {
      if (current()) await this.stop();
      throw cause;
    }
  }

  /** Starts the add-ons again after the DM asked; a failure leaves them marked degraded. */
  async retry(signal: AbortSignal): Promise<void> {
    if (this.state.state === "loading" || signal.aborted) return;
    try {
      await this.start(signal);
    } catch {
      if (!signal.aborted) this.#set({ state: "degraded", message: uiText("dm.failed") });
    }
  }

  /** Stops the add-ons; the promise settles once their resources are released. */
  stop(): Promise<void> {
    const owner = ++this.#owner;
    this.#disposeOutlets();
    const composition = this.#composition;
    this.#composition = undefined;
    this.health = [];
    this.#set({ state: "idle" });
    if (composition === undefined) return this.#cleanup;
    const stopping = composition.session.stop();
    this.#cleanup = (async () => {
      const failures = await stopping;
      for (const failure of failures) browserDiagnostics.record("disposal", failure);
      if (owner === this.#owner && failures.length > 0)
        this.#options.cleanupFailed(
          uiText("Failed to clean up {0} browser add-on resource(s).", { "0": failures.length }),
        );
    })();
    return this.#cleanup;
  }

  #mount(
    composition: BrowserAddonComposition,
    auth: Extract<AuthState, { authenticated: true }>,
    current: () => boolean,
  ): void {
    const root = (selector: string): HTMLElement => {
      const element = this.#host.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error("browser add-on mounting surfaces are unavailable");
      return element;
    };
    const navigationRoot = root("[data-addon-navigation]"),
      dashboardRoot = root("[data-addon-slot]"),
      articleRoot = root("[data-addon-article]"),
      routeRoot = root("[data-addon-route-outlet]");
    const registry = composition.contributions;
    const locale = () => this.#options.locale();
    const onError = (cause: unknown): void => {
      if (!current()) return;
      browserDiagnostics.record("contribution", cause);
      this.#set({ state: "degraded", message: uiText("dm.failed") });
    };
    const counted = (update: (count: number) => void) => (count: number) => {
      if (!current()) return;
      update(count);
      this.#host.requestUpdate();
    };
    this.#navigation = new BrowserNavigationOutlet({
      document,
      root: navigationRoot,
      registry,
      role: auth.role,
      currentHash: () => window.location.hash,
      locale,
      include: (entry) => {
        const mode = addonSidebarMode(this.#options.campaign(), addonSidebarKey(entry));
        return mode === "everyone" || (mode === "dm" && auth.role === "dm");
      },
      onError,
      onCountChange: counted((count) => (this.navigationCount = count)),
    });
    this.#dashboard = new BrowserContributionOutlet({
      document,
      root: dashboardRoot,
      registry,
      surface: "slot",
      role: auth.role,
      locale,
      include: (active) =>
        this.#options.route().kind === "dashboard" &&
        active.descriptor.config["slot"] === undefined,
      onError,
      onCountChange: counted((count) => (this.dashboardCount = count)),
    });
    this.#article = new BrowserContributionOutlet({
      document,
      root: articleRoot,
      registry,
      surface: "article-section",
      compact: true,
      role: auth.role,
      locale,
      include: (active) => {
        const route = this.#options.route();
        return (
          route.kind === "record" &&
          active.descriptor.config["collection"] === route.page.collection
        );
      },
      hostContext: () => this.recordContext,
      handoffKey: () => {
        const route = this.#options.route();
        return route.kind === "record" && this.recordContext !== null
          ? JSON.stringify([route.page.collection, route.key])
          : undefined;
      },
      onError,
      onCountChange: counted((count) => (this.articleCount = count)),
    });
    this.#route = new BrowserContributionOutlet({
      document,
      root: routeRoot,
      registry,
      surface: "route",
      // Add-on pages carry their own title; the sidebar already names their add-on.
      compact: true,
      role: auth.role,
      locale,
      include: (active) =>
        browserAddonRouteHash(active) ===
        parseBrowserAddonLocation(window.location.hash)?.routeHash,
      hostContext: (active) => {
        const recordReferences = routeRecordReferences(this.#options.campaign(), active);
        return {
          contractVersion: "addon-route-context.v1",
          locale: this.#options.locale(),
          query: parseBrowserAddonLocation(window.location.hash)?.query ?? [],
          ...(recordReferences ? { recordReferences } : {}),
        };
      },
      onError,
      onCountChange: counted((count) => (this.routeCount = count)),
    });
  }

  #disposeOutlets(): void {
    this.#dashboard?.dispose();
    this.#article?.dispose();
    this.#navigation?.dispose();
    this.#route?.dispose();
    this.#dashboard = undefined;
    this.#article = undefined;
    this.#navigation = undefined;
    this.#route = undefined;
    this.dashboardCount = 0;
    this.navigationCount = 0;
    this.articleCount = 0;
    this.routeCount = 0;
    this.#host.requestUpdate();
  }

  #set(state: AddonState): void {
    this.state = state;
    this.#host.requestUpdate();
  }
}
