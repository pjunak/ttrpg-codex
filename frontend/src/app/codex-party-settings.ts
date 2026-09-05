import { LitElement, html, nothing } from "lit";
import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { campaignPartyIdentity, campaignPartyRecord, type CampaignPartySaveDetail } from "./campaign-party.js";
import { recordValue, text } from "./campaign-projection.js";
import { campaignPages, recordHash } from "./routes.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";

export class CodexPartySettings extends LitElement {
  static override properties = {
    campaign: { attribute: false }, saving: { type: Boolean }, editCompletion: { type: Number },
    draft: { state: true }, dirty: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  declare saving: boolean;
  declare editCompletion: number;
  declare private draft: CampaignPartySaveDetail | undefined;
  declare private dirty: boolean;
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super(); this.campaign = undefined; this.saving = false; this.editCompletion = 0;
    this.draft = undefined; this.dirty = false;
  }
  protected override createRenderRoot() { return this; }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (this.draft === undefined || changed.has("editCompletion") || (changed.has("campaign") && !this.dirty)) this.#reset();
  }
  protected override render() {
    if (this.campaign === undefined || this.draft === undefined) return nothing;
    const record = campaignPartyRecord(this.campaign);
    const invalid = record !== undefined && !isRecord(record.value);
    const members = campaignCollection(this.campaign, "characters").records.filter(member => recordValue(member)["faction"] === "party");
    const characters = campaignPages.find(({ collection }) => collection === "characters")!;
    const party = campaignPartyIdentity(this.campaign);
    return html`<section class="settings-ledger settings-party-panel" aria-labelledby="settings-party-title">
      <header class="settings-ledger-heading"><h2 id="settings-party-title">🛡 ${this.#ui.t("settings.playerParty")}</h2></header>
      <p class="settings-hint">${this.#ui.t("settings.partyIntro")}</p>
      ${invalid ? html`<p role="alert">${this.#ui.t("settings.partyInvalid")}</p>` : nothing}
      ${invalid && !this.dirty ? nothing : html`<form @submit=${this.#save}>
        <div class="settings-edit-grid settings-party-fields">
          <label><span>${this.#ui.t("settings.partyName")}</span><input name="partyName" maxlength="200"
            .value=${this.draft.name} ?disabled=${this.saving} @input=${(event: Event) => this.#input("name", event)} /></label>
          <label><span>${this.#ui.t("settings.partyIcon")}</span><input name="partyIcon" maxlength="100"
            .value=${this.draft.icon} ?disabled=${this.saving} @input=${(event: Event) => this.#input("icon", event)} /></label>
          <label><span>${this.#ui.t("settings.partyColor")}</span><input type="color" name="partyColor"
            .value=${this.draft.color} ?disabled=${this.saving} @input=${(event: Event) => this.#input("color", event)} /></label>
          <label><span>${this.#ui.t("settings.partyTextColor")}</span><input type="color" name="partyTextColor"
            .value=${this.draft.textColor} ?disabled=${this.saving} @input=${(event: Event) => this.#input("textColor", event)} /></label>
        </div>
        <div class="settings-edit-actions">
          <button class="primary" type="submit" ?disabled=${this.saving}>${this.#ui.t(this.saving ? "settings.saving" : "dashboard.save")}</button>
          <button type="button" ?disabled=${this.saving} @click=${this.#cancel}>${this.#ui.t("dashboard.cancel")}</button>
        </div>
      </form>`}
      <section class="settings-party-members" aria-labelledby="settings-party-members-title">
        <h3 id="settings-party-members-title">${this.#ui.plural("settings.partyMembers", members.length)}</h3>
        <p class="settings-hint">${this.#ui.t("settings.partyMembersHint")}</p>
        ${members.length === 0 ? html`<p class="settings-hint">${this.#ui.t("settings.partyNoMembers")}</p>` : html`
          <ul>${members.map(member => html`<li><a href=${recordHash(characters, member.key)}>
            <span aria-hidden="true">${party.badge}</span><span>${text(recordValue(member)["name"]) || member.key}</span>
            <span class="settings-party-open">${this.#ui.t("settings.partyOpen")}</span>
          </a></li>`)}</ul>`}
      </section>
    </section>`;
  }
  #reset(): void {
    if (this.campaign === undefined) return;
    this.draft = { ...campaignPartyIdentity(this.campaign), expectedRevision: campaignPartyRecord(this.campaign)?.revision ?? 0 };
    this.#setDirty(false);
  }
  #setDirty(dirty: boolean): void {
    this.dirty = dirty;
    this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty }, bubbles: true, composed: true }));
  }
  #input(field: "name" | "icon" | "color" | "textColor", event: Event): void {
    if (this.saving || this.draft === undefined) return;
    this.draft = { ...this.draft, [field]: (event.currentTarget as HTMLInputElement).value }; this.#setDirty(true);
  }
  readonly #cancel = (): void => {
    if (!this.saving && confirmDiscardUnsavedEdit(this.dirty, message => window.confirm(message))) this.#reset();
  };
  readonly #save = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.saving && this.draft !== undefined) this.dispatchEvent(new CustomEvent<CampaignPartySaveDetail>("campaign-party-save", {
      detail: this.draft, bubbles: true, composed: true,
    }));
  };
}

customElements.define("codex-party-settings", CodexPartySettings);
