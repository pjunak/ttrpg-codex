import { LitElement, html, nothing } from "lit";
import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import {
  campaignPartyIdentity,
  campaignPartyRecord,
  type CampaignPartySaveDetail,
} from "./campaign-party.js";
import { recordValue, text } from "./campaign-projection.js";
import { campaignPages, recordHash } from "./routes.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit, reportEditState } from "./unsaved-edit.js";
import { saveCampaign } from "./campaign-writes.js";
import { saveFailure } from "./save-failure.js";

export class CodexPartySettings extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    busy: { type: Boolean },
    draft: { state: true },
    dirty: { state: true },
    saving: { state: true },
    error: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  declare private draft: CampaignPartySaveDetail | undefined;
  declare private dirty: boolean;
  declare private saving: boolean;
  declare private error: string;
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    this.campaign = undefined;
    this.busy = false;
    this.draft = undefined;
    this.dirty = false;
    this.saving = false;
    this.error = "";
  }
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (this.draft === undefined || (changed.has("campaign") && !this.dirty)) this.#reset();
  }
  protected override render() {
    if (this.campaign === undefined || this.draft === undefined) return nothing;
    const record = campaignPartyRecord(this.campaign);
    const invalid = record !== undefined && !isRecord(record.value);
    const members = campaignCollection(this.campaign, "characters").records.filter(
      (member) => recordValue(member)["faction"] === "party",
    );
    const characters = campaignPages.find(({ collection }) => collection === "characters")!;
    const party = campaignPartyIdentity(this.campaign);
    return html`<section class="settings-ledger settings-party-panel" aria-labelledby="settings-party-title">
      <header class="settings-ledger-heading"><h2 id="settings-party-title">🛡 ${this.#ui.t("settings.playerParty")}</h2></header>
      <p class="settings-hint">${this.#ui.t("settings.partyIntro")}</p>
      ${invalid ? html`<p role="alert">${this.#ui.t("settings.partyInvalid")}</p>` : nothing}
      ${
        invalid && !this.dirty
          ? nothing
          : html`<form @submit=${this.#save}>
        <div class="settings-edit-grid settings-party-fields">
          <label><span>${this.#ui.t("settings.partyName")}</span><input name="partyName" maxlength="200"
            .value=${this.draft.name} ?disabled=${this.#locked} @input=${(event: Event) => this.#input("name", event)} /></label>
          <label><span>${this.#ui.t("settings.partyIcon")}</span><input name="partyIcon" maxlength="100"
            .value=${this.draft.icon} ?disabled=${this.#locked} @input=${(event: Event) => this.#input("icon", event)} /></label>
          <label><span>${this.#ui.t("settings.partyColor")}</span><input type="color" name="partyColor"
            .value=${this.draft.color} ?disabled=${this.#locked} @input=${(event: Event) => this.#input("color", event)} /></label>
          <label><span>${this.#ui.t("settings.partyTextColor")}</span><input type="color" name="partyTextColor"
            .value=${this.draft.textColor} ?disabled=${this.#locked} @input=${(event: Event) => this.#input("textColor", event)} /></label>
        </div>
        ${saveFailure(this.error)}
        <div class="settings-edit-actions">
          <button class="primary" type="submit" ?disabled=${this.#locked}>${this.#ui.t(this.saving ? "settings.saving" : "dashboard.save")}</button>
          <button type="button" ?disabled=${this.#locked} @click=${this.#cancel}>${this.#ui.t("dashboard.cancel")}</button>
        </div>
      </form>`
      }
      <section class="settings-party-members" aria-labelledby="settings-party-members-title">
        <h3 id="settings-party-members-title">${this.#ui.plural("settings.partyMembers", members.length)}</h3>
        <p class="settings-hint">${this.#ui.t("settings.partyMembersHint")}</p>
        ${
          members.length === 0
            ? html`<p class="settings-hint">${this.#ui.t("settings.partyNoMembers")}</p>`
            : html`
          <ul>${members.map(
            (member) => html`<li><a href=${recordHash(characters, member.key)}>
            <span aria-hidden="true">${party.badge}</span><span>${text(recordValue(member)["name"]) || member.key}</span>
            <span class="settings-party-open">${this.#ui.t("settings.partyOpen")}</span>
          </a></li>`,
          )}</ul>`
        }
      </section>
    </section>`;
  }
  #reset(campaign = this.campaign): void {
    if (campaign === undefined) return;
    this.draft = {
      ...campaignPartyIdentity(campaign),
      expectedRevision: campaignPartyRecord(campaign)?.revision ?? 0,
    };
    this.error = "";
    this.#setDirty(false);
  }
  get #locked(): boolean {
    return this.busy || this.saving;
  }
  #setDirty(dirty: boolean): void {
    this.dirty = dirty;
    reportEditState(this, { dirty });
  }
  #input(field: "name" | "icon" | "color" | "textColor", event: Event): void {
    if (this.#locked || this.draft === undefined) return;
    this.draft = { ...this.draft, [field]: (event.currentTarget as HTMLInputElement).value };
    this.error = "";
    this.#setDirty(true);
  }
  readonly #cancel = (): void => {
    if (
      !this.#locked &&
      confirmDiscardUnsavedEdit(this.dirty, (message) => window.confirm(message))
    )
      this.#reset();
  };
  readonly #save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const draft = this.draft;
    if (this.#locked || draft === undefined) return;
    this.saving = true;
    this.error = "";
    const result = await saveCampaign(this, "party", draft);
    this.saving = false;
    if (!this.isConnected || this.draft !== draft) return;
    if (result.ok) this.#reset(result.campaign);
    else this.error = result.message;
  };
}

customElements.define("codex-party-settings", CodexPartySettings);
