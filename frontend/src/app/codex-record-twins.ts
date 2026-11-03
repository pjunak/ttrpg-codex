import { LitElement, html, nothing } from "lit";
import {
  campaignCollection,
  type CampaignDataset,
  type CampaignRecord,
} from "../core/campaign-data.js";
import type { CampaignTwinMutation } from "../core/campaign-mutations.js";
import { recordHash, type CampaignPageDefinition } from "./routes.js";
import { recordValue, text } from "./campaign-projection.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { saveCampaign } from "./campaign-writes.js";
import { dmVersionIcon, playerVersionIcon } from "./record-chrome.js";

export class CodexRecordTwins extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    record: { attribute: false },
    page: { attribute: false },
    disabled: { type: Boolean },
    open: { state: true },
    pending: { state: true },
    message: { state: true },
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
  constructor() {
    super();
    new UiLocalizationController(this);
    this.disabled = false;
    this.open = false;
    this.pending = false;
    this.message = "";
  }
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const previous = changed.get("record") as CampaignRecord | undefined;
    if ((previous && previous.key !== this.record.key) || changed.has("page")) {
      this.open = false;
      this.#base = undefined;
      this.message = "";
    }
  }
  protected override render() {
    if (!this.record || !this.page || this.page.collection === "companions") return nothing;
    const records = campaignCollection(this.campaign, this.page.collection).records;
    const twinKey = text(recordValue(this.record)["linkedTwinId"]);
    const twin = records.find((record) => record.key === twinKey);
    const base = this.#base ?? this.record,
      linked = text(recordValue(base)["linkedTwinId"]);
    const dm = recordValue(base)["visibility"] === "dm";
    const current = recordValue(this.record)["visibility"] === "dm" ? "dm" : "public";
    const side = (kind: "dm" | "public") => {
      const icon = kind === "dm" ? dmVersionIcon() : playerVersionIcon(),
        name = uiText(kind === "dm" ? "twins.dmVersion" : "twins.publicVersion");
      if (kind === current)
        return html`<span class="record-version is-current" title=${name}>${icon}<span class="visually-hidden">${name}</span></span>`;
      if (twin) {
        const open = uiText(kind === "dm" ? "twins.openDM" : "twins.openPublic");
        return html`<a class="record-version" href=${recordHash(this.page, twin.key)} aria-label=${open} title=${open}>${icon}</a>`;
      }
      if (twinKey)
        return html`<span class="record-version is-unavailable" title=${uiText("twins.unavailable")}>${icon}<span class="visually-hidden">${uiText("twins.unavailable")}</span></span>`;
      const add = uiText(kind === "dm" ? "twins.addDM" : "twins.addPublic");
      return html`<button type="button" class="record-version is-missing" aria-label=${add} title=${add}
        aria-expanded=${this.open ? "true" : "false"} ?disabled=${this.disabled || this.pending} @click=${this.manage}>${icon}</button>`;
    };
    return html`<div class="record-versions">
      <div class="record-version-switch" role="group" aria-label=${uiText("twins.title")}>${side("dm")}${side("public")}</div>
      ${
        this.open
          ? html`<section class="record-versions-panel" aria-label=${uiText("twins.manage")}>
        <h2>${uiText("twins.title")}</h2>
        <p>${uiText("twins.visibility")}</p>
        ${
          linked
            ? html`<p>${uiText("twins.unlinkHint")}</p><button type="button" class="ui-action" ?disabled=${this.disabled || this.pending || this.#failed} @click=${() => this.#submit("unlink")}>${uiText("twins.unlink")}</button>`
            : html`
          <p>${uiText(dm ? "twins.publishHint" : "twins.privateHint")}</p>
          <button type="button" class="ui-action" ?disabled=${this.disabled || this.pending || this.#failed} @click=${() => this.#submit("create")}>${uiText(dm ? "twins.createPublic" : "twins.createDM")}</button>
          <label>${uiText("twins.existing")}<select aria-label=${uiText("twins.existing")} .value=${this.#target} ?disabled=${this.disabled || this.pending || this.#failed} @change=${(
            event: Event,
          ) => {
            this.#target = (event.target as HTMLSelectElement).value;
            this.requestUpdate();
          }}>
            <option value="">${uiText("twins.choose")}</option>${this.#candidates.map((record) => html`<option value=${record.key}>${text(recordValue(record)["name"]) || text(recordValue(record)["title"]) || record.key}</option>`)}
          </select></label>
          <button type="button" class="ui-action" ?disabled=${!this.#target || this.disabled || this.pending || this.#failed} @click=${() => this.#submit("link")}>${uiText("twins.link")}</button>
        `
        }
        ${this.message ? html`<p role=${this.#failed ? "alert" : "status"}>${this.message}</p>` : nothing}
        <div class="record-versions-actions">
          <button type="button" class="ui-action" ?disabled=${this.disabled || this.pending} @click=${this.#review}>${uiText("twins.review")}</button>
          <button type="button" class="ui-action" ?disabled=${this.pending} @click=${this.#close}>${uiText("Close")}</button>
        </div>
      </section>`
          : this.message
            ? html`<p class="record-versions-panel record-versions-note" role=${this.#failed ? "alert" : "status"}><span>${this.message}</span>
          <button type="button" class="ui-action" data-ui-variant="quiet" @click=${this.#close}>${uiText("Close")}</button></p>`
            : nothing
      }
    </div>`;
  }
  /** Opens the panel that creates, links or unlinks this record's other version. */
  readonly manage = (): void => this.#review();
  readonly #close = (): void => {
    this.open = false;
    this.message = "";
  };
  #review = (): void => {
    this.#base = this.record;
    this.#target = "";
    this.#failed = false;
    this.message = "";
    const dm = recordValue(this.record)["visibility"] === "dm";
    this.#candidates = campaignCollection(this.campaign, this.page.collection).records.filter(
      (record) =>
        record.key !== this.record.key &&
        (recordValue(record)["visibility"] === "dm") !== dm &&
        !text(recordValue(record)["linkedTwinId"]),
    );
    this.open = true;
  };
  async #submit(action: "create" | "link" | "unlink"): Promise<void> {
    if (!this.#base || this.pending || this.disabled || this.#failed) return;
    const source = {
      collection: this.page.collection,
      sourceKey: this.#base.key,
      sourceExpectedRevision: this.#base.revision,
    };
    const target = this.#candidates.find((record) => record.key === this.#target);
    if (action === "link" && !target) return;
    const mutation: CampaignTwinMutation =
      action === "link"
        ? { ...source, action, targetKey: target!.key, targetExpectedRevision: target!.revision }
        : { ...source, action };
    this.pending = true;
    this.message = "";
    const result = await saveCampaign(this, "twin", mutation);
    this.pending = false;
    this.message = result.message ?? "";
    this.#failed = !result.ok;
    if (result.ok) {
      this.open = false;
      this.#base = undefined;
    }
  }
}
customElements.define("codex-record-twins", CodexRecordTwins);
