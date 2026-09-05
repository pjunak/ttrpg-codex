import { LitElement, html, nothing } from "lit";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import { browserAddonRouteHash } from "../addons/navigation.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { isRecord } from "../core/boundary.js";
import { campaignPages, collectionHash } from "./routes.js";
import { UiLocalizationController, uiCollectionLabel } from "./ui-localization.js";

export interface DmAddonHealth { readonly id: string; readonly version: string; readonly state: "ready" | "blocked" | "failed" }

/** Core recovery surface remains available when an add-on cannot supply its dashboard. */
export class CodexDmDashboard extends LitElement {
  static override properties = {
    campaign: { attribute: false }, registry: { attribute: false }, canManage: { attribute: false },
    health: { attribute: false }, loading: { attribute: false }, degraded: { attribute: false },
    count: { state: true }, failed: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare canManage: boolean;
  declare health: readonly DmAddonHealth[];
  declare loading: boolean;
  declare degraded: boolean;
  declare private count: number;
  declare private failed: boolean;
  #outlet: BrowserContributionOutlet | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #ui = new UiLocalizationController(this);
  constructor() {
    super(); this.campaign = undefined; this.registry = undefined; this.canManage = false;
    this.health = []; this.loading = false; this.degraded = false; this.count = 0; this.failed = false;
  }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.requestUpdate(); }
  override disconnectedCallback(): void { this.#dispose(); super.disconnectedCallback(); }
  #dispose(): void { this.#unsubscribe?.(); this.#unsubscribe = undefined; this.#outlet?.dispose(); this.#outlet = undefined; this.count = 0; }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("registry") || changed.has("canManage")) { this.#dispose(); this.failed = false; }
  }
  protected override updated(): void {
    if (!this.isConnected || !this.canManage || !this.registry || this.#outlet) return;
    // Clear the previous mount error before the outlet evaluates a changed generation.
    this.#unsubscribe = this.registry.subscribe(() => { this.failed = false; });
    this.#outlet = new BrowserContributionOutlet({ document: this.ownerDocument,
      root: this.querySelector<HTMLElement>("[data-dm-dashboard-slot]")!, registry: this.registry, surface: "slot", role: "dm", compact: true,
      include: active => Object.keys(active.descriptor.config).length === 2 && active.descriptor.config["contractVersion"] === 1 && active.descriptor.config["slot"] === "dm:dashboard",
      onError: () => { this.failed = true; }, onCountChange: count => { this.count = count; this.requestUpdate(); },
    });
  }
  protected override render() {
    return html`<section class="dm-panel" aria-labelledby="dm-page-title">
      <h1 id="dm-page-title">🛡 ${this.#ui.t("dm.title")}</h1>
      ${!this.canManage ? html`<p class="dm-stub">${this.#ui.t("dm.refusal")}</p>` : html`
        <div data-dm-dashboard-slot></div>
        ${this.failed || this.degraded ? html`<p class="dm-stub" role="alert">${this.#ui.t("dm.failed")}</p>` : nothing}
        ${this.loading ? html`<p class="dm-stub" role="status">${this.#ui.t("dm.loading")}</p>` : nothing}
        ${this.count === 0 || this.failed || this.degraded ? this.#fallback() : nothing}
      `}
    </section>`;
  }
  #fallback() {
    const routes = this.registry?.list("route", "dm").filter(active => active.binding.kind === "element" || active.binding.kind === "isolated-frame") ?? [];
    const pages = ["characters", "locations", "events", "mysteries", "pantheon", "artifacts", "history", "factions"];
    const counts = this.campaign === undefined ? [] : pages.map(id => {
      const page = campaignPages.find(page => page.id === id)!;
      const records = campaignCollection(this.campaign!, page.collection).records;
      return { page, total: records.length, hidden: records.filter(record => isRecord(record.value) && record.value["visibility"] === "dm").length };
    });
    const totalHidden = counts.reduce((sum, count) => sum + count.hidden, 0);
    const number = (value: number) => new Intl.NumberFormat(this.#ui.locale).format(value);
    return html`<p class="dm-stub">${this.#ui.t("dm.fallback")}</p>
      ${routes.length === 0 ? nothing : html`<section class="dm-section" aria-labelledby="dm-tools-title">
        <h2 id="dm-tools-title">${this.#ui.t("dm.tools")}</h2>
        <nav class="dm-grid" aria-label=${this.#ui.t("dm.tools")}>${routes.map(active => html`
          <a class="dm-count-card" href=${browserAddonRouteHash(active)}><strong>${active.descriptor.label}</strong><span class="dm-count-meta">${active.addonId}</span></a>
        `)}</nav>
      </section>`}
      <section class="dm-section" aria-labelledby="dm-addon-health-title">
        <h2 id="dm-addon-health-title">${this.#ui.t("dm.addonHealth")}</h2>
        <p class="dm-section-hint">${this.#ui.t("dm.addonHealthHint")}</p>
        ${this.health.length === 0 ? html`<p class="dm-stub">${this.#ui.t("dm.noAddons")}</p>` : html`
          <ul class="dm-addon-diagnostics">${this.health.map(addon => html`<li data-addon-health=${addon.id}>
            <strong>${addon.id}</strong><span>${addon.version}</span><span class=${`dm-addon-state ${addon.state}`}>${this.#ui.t(`dm.state.${addon.state}`)}</span>
          </li>`)}</ul>`}
        <div class="dm-actions">
          <button ?disabled=${this.loading} @click=${() => this.dispatchEvent(new CustomEvent("dm-retry-addons", { bubbles: true, composed: true }))}>${this.#ui.t("dm.retry")}</button>
          <a href="#/settings">${this.#ui.t("shell.settings")}</a>
        </div>
      </section>
      <section class="dm-section" aria-labelledby="dm-hidden-title">
        <h2 id="dm-hidden-title">${this.#ui.t("dm.hiddenContent")}</h2>
        <p class="dm-section-hint">${totalHidden === 0 ? this.#ui.t("dm.hiddenEmpty") : this.#ui.plural("dm.hiddenCount", totalHidden)}</p>
        <div class="dm-grid">${counts.map(({ page, total, hidden }) => html`
          <a class=${`dm-count-card ${hidden ? "has-dm" : ""}`} data-dm-collection=${page.id} href=${page.id === "events" ? "#/timeline" : collectionHash(page)}>
            <span class="dm-count-label">${uiCollectionLabel(page.id, "other")}</span>
            <span class="dm-count-numbers"><strong>${number(hidden)}</strong> / ${number(total)}</span>
            <span class="dm-count-meta">${this.#ui.t("dm.onlyDm")}</span>
          </a>`)}</div>
      </section>`;
  }
}
customElements.define("codex-dm-dashboard", CodexDmDashboard);
