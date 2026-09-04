import { LitElement, html, nothing } from "lit";
import * as L from "leaflet";
import type { CampaignDataset } from "../core/campaign-data.js";
import { MediaClient, MediaHTTPError } from "../core/media.js";
import { createCampaignRecordKey } from "./campaign-record-editor.js";
import { recordValue, safeMediaURL, text } from "./campaign-projection.js";
import { mapLocationRecord, mapLocations, mapViews, mapViewRecord, mapParent, locationPage, mapCoordinate,
  type MapSaveDetail, type MapUploadDetail, type MapBounds, type MapLocation } from "./campaign-map.js";
import { campaignCollection } from "../core/campaign-data.js";
import { mapHash, recordHash, type AppRoute } from "./routes.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";

type MapRoute = Extract<AppRoute, { kind: "map" }>;
type LocationDraft = Extract<MapSaveDetail, { kind: "location" }>;

export class CodexMap extends LitElement {
  static override properties = {
    campaign: { attribute: false }, route: { attribute: false }, canEdit: { type: Boolean },
    canManageCampaign: { type: Boolean }, saving: { type: Boolean }, editCompletion: { type: Number },
    errorMessage: { type: String }, editing: { state: true }, placing: { state: true }, draft: { state: true },
    selected: { state: true }, query: { state: true }, status: { state: true }, zoom: { state: true },
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
  #map: L.Map | undefined;
  #layers: L.LayerGroup | undefined;
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
  }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void { this.#dispose(); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("route") || changed.has("editCompletion") || (changed.has("canEdit") && !this.canEdit)) {
      this.draft = undefined; this.placing = null; this.#setDirty(false);
    }
    if (changed.has("route")) { this.selected = undefined; this.query = ""; this.editing = false; }
  }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("route") || changed.has("editCompletion") ||
      (changed.has("campaign") && this.route?.parentId !== null && this.#localImage() !== this.#imageURL)) {
      void this.#loadMap();
    } else if (["campaign", "draft", "editing", "saving"].some(key => changed.has(key))) this.#renderMarkers();
  }
  #localImage(): string | undefined {
    return this.campaign !== undefined && this.route?.parentId
      ? safeMediaURL(recordValue(mapLocationRecord(this.campaign, this.route.parentId))["localMap"]) : undefined;
  }
  protected override render() {
    if (this.campaign === undefined || this.route === undefined) return nothing;
    const parent = this.route.parentId === null ? undefined : mapLocationRecord(this.campaign, this.route.parentId);
    const locations = mapLocations(this.campaign, this.route.parentId);
    const results = this.query.trim() === "" ? [] : locations.filter(location => location.name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase()));
    const unplaced = campaignCollection(this.campaign, "locations").records.filter(record => {
      const value = recordValue(record);
      return mapParent(value) === this.route!.parentId && (!mapCoordinate(value["x"]) || !mapCoordinate(value["y"]));
    });
    return html`<section class="sc-shell" aria-label=${this.#ui.t("map.world")}>
      <header class="sc-toolbar">
        <h1 class="sc-title">🗺 ${parent === undefined ? this.#ui.t("map.world") : text(recordValue(parent)["name"])}</h1>
        ${parent === undefined ? nothing : html`<a class="sc-btn" href=${mapHash(null)}>↩ ${this.#ui.t("map.world")}</a>`}
        <div class="sc-search-wrap"><input class="sc-search" type="search" aria-label=${this.#ui.t("map.search")}
          placeholder=${this.#ui.t("map.search")} .value=${this.query} @input=${(event: Event) => { this.query = (event.target as HTMLInputElement).value; }} />
          ${this.query === "" ? nothing : html`<div class="sc-search-results">${results.length === 0 ? this.#ui.t("map.noResults") : results.map(location => html`
            <button type="button" @click=${() => this.#select(location, true)}>${location.name}</button>`)}</div>`}
        </div>
        <button class="sc-btn" @click=${this.#fit} ?disabled=${this.status !== "ready"}>🌐 ${this.#ui.t("map.fit")}</button>
        ${mapViews(this.campaign, this.route.parentId).map(view => html`<button class="sc-btn" ?disabled=${this.status !== "ready"}
          @click=${() => this.#fitView(view.bounds)}>${view.icon} ${view.label}</button>`)}
        ${this.editing ? html`
          <button class="sc-btn" ?disabled=${this.saving || this.status !== "ready"} @click=${() => this.#place("")}>＋ ${this.#ui.t("map.add")}</button>
          ${unplaced.length === 0 ? nothing : html`<select class="sc-btn" aria-label=${this.#ui.t("map.placeExisting")} ?disabled=${this.saving || this.status !== "ready"}
            @change=${(event: Event) => { const select = event.target as HTMLSelectElement; if (select.value) this.#place(select.value); select.value = ""; }}>
            <option value="">${this.#ui.t("map.placeExisting")}</option>${unplaced.map(record => html`<option value=${record.key}>${text(recordValue(record)["name"]) || record.key}</option>`)}
          </select>`}
          ${this.canManageCampaign ? html`<button class="sc-btn" ?disabled=${this.saving || this.draft !== undefined || this.status !== "ready"} @click=${this.#saveView}>✚ ${this.#ui.t("map.saveView")}</button>` : nothing}
        ` : nothing}
        <span class="sc-hint">${this.placing !== null ? this.#ui.t("map.placeHint") : this.#ui.t("map.panHint")}</span>
        ${this.canEdit ? html`<button class="sc-btn" aria-pressed=${this.editing} ?disabled=${this.saving}
          @click=${this.#toggleEditing}>✏ ${this.#ui.t(this.editing ? "map.done" : "map.edit")}</button>` : nothing}
      </header>
      ${this.errorMessage ? html`<p class="sc-message" role="alert">${this.errorMessage}</p>` : nothing}
      ${this.editing && (this.route.parentId !== null || this.canManageCampaign) ? html`<label class="sc-upload">
        ${this.#ui.t("map.upload")} <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          aria-label=${this.#ui.t("map.upload")} ?disabled=${this.saving || this.draft !== undefined} @change=${this.#upload} />
      </label>` : nothing}
      <div class="sc-stage">
        <div class="sc-map" role="region" aria-label=${this.#ui.t("map.canvas")}></div>
        ${this.status === "ready" ? html`<div class="sc-zoom-panel">
          <button class="sc-zoom-btn" aria-label=${this.#ui.t("map.zoomIn")} @click=${() => this.#map?.zoomIn(.25)}>+</button>
          <input class="sc-zoom-slider-vertical" type="range" min="-8" max="2" step="0.25" .value=${String(this.zoom)} aria-label=${this.#ui.t("map.zoom")}
            @input=${(event: Event) => this.#map?.setZoom(Number((event.target as HTMLInputElement).value))} />
          <button class="sc-zoom-btn" aria-label=${this.#ui.t("map.zoomOut")} @click=${() => this.#map?.zoomOut(.25)}>−</button>
          <button class="sc-zoom-btn sc-zoom-readout-btn" aria-label=${this.#ui.t("map.actualSize")} @click=${() => this.#map?.setZoom(0)}>${(2 ** this.zoom).toFixed(2)}×</button>
        </div>` : html`<div class="sc-map-state" role="status">${this.#ui.t(this.status === "loading" ? "map.loading" : this.status === "empty" ? "map.empty" : this.status === "missing" ? "map.missing" : "map.failed")}
          ${this.status === "error" ? html`<button class="sc-btn" @click=${() => void this.#loadMap()}>${this.#ui.t("shell.tryAgain")}</button>` : nothing}
        </div>`}
        ${this.#panel()}
      </div>
    </section>`;
  }
  #panel() {
    if (this.campaign === undefined || (this.selected === undefined && this.draft === undefined && this.placing === null)) return nothing;
    const record = this.selected === undefined ? undefined : mapLocationRecord(this.campaign, this.selected);
    const value = recordValue(record);
    return html`<aside class="sc-panel" aria-label=${this.#ui.t("map.location")}>
      <button class="sc-panel-close" aria-label=${this.#ui.t("map.close")} @click=${this.#closePanel} ?disabled=${this.saving}>✕</button>
      ${this.draft === undefined ? html`
        <h2>${text(value["name"]) || this.#ui.t("map.add")}</h2>
        ${this.placing !== null ? html`<p>${this.#ui.t("map.placeHint")}</p>` : nothing}
        ${record === undefined ? nothing : html`
          <p>${text(value["mapNotes"])}</p>
          <a class="sc-btn" href=${recordHash(locationPage, record.key)}>${this.#ui.t("map.article")}</a>
          ${safeMediaURL(value["localMap"]) === undefined ? nothing : html`<a class="sc-btn" href=${mapHash(record.key)}>${this.#ui.t("map.local")}</a>`}
          ${this.editing ? html`<button class="sc-btn" @click=${() => this.#editSelected()}>${this.#ui.t("map.position")}</button>` : nothing}
        `}
      ` : html`<form @submit=${this.#saveLocation} @input=${this.#draftInput}>
        <h2>${this.draft.expectedRevision === 0 ? this.#ui.t("map.add") : text(value["name"])}</h2>
        ${this.draft.expectedRevision === 0 ? html`<label>${this.#ui.t("map.name")}<input name="name" required maxlength="200" .value=${this.draft.name ?? ""} ?readonly=${this.saving} /></label>` : nothing}
        <label>${this.#ui.t("map.x")}<input name="x" type="number" required step="any" .value=${percent(this.draft.x)} ?readonly=${this.saving} /></label>
        <label>${this.#ui.t("map.y")}<input name="y" type="number" required step="any" .value=${percent(this.draft.y)} ?readonly=${this.saving} /></label>
        <button class="sc-btn" type="submit" ?disabled=${this.saving}>${this.#ui.t("dashboard.save")}</button>
        <button class="sc-btn" type="button" @click=${this.#closePanel} ?disabled=${this.saving}>${this.#ui.t("dashboard.cancel")}</button>
        ${this.draft.expectedRevision === 0 ? nothing : html`<button class="sc-btn" type="button" @click=${this.#removePin} ?disabled=${this.saving}>${this.#ui.t("map.removePin")}</button>`}
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
      const image = await loadImage(url, request.signal);
      await this.updateComplete;
      if (request.signal.aborted || !this.isConnected) return;
      this.#width = image.naturalWidth; this.#height = image.naturalHeight;
      const container = this.querySelector<HTMLElement>(".sc-map")!;
      const map = L.map(container, { crs: L.CRS.Simple, minZoom: -8, maxZoom: 2, zoomSnap: .25, zoomDelta: .25,
        zoomControl: false, attributionControl: false, zoomAnimation: false });
      this.#map = map;
      L.imageOverlay(url, this.#bounds()).addTo(map);
      this.#layers = L.layerGroup().addTo(map);
      if (previous?.url === url) map.setView(previous.center, previous.zoom);
      else map.fitBounds(this.#bounds());
      map.on("zoomend", () => { this.zoom = map.getZoom(); });
      map.on("click", (event: L.LeafletMouseEvent) => this.#mapClick(event.latlng));
      this.#resize = new ResizeObserver(() => map.invalidateSize({ pan: false }));
      this.#resize.observe(container);
      this.zoom = map.getZoom(); this.status = "ready";
      this.#renderMarkers();
    } catch (cause) {
      if (!request.signal.aborted) this.status = cause instanceof MediaHTTPError && cause.status === 404 ? "empty" : "error";
    }
  }
  #dispose(): void {
    this.#request?.abort(); this.#resize?.disconnect(); this.#map?.remove();
    this.#map = undefined; this.#layers = undefined;
    this.#dragging = false;
  }
  #bounds(): L.LatLngBounds { return L.latLngBounds([-this.#height, 0], [0, this.#width]); }
  #point(x: number, y: number): L.LatLng { return L.latLng(-y * this.#height, x * this.#width); }
  #renderMarkers(): void {
    if (this.campaign === undefined || this.route === undefined || this.#layers === undefined || this.#dragging) return;
    this.#layers.clearLayers();
    for (const location of mapLocations(this.campaign, this.route.parentId)) {
      const draft = this.draft?.key === location.key ? this.draft : undefined;
      const node = document.createElement("span"); node.className = "sc-pin";
      if (location.attitudeFilter) node.style.filter = location.attitudeFilter;
      if (location.markerIcon) { const image = document.createElement("img"); image.src = location.markerIcon; image.alt = ""; node.append(image); }
      else node.textContent = location.markerGlyph;
      const marker = L.marker(this.#point(draft?.x ?? location.x, draft?.y ?? location.y), {
        icon: L.divIcon({ html: node, className: "sc-marker", iconSize: [location.markerSize, location.markerSize], iconAnchor: [location.markerSize / 2, location.markerSize / 2] }),
        title: location.name, alt: location.name, keyboard: true,
        draggable: this.editing && this.canEdit && !this.saving && (!this.#dirty || this.draft?.key === location.key),
      }).addTo(this.#layers);
      const label = document.createElement("span"); label.textContent = location.name;
      marker.bindTooltip(label);
      marker.on("click", () => this.#select(location));
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
  }
  #select(location: MapLocation, pan = false): void {
    if (!this.#discard()) return;
    this.draft = undefined; this.placing = null; this.selected = location.key; this.query = "";
    if (pan) this.#map?.panTo(this.#point(location.x, location.y));
  }
  #editLocation(key: string): void {
    if (this.campaign === undefined || this.route === undefined || !this.canEdit || this.saving) return;
    if (this.draft?.key === key) return;
    const record = mapLocationRecord(this.campaign, key); if (record === undefined) return;
    const value = recordValue(record);
    this.selected = key;
    this.draft = { kind: "location", key, expectedRevision: record.revision, parentId: this.route.parentId,
      x: mapCoordinate(value["x"]) ? value["x"] : 0, y: mapCoordinate(value["y"]) ? value["y"] : 0 };
  }
  #editSelected(): void { if (this.selected !== undefined) this.#editLocation(this.selected); }
  #place(key: string): void {
    if (!this.#discard()) return;
    this.draft = undefined; this.selected = key || undefined; this.placing = key;
  }
  #mapClick(point: L.LatLng): void {
    if (!this.canEdit || !this.editing || this.saving || this.placing === null || this.route === undefined) return;
    const x = point.lng / this.#width, y = -point.lat / this.#height;
    if (!mapCoordinate(x) || !mapCoordinate(y)) return;
    if (this.placing) this.#editLocation(this.placing);
    else this.draft = { kind: "location", key: createCampaignRecordKey("location"), name: "", expectedRevision: 0, parentId: this.route.parentId, x, y };
    if (this.draft !== undefined) this.draft = { ...this.draft, x, y };
    this.placing = null; this.#setDirty(true);
  }
  readonly #draftInput = (event: Event): void => {
    if (this.draft === undefined || this.saving) return;
    const input = event.target as HTMLInputElement;
    if (input.name === "name") this.draft = { ...this.draft, name: input.value };
    if ((input.name === "x" || input.name === "y") && input.value !== "" && input.validity.valid) this.draft = { ...this.draft, [input.name]: Number(input.value) / 100 };
    this.#setDirty(true);
  };
  readonly #saveLocation = (event: SubmitEvent): void => { event.preventDefault(); if (this.draft !== undefined && !this.saving) this.#emitSave(this.draft); };
  readonly #removePin = (): void => { if (this.draft !== undefined && !this.saving) this.#emitSave({ ...this.draft, x: null, y: null }); };
  #emitSave(detail: MapSaveDetail): void { this.dispatchEvent(new CustomEvent("campaign-map-save", { detail, bubbles: true, composed: true })); }
  readonly #closePanel = (): void => { if (this.#discard()) { this.draft = undefined; this.selected = undefined; this.placing = null; } };
  readonly #toggleEditing = (): void => { if (this.#discard()) { this.editing = !this.editing; this.draft = undefined; this.placing = null; } };
  #discard(): boolean {
    if (this.saving || !confirmDiscardUnsavedEdit(this.#dirty, message => window.confirm(message))) return false;
    this.#setDirty(false); return true;
  }
  #setDirty(dirty: boolean): void { this.#dirty = dirty; this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty }, bubbles: true, composed: true })); }
  readonly #fit = (): void => { this.#map?.fitBounds(this.#bounds()); };
  #fitView(bounds: MapBounds): void { this.#map?.fitBounds(L.latLngBounds(this.#point(bounds.x1, bounds.y1), this.#point(bounds.x2, bounds.y2))); }
  readonly #saveView = (): void => {
    if (this.#map === undefined || this.campaign === undefined || this.route === undefined || !this.canManageCampaign || this.saving) return;
    const bounds = this.#map.getBounds();
    const expectedRevision = mapViewRecord(this.campaign)?.revision ?? 0;
    const label = window.prompt(this.#ui.t("map.viewName")); if (!label?.trim()) return;
    this.#emitSave({ kind: "view", id: createCampaignRecordKey(label), label, expectedRevision, parentId: this.route.parentId,
      bounds: { x1: clamp(bounds.getWest() / this.#width), y1: clamp(-bounds.getNorth() / this.#height),
        x2: clamp(bounds.getEast() / this.#width), y2: clamp(-bounds.getSouth() / this.#height) } });
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
function percent(value: number | null): string { return String(Number(((value ?? 0) * 100).toFixed(6))); }
function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); image.src = ""; reject(signal.reason); };
    image.onload = () => { cleanup(); image.naturalWidth && image.naturalHeight ? resolve(image) : reject(new Error("Empty image")); };
    image.onerror = () => { cleanup(); reject(new Error("Image unavailable")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else image.src = url;
  });
}
if (!customElements.get("codex-map")) customElements.define("codex-map", CodexMap);
