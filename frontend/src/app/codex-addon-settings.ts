import { LitElement, html, nothing } from "lit";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import { AddonContributionsController } from "./addon-contributions-controller.js";
import { UiLocalizationController } from "./ui-localization.js";

/** One add-on's lazy settings outlet. Visited tabs retain their mounted drafts. */
export class CodexAddonSettings extends LitElement {
  static override properties = {
    registry: { attribute: false }, actorRole: { attribute: false }, addonId: { attribute: false },
    active: { attribute: false }, failed: { state: true },
  };
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  declare addonId: string;
  declare active: boolean;
  declare private failed: boolean;
  #visited = false;
  #outlet: BrowserContributionOutlet | undefined;
  #identity = "";
  #locale = "";
  #refresh = false;
  readonly #ui = new UiLocalizationController(this);
  readonly #contributions = new AddonContributionsController(this, () => ({ registry: this.registry, role: this.actorRole }));
  constructor() { super(); this.addonId = ""; this.active = false; this.failed = false; }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void { this.#dispose(); super.disconnectedCallback(); }
  #dispose(): void { this.#outlet?.dispose(); this.#outlet = undefined; }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("registry") || changed.has("actorRole") || changed.has("addonId")) {
      this.#dispose(); this.#visited = false; this.failed = false; this.#identity = "";
    }
    if (this.active) this.#visited = true;
    const identity = this.#contributions.list("settings").filter(active => active.addonId === this.addonId)
      .map(active => `${active.generationId}:${active.descriptor.id}`).join("|");
    if (identity !== this.#identity) { this.#identity = identity; this.failed = false; this.#refresh = true; }
    if (!identity) this.#dispose();
  }
  protected override updated(): void {
    if (!this.isConnected || !this.#visited || !this.#identity || !this.registry || !this.actorRole) return;
    if (this.#outlet) {
      if (this.#refresh || this.#locale !== this.#ui.locale) {
        this.#refresh = false; this.#locale = this.#ui.locale; this.#outlet.refresh();
      }
      return;
    }
    this.#locale = this.#ui.locale;
    this.#refresh = false;
    this.#outlet = new BrowserContributionOutlet({ document: this.ownerDocument,
      root: this.querySelector<HTMLElement>("[data-addon-settings-outlet]")!, registry: this.registry,
      surface: "settings", role: this.actorRole, include: active => active.addonId === this.addonId,
      isolatedHostContext: true,
      hostContext: () => ({ contractVersion: "addon-settings-context.v1", locale: this.#ui.locale, role: this.actorRole }),
      onError: () => { this.failed = true; },
    });
  }
  protected override render() {
    if (!this.#identity) return nothing;
    return html`<div class="addon-settings">
      ${this.failed ? html`<p role="alert">${this.#ui.t("addons.settingsFailed")}</p>
        <button type="button" @click=${() => { this.failed = false; this.#outlet?.refresh(); }}>${this.#ui.t("addons.settingsRetry")}</button>` : nothing}
      <div data-addon-settings-outlet></div>
    </div>`;
  }
}
customElements.define("codex-addon-settings", CodexAddonSettings);
