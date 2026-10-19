import { previewResourceURL } from "../core/player-preview.js";
import { LitElement, html, nothing } from "lit";
import { isRecord } from "../core/boundary.js";
import { campaignCollection, type CampaignDataset } from "../core/campaign-data.js";
import { MediaClient, MediaHTTPError } from "../core/media.js";
import {
  mapConfigKey,
  mapConfigRecord,
  mapLocationRecord,
  mapViews,
  mapZoomScaleRatio,
  type MapSaveDetail,
  type MapUploadDetail,
} from "./campaign-map.js";
import { recordValue, safeMediaURL, text } from "./campaign-projection.js";
import { mapHash } from "./routes.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit, reportEditState } from "./unsaved-edit.js";
import {
  saveCampaign,
  type CampaignWriteKind,
  type CampaignWriteResult,
  type CampaignWrites,
} from "./campaign-writes.js";
import { saveFailure } from "./save-failure.js";

type ConfigDraft = Extract<MapSaveDetail, { kind: "config" }>;

export class CodexMapSettings extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    initialParentId: { attribute: false },
    busy: { type: Boolean },
    parentId: { state: true },
    saving: { state: true },
    error: { state: true },
    draft: { state: true },
    imageURL: { state: true },
    preview: { state: true },
    dirty: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  declare initialParentId: string | null;
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  declare private parentId: string | null;
  declare private saving: boolean;
  declare private error: string;
  declare private draft: ConfigDraft | undefined;
  declare private imageURL: string | undefined;
  declare private preview: "loading" | "ready" | "empty" | "error";
  declare private dirty: boolean;
  #request: AbortController | undefined;
  readonly #media = new MediaClient();
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    this.campaign = undefined;
    this.initialParentId = null;
    this.parentId = null;
    this.busy = false;
    this.saving = false;
    this.error = "";
    this.draft = undefined;
    this.imageURL = undefined;
    this.preview = "loading";
    this.dirty = false;
  }
  protected override createRenderRoot() {
    return this;
  }
  override disconnectedCallback(): void {
    this.#request?.abort();
    super.disconnectedCallback();
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("initialParentId")) this.parentId = this.initialParentId;
    if (
      changed.has("initialParentId") ||
      this.draft === undefined ||
      (changed.has("campaign") && !this.dirty)
    )
      this.#reset();
  }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (
      changed.has("parentId") ||
      (changed.has("campaign") && this.parentId !== null && this.#localImage() !== this.imageURL)
    )
      void this.#loadPreview();
  }
  protected override render() {
    if (this.campaign === undefined || this.draft === undefined) return nothing;
    const locations = campaignCollection(this.campaign, "locations").records;
    const record =
      this.parentId === null ? undefined : mapLocationRecord(this.campaign, this.parentId);
    const missing = this.parentId !== null && record === undefined;
    const all = mapConfigRecord(this.campaign)?.value;
    const key = mapConfigKey(this.parentId);
    const invalid =
      all !== undefined && (!isRecord(all) || (all[key] !== undefined && !isRecord(all[key])));
    const views = mapViews(this.campaign, this.parentId);
    return html`<section class="settings-ledger settings-map-panel" aria-label=${this.#ui.t("map.settings")}>
      <header class="settings-ledger-heading"><h2>🗺 ${this.#ui.t("map.settings")}</h2></header>
      <div class="settings-maps-shell">
        <nav class="settings-maps-tree" aria-label=${this.#ui.t("map.selectMap")}>
          <button class="settings-map-node" aria-current=${this.parentId === null ? "page" : nothing} ?disabled=${this.#locked} @click=${() => this.#select(null)}>🌐 ${this.#ui.t("map.world")}</button>
          ${locations.map(
            (
              location,
            ) => html`<button class="settings-map-node" aria-current=${this.parentId === location.key ? "page" : nothing}
            ?disabled=${this.#locked} @click=${() => this.#select(location.key)}>🗺 ${text(recordValue(location)["name"]) || location.key}</button>`,
          )}
        </nav>
        <section class="settings-maps-detail">
          <h3 class="settings-maps-detail-title">${this.parentId === null ? this.#ui.t("map.world") : text(recordValue(record)["name"]) || this.#ui.t("map.missing")}</h3>
          ${
            this.imageURL === undefined
              ? html`<p class="settings-hint" role="status">${this.#ui.t(this.preview === "loading" ? "map.loading" : this.preview === "error" ? "map.failed" : "map.empty")}</p>
            ${this.preview === "error" ? html`<button class="sc-btn" @click=${() => void this.#loadPreview()}>${this.#ui.t("shell.tryAgain")}</button>` : nothing}`
              : html`<div class="settings-worldmap-preview"><img src=${previewResourceURL(this.imageURL)} alt=${this.#ui.t("map.previewImage")} @error=${() => {
                  this.imageURL = undefined;
                  this.preview = "error";
                }} /></div>`
          }
          <a class="sc-btn" href=${mapHash(this.parentId)}>${this.#ui.t("map.openMap")}</a>
          <label class="settings-map-upload">${this.#ui.t("map.upload")}<input type="file" aria-label=${this.#ui.t("map.upload")}
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" ?disabled=${this.#locked || missing} @change=${this.#upload} /></label>
          ${saveFailure(this.error)}
          ${invalid ? html`<p role="alert">${this.#ui.t("map.configInvalid")}</p>` : nothing}
          ${
            invalid && !this.dirty
              ? nothing
              : html`<form class="settings-map-config" @submit=${this.#save}>
            <label for="map-marker-zoom">${this.#ui.t("map.markerZoom")}</label>
            <p class="settings-hint">${this.#ui.t("map.markerZoomHint")}</p>
            <div class="settings-strength-row"><input id="map-marker-zoom" type="range" min="0" max="1" step="0.05"
              .value=${String(this.draft.zoomScaleRatio)} ?disabled=${this.#locked} @input=${this.#input} /><output for="map-marker-zoom">${Math.round(this.draft.zoomScaleRatio * 100)}%</output></div>
            <button class="sc-btn" type="submit" ?disabled=${this.#locked}>${this.#ui.t(this.saving ? "settings.saving" : "dashboard.save")}</button>
            <button class="sc-btn" type="button" ?disabled=${this.#locked} @click=${() => {
              if (this.#discard()) this.#reset();
            }}>${this.#ui.t("dashboard.cancel")}</button>
          </form>`
          }
          <div class="settings-map-views"><h3>${this.#ui.t("map.savedViews")}</h3>
            ${views.length ? html`<ul>${views.map((view) => html`<li>${view.icon} ${view.label}</li>`)}</ul>` : html`<p class="settings-hint">${this.#ui.t("map.noViews")}</p>`}
            <a class="sc-btn" href=${mapHash(this.parentId)}>${this.#ui.t("map.manageViews")}</a>
          </div>
        </section>
      </div>
    </section>`;
  }
  #select(parentId: string | null): void {
    if (parentId === this.parentId || this.#locked || !this.#discard()) return;
    this.parentId = parentId;
    this.#reset();
  }
  #reset(campaign = this.campaign): void {
    if (campaign === undefined) return;
    this.draft = {
      kind: "config",
      parentId: this.parentId,
      expectedRevision: mapConfigRecord(campaign)?.revision ?? 0,
      zoomScaleRatio: mapZoomScaleRatio(campaign, this.parentId),
    };
    this.error = "";
    this.#setDirty(false);
  }
  get #locked(): boolean {
    return this.busy || this.saving;
  }
  #discard(): boolean {
    if (
      this.#locked ||
      !confirmDiscardUnsavedEdit(this.dirty, (message) => window.confirm(message))
    )
      return false;
    this.#setDirty(false);
    return true;
  }
  /** Saves for this panel; the answer is dropped once another map is selected. */
  async #write<K extends CampaignWriteKind>(
    kind: K,
    detail: CampaignWrites[K],
  ): Promise<CampaignWriteResult | undefined> {
    const parentId = this.parentId;
    this.saving = true;
    this.error = "";
    const result = await saveCampaign(this, kind, detail);
    this.saving = false;
    if (!this.isConnected || this.parentId !== parentId) return undefined;
    if (!result.ok) this.error = result.message;
    return result;
  }
  #setDirty(dirty: boolean): void {
    this.dirty = dirty;
    reportEditState(this, { dirty });
  }
  readonly #input = (event: Event): void => {
    if (this.#locked || this.draft === undefined) return;
    this.draft = {
      ...this.draft,
      zoomScaleRatio: Number((event.target as HTMLInputElement).value),
    };
    this.#setDirty(true);
  };
  readonly #save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const draft = this.draft;
    if (this.#locked || draft === undefined) return;
    const result = await this.#write("map", draft);
    if (result?.ok && this.draft === draft) this.#reset(result.campaign);
  };
  readonly #upload = async (event: Event): Promise<void> => {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    input.value = "";
    if (file === undefined || this.campaign === undefined || this.#locked) return;
    const detail: MapUploadDetail = {
      parentId: this.parentId,
      file,
      expectedRevision:
        this.parentId === null
          ? 0
          : (mapLocationRecord(this.campaign, this.parentId)?.revision ?? 0),
    };
    // A new image leaves the zoom draft alone; only the preview reloads.
    if ((await this.#write("map-upload", detail))?.ok) void this.#loadPreview();
  };
  #localImage(): string | undefined {
    return this.campaign !== undefined && this.parentId !== null
      ? safeMediaURL(recordValue(mapLocationRecord(this.campaign, this.parentId))["localMap"])
      : undefined;
  }
  async #loadPreview(): Promise<void> {
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.preview = "loading";
    this.imageURL = undefined;
    try {
      const url =
        this.parentId === null
          ? (await this.#media.latest("world-map", "main", request.signal)).url
          : this.#localImage();
      if (request.signal.aborted) return;
      this.imageURL = url;
      this.preview = url === undefined ? "empty" : "ready";
    } catch (cause) {
      if (!request.signal.aborted)
        this.preview = cause instanceof MediaHTTPError && cause.status === 404 ? "empty" : "error";
    }
  }
}
if (!customElements.get("codex-map-settings"))
  customElements.define("codex-map-settings", CodexMapSettings);
