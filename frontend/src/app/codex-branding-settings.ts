import { previewResourceURL } from "../core/player-preview.js";
import { LitElement, html, nothing } from "lit";
import { isRecord } from "../core/boundary.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import {
  brandingRecord,
  campaignBranding,
  defaultLogo,
  type BrandingSaveDetail,
} from "./campaign-branding.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit, reportEditState } from "./unsaved-edit.js";
import { saveCampaign } from "./campaign-writes.js";
import { saveFailure } from "./save-failure.js";

export class CodexBrandingSettings extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    busy: { type: Boolean },
    draft: { state: true },
    dirty: { state: true },
    file: { state: true },
    saving: { state: true },
    error: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  declare private saving: boolean;
  declare private error: string;
  declare private draft: BrandingSaveDetail | undefined;
  declare private dirty: boolean;
  declare private file: File | undefined;
  readonly #ui = new UiLocalizationController(this);
  constructor() {
    super();
    this.busy = false;
    this.saving = false;
    this.error = "";
    this.dirty = false;
  }
  get #disabled(): boolean {
    return this.busy || this.saving;
  }
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (this.draft === undefined || (changed.has("campaign") && !this.dirty)) this.#reset();
  }
  protected override render() {
    if (this.campaign === undefined || this.draft === undefined) return nothing;
    const record = brandingRecord(this.campaign),
      invalid = record !== undefined && !isRecord(record.value);
    return html`<section class="settings-branding" aria-labelledby="branding-title">
      <h3 id="branding-title">🐉 ${this.#ui.t("branding.title")}</h3>
      <p class="settings-hint">${this.#ui.t("branding.intro")}</p>
      ${invalid ? html`<p role="alert">${this.#ui.t("branding.invalid")}</p>` : nothing}
      <div class="settings-branding-preview"><img src=${previewResourceURL(this.draft.logoUrl || defaultLogo)} alt=${this.#ui.t("branding.logo")}
        @error=${(event: Event) => {
          const image = event.currentTarget as HTMLImageElement;
          if (image.getAttribute("src") !== defaultLogo) image.src = defaultLogo;
        }} />
        <span>${this.#ui.t(this.draft.logoUrl ? "branding.customLogo" : "branding.defaultLogo")}</span></div>
      ${
        invalid && !this.dirty
          ? nothing
          : html`
        <div class="settings-branding-upload"><label>${this.#ui.t("branding.upload")}<input type="file" aria-label=${this.#ui.t("branding.upload")}
          accept="image/png,image/jpeg,image/webp,image/svg+xml" ?disabled=${this.#disabled} @change=${this.#upload} /></label>
          ${this.file ? html`<span class="settings-hint">${this.file.name}</span>` : nothing}
          ${
            this.draft.logoUrl || this.file
              ? html`<button class="sc-btn" ?disabled=${this.#disabled} @click=${() => {
                  this.file = undefined;
                  this.draft = { ...this.draft!, logoUrl: "" };
                  this.#setDirty(true);
                }}>${this.#ui.t("branding.restoreLogo")}</button>`
              : nothing
          }
        </div>
        <form @submit=${this.#save}>
          <div class="settings-edit-grid">
            <label><span>${this.#ui.t("branding.name")}</span><input name="brandingTitle" maxlength="200" .value=${this.draft.title} ?disabled=${this.#disabled} @input=${(event: Event) => this.#input("title", event)} /></label>
            <label><span>${this.#ui.t("branding.subtitle")}</span><input name="brandingSubtitle" maxlength="300" .value=${this.draft.subtitle} ?disabled=${this.#disabled} @input=${(event: Event) => this.#input("subtitle", event)} /></label>
          </div>
          ${saveFailure(this.error)}
          <div class="settings-edit-actions"><button class="primary" ?disabled=${this.#disabled}>${this.#ui.t(this.saving ? "settings.saving" : "dashboard.save")}</button>
            <button type="button" ?disabled=${this.#disabled} @click=${() => {
              if (confirmDiscardUnsavedEdit(this.dirty, (message) => window.confirm(message)))
                this.#reset();
            }}>${this.#ui.t("dashboard.cancel")}</button></div>
        </form>`
      }
    </section>`;
  }
  #reset(campaign = this.campaign): void {
    if (campaign !== undefined) {
      this.file = undefined;
      this.error = "";
      this.draft = {
        ...campaignBranding(campaign),
        expectedRevision: brandingRecord(campaign)?.revision ?? 0,
      };
      this.#setDirty(false);
    }
  }
  #setDirty(dirty: boolean): void {
    this.dirty = dirty;
    reportEditState(this, { dirty });
  }
  #input(field: "title" | "subtitle", event: Event): void {
    if (!this.#disabled && this.draft !== undefined) {
      this.draft = { ...this.draft, [field]: (event.target as HTMLInputElement).value };
      this.error = "";
      this.#setDirty(true);
    }
  }
  readonly #save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const draft = this.draft;
    if (this.#disabled || draft === undefined) return;
    this.saving = true;
    this.error = "";
    const result = await saveCampaign(this, "branding", {
      ...draft,
      ...(this.file ? { file: this.file } : {}),
    });
    this.saving = false;
    if (!this.isConnected || this.draft !== draft) return;
    if (result.ok) this.#reset(result.campaign);
    else this.error = result.message;
  };
  readonly #upload = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement,
      file = input.files?.[0];
    input.value = "";
    if (file !== undefined && this.draft !== undefined && !this.#disabled) {
      this.file = file;
      this.#setDirty(true);
    }
  };
}
customElements.define("codex-branding-settings", CodexBrandingSettings);
