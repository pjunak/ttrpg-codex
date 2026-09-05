import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { campaignCollection, type CampaignDataset, type CampaignRecord } from "../core/campaign-data.js";
import { recordValue, stringList, text } from "./campaign-projection.js";
import { timelineColumns, timelineDraft, timelineRecords, timelineSessions, nextTimelineSitting, moveTimelineEvent,
  sameTimelineOrder, type TimelineColumn, type TimelineDraft } from "./campaign-timeline.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { isTimelineSlot, type TimelineSlot } from "./timeline-contributions.js";
import "./codex-timeline-slot.js";

export class CodexTimeline extends LitElement {
  static override properties = {
    campaign: { attribute: false }, canEdit: { type: Boolean }, saving: { type: Boolean }, editCompletion: { type: Number },
    errorMessage: { type: String }, editing: { state: true }, draft: { state: true }, expanded: { state: true },
    dragging: { state: true }, dropTarget: { state: true }, scrollMax: { state: true }, scrollPosition: { state: true },
    registry: { attribute: false }, actorRole: { attribute: false }, addonRevision: { state: true },
  };
  declare campaign: CampaignDataset | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  declare private addonRevision: number;
  #unsubscribe: (() => void) | undefined;
  #slots = new Set<unknown>();
  #liveEventKeys = new Set<string>();
  declare canEdit: boolean;
  declare saving: boolean;
  declare editCompletion: number;
  declare errorMessage: string;
  declare private editing: boolean;
  declare private draft: TimelineDraft | undefined;
  declare private expanded: readonly number[];
  declare private dragging: string | undefined;
  declare private dropTarget: { sitting: number; index: number } | undefined;
  declare private scrollMax: number;
  declare private scrollPosition: number;
  #baseCampaign: CampaignDataset | undefined;
  #dragBase: TimelineDraft | undefined;
  #dragCampaign: CampaignDataset | undefined;
  #resize: ResizeObserver | undefined;
  #dirty = false;
  #lastDrag = { key: "", until: 0 };
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super(); this.campaign = undefined; this.canEdit = false; this.saving = false; this.editCompletion = 0;
    this.errorMessage = ""; this.editing = false; this.draft = undefined; this.expanded = [];
    this.dragging = undefined; this.dropTarget = undefined; this.scrollMax = 0; this.scrollPosition = 0;
    this.registry = undefined; this.actorRole = undefined; this.addonRevision = 0;
  }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#subscribe(); this.addonRevision++; }
  override disconnectedCallback(): void { this.#resize?.disconnect(); this.#resize = undefined; this.#unsubscribe?.(); this.#unsubscribe = undefined; this.#setDirty(false); super.disconnectedCallback(); }
  #subscribe(): void { this.#unsubscribe?.(); this.#unsubscribe = this.isConnected ? this.registry?.subscribe(() => { this.addonRevision++; }) : undefined; }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("registry")) this.#subscribe();
    if (changed.has("editCompletion") || changed.has("canEdit") && !this.canEdit) this.#clearDraft();
    if (!this.canEdit) this.editing = false;
  }
  protected override updated(): void {
    if (!this.isConnected) return;
    const viewport = this.querySelector<HTMLElement>(".tl-board-viewport");
    if (viewport === null) return;
    if (this.#resize === undefined) {
      this.#resize = new ResizeObserver(() => this.#syncScroll()); this.#resize.observe(viewport);
    }
    this.#syncScroll();
  }
  protected override render() {
    const campaign = this.#baseCampaign ?? this.#dragCampaign ?? this.campaign;
    if (campaign === undefined) return nothing;
    const columns = this.draft?.columns ?? this.#dragBase?.columns ?? timelineColumns(campaign);
    const records = new Map(timelineRecords(campaign).map(record => [record.key, record]));
    const sessions = timelineSessions(columns), next = nextTimelineSitting(columns), editableSessions = [...new Set([...sessions, next])];
    const characters = new Map(campaignCollection(campaign, "characters").records.map(record => [record.key, recordValue(record)]));
    const locations = new Map(campaignCollection(campaign, "locations").records.map(record => [record.key, recordValue(record)]));
    const factions = new Map(campaignCollection(campaign, "factions").records.map(record => [record.key, recordValue(record)]));
    this.#liveEventKeys = new Set(this.campaign ? campaignCollection(this.campaign, "events").records.map(record => record.key) : []);
    this.#slots = new Set(this.actorRole ? this.registry?.list("slot", this.actorRole).filter(active => isTimelineSlot(active)).map(active => active.descriptor.config["slot"]) : []);
    return html`<section class=${`tl-shell${this.editing ? " is-editing" : ""}`} aria-label=${this.#ui.t("timeline.title")}>
      <header class="tl-toolbar">
        <h1 class="tl-title">⏳ ${this.#ui.t("timeline.title")}</h1>
        <span class="tl-hint">${this.#ui.t(this.editing ? "timeline.dragHint" : "timeline.hint")}</span>
        ${this.draft === undefined ? nothing : html`
          <button class="tl-add-btn" ?disabled=${this.saving} @click=${this.#save}>${this.#ui.t(this.saving ? "dashboard.saving" : "timeline.save")}</button>
          <button class="tl-add-btn" ?disabled=${this.saving} @click=${this.#cancel}>${this.#ui.t("dashboard.cancel")}</button>`}
        ${this.canEdit ? html`<button class="tl-add-btn" aria-pressed=${this.editing} ?disabled=${this.saving} @click=${this.#toggleEditing}>
          ✎ ${this.#ui.t(this.editing ? "timeline.done" : "timeline.edit")}</button>` : nothing}
        ${this.editing ? html`<a class="tl-add-btn" href="#/timeline/new/1">＋ ${this.#ui.t("timeline.newEvent")}</a>` : nothing}
        ${this.#slot("timeline:toolbar", null, [])}
      </header>
      ${this.errorMessage === "" ? nothing : html`<p class="tl-message" role="alert">${this.errorMessage}</p>`}
      <div class="tl-board-viewport" @scroll=${this.#syncScroll} @wheel=${{ handleEvent: this.#wheel, passive: false }}>
        <div class="tl-board">${repeat(this.editing ? editableSessions : sessions, sitting => sitting, sitting => {
          const ids = columns.find(column => column.sitting === sitting)?.ids ?? [], phantom = sitting === next && !sessions.includes(sitting);
          return html`<section class=${`tl-col tl-col-${phantom ? "phantom" : "sitting"}${ids.length > 4 ? " tl-col-stacked" : ""}${this.expanded.includes(sitting) || this.dropTarget?.sitting === sitting ? " tl-col-expanded" : ""}`}
            data-sitting=${sitting} aria-label=${this.#ui.t(phantom ? "timeline.newSession" : "timeline.session", { n: sitting })}
            @dragover=${(event: DragEvent) => this.#dragOver(event, sitting)} @drop=${(event: DragEvent) => this.#drop(event, sitting)}
            @dragleave=${(event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !(event.currentTarget as Element).contains(event.relatedTarget)) this.dropTarget = undefined; }}>
            <div class="tl-col-header">
              <button class="tl-col-title" ?disabled=${ids.length <= 4 || this.editing} aria-expanded=${this.editing || this.expanded.includes(sitting)}
                @click=${() => { this.expanded = this.expanded.includes(sitting) ? this.expanded.filter(value => value !== sitting) : [...this.expanded, sitting]; }}>
                ${this.#ui.t(phantom ? "timeline.newSession" : "timeline.session", { n: sitting })}</button>
              <span class="tl-col-count">${ids.length || ""}</span>
            </div>
            ${this.#slot("timeline:column:header", sitting, ids.flatMap(key => records.get(key) ?? []))}
            <div class="tl-col-body">
              ${ids.length > 0 || phantom ? nothing : html`<p class="tl-col-empty">${this.#ui.t(this.editing ? "timeline.emptyEditing" : "timeline.empty")}</p>`}
              ${repeat(ids, key => key, (key, index) => {
                const record = records.get(key); if (record === undefined) return nothing;
                const value = recordValue(record), name = text(value["name"]) || key;
                const charIDs = stringList(value["characters"]), locIDs = stringList(value["locations"]);
                const faction = charIDs.map(id => characters.get(id)?.["faction"]).find(id => typeof id === "string" && id !== "neutral" && id !== "");
                const rawColor = typeof faction === "string" ? factions.get(faction)?.["color"] : undefined;
                const color = typeof rawColor === "string" && /^#[a-f0-9]{6}$/iu.test(rawColor) ? rawColor : "#8B6914";
                return html`${key === this.dragging ? nothing : this.#indicator(sitting, ids.slice(0, index).filter(id => id !== this.dragging).length)}
                  <div class=${`tl-card${this.dragging === key ? " tl-drag-src" : ""}`} data-key=${key} style=${`--tc:${color}`}
                    draggable=${this.editing && !this.saving ? "true" : "false"} @dragstart=${(event: DragEvent) => this.#dragStart(event, record, sitting)} @dragend=${this.#dragEnd}>
                    <a class="tl-card-open" draggable="false" href=${`#/events/${encodeURIComponent(key)}`}
                      @click=${(event: MouseEvent) => { if (this.#lastDrag.key === key && Date.now() < this.#lastDrag.until) event.preventDefault(); }}>
                      <div class="tl-card-name">${name}</div>
                      ${text(value["short"]) ? html`<div class="tl-card-desc">${text(value["short"])}</div>` : nothing}
                      <div class="tl-card-meta">
                        ${charIDs.length === 0 ? nothing : html`<div class="tl-card-chars">👤 ${charIDs.slice(0, 4).map(id => text(characters.get(id)?.["name"]) || id).join(", ")}${charIDs.length > 4 ? html` <span class="tl-more">+${charIDs.length - 4}</span>` : nothing}</div>`}
                        ${locIDs.length === 0 ? nothing : html`<div class="tl-card-loc">📍 ${locIDs.map(id => text(locations.get(id)?.["name"]) || id).join(" → ")}</div>`}
                      </div>
                    </a>
                    ${this.#slot("timeline:card:extra", sitting, [record])}
                    ${this.editing ? html`<div class="tl-card-actions">
                      <button aria-label=${this.#ui.t("timeline.up", { name })} ?disabled=${this.saving || index === 0} @click=${() => this.#move(key, sitting, index - 1)}>↑</button>
                      <button aria-label=${this.#ui.t("timeline.down", { name })} ?disabled=${this.saving || index === ids.length - 1} @click=${() => this.#move(key, sitting, index + 1)}>↓</button>
                      <select aria-label=${this.#ui.t("timeline.move", { name })} ?disabled=${this.saving} .value=${String(sitting)}
                        @change=${(event: Event) => { const select = event.target as HTMLSelectElement; this.#move(key, Number(select.value), Number.MAX_SAFE_INTEGER); select.value = String(sitting); }}>
                        ${editableSessions.map(target => html`<option value=${target} ?selected=${target === sitting}>${this.#ui.t(target === next ? "timeline.newSession" : "timeline.session", { n: target })}</option>`)}
                      </select>
                      <a href=${`#/events/${encodeURIComponent(key)}/edit`}>${this.#ui.t("timeline.editEvent")}</a>
                    </div>` : nothing}
                  </div>`;
              })}
              ${this.#indicator(sitting, ids.filter(key => key !== this.dragging).length)}
            </div>
            ${this.#slot("timeline:column:footer", sitting, ids.flatMap(key => records.get(key) ?? []))}
            ${this.editing ? html`<a class="tl-col-add" href=${`#/timeline/new/${sitting}`}>＋ ${this.#ui.t("timeline.newEvent")}</a>` : nothing}
          </section>`;
        })}</div>
      </div>
      <input class="tl-hscroll" type="range" min="0" max=${this.scrollMax} .value=${String(this.scrollPosition)} ?hidden=${this.scrollMax <= 0}
        aria-label=${this.#ui.t("timeline.scroll")} @input=${(event: Event) => { const viewport = this.querySelector(".tl-board-viewport"); if (viewport) viewport.scrollLeft = Number((event.target as HTMLInputElement).value); }} />
    </section>`;
  }
  #slot(slot: TimelineSlot, sitting: number | null, records: readonly CampaignRecord[]) {
    if (!this.#slots.has(slot)) return nothing;
    return html`<codex-timeline-slot data-timeline-slot=${slot} .registry=${this.registry} .actorRole=${this.actorRole}
      .context=${{ slot, sitting, editing: this.editing, events: records.filter(record => this.#liveEventKeys.has(record.key)).map(({ key, revision }) => ({ key, revision })) }}
      @dragstart=${(event: DragEvent) => { event.stopPropagation(); event.preventDefault(); }}
      @keydown=${(event: KeyboardEvent) => event.stopPropagation()}></codex-timeline-slot>`;
  }
  #indicator(sitting: number, index: number) { return this.dropTarget?.sitting === sitting && this.dropTarget.index === index ? html`<div class="tl-drop-indicator"></div>` : nothing; }
  #move(key: string, sitting: number, index: number): void {
    const campaign = this.#baseCampaign ?? this.#dragCampaign ?? this.campaign;
    if (!this.canEdit || !this.editing || this.saving || campaign === undefined) return;
    const draft = moveTimelineEvent(this.draft ?? this.#dragBase ?? timelineDraft(campaign), key, sitting, index);
    if (sameTimelineOrder(draft.columns, timelineColumns(campaign))) { this.draft = undefined; this.#baseCampaign = undefined; this.#setDirty(false); }
    else { this.#baseCampaign = campaign; this.draft = draft; this.#setDirty(true); }
  }
  #dragStart(event: DragEvent, record: CampaignRecord, sitting: number): void {
    if (!this.editing || !this.canEdit || this.saving || this.campaign === undefined || event.dataTransfer === null) { event.preventDefault(); return; }
    this.#dragCampaign = this.#baseCampaign ?? this.campaign; this.#dragBase = this.draft ?? timelineDraft(this.#dragCampaign);
    this.dragging = record.key; this.expanded = [...new Set([...this.expanded, sitting])];
    event.dataTransfer.setData("text/plain", record.key); event.dataTransfer.effectAllowed = "move";
  }
  #insertionIndex(event: DragEvent): number {
    const cards = [...(event.currentTarget as Element).querySelectorAll<HTMLElement>(":scope > .tl-col-body > .tl-card")].filter(card => card.dataset["key"] !== this.dragging);
    const index = cards.findIndex(card => event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
    return index < 0 ? cards.length : index;
  }
  #dragOver(event: DragEvent, sitting: number): void {
    if (this.dragging === undefined || this.saving) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const index = this.#insertionIndex(event);
    if (this.dropTarget?.sitting !== sitting || this.dropTarget.index !== index) this.dropTarget = { sitting, index };
  }
  #drop(event: DragEvent, sitting: number): void {
    if (this.dragging === undefined) return;
    event.preventDefault(); const key = this.dragging;
    this.#move(key, sitting, this.#insertionIndex(event)); this.#dragEnd();
  }
  readonly #dragEnd = (): void => {
    if (this.dragging !== undefined) this.#lastDrag = { key: this.dragging, until: Date.now() + 300 };
    this.dragging = undefined; this.dropTarget = undefined; this.#dragBase = undefined; this.#dragCampaign = undefined;
  };
  readonly #save = (): void => {
    if (this.draft !== undefined && !this.saving && this.canEdit) this.dispatchEvent(new CustomEvent("campaign-timeline-save", { detail: this.draft, bubbles: true, composed: true }));
  };
  readonly #cancel = (): void => {
    if (!this.saving && confirmDiscardUnsavedEdit(this.#dirty, message => window.confirm(message))) { this.#clearDraft(); this.#clearError(); }
  };
  readonly #toggleEditing = (): void => {
    if (!this.canEdit || this.saving || !confirmDiscardUnsavedEdit(this.#dirty, message => window.confirm(message))) return;
    this.#clearDraft(); this.#clearError(); this.editing = !this.editing;
  };
  #clearError(): void { this.dispatchEvent(new CustomEvent("campaign-timeline-reset", { bubbles: true, composed: true })); }
  #clearDraft(): void { this.draft = undefined; this.#baseCampaign = undefined; this.#dragEnd(); this.#setDirty(false); }
  #setDirty(dirty: boolean): void { if (dirty !== this.#dirty) { this.#dirty = dirty; this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty }, bubbles: true, composed: true })); } }
  readonly #syncScroll = (): void => {
    const viewport = this.querySelector(".tl-board-viewport"); if (!viewport) return;
    this.scrollMax = Math.max(0, viewport.scrollWidth - viewport.clientWidth); this.scrollPosition = Math.round(viewport.scrollLeft);
  };
  readonly #wheel = (event: WheelEvent): void => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || this.scrollMax <= 0 || event.ctrlKey) return;
    const body = event.target instanceof Element ? event.target.closest(".tl-col-body") : null;
    if (body && body.scrollHeight > body.clientHeight) return;
    const viewport = this.querySelector(".tl-board-viewport"); if (!viewport) return;
    viewport.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? viewport.clientWidth : 1); event.preventDefault();
  };
}
customElements.define("codex-timeline", CodexTimeline);
