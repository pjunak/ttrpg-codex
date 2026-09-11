import { uiText } from "./ui-localization.js";
import { previewResourceURL } from "../core/player-preview.js";
import { LitElement, html, nothing } from "lit";
import { markerGlowLayers } from "./campaign-attitude-glow.js";
import * as L from "leaflet";
import type { CampaignDataset } from "../core/campaign-data.js";
import { MediaClient, MediaHTTPError } from "../core/media.js";
import { createCampaignRecordKey, editorOptionsFor } from "./campaign-record-editor.js";
import { recordValue, safeMediaURL, text, projectEffectiveAttitudes } from "./campaign-projection.js";
import { recordFieldControl } from "./record-field-controls.js";
import { searchable, searchTokens } from "./campaign-search.js";
import { mapLocationRecord, mapLocations, mapViews, mapViewRecord, mapParent, locationPage, mapCoordinate,
  mapEventPoints, mapEventRecord, eventMapParent, hasEventPin, eventPage, eventPathColors, validBounds, mapZoomScaleRatio, mapMarkerScale, mapDetailFields,
  type MapSaveDetail, type MapUploadDetail, type MapBounds, type MapLocation, type MapView, type MapEventPoint } from "./campaign-map.js";
import { campaignCollection } from "../core/campaign-data.js";
import { mapHash, mapSettingsHash, recordHash, type AppRoute } from "./routes.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";

type MapRoute = Extract<AppRoute, { kind: "map" }>;
type LocationDraft = Extract<MapSaveDetail, { kind: "location" }>;
type ViewDraft = Extract<MapSaveDetail, { action: "create" | "update" }>;
type EventDraft = Extract<MapSaveDetail, { kind: "event" }> & { readonly name: string; readonly hadPin: boolean };

