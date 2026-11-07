import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { BrowserCatalogStore } from "../addons/catalog-store.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import {
  campaignAppearanceRecord,
  campaignTheme,
  campaignThemes,
  onThemeChange,
  personalTheme,
  setPersonalTheme,
  type CampaignAppearanceSaveDetail,
  type CampaignThemeID,
} from "./campaign-appearance.js";
import { saveCampaign } from "./campaign-writes.js";
import "./codex-branding-settings.js";
import "./codex-interface-consistency.js";
import { saveFailure } from "./save-failure.js";
import { UiLocalizationController } from "./ui-localization.js";

/**
 * Settings → Appearance. Everyone picks this browser's theme or follows the
 * site; the DM also chooses the site's default theme and branding.
 */
export class CodexAppearanceSettings extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    canManage: { type: Boolean },
    busy: { type: Boolean },
    catalogs: { attribute: false },
    pending: { state: true },
    error: { state: true },
    notice: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  /** The viewer is the DM outside player preview. */
  declare canManage: boolean;
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  /** The add-on session's catalogs, which name the add-ons in the consistency map. */
  declare catalogs: BrowserCatalogStore | undefined;
  /** The site theme being saved, shown until that save finishes or fails. */
  declare private pending: CampaignThemeID | undefined;
  declare private error: string;
  declare private notice: string;
  readonly #ui = new UiLocalizationController(this);
  #unsubscribe: (() => void) | undefined;

  constructor() {
    super();
    this.canManage = false;
    this.busy = false;
    this.error = "";
    this.notice = "";
  }

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#unsubscribe = onThemeChange(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  protected override render() {
    const personal = personalTheme(),
      site = this.campaign === undefined ? "classic" : campaignTheme(this.campaign);
    return html`
      <section class="settings-ledger settings-personal-panel" aria-labelledby="settings-appearance-title">
        <header class="settings-ledger-heading">
          <div>
            <span class="settings-category-mark" aria-hidden="true">◐</span>
            <div>
              <h2 id="settings-appearance-title">${this.#ui.t("settings.appearance")}</h2>
              <p>${this.#ui.t("settings.appearanceIntro")}</p>
            </div>
          </div>
        </header>
        <form class="settings-theme-form" @submit=${(event: Event) => event.preventDefault()}>
          <fieldset>
            <legend>${this.#ui.t("settings.appearanceLabel")}</legend>
            <div class="settings-theme-list">
              <label class="settings-theme-choice">
                <input type="radio" name="theme" value="" .checked=${live(personal === undefined)}
                  @change=${() => setPersonalTheme(undefined)} />
                <span class="settings-theme-sample" data-theme-sample=${site} aria-hidden="true"><i></i><b></b><em></em></span>
                <span><strong>${this.#ui.t("settings.appearanceFollowSite")}</strong>
                  <small>${this.#ui.t("settings.appearanceFollowSiteHint", { theme: this.#label(site) })}</small></span>
              </label>
              ${campaignThemes.map(
                (theme) => html`
                <label class="settings-theme-choice">
                  <input type="radio" name="theme" value=${theme.id} .checked=${live(theme.id === personal)}
                    @change=${() => setPersonalTheme(theme.id)} />
                  <span class="settings-theme-sample" data-theme-sample=${theme.id} aria-hidden="true"><i></i><b></b><em></em></span>
                  <span><strong>${this.#ui.t(theme.labelKey)}</strong><small>${this.#ui.t(theme.hintKey)}</small></span>
                </label>`,
              )}
            </div>
          </fieldset>
          <p class="settings-hint">${this.#ui.t("settings.themeApplies")}</p>
        </form>
        ${this.canManage && this.campaign !== undefined ? this.#siteForm(this.pending ?? site) : nothing}
        ${
          this.canManage && this.campaign !== undefined
            ? html`<codex-branding-settings .campaign=${this.campaign} .busy=${this.busy}></codex-branding-settings>
              <codex-interface-consistency .catalogs=${this.catalogs}></codex-interface-consistency>`
            : nothing
        }
      </section>`;
  }

  #siteForm(current: CampaignThemeID) {
    const disabled = this.busy || this.pending !== undefined;
    return html`
      <form class="settings-site-theme" aria-labelledby="settings-site-theme-title"
        @submit=${(event: Event) => event.preventDefault()}>
        <h3 id="settings-site-theme-title">${this.#ui.t("settings.siteTheme")}</h3>
        <p class="settings-hint">${this.#ui.t("settings.siteThemeIntro")}</p>
        <fieldset data-ui="choices" aria-labelledby="settings-site-theme-title" ?disabled=${disabled}>
          ${campaignThemes.map(
            (theme) => html`<label><input type="radio" name="siteTheme" value=${theme.id}
              .checked=${live(theme.id === current)} @change=${() => void this.#saveSite(theme.id)} />${this.#ui.t(theme.labelKey)}</label>`,
          )}
        </fieldset>
        <p class="settings-hint" role="status">${this.pending === undefined ? this.notice : this.#ui.t("settings.saving")}</p>
        ${saveFailure(this.error)}
      </form>`;
  }

  #label(theme: CampaignThemeID): string {
    const definition = campaignThemes.find(({ id }) => id === theme) ?? campaignThemes[0]!;
    return this.#ui.t(definition.labelKey);
  }

  /** A theme is a reversible shared choice, so it saves as soon as it is picked. */
  async #saveSite(theme: CampaignThemeID): Promise<void> {
    const campaign = this.campaign;
    if (this.busy || this.pending !== undefined || campaign === undefined || !this.canManage)
      return;
    if (theme === campaignTheme(campaign)) return;
    this.pending = theme;
    this.error = "";
    this.notice = "";
    const detail: CampaignAppearanceSaveDetail = Object.freeze({
      theme,
      expectedRevision: campaignAppearanceRecord(campaign)?.revision ?? 0,
    });
    const result = await saveCampaign(this, "appearance", detail);
    this.pending = undefined;
    if (!this.isConnected) return;
    if (result.ok) this.notice = this.#ui.t("settings.siteThemeSaved");
    else this.error = result.message;
  }
}

customElements.define("codex-appearance-settings", CodexAppearanceSettings);
