import { LitElement, html, nothing } from "lit";
import type { BrowserCatalogStore } from "../addons/catalog-store.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import { hostLocales, languageEndonym } from "../locales/index.js";
import {
  campaignLanguageRecord,
  campaignSiteLanguages,
  type CampaignLanguageSaveDetail,
} from "./campaign-language.js";
import { saveCampaign } from "./campaign-writes.js";
import "./codex-language-coverage.js";
import { saveFailure } from "./save-failure.js";
import {
  UiLocalizationController,
  defaultSiteLanguages,
  maximumSiteLanguages,
  personalUiLocale,
  setPersonalUiLocale,
  siteLanguages,
} from "./ui-localization.js";
import { confirmDiscardUnsavedEdit, reportEditState } from "./unsaved-edit.js";

/**
 * Settings → Language. Everyone picks this browser's language or follows the
 * site; the DM also chooses the site's default and enabled languages.
 */
export class CodexLanguageSettings extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    canManage: { type: Boolean },
    busy: { type: Boolean },
    catalogs: { attribute: false },
    draft: { state: true },
    dirty: { state: true },
    saving: { state: true },
    error: { state: true },
    notice: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  /** The viewer is the DM outside player preview. */
  declare canManage: boolean;
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  /** The add-on session's catalogs; their languages can be enabled too. */
  declare catalogs: BrowserCatalogStore | undefined;
  declare private draft: CampaignLanguageSaveDetail | undefined;
  declare private dirty: boolean;
  declare private saving: boolean;
  declare private error: string;
  declare private notice: string;
  readonly #ui = new UiLocalizationController(this);
  #unsubscribe: (() => void) | undefined;
  #subscribed: BrowserCatalogStore | undefined;

  constructor() {
    super();
    this.canManage = false;
    this.busy = false;
    this.dirty = false;
    this.saving = false;
    this.error = "";
    this.notice = "";
  }

  protected override createRenderRoot() {
    return this;
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (this.#subscribed !== this.catalogs) {
      this.#unsubscribe?.();
      this.#subscribed = this.catalogs;
      this.#unsubscribe = this.catalogs?.subscribe(() => this.requestUpdate());
    }
    if (this.draft === undefined || (changed.has("campaign") && !this.dirty)) this.#reset();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#subscribed = undefined;
    if (this.dirty) reportEditState(this, { dirty: false });
  }

  protected override render() {
    const site = siteLanguages(),
      personal = personalUiLocale();
    return html`
      <section class="settings-ledger settings-personal-panel" aria-labelledby="settings-language-title">
        <header class="settings-ledger-heading">
          <div>
            <span class="settings-category-mark" aria-hidden="true">文</span>
            <div>
              <h2 id="settings-language-title">${this.#ui.t("settings.language")}</h2>
              <p>${this.#ui.t("settings.languageIntro")}</p>
            </div>
          </div>
        </header>
        <label class="settings-preference-field">
          <span>${this.#ui.t("settings.languageLabel")}</span>
          <select @change=${this.#changePersonal}>
            <option value="" ?selected=${personal === undefined || !site.enabledLocales.includes(personal)}
              >${this.#ui.t("settings.languageFollowSite", { language: languageEndonym(site.defaultLocale) })}</option>
            ${site.enabledLocales.map(
              (locale) =>
                html`<option value=${locale} ?selected=${locale === personal}>${languageEndonym(locale)}</option>`,
            )}
          </select>
        </label>
        <p class="settings-progress-note">${this.#ui.t("settings.languageProgress")}</p>
        ${this.canManage && this.campaign !== undefined ? this.#siteForm() : nothing}
        ${
          this.canManage
            ? html`<codex-language-coverage .catalogs=${this.catalogs}
              .locales=${site.enabledLocales.filter((locale) => locale !== "en")}></codex-language-coverage>`
            : nothing
        }
      </section>`;
  }

  #siteForm() {
    const draft = this.draft;
    if (draft === undefined) return nothing;
    const disabled = this.busy || this.saving;
    return html`
      <form class="settings-site-languages" aria-labelledby="settings-site-languages-title" @submit=${this.#save}>
        <h3 id="settings-site-languages-title">${this.#ui.t("settings.siteLanguages")}</h3>
        <p class="settings-hint">${this.#ui.t("settings.siteLanguagesIntro")}</p>
        <fieldset ?disabled=${disabled}>
          <legend>${this.#ui.t("settings.siteEnabledLanguages")}</legend>
          <div class="settings-language-choices">
            ${this.#candidates().map(
              (locale) => html`
              <label>
                <input type="checkbox" name="enabledLocale" value=${locale}
                  .checked=${draft.enabledLocales.includes(locale)}
                  ?disabled=${
                    locale === "en" ||
                    (!draft.enabledLocales.includes(locale) &&
                      draft.enabledLocales.length >= maximumSiteLanguages)
                  }
                  @change=${this.#toggle} />
                <span lang=${locale}>${
                  hostLocales.includes(locale)
                    ? languageEndonym(locale)
                    : this.#ui.t("settings.languageAddonsOnly", {
                        language: languageEndonym(locale),
                      })
                }</span>
              </label>`,
            )}
          </div>
        </fieldset>
        <label class="settings-site-default">
          <span>${this.#ui.t("settings.siteDefaultLanguage")}</span>
          <select name="defaultLocale" ?disabled=${disabled} @change=${this.#changeDefault}>
            ${draft.enabledLocales.map(
              (locale) =>
                html`<option value=${locale} ?selected=${locale === draft.defaultLocale}>${languageEndonym(locale)}</option>`,
            )}
          </select>
        </label>
        ${saveFailure(this.error)}
        <p class="settings-hint" role="status">${this.notice}</p>
        <div class="settings-edit-actions">
          <button data-ui-variant="primary" ?disabled=${disabled || !this.dirty}>
            ${this.#ui.t(this.saving ? "settings.saving" : "settings.siteLanguagesSave")}
          </button>
          <button type="button" ?disabled=${disabled || !this.dirty} @click=${() => {
            if (confirmDiscardUnsavedEdit(this.dirty, (message) => window.confirm(message)))
              this.#reset();
          }}>${this.#ui.t("dashboard.cancel")}</button>
        </div>
      </form>`;
  }

  /** English first, then every built-in, add-on and already enabled language. */
  #candidates(): readonly string[] {
    const draft = this.draft?.enabledLocales ?? [];
    return ["en", ...hostLocales, ...(this.catalogs?.locales() ?? []), ...draft].filter(
      (locale, index, all) => all.indexOf(locale) === index,
    );
  }

  #reset(campaign = this.campaign): void {
    if (campaign === undefined) return;
    const languages = campaignSiteLanguages(campaign) ?? defaultSiteLanguages;
    this.draft = Object.freeze({
      defaultLocale: languages.defaultLocale,
      enabledLocales: languages.enabledLocales,
      expectedRevision: campaignLanguageRecord(campaign)?.revision ?? 0,
    });
    this.error = "";
    this.#setDirty(false);
  }

  #setDirty(dirty: boolean): void {
    this.dirty = dirty;
    reportEditState(this, { dirty });
  }

  #edit(change: Partial<CampaignLanguageSaveDetail>): void {
    if (this.draft === undefined) return;
    const enabledLocales = change.enabledLocales ?? this.draft.enabledLocales,
      defaultLocale = change.defaultLocale ?? this.draft.defaultLocale;
    this.draft = Object.freeze({
      ...this.draft,
      enabledLocales,
      defaultLocale: enabledLocales.includes(defaultLocale) ? defaultLocale : "en",
    });
    this.error = "";
    this.notice = "";
    this.#setDirty(true);
  }

  readonly #changePersonal = (event: Event): void => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    setPersonalUiLocale(value === "" ? undefined : value);
  };

  readonly #toggle = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement,
      enabled = this.draft?.enabledLocales ?? [];
    this.#edit({
      enabledLocales: input.checked
        ? this.#candidates().filter((locale) => locale === input.value || enabled.includes(locale))
        : enabled.filter((locale) => locale !== input.value),
    });
  };

  readonly #changeDefault = (event: Event): void => {
    this.#edit({ defaultLocale: (event.currentTarget as HTMLSelectElement).value });
  };

  readonly #save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const draft = this.draft;
    if (this.busy || this.saving || draft === undefined || !this.dirty) return;
    this.saving = true;
    this.error = "";
    const result = await saveCampaign(this, "language", draft);
    this.saving = false;
    if (!this.isConnected || this.draft !== draft) return;
    if (result.ok) {
      this.#reset(result.campaign);
      this.notice = this.#ui.t("settings.siteLanguagesSaved");
    } else this.error = result.message;
  };
}

customElements.define("codex-language-settings", CodexLanguageSettings);
