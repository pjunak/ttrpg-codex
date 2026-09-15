import { LitElement, html, nothing } from "lit";
import { campaignCollection, type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import type { CampaignTwinMutation } from "../core/campaign-mutations.js";
import { recordHash, type CampaignPageDefinition } from "./routes.js";
import { recordValue, text } from "./campaign-projection.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";

export interface CampaignTwinRequest {
  readonly mutation: CampaignTwinMutation;
  readonly respond: (result: { readonly ok: boolean; readonly message: string }) => void;
}

export class CodexRecordTwins extends LitElement {
  static override properties = {
    campaign: { attribute: false }, record: { attribute: false }, page: { attribute: false },
    disabled: { type: Boolean }, open: { state: true }, pending: { state: true }, message: { state: true },
  };
  declare campaign: CampaignDataset;
  declare record: CampaignRecord;
  declare page: CampaignPageDefinition;
  declare disabled: boolean;
  declare private open: boolean;
  declare private pending: boolean;
  declare private message: string;
  #base: CampaignRecord | undefined;
  #candidates: readonly CampaignRecord[] = [];
  #target = "";
  #failed = false;
  constructor() { super(); new UiLocalizationController(this); this.disabled = false; this.open = false; this.pending = false; this.message = ""; }
  protected override createRenderRoot() { return this; }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const previous = changed.get("record") as CampaignRecord | undefined;
    if (previous && previous.key !== this.record.key || changed.has("page")) { this.open = false; this.#base = undefined; this.message = ""; }
  }
  protected override render() {
    if (!this.record || !this.page || this.page.collection === "pets") return nothing;
    const records = campaignCollection(this.campaign, this.page.collection).records;
    const twinKey = text(recordValue(this.record)["linkedTwinId"]);
    const twin = records.find(record => record.key === twinKey);
    const base = this.#base ?? this.record, linked = text(recordValue(base)["linkedTwinId"]);
    const dm = recordValue(base)["visibility"] === "dm";
    return html`<section class="record-twins" aria-label=${uiText("twins.title")}>
      <div class="record-twin-actions"><strong>${uiText("twins.title")}</strong>
        ${twin ? html`<a href=${recordHash(this.page, twin.key)}>${uiText(recordValue(twin)["visibility"] === "dm" ? "twins.openDM" : "twins.openPublic")}</a>`
          : twinKey ? html`<span>${uiText("twins.unavailable")}</span>` : nothing}
        <button type="button" ?disabled=${this.disabled || this.pending} @click=${this.#review}>${uiText(this.open ? "twins.review" : "twins.manage")}</button>
      </div>
      ${this.open ? html`<div class="record-twin-review">
        <p>${uiText("twins.visibility")}</p>
        ${linked ? html`<p>${uiText("twins.unlinkHint")}</p><button type="button" ?disabled=${this.disabled || this.pending || this.#failed} @click=${() => this.#submit("unlink")}>${uiText("twins.unlink")}</button>` : html`
          <p>${uiText(dm ? "twins.publishHint" : "twins.privateHint")}</p>
          <button type="button" ?disabled=${this.disabled || this.pending || this.#failed} @click=${() => this.#submit("create")}>${uiText(dm ? "twins.createPublic" : "twins.createDM")}</button>
          <label>${uiText("twins.existing")}<select aria-label=${uiText("twins.existing")} .value=${this.#target} ?disabled=${this.disabled || this.pending || this.#failed} @change=${(event: Event) => { this.#target = (event.target as HTMLSelectElement).value; this.requestUpdate(); }}>
            <option value="">${uiText("twins.choose")}</option>${this.#candidates.map(record => html`<option value=${record.key}>${text(recordValue(record)["name"]) || text(recordValue(record)["title"]) || record.key}</option>`)}
          </select></label>
          <button type="button" ?disabled=${!this.#target || this.disabled || this.pending || this.#failed} @click=${() => this.#submit("link")}>${uiText("twins.link")}</button>
        `}
        <button type="button" ?disabled=${this.pending} @click=${() => { this.open = false; this.message = ""; }}>${uiText("Cancel")}</button>
      </div>` : nothing}
      ${this.message ? html`<p role=${this.#failed ? "alert" : "status"}>${this.message}</p>` : nothing}
    </section>`;
  }
  #review = (): void => {
    this.#base = this.record; this.#target = ""; this.#failed = false; this.message = "";
    const dm = recordValue(this.record)["visibility"] === "dm";
    this.#candidates = campaignCollection(this.campaign, this.page.collection).records.filter(record => record.key !== this.record.key &&
      (recordValue(record)["visibility"] === "dm") !== dm && !text(recordValue(record)["linkedTwinId"]));
    this.open = true;
  };
  async #submit(action: "create" | "link" | "unlink"): Promise<void> {
    if (!this.#base || this.pending || this.disabled || this.#failed) return;
    const source = { collection: this.page.collection, sourceKey: this.#base.key, sourceExpectedRevision: this.#base.revision };
    const target = this.#candidates.find(record => record.key === this.#target);
    if (action === "link" && !target) return;
    const mutation: CampaignTwinMutation = action === "link"
      ? { ...source, action, targetKey: target!.key, targetExpectedRevision: target!.revision } : { ...source, action };
    this.pending = true; this.message = "";
    const result = await new Promise<{ ok: boolean; message: string }>(respond => {
      const handled = !this.dispatchEvent(new CustomEvent<CampaignTwinRequest>("campaign-twin", { detail: { mutation, respond }, bubbles: true, composed: true, cancelable: true }));
      if (!handled) respond({ ok: false, message: uiText("twins.failed") });
    });
    this.pending = false; this.message = result.message; this.#failed = !result.ok;
    if (result.ok) { this.open = false; this.#base = undefined; }
  }
}
customElements.define("codex-record-twins", CodexRecordTwins);