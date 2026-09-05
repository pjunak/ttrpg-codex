import { LitElement, html, nothing } from "lit";
import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { MediaClient, MediaHTTPError } from "../core/media.js";
import { mapConfigKey, mapConfigRecord, mapLocationRecord, mapViews, mapZoomScaleRatio,
  type MapSaveDetail, type MapUploadDetail } from "./campaign-map.js";
import { recordValue, safeMediaURL, text } from "./campaign-projection.js";
import { mapHash } from "./routes.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";

type ConfigDraft = Extract<MapSaveDetail, { kind: "config" }>;

export class CodexMapSettings extends LitElement {
  static override properties = {
    campaign: { attribute: false }, initialParentId: { attribute: false }, saving: { type: Boolean }, editCompletion: { type: Number },
    parentId: { state: true }, draft: { state: true }, imageURL: { state: true }, preview: { state: true }, dirty: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  declare initialParentId: string | null;
  declare saving: boolean;
  declare editCompletion: number;
  declare private parentId: string | null;
  declare private draft: ConfigDraft | undefined;
  declare private imageURL: string | undefined;
  declare private preview: "loading" | "ready" | "empty" | "error";
  declare private dirty: boolean;
  #request: AbortController | undefined;
  readonly #media = new MediaClient();
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    this.campaign = undefined; this.initialParentId = null; this.parentId = null;
    this.saving = false; this.editCompletion = 0; this.draft = undefined;
    this.imageURL = undefined; this.preview = "loading"; this.dirty = false;
  }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void { this.#request?.abort(); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("initialParentId")) this.parentId = this.initialParentId;
    if (changed.has("initialParentId") || changed.has("editCompletion") || this.draft === undefined ||
      (changed.has("campaign") && !this.dirty)) this.#reset();
  }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("parentId") || changed.has("editCompletion") ||
      (changed.has("campaign") && this.parentId !== null && this.#localImage() !== this.imageURL)) void this.#loadPreview();
  }
  protected override render() {
    if (this.campaign === undefined || this.draft === undefined) return nothing;
    const locations = campaignCollection(this.campaign, "locations").records;
    const record = this.parentId === null ? undefined : mapLocationRecord(this.campaign, this.parentId);
    const missing = this.parentId !== null && record === undefined;
    const all = mapConfigRecord(this.campaign)?.value;
    const key = mapConfigKey(this.parentId);
    const invalid = all !== undefined && (!isRecord(all) || (all[key] !== undefined && !isRecord(all[key])));
    const views = mapViews(this.campaign, this.parentId);
    return html`<section class="settings-ledger settings-map-panel" aria-label=${this.#ui.t("map.settings")}>
      <header class="settings-ledger-heading"><h2>🗺 ${this.#ui.t("map.settings")}</h2></header>
      <div class="settings-maps-shell">
        <nav class="settings-maps-tree" aria-label=${this.#ui.t("map.selectMap")}>
          <button class="settings-map-node" aria-current=${this.parentId === null ? "page" : nothing} ?disabled=${this.saving} @click=${() => this.#select(null)}>🌐 ${this.#ui.t("map.world")}</button>
          ${locations.map(location => html`<button class="settings-map-node" aria-current=${this.parentId === location.key ? "page" : nothing}
            ?disabled=${this.saving} @click=${() => this.#select(location.key)}>🗺 ${text(recordValue(location)["name"]) || location.key}</button>`)}
        </nav>
        <section class="settings-maps-detail">
          <h3 class="settings-maps-detail-title">${this.parentId === null ? this.#ui.t("map.world") : text(recordValue(record)["name"]) || this.#ui.t("map.missing")}</h3>
          ${this.imageURL === undefined ? html`<p class="settings-hint" role="status">${this.#ui.t(this.preview === "loading" ? "map.loading" : this.preview === "error" ? "map.failed" : "map.empty")}</p>
            ${this.preview === "error" ? html`<button class="sc-btn" @click=${() => void this.#loadPreview()}>${this.#ui.t("shell.tryAgain")}</button>` : nothing}`
            : html`<div class="settings-worldmap-preview"><img src=${this.imageURL} alt=${this.#ui.t("map.previewImage")} @error=${() => { this.imageURL = undefined; this.preview = "error"; }} /></div>`}
          <a class="sc-btn" href=${mapHash(this.parentId)}>${this.#ui.t("map.openMap")}</a>
          <label class="settings-map-upload">${this.#ui.t("map.upload")}<input type="file" aria-label=${this.#ui.t("map.upload")}
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" ?disabled=${this.saving || this.dirty || missing} @change=${this.#upload} /></label>
          ${invalid ? html`<p role="alert">${this.#ui.t("map.configInvalid")}</p>` : nothing}
          ${invalid && !this.dirty ? nothing : html`<form class="settings-map-config" @submit=${this.#save}>
            <label for="map-marker-zoom">${this.#ui.t("map.markerZoom")}</label>
            <p class="settings-hint">${this.#ui.t("map.markerZoomHint")}</p>
            <div class="settings-strength-row"><input id="map-marker-zoom" type="range" min="0" max="1" step="0.05"
              .value=${String(this.draft.zoomScaleRatio)} ?disabled=${this.saving} @input=${this.#input} /><output for="map-marker-zoom">${Math.round(this.draft.zoomScaleRatio * 100)}%</output></div>
            <button class="sc-btn" type="submit" ?disabled=${this.saving}>${this.#ui.t("dashboard.save")}</button>
            <button class="sc-btn" type="button" ?disabled=${this.saving} @click=${() => { if (this.#discard()) this.#reset(); }}>${this.#ui.t("dashboard.cancel")}</button>
          </form>`}
          <div class="settings-map-views"><h3>${this.#ui.t("map.savedViews")}</h3>
            ${views.length ? html`<ul>${views.map(view => html`<li>${view.icon} ${view.label}</li>`)}</ul>` : html`<p class="settings-hint">${this.#ui.t("map.noViews")}</p>`}
            <a class="sc-btn" href=${mapHash(this.parentId)}>${this.#ui.t("map.manageViews")}</a>
          </div>
        </section>
      </div>
    </section>`;
  }
  #select(parentId: string | null): void {
    if (parentId === this.parentId || this.saving || !this.#discard()) return;
    this.parentId = parentId; this.#reset();
  }
  #reset(): void {
    if (this.campaign === undefined) return;
    this.draft = { kind: "config", parentId: this.parentId, expectedRevision: mapConfigRecord(this.campaign)?.revision ?? 0,
      zoomScaleRatio: mapZoomScaleRatio(this.campaign, this.parentId) };
    this.#setDirty(false);
  }
  #discard(): boolean {
    if (this.saving || !confirmDiscardUnsavedEdit(this.dirty, message => window.confirm(message))) return false;
    this.#setDirty(false); return true;
  }
  #setDirty(dirty: boolean): void {
    this.dirty = dirty;
    this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty }, bubbles: true, composed: true }));
  }
  readonly #input = (event: Event): void => {
    if (this.saving || this.draft === undefined) return;
    this.draft = { ...this.draft, zoomScaleRatio: Number((event.target as HTMLInputElement).value) }; this.#setDirty(true);
  };
  readonly #save = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.saving && this.draft !== undefined) this.dispatchEvent(new CustomEvent("campaign-map-save", { detail: this.draft, bubbles: true, composed: true }));
  };
  readonly #upload = (event: Event): void => {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    if (file !== undefined && this.campaign !== undefined && !this.saving && !this.dirty) {
      const detail: MapUploadDetail = { parentId: this.parentId, file,
        expectedRevision: this.parentId === null ? 0 : mapLocationRecord(this.campaign, this.parentId)?.revision ?? 0 };
      this.dispatchEvent(new CustomEvent("campaign-map-upload", { detail, bubbles: true, composed: true }));
    }
    input.value = "";
  };
  #localImage(): string | undefined {
    return this.campaign !== undefined && this.parentId !== null
      ? safeMediaURL(recordValue(mapLocationRecord(this.campaign, this.parentId))["localMap"]) : undefined;
  }
  async #loadPreview(): Promise<void> {
    this.#request?.abort(); const request = new AbortController(); this.#request = request;
    this.preview = "loading"; this.imageURL = undefined;
    try {
      const url = this.parentId === null ? (await this.#media.latest("world-map", "main", request.signal)).url : this.#localImage();
      if (request.signal.aborted) return;
      this.imageURL = url; this.preview = url === undefined ? "empty" : "ready";
    } catch (cause) {
      if (!request.signal.aborted) this.preview = cause instanceof MediaHTTPError && cause.status === 404 ? "empty" : "error";
    }
  }
}
if (!customElements.get("codex-map-settings")) customElements.define("codex-map-settings", CodexMapSettings);
