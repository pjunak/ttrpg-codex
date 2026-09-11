import { LitElement, html, nothing } from "lit";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import type { CampaignCollectionName, CampaignRecord } from "../core/campaign-data.js";
import { AddonContributionsController } from "./addon-contributions-controller.js";
import { acceptsRecordContribution, recordContributionContext, type RecordContributionMode } from "./record-contributions.js";
import { UiLocalizationController } from "./ui-localization.js";

export class CodexRecordContributions extends LitElement {
  static override properties = { registry: { attribute: false }, actorRole: { attribute: false }, record: { attribute: false },
    collection: { attribute: false }, mode: { attribute: false }, failed: { state: true } };
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  declare record: CampaignRecord | undefined;
  declare collection: CampaignCollectionName;
  declare mode: RecordContributionMode;
  declare private failed: boolean;
  #outlet: BrowserContributionOutlet | undefined;
  #identity = "";
  #bindings = "";
  readonly #ui = new UiLocalizationController(this);
  readonly #contributions = new AddonContributionsController(this, () => ({ registry: this.registry, role: this.actorRole }));
  constructor() { super(); this.collection = "locations"; this.mode = "map"; this.failed = false; }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void { this.#dispose(); super.disconnectedCallback(); }
  #dispose(): void { this.#outlet?.dispose(); this.#outlet = undefined; }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const identity = `${this.mode}:${this.collection}:${this.record?.key ?? ""}`;
    if (identity !== this.#identity || changed.has("registry") || changed.has("actorRole")) {
      this.#dispose(); this.failed = false; this.#identity = identity;
    }
    const bindings = this.#contributions.list(this.mode === "map" ? "slot" : "editor-panel")
      .map(active => `${active.addonId}:${active.generationId}:${active.descriptor.id}`).join("|");
    if (bindings !== this.#bindings) { this.#bindings = bindings; this.failed = false; }
    if (!this.#visible()) this.#dispose();
  }
  #visible(): boolean {
    return this.record !== undefined && this.#contributions.list(this.mode === "map" ? "slot" : "editor-panel")
      .some(active => acceptsRecordContribution(active, this.mode, this.collection));
  }
  protected override updated(): void {
    if (!this.isConnected || !this.registry || !this.actorRole || !this.#visible()) return;
    if (this.#outlet) { this.#outlet.refresh(); return; }
    this.#outlet = new BrowserContributionOutlet({ document: this.ownerDocument, root: this.querySelector<HTMLElement>("[data-record-contributions]")!,
      registry: this.registry, surface: this.mode === "map" ? "slot" : "editor-panel", role: this.actorRole, isolatedHostContext: true,
      include: active => acceptsRecordContribution(active, this.mode, this.collection),
      hostContext: () => recordContributionContext(this.record!, this.collection, this.mode, this.#ui.locale),
      onError: () => { this.failed = true; },
    });
  }
  protected override render() {
    if (!this.#visible()) return nothing;
    return html`<section class="record-contributions" aria-label=${this.#ui.t("recordAddons.title")}>
      ${this.mode === "editor" ? html`<h3>${this.#ui.t("recordAddons.title")}</h3><p>${this.#ui.t("recordAddons.separateSave")}</p>` : nothing}
      ${this.failed ? html`<p role="alert">${this.#ui.t("recordAddons.failed")}</p>
        <button type="button" @click=${() => { this.failed = false; this.#outlet?.refresh(); }}>${this.#ui.t("recordAddons.retry")}</button>` : nothing}
      <div data-record-contributions></div>
    </section>`;
  }
}
customElements.define("codex-record-contributions", CodexRecordContributions);