export class CodexMap extends LitElement {
  static override properties = {
    campaign: { attribute: false }, route: { attribute: false }, canEdit: { type: Boolean },
    canManageCampaign: { type: Boolean }, saving: { type: Boolean }, editCompletion: { type: Number },
    errorMessage: { type: String }, editing: { state: true }, placing: { state: true }, draft: { state: true },
    selected: { state: true }, query: { state: true }, status: { state: true }, zoom: { state: true },
    viewDraft: { state: true }, viewBoundsUnavailable: { state: true }, eventsVisible: { state: true },
    eventDraft: { state: true }, eventUnavailable: { state: true }, locationUnavailable: { state: true },
    minZoom: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  declare route: MapRoute | undefined;
  declare canEdit: boolean;
  declare canManageCampaign: boolean;
  declare saving: boolean;
  declare editCompletion: number;
  declare errorMessage: string;
  declare private editing: boolean;
  declare private placing: string | null;
  declare private draft: LocationDraft | undefined;
  declare private selected: string | undefined;
  declare private query: string;
  declare private status: "loading" | "ready" | "empty" | "error" | "missing";
  declare private zoom: number;
  declare private minZoom: number;
  declare private viewDraft: ViewDraft | undefined;
  declare private viewBoundsUnavailable: boolean;
  declare private eventsVisible: boolean;
  declare private eventDraft: EventDraft | undefined;
  declare private eventUnavailable: boolean;
  declare private locationUnavailable: boolean;
  #routeTargetPending = false;
  #placementBase: { readonly key: string; readonly revision: number } | undefined;
  #detailCampaign: CampaignDataset | undefined;
  #detailValue: Readonly<Record<string, unknown>> = {};
  #map: L.Map | undefined;
  #layers: L.LayerGroup | undefined;
  #eventLayers: L.LayerGroup | undefined;
  #request: AbortController | undefined;
  #resize: ResizeObserver | undefined;
  #width = 1;
  #height = 1;
  #imageURL: string | undefined;
  #dirty = false;
  #dragging = false;
  readonly #media = new MediaClient();
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    this.campaign = undefined; this.route = undefined;
    this.canEdit = false; this.canManageCampaign = false; this.saving = false; this.editCompletion = 0;
    this.errorMessage = ""; this.editing = false; this.placing = null; this.draft = undefined;
    this.selected = undefined; this.query = ""; this.status = "loading"; this.zoom = 0;
    this.viewDraft = undefined; this.viewBoundsUnavailable = false; this.eventsVisible = false;
    this.eventDraft = undefined; this.eventUnavailable = false; this.locationUnavailable = false;
    this.minZoom = -8;
  }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void { this.#dispose(); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("route") || changed.has("editCompletion") || (changed.has("canEdit") && !this.canEdit)) {
      this.draft = undefined; this.viewDraft = undefined; this.eventDraft = undefined; this.viewBoundsUnavailable = false; this.placing = null; this.#setDirty(false);
      this.#detailCampaign = undefined; this.#detailValue = {};
    }
    if (changed.has("canManageCampaign") && !this.canManageCampaign && this.viewDraft !== undefined) {
      this.viewDraft = undefined; this.#setDirty(false);
    }
    if (!this.canEdit) this.editing = false;
    if (changed.has("route")) {
      this.selected = undefined; this.query = ""; this.editing = false; this.eventUnavailable = false;
      this.locationUnavailable = false; this.#routeTargetPending = true; this.#placementBase = undefined;
    }
  }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("route") || changed.has("editCompletion") ||
      (changed.has("campaign") && this.route?.parentId !== null && this.#localImage() !== this.#imageURL)) {
      void this.#loadMap();
    } else {
      if (["campaign", "draft", "viewDraft", "eventDraft", "editing", "saving"].some(key => changed.has(key))) this.#renderMarkers();
      if (["campaign", "draft", "viewDraft", "eventDraft", "eventsVisible", "editing", "saving"].some(key => changed.has(key))) this.#renderEvents();
    }
  }
  #localImage(): string | undefined {
    return this.campaign !== undefined && this.route?.parentId
      ? safeMediaURL(recordValue(mapLocationRecord(this.campaign, this.route.parentId))["localMap"]) : undefined;
  }
  protected override render() {
    if (this.campaign === undefined || this.route === undefined) return nothing;
    const parent = this.route.parentId === null ? undefined : mapLocationRecord(this.campaign, this.route.parentId);
    const locations = mapLocations(this.campaign, this.route.parentId);
    const tokens = searchTokens(this.query);
    const results = tokens.length ? locations.filter(location => tokens.every(token => searchable(`${location.name} ${location.title}`).includes(token)))
      .sort((a, b) => a.name.localeCompare(b.name, this.#ui.locale, { numeric: true }) || a.key.localeCompare(b.key)) : [];
    const unplaced = campaignCollection(this.campaign, "locations").records.filter(record => {
      const value = recordValue(record);
      return mapParent(value) === this.route!.parentId && (!mapCoordinate(value["x"]) || !mapCoordinate(value["y"]));
    });
    const events = campaignCollection(this.campaign, "events").records.filter(record => {
      const value = recordValue(record);
      return !hasEventPin(value) || eventMapParent(value) === this.route!.parentId;
    });
    return html`<section class="sc-shell" aria-label=${this.#ui.t("map.world")}>
      <header class="sc-toolbar">
        <h1 class="sc-title">🗺 ${parent === undefined ? this.#ui.t("map.world") : text(recordValue(parent)["name"])}</h1>
        ${parent === undefined ? nothing : html`<a class="sc-btn" href=${mapHash(null)}>↩ ${this.#ui.t("map.world")}</a>`}
        <div class="sc-search-wrap"><input class="sc-search" type="search" aria-label=${this.#ui.t("map.search")}
          placeholder=${this.#ui.t("map.search")} .value=${this.query} @input=${(event: Event) => { this.query = (event.target as HTMLInputElement).value; }}
          @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" && !event.isComposing && results[0]) { event.preventDefault(); this.#select(results[0], true); } }} />
          ${this.query === "" ? nothing : html`<div class="sc-search-results">${results.length === 0 ? this.#ui.t("map.noResults") : results.map(location => html`
            <button type="button" @click=${() => this.#select(location, true)}>${location.name}</button>`)}</div>`}
        </div>
        <button class="sc-btn" aria-pressed=${this.eventsVisible} @click=${this.#toggleEvents} ?disabled=${this.status !== "ready"}>📜 ${this.#ui.t("map.eventPaths")}</button>
        <button class="sc-btn" @click=${this.#fit} ?disabled=${this.status !== "ready"}>🌐 ${this.#ui.t("map.fit")}</button>
        ${mapViews(this.campaign, this.route.parentId).map(view => html`<span class="sc-view-preset"><button class="sc-btn" ?disabled=${this.status !== "ready"}
          @click=${() => this.#fitView(view.bounds)}>${view.icon} ${view.label}</button>
          ${this.editing && this.canManageCampaign ? html`<button class="sc-btn sc-view-edit" aria-label=${this.#ui.t("map.editView", { name: view.label })}
            ?disabled=${this.saving} @click=${() => this.#openView(view)}>✎</button>` : nothing}</span>`)}
        ${this.editing ? html`
          <button class="sc-btn" ?disabled=${this.saving || this.status !== "ready"} @click=${() => this.#place("")}>＋ ${this.#ui.t("map.add")}</button>
          ${unplaced.length === 0 ? nothing : html`<select class="sc-btn" aria-label=${this.#ui.t("map.placeExisting")} ?disabled=${this.saving || this.status !== "ready"}
            @change=${(event: Event) => { const select = event.target as HTMLSelectElement; if (select.value) this.#place(select.value); select.value = ""; }}>
            <option value="">${this.#ui.t("map.placeExisting")}</option>${unplaced.map(record => html`<option value=${record.key}>${text(recordValue(record)["name"]) || record.key}</option>`)}
          </select>`}
          ${events.length === 0 ? nothing : html`<select class="sc-btn sc-event-select" aria-label=${this.#ui.t("map.pickEvent")} ?disabled=${this.saving || this.status !== "ready"}
            @change=${(event: Event) => { const select = event.target as HTMLSelectElement; if (select.value) this.#openEvent(select.value, true); select.value = ""; }}>
            <option value="">${this.#ui.t("map.pickEvent")}</option>${events.map(record => html`<option value=${record.key}>${text(recordValue(record)["name"]) || record.key}</option>`)}
          </select>`}
          ${this.canManageCampaign ? html`<button class="sc-btn" ?disabled=${this.saving || this.status !== "ready"} @click=${() => this.#openView()}>✚ ${this.#ui.t("map.saveView")}</button>` : nothing}
          ${this.canManageCampaign ? html`<a class="sc-btn" href=${mapSettingsHash(this.route.parentId)}>⚙ ${this.#ui.t("map.settings")}</a>` : nothing}
        ` : nothing}
        <span class="sc-hint">${this.placing !== null || this.eventDraft?.x === null ? this.#ui.t("map.placeHint") : this.#ui.t("map.panHint")}</span>
        ${this.canEdit ? html`<button class="sc-btn" aria-pressed=${this.editing} ?disabled=${this.saving}
          @click=${this.#toggleEditing}>✏ ${this.#ui.t(this.editing ? "map.done" : "map.edit")}</button>` : nothing}
      </header>
      ${this.errorMessage ? html`<p class="sc-message" role="alert">${this.errorMessage}</p>` : nothing}
      ${this.viewBoundsUnavailable ? html`<p class="sc-message" role="alert">${this.#ui.t("map.viewBoundsUnavailable")}</p>` : nothing}
      ${this.eventUnavailable ? html`<p class="sc-message" role="alert">${this.#ui.t("map.eventUnavailable")}</p>` : nothing}
      ${this.locationUnavailable ? html`<p class="sc-message" role="alert">${this.#ui.t("map.locationUnavailable")}</p>` : nothing}
      ${this.editing && (this.route.parentId !== null || this.canManageCampaign) ? html`<label class="sc-upload">
        ${this.#ui.t("map.upload")} <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          aria-label=${this.#ui.t("map.upload")} ?disabled=${this.saving || this.draft !== undefined || this.viewDraft !== undefined || this.eventDraft !== undefined} @change=${this.#upload} />
      </label>` : nothing}
      <div class="sc-stage">
        <div class="sc-map" role="region" aria-label=${this.#ui.t("map.canvas")}></div>
        ${this.status === "ready" ? html`<div class="sc-zoom-panel">
          <button class="sc-zoom-btn" aria-label=${this.#ui.t("map.zoomIn")} @click=${() => this.#map?.zoomIn()}>+</button>
          <input class="sc-zoom-slider-vertical" type="range" min=${String(this.minZoom)} max="2" step="0.25" .value=${String(this.zoom)} aria-label=${this.#ui.t("map.zoom")}
            @input=${(event: Event) => this.#map?.setZoom(Number((event.target as HTMLInputElement).value))} />
          <button class="sc-zoom-btn" aria-label=${this.#ui.t("map.zoomOut")} @click=${() => this.#map?.zoomOut()}>−</button>
          <button class="sc-zoom-btn sc-zoom-readout-btn" aria-label=${this.#ui.t("map.actualSize")} @click=${() => this.#map?.setZoom(0)}>${(2 ** this.zoom).toFixed(2)}×</button>
        </div>` : html`<div class="sc-map-state" role="status">${this.#ui.t(this.status === "loading" ? "map.loading" : this.status === "empty" ? "map.empty" : this.status === "missing" ? "map.missing" : "map.failed")}
          ${this.status === "error" ? html`<button class="sc-btn" @click=${() => void this.#loadMap()}>${this.#ui.t("shell.tryAgain")}</button>` : nothing}
        </div>`}
        ${this.eventsVisible && this.status === "ready" ? html`<aside class="sc-legend" aria-label=${this.#ui.t("map.eventPaths")}>
          <div class="legend-title">${this.#ui.t("map.eventPaths")}</div>
          <div class="legend-item"><span class="legend-line" style=${`border-color:${eventPathColors.path}`}></span>${this.#ui.t("map.storyPath")}</div>
          <div class="legend-item"><span class="sc-event-marker-tiny" style=${`background:${eventPathColors.sitting}`}>S#</span>${this.#ui.t("map.inSession")}</div>
          <div class="legend-item"><span class="sc-event-marker-tiny" style=${`background:${eventPathColors.past}`}>✦</span>${this.#ui.t("map.pastEvent")}</div>
          ${mapEventPoints(this.campaign, this.route.parentId).length === 0 ? html`<p class="legend-hint">${this.#ui.t("map.noEvents")}</p>` : nothing}
        </aside>` : nothing}
        ${this.eventDraft !== undefined ? this.#eventPanel() : this.viewDraft !== undefined ? this.#viewPanel() : this.#panel()}
      </div>
    </section>`;
  }
  #eventPanel() {
    const draft = this.eventDraft;
    if (draft === undefined) return nothing;
    return html`<aside class="sc-panel" aria-label=${this.#ui.t("map.eventPosition")}>
      <button class="sc-panel-close" aria-label=${this.#ui.t("map.close")} @click=${this.#closePanel} ?disabled=${this.saving}>✕</button>
      <h2>${draft.name}</h2>
      <a class="sc-btn" href=${recordHash(eventPage, draft.key)}>${this.#ui.t("map.eventArticle")}</a>
      ${draft.x === null ? html`<p>${this.#ui.t("map.placeHint")}</p>` : html`<form @submit=${this.#saveEvent} @input=${this.#eventInput}>
        <label>${this.#ui.t("map.x")}<input name="x" type="number" required step="any" .value=${percent(draft.x)} ?readonly=${this.saving} /></label>
        <label>${this.#ui.t("map.y")}<input name="y" type="number" required step="any" .value=${percent(draft.y)} ?readonly=${this.saving} /></label>
        <button class="sc-btn" type="submit" ?disabled=${this.saving}>${this.#ui.t("dashboard.save")}</button>
        <button class="sc-btn" type="button" ?disabled=${this.saving} @click=${() => { this.eventDraft = { ...draft, x: null, y: null }; }}>${this.#ui.t("map.chooseEventPosition")}</button>
      </form>`}
      <button class="sc-btn" type="button" @click=${this.#closePanel} ?disabled=${this.saving}>${this.#ui.t("dashboard.cancel")}</button>
      ${draft.hadPin ? html`<button class="sc-btn" type="button" @click=${this.#removeEvent} ?disabled=${this.saving}>${this.#ui.t("map.removeEvent")}</button>` : nothing}
    </aside>`;
  }
  #viewPanel() {
    const draft = this.viewDraft;
    if (draft === undefined) return nothing;
    return html`<aside class="sc-panel" aria-label=${this.#ui.t("map.savedView")}>
      <button class="sc-panel-close" aria-label=${this.#ui.t("map.close")} @click=${this.#closePanel} ?disabled=${this.saving}>✕</button>
      <form @submit=${this.#saveView} @input=${this.#viewInput}>
        <h2>${this.#ui.t("map.savedView")}</h2>
        <label>${this.#ui.t("map.viewName")}<input name="label" required maxlength="200" .value=${draft.label} ?readonly=${this.saving} /></label>
        <label>${this.#ui.t("map.viewIcon")}<input name="icon" maxlength="32" .value=${draft.icon} ?readonly=${this.saving} /></label>
        <p class="sc-view-bounds">${this.#ui.t("map.viewBounds", { x1: percent(draft.bounds.x1, 1), y1: percent(draft.bounds.y1, 1), x2: percent(draft.bounds.x2, 1), y2: percent(draft.bounds.y2, 1) })}</p>
        <button class="sc-btn" type="button" ?disabled=${this.saving || this.status !== "ready"} @click=${this.#captureView}>${this.#ui.t("map.captureView")}</button>
        <button class="sc-btn" type="button" ?disabled=${this.status !== "ready"} @click=${() => this.#fitView(draft.bounds)}>${this.#ui.t("map.previewView")}</button>
        <div><button class="sc-btn" type="submit" ?disabled=${this.saving}>${this.#ui.t("dashboard.save")}</button>
          <button class="sc-btn" type="button" @click=${this.#closePanel} ?disabled=${this.saving}>${this.#ui.t("dashboard.cancel")}</button></div>
        ${draft.action === "create" ? nothing : html`<button class="sc-btn" type="button" @click=${this.#deleteView} ?disabled=${this.saving}>${this.#ui.t("map.deleteView")}</button>`}
      </form>
    </aside>`;
  }
  #panel() {
    if (this.campaign === undefined || (this.selected === undefined && this.draft === undefined && this.placing === null)) return nothing;
    const record = this.selected === undefined ? undefined : mapLocationRecord(this.campaign, this.selected);
    const value = recordValue(record);
    const definitions = mapDetailFields();
    const typeField = definitions.find(field => field.key === "pinType")!;
    const markerType = editorOptionsFor(this.campaign, typeField, record?.key ?? "").find(option => option.value === value["pinType"])?.label;
    const attitudes = projectEffectiveAttitudes(this.campaign, "locations", value);
    const draftValue = { ...this.#detailValue, ...this.draft?.fields };
    if (Array.isArray(this.draft?.fields?.["attitudes"])) draftValue["attitudes"] = (this.draft.fields["attitudes"] as string[]).map(id => ({ id }));
    return html`<aside class=${this.draft === undefined ? "sc-panel" : "sc-panel sc-location-editor"} aria-label=${this.#ui.t("map.location")}>
      <button class="sc-panel-close" aria-label=${this.#ui.t("map.close")} @click=${this.#closePanel} ?disabled=${this.saving}>✕</button>
      ${this.draft === undefined ? html`
        <h2>${text(value["name"]) || this.#ui.t("map.add")}</h2>
        ${this.placing !== null ? html`<p>${this.#ui.t("map.placeHint")}</p>` : nothing}
        ${record === undefined ? nothing : html`
          ${markerType ? html`<p class="sc-marker-type">${typeField.label}: ${markerType}</p>` : nothing}
          ${attitudes.length ? html`<p class="sc-marker-attitudes">${attitudes.map(attitude => html`<span class="attitude-badge" style=${`--attitude-color: ${attitude.color}`}>${attitude.label}</span>`)}</p>` : nothing}
          <p>${text(value["mapNotes"])}</p>
          <a class="sc-btn" href=${recordHash(locationPage, record.key)}>${this.#ui.t("map.article")}</a>
          ${safeMediaURL(value["localMap"]) === undefined ? nothing : html`<a class="sc-btn" href=${mapHash(record.key)}>${this.#ui.t("map.local")}</a>`}
          ${this.editing ? html`<button class="sc-btn" @click=${() => this.#editSelected()}>${this.#ui.t("map.editLocation")}</button>` : nothing}
        `}
      ` : html`<form @submit=${this.#saveLocation} @input=${this.#draftInput}>
        <div class="sc-detail-body">
        <h2>${this.draft.expectedRevision === 0 ? this.#ui.t("map.add") : text(this.#detailValue["name"])}</h2>
        ${record === undefined && this.draft.expectedRevision > 0 ? html`<p role="alert">${this.#ui.t("map.missingDraft")}</p>` : nothing}
        ${this.draft.expectedRevision === 0 ? html`<label>${this.#ui.t("map.name")}<input name="name" required maxlength="200" .value=${this.draft.name ?? ""} ?readonly=${this.saving} /></label>` : nothing}
        <fieldset class="sc-detail-fields" ?disabled=${this.saving}>
          <legend class="visually-hidden">${this.#ui.t("map.editLocation")}</legend>
          ${definitions.filter(field => field.key !== "size").map(field => recordFieldControl(this.#detailCampaign ?? this.campaign!, field, draftValue, this.draft!.key))}
          <details class="sc-marker-details"><summary>${this.#ui.t("map.markerDetails")}</summary>
            ${definitions.filter(field => field.key === "size").map(field => recordFieldControl(this.#detailCampaign ?? this.campaign!, field, draftValue, this.draft!.key))}
          </details>
        </fieldset>
        <label>${this.#ui.t("map.x")}<input name="x" type="number" required step="any" .value=${percent(this.draft.x)} ?readonly=${this.saving} /></label>
        <label>${this.#ui.t("map.y")}<input name="y" type="number" required step="any" .value=${percent(this.draft.y)} ?readonly=${this.saving} /></label>
        </div>
        <div class="sc-detail-actions">
          <button class="sc-btn" type="submit" ?disabled=${this.saving}>${this.#ui.t("dashboard.save")}</button>
          <button class="sc-btn" type="button" @click=${this.#closePanel} ?disabled=${this.saving}>${this.#ui.t("dashboard.cancel")}</button>
          ${this.draft.expectedRevision === 0 ? nothing : html`<button class="sc-btn" type="button" @click=${this.#removePin} ?disabled=${this.saving}>${this.#ui.t("map.removePin")}</button>`}
        </div>
      </form>`}
    </aside>`;
  }
  async #loadMap(): Promise<void> {
    const previous = this.#map === undefined ? undefined : { url: this.#imageURL, center: this.#map.getCenter(), zoom: this.#map.getZoom() };
    this.#dispose();
    if (this.campaign === undefined || this.route === undefined || !this.isConnected) return;
    const request = new AbortController(); this.#request = request;
    this.status = "loading";
    try {
      if (this.route.parentId !== null && mapLocationRecord(this.campaign, this.route.parentId) === undefined) { this.status = "missing"; return; }
      const url = this.route.parentId === null ? (await this.#media.latest("world-map", "main", request.signal)).url : this.#localImage();
      this.#imageURL = url;
      if (url === undefined) { this.status = "empty"; return; }
      const tiles = await this.#media.mapTiles(url, request.signal).catch(cause => {
        if (request.signal.aborted) throw cause;
        return undefined;
      });
      const image = tiles === undefined ? await loadImage(url, request.signal) : undefined;
      await this.updateComplete;
      if (request.signal.aborted || !this.isConnected) return;
      this.#width = tiles?.width ?? image!.naturalWidth; this.#height = tiles?.height ?? image!.naturalHeight;
      const container = this.querySelector<HTMLElement>(".sc-map")!;
      const map = L.map(container, { crs: L.CRS.Simple, minZoom: -8, maxZoom: 2, zoomSnap: .25, zoomDelta: .5, wheelPxPerZoomLevel: 120,
        zoomControl: false, attributionControl: false, zoomAnimation: false });
      this.#map = map;
      if (tiles === undefined) L.imageOverlay(previewResourceURL(url), this.#bounds()).addTo(map);
      else {
        const layer = L.tileLayer(previewResourceURL(`${url}/tiles/v1/{z}/{x}/{y}`), {
          tileSize: tiles.tileSize, noWrap: true, bounds: this.#bounds(), minZoom: -8, maxZoom: 2,
          minNativeZoom: -tiles.depth, maxNativeZoom: 0, zoomOffset: tiles.depth,
        });
        layer.on("tileloadstart", (event: L.TileEvent) => {
          // v1 tiles include one real source pixel of right/bottom overlap.
          event.tile.style.width = `${tiles.tileSize + 1}px`; event.tile.style.height = `${tiles.tileSize + 1}px`;
        });
        let fallingBack = false;
        layer.on("tileerror", () => {
          if (fallingBack || request.signal.aborted) return;
          fallingBack = true;
          // A broken/evicted cache must not leave a partially blank map. Keep
          // this viewport and its edits while loading the immutable original.
          void loadImage(url, request.signal).then(() => {
            if (request.signal.aborted) return;
            L.imageOverlay(previewResourceURL(url), this.#bounds()).addTo(map); layer.remove();
          }).catch(() => { if (!request.signal.aborted) this.status = "error"; });
        });
        layer.addTo(map);
      }
      this.#layers = L.layerGroup().addTo(map);
      this.#eventLayers = L.layerGroup().addTo(map);
      this.#updateFitZoom();
      if (previous?.url === url) map.setView(previous.center, previous.zoom);
      else map.fitBounds(this.#bounds());
      map.on("zoomend", () => { this.zoom = map.getZoom(); this.#applyMarkerScale(); });
      map.on("click", (event: L.LeafletMouseEvent) => this.#mapClick(event.latlng));
      this.#resize = new ResizeObserver(() => { map.invalidateSize({ pan: false }); this.#updateFitZoom(); });
      this.#resize.observe(container);
      this.zoom = map.getZoom(); this.status = "ready";
      this.#applyRouteTarget();
      this.#renderMarkers();
      this.#renderEvents();
    } catch (cause) {
      if (!request.signal.aborted) this.status = cause instanceof MediaHTTPError && cause.status === 404 ? "empty" : "error";
    }
  }
  #dispose(): void {
    this.#request?.abort(); this.#resize?.disconnect(); this.#map?.remove();
    this.#map = undefined; this.#layers = undefined; this.#eventLayers = undefined;
    this.#dragging = false;
  }
  #bounds(): L.LatLngBounds { return L.latLngBounds([-this.#height, 0], [0, this.#width]); }
  #point(x: number, y: number): L.LatLng { return L.latLng(-y * this.#height, x * this.#width); }
  #updateFitZoom(): void {
    if (this.#map === undefined) return;
    const size = this.#map.getSize();
    if (size.x <= 0 || size.y <= 0) return;
    const wasFit = this.#map.getZoom() <= this.minZoom;
    // Compute independently of the current minZoom so shrinking a viewport can lower the limit again.
    this.minZoom = Math.max(-8, Math.min(2, Math.floor(Math.log2(Math.min(size.x / this.#width, size.y / this.#height)) * 4) / 4));
    this.#map.setMinZoom(this.minZoom);
    // Responsive layout can resize the canvas more than once; keep a fitted map fitted throughout.
    if (wasFit) this.#map.fitBounds(this.#bounds(), { animate: false });
  }
  #applyMarkerScale(): void {
    if (this.#map === undefined || this.campaign === undefined || this.route === undefined) return;
    const scale = mapMarkerScale(this.#map.getZoom(), mapZoomScaleRatio(this.campaign, this.route.parentId));
    this.querySelectorAll<HTMLElement>(".sc-pin").forEach(pin => pin.style.setProperty("--sc-pin-base-scale", String(scale)));
  }
  #renderMarkers(): void {
    if (this.campaign === undefined || this.route === undefined || this.#layers === undefined || this.#dragging) return;
    this.#layers.clearLayers();
    for (const location of mapLocations(this.campaign, this.route.parentId)) {
      const draft = this.draft?.key === location.key ? this.draft : undefined;
      const node = document.createElement("span"); node.className = "sc-pin";
      node.setAttribute("aria-hidden", "true");
      const layers = markerGlowLayers(location.attitudes, location.markerSize, Boolean(location.markerIcon));
      for (const layer of layers) {
        const visual = location.markerIcon ? document.createElement("img") : document.createElement("span");
        visual.className = `sc-pin-${location.markerIcon ? "icon" : "emoji"}${layers.length > 1 ? "-segment" : ""}`;
        visual.style.filter = layer.filter; visual.style.clipPath = layer.clipPath;
        if (visual instanceof HTMLImageElement) { visual.src = previewResourceURL(location.markerIcon); visual.alt = ""; visual.draggable = false; }
        else { visual.textContent = location.markerGlyph; visual.style.fontSize = `${Math.round(location.markerSize * .85)}px`; }
        node.append(visual);
      }
      const marker = L.marker(this.#point(draft?.x ?? location.x, draft?.y ?? location.y), {
        icon: L.divIcon({ html: node, className: "sc-marker", iconSize: [location.markerSize, location.markerSize], iconAnchor: [location.markerSize / 2, location.markerSize / 2] }),
        title: location.name, alt: location.name, keyboard: true,
        draggable: this.editing && this.canEdit && !this.saving && this.viewDraft === undefined && this.eventDraft === undefined && (!this.#dirty || this.draft?.key === location.key),
      }).addTo(this.#layers);
      const label = document.createElement("span"); label.textContent = location.name;
      marker.bindTooltip(label);
      bindMarkerAction(marker, () => this.#select(location));
      marker.on("dragstart", () => {
        if (this.#dirty && this.draft?.key !== location.key) { marker.dragging?.disable(); return; }
        this.#dragging = true;
        this.#editLocation(location.key);
      });
      marker.on("dragend", () => {
        this.#dragging = false;
        if (this.draft?.key !== location.key) { this.#renderMarkers(); return; }
        const point = marker.getLatLng();
        this.draft = { ...this.draft, x: point.lng / this.#width, y: -point.lat / this.#height };
        this.#setDirty(true);
      });
    }
    if (this.draft?.expectedRevision === 0 && this.draft.x !== null && this.draft.y !== null) {
      L.circleMarker(this.#point(this.draft.x, this.draft.y), { radius: 9, color: "#c8a040" }).addTo(this.#layers);
    }
    if (this.eventDraft !== undefined && !this.eventDraft.hadPin && this.eventDraft.x !== null && this.eventDraft.y !== null) {
      L.circleMarker(this.#point(this.eventDraft.x, this.eventDraft.y), { radius: 14, color: eventPathColors.path, className: "sc-event-draft" }).addTo(this.#layers);
    }
    this.#applyMarkerScale();
  }
  #renderEvents(): void {
    if (this.#dragging) return;
    this.#eventLayers?.clearLayers();
    if (!this.eventsVisible || this.campaign === undefined || this.route === undefined || this.#eventLayers === undefined) return;
    const points = mapEventPoints(this.campaign, this.route.parentId);
    points.forEach((point, index) => {
      const previous = points[index - 1];
      if (previous !== undefined && (previous.x !== point.x || previous.y !== point.y)) {
        L.polyline([this.#point(previous.x, previous.y), this.#point(point.x, point.y)], {
          color: eventPathColors.path, weight: 2.5, opacity: .75, dashArray: "7, 5", interactive: false, className: "sc-event-path",
        }).addTo(this.#eventLayers!);
      }
      const node = document.createElement("span"); node.className = "sc-event-marker";
      node.style.background = point.sitting ? eventPathColors.sitting : eventPathColors.past;
      const label = document.createElement("span"); label.className = "sc-event-marker-label";
      label.textContent = point.sitting ? `S${point.sitting}` : "✦"; node.append(label);
      const value = recordValue(mapEventRecord(this.campaign!, point.key));
      const ownPin = hasEventPin(value) && eventMapParent(value) === this.route!.parentId;
      const draft = ownPin && this.eventDraft?.key === point.key ? this.eventDraft : undefined;
      const marker = L.marker(this.#point(draft?.x ?? point.x, draft?.y ?? point.y), {
        icon: L.divIcon({ html: node, className: "sc-event-pin", iconSize: [28, 28], iconAnchor: [14, 14] }),
        title: point.name, alt: point.name, keyboard: true, zIndexOffset: 500,
        draggable: ownPin && this.editing && this.canEdit && !this.saving && this.draft === undefined && this.viewDraft === undefined &&
          (this.eventDraft === undefined || (this.eventDraft.key === point.key && this.eventDraft.x !== null)),
      }).addTo(this.#eventLayers!);
      const tooltip = document.createElement("span"); tooltip.textContent = point.name; marker.bindTooltip(tooltip);
      bindMarkerAction(marker, () => {
        if (this.editing && this.canEdit) this.#openEvent(point.key, false, point);
        else window.location.hash = recordHash(eventPage, point.key);
      });
      marker.on("dragstart", () => {
        this.#dragging = true;
        if (this.eventDraft?.key !== point.key) this.#openEvent(point.key, false, point);
      });
      marker.on("dragend", () => {
        this.#dragging = false;
        if (this.eventDraft?.key !== point.key) { this.#renderEvents(); return; }
        const position = marker.getLatLng();
        this.eventDraft = { ...this.eventDraft, x: position.lng / this.#width, y: -position.lat / this.#height };
        this.#setDirty(true);
      });
    });
  }
  #applyRouteTarget(): void {
    if (!this.#routeTargetPending || this.campaign === undefined || this.route === undefined || this.#map === undefined) return;
    this.#routeTargetPending = false;
    const location = this.route.location;
    if (location !== undefined) {
      const record = mapLocationRecord(this.campaign, location.key);
      if (record === undefined || mapParent(recordValue(record)) !== this.route.parentId) { this.locationUnavailable = true; return; }
      const point = mapLocations(this.campaign, this.route.parentId).find(point => point.key === location.key);
      if (point !== undefined) { this.#map.setView(this.#point(point.x, point.y), 0); this.#select(point); }
      if (location.mode === "place" && this.canEdit) { this.editing = true; this.#place(location.key); }
      else if (point === undefined) this.locationUnavailable = true;
      return;
    }
    const target = this.route.event;
    if (target === undefined) return;
    this.eventsVisible = true;
    const record = mapEventRecord(this.campaign, target.key);
    if (record === undefined) { this.eventUnavailable = true; return; }
    const point = mapEventPoints(this.campaign, this.route.parentId).find(point => point.key === target.key);
    if (point !== undefined) this.#map.setView(this.#point(point.x, point.y), 0);
    if (target.mode === "place" && this.canEdit) {
      this.editing = true; this.#openEvent(target.key, true);
    } else if (point === undefined) this.eventUnavailable = true;
  }
  #openEvent(key: string, choosePosition: boolean, point?: MapEventPoint): void {
    if (this.campaign === undefined || this.route === undefined || !this.canEdit || this.saving) return;
    if (this.eventDraft?.key === key && !choosePosition) return;
    const record = mapEventRecord(this.campaign, key), value = recordValue(record);
    const hadPin = hasEventPin(value);
    if (record === undefined || (hadPin && eventMapParent(value) !== this.route.parentId)) { this.eventUnavailable = true; return; }
    if (!this.#discard()) return;
    this.draft = undefined; this.viewDraft = undefined; this.selected = undefined; this.placing = null;
    this.eventUnavailable = false; this.eventsVisible = true;
    this.eventDraft = { kind: "event", key, name: text(value["name"]) || key, hadPin, expectedRevision: record.revision, parentId: this.route.parentId,
      x: choosePosition ? null : hadPin && mapCoordinate(value["mapX"]) ? value["mapX"] : point?.x ?? null,
      y: choosePosition ? null : hadPin && mapCoordinate(value["mapY"]) ? value["mapY"] : point?.y ?? null };
  }
  readonly #eventInput = (event: Event): void => {
    if (this.eventDraft === undefined || this.saving) return;
    const input = event.target as HTMLInputElement;
    if ((input.name === "x" || input.name === "y") && input.value !== "" && input.validity.valid) {
      this.eventDraft = { ...this.eventDraft, [input.name]: Number(input.value) / 100 };
    }
    this.#setDirty(true);
  };
  readonly #saveEvent = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.eventDraft !== undefined && this.eventDraft.x !== null && this.eventDraft.y !== null && !this.saving) this.#emitSave(this.eventDraft);
  };
  readonly #removeEvent = (): void => {
    if (this.eventDraft?.hadPin && !this.saving) this.#emitSave({ ...this.eventDraft, x: null, y: null });
  };
  readonly #toggleEvents = (): void => {
    this.eventsVisible = !this.eventsVisible;
    if (!this.eventsVisible || this.campaign === undefined || this.route === undefined || this.#map === undefined) return;
    const played = mapEventPoints(this.campaign, this.route.parentId).filter(point => point.sitting > 0);
    if (played.length) this.#map.fitBounds(L.latLngBounds(played.map(point => this.#point(point.x, point.y))), { maxZoom: 0, padding: [30, 30] });
    else this.#fit();
  };
  #select(location: MapLocation, pan = false): void {
    if (!this.#discard()) return;
    this.draft = undefined; this.viewDraft = undefined; this.eventDraft = undefined; this.placing = null; this.selected = location.key; this.query = "";
    if (pan) this.#map?.panTo(this.#point(location.x, location.y));
  }
  #editLocation(key: string): void {
    if (this.campaign === undefined || this.route === undefined || !this.canEdit || this.saving) return;
    if (this.draft?.key === key) return;
    const record = mapLocationRecord(this.campaign, key); if (record === undefined) return;
    const value = recordValue(record);
    this.placing = null; this.#placementBase = undefined;
    this.#detailCampaign = this.campaign; this.#detailValue = value;
    this.selected = key;
    this.draft = { kind: "location", key, expectedRevision: record.revision, parentId: this.route.parentId,
      x: mapCoordinate(value["x"]) ? value["x"] : 0, y: mapCoordinate(value["y"]) ? value["y"] : 0 };
  }
  #editSelected(): void { if (this.selected !== undefined) this.#editLocation(this.selected); }
  #place(key: string): void {
    if (!this.canEdit || this.campaign === undefined || this.route === undefined || this.saving) return;
    const record = mapLocationRecord(this.campaign, key);
    if (key && (record === undefined || mapParent(recordValue(record)) !== this.route.parentId)) { this.locationUnavailable = true; return; }
    if (!this.#discard()) return;
    this.locationUnavailable = false;
    this.#detailCampaign = this.campaign; this.#detailValue = record ? recordValue(record) : { pinType: "custom", attitudes: [] };
    this.#placementBase = record === undefined ? undefined : { key, revision: record.revision };
    this.draft = undefined; this.viewDraft = undefined; this.eventDraft = undefined; this.selected = key || undefined; this.placing = key;
  }
  #mapClick(point: L.LatLng): void {
    if (!this.canEdit || !this.editing || this.saving || this.route === undefined) return;
    const x = point.lng / this.#width, y = -point.lat / this.#height;
    if (!mapCoordinate(x) || !mapCoordinate(y)) return;
    if (this.eventDraft?.x === null) {
      this.eventDraft = { ...this.eventDraft, x, y }; this.#setDirty(true); return;
    }
    if (this.placing === null) return;
    if (this.placing) {
      if (this.#placementBase?.key !== this.placing) return;
      this.draft = { kind: "location", key: this.placing, expectedRevision: this.#placementBase.revision, parentId: this.route.parentId, x, y };
    }
    else this.draft = { kind: "location", key: createCampaignRecordKey("location"), name: "", expectedRevision: 0, parentId: this.route.parentId, x, y };
    if (this.draft !== undefined) this.draft = { ...this.draft, x, y };
    this.placing = null; this.#setDirty(true);
  }
  readonly #draftInput = (event: Event): void => {
    if (this.draft === undefined || this.saving) return;
    const input = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (input instanceof HTMLInputElement && input.type === "number" && !input.validity.valid) { this.#setDirty(true); return; }
    if (input.name === "name") this.draft = { ...this.draft, name: input.value };
    if (mapDetailFields().some(field => field.key === input.name)) {
      const value = input instanceof HTMLSelectElement && input.multiple ? [...input.selectedOptions].map(option => option.value) : input.value;
      this.draft = { ...this.draft, fields: { ...this.draft.fields, [input.name]: value } };
    }
    if ((input.name === "x" || input.name === "y") && input.value !== "" && input.validity.valid) this.draft = { ...this.draft, [input.name]: Number(input.value) / 100 };
    this.#setDirty(true);
  };
  readonly #saveLocation = (event: SubmitEvent): void => { event.preventDefault(); if (this.draft !== undefined && !this.saving) this.#emitSave(this.draft); };
  readonly #removePin = (): void => { if (this.draft !== undefined && !this.saving && this.querySelector<HTMLFormElement>(".sc-panel form")?.reportValidity()) this.#emitSave({ ...this.draft, x: null, y: null }); };
  #emitSave(detail: MapSaveDetail): void { this.dispatchEvent(new CustomEvent("campaign-map-save", { detail, bubbles: true, composed: true })); }
  readonly #closePanel = (): void => { if (this.#discard()) { this.draft = undefined; this.viewDraft = undefined; this.eventDraft = undefined; this.selected = undefined; this.placing = null; } };
  readonly #toggleEditing = (): void => { if (this.#discard()) { this.editing = !this.editing; this.draft = undefined; this.viewDraft = undefined; this.eventDraft = undefined; this.placing = null; } };
  #discard(): boolean {
    if (this.saving || !confirmDiscardUnsavedEdit(this.#dirty, message => window.confirm(message))) return false;
    this.#detailCampaign = undefined; this.#detailValue = {};
    this.#setDirty(false); this.viewBoundsUnavailable = false; return true;
  }
  #setDirty(dirty: boolean): void { this.#dirty = dirty; this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty }, bubbles: true, composed: true })); }
  readonly #fit = (): void => { this.#map?.fitBounds(this.#bounds()); };
  #fitView(bounds: MapBounds): void { this.#map?.fitBounds(L.latLngBounds(this.#point(bounds.x1, bounds.y1), this.#point(bounds.x2, bounds.y2))); }
  #currentViewBounds(): MapBounds | undefined {
    if (this.#map === undefined) return undefined;
    const bounds = this.#map.getBounds();
    const result = { x1: clamp(bounds.getWest() / this.#width), y1: clamp(-bounds.getNorth() / this.#height),
      x2: clamp(bounds.getEast() / this.#width), y2: clamp(-bounds.getSouth() / this.#height) };
    this.viewBoundsUnavailable = !validBounds(result);
    return this.viewBoundsUnavailable ? undefined : result;
  }
  #openView(view?: MapView): void {
    if (this.campaign === undefined || this.route === undefined || !this.canManageCampaign || this.saving) return;
    const bounds = view?.bounds ?? this.#currentViewBounds();
    if (bounds === undefined || !this.#discard()) return;
    this.draft = undefined; this.eventDraft = undefined; this.selected = undefined; this.placing = null;
    this.viewDraft = { kind: "view", action: view === undefined ? "create" : "update", id: view?.id ?? createCampaignRecordKey("view"),
      label: view?.label ?? "", icon: view?.icon ?? "📍", expectedRevision: mapViewRecord(this.campaign)?.revision ?? 0, parentId: this.route.parentId, bounds };
    this.#setDirty(view === undefined);
    void this.updateComplete.then(() => this.querySelector<HTMLInputElement>('.sc-panel input[name="label"]')?.focus());
  }
  readonly #viewInput = (event: Event): void => {
    if (this.viewDraft === undefined || this.saving) return;
    const input = event.target as HTMLInputElement;
    if (input.name === "label" || input.name === "icon") { this.viewDraft = { ...this.viewDraft, [input.name]: input.value }; this.#setDirty(true); }
  };
  readonly #captureView = (): void => {
    if (this.viewDraft === undefined || this.saving) return;
    const bounds = this.#currentViewBounds();
    if (bounds !== undefined) { this.viewDraft = { ...this.viewDraft, bounds }; this.#setDirty(true); }
  };
  readonly #saveView = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.viewDraft !== undefined && !this.saving) this.#emitSave(this.viewDraft);
  };
  readonly #deleteView = (): void => {
    if (this.viewDraft === undefined || this.saving || !window.confirm(this.#ui.t("map.deleteViewConfirm", { name: this.viewDraft.label }))) return;
    this.#emitSave({ kind: "view", action: "delete", id: this.viewDraft.id, parentId: this.viewDraft.parentId, expectedRevision: this.viewDraft.expectedRevision });
  };
  readonly #upload = (event: Event): void => {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    if (file !== undefined && this.campaign !== undefined && this.route !== undefined && !this.saving) {
      const detail: MapUploadDetail = { file, parentId: this.route.parentId,
        expectedRevision: this.route.parentId === null ? 0 : mapLocationRecord(this.campaign, this.route.parentId)?.revision ?? 0 };
      this.dispatchEvent(new CustomEvent("campaign-map-upload", { detail, bubbles: true, composed: true }));
    }
    input.value = "";
  };
}
function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function percent(value: number | null, digits = 6): string { return String(Number(((value ?? 0) * 100).toFixed(digits))); }
function bindMarkerAction(marker: L.Marker, action: () => void): void {
  marker.on("click", action);
  // Leaflet makes divIcon markers focusable; custom click actions still need key activation.
  marker.on("keydown", (event: L.LeafletKeyboardEvent) => {
    if (event.originalEvent.key === "Enter" || event.originalEvent.key === " ") { L.DomEvent.stop(event.originalEvent); action(); }
  });
}
function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); image.src = ""; reject(signal.reason); };
    image.onload = () => { cleanup(); image.naturalWidth && image.naturalHeight ? resolve(image) : reject(new Error(uiText("Empty image"))); };
    image.onerror = () => { cleanup(); reject(new Error(uiText("Image unavailable"))); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else image.src = previewResourceURL(url);
  });
}
if (!customElements.get("codex-map")) customElements.define("codex-map", CodexMap);
