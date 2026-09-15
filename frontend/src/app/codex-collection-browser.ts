import { LitElement, html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { EntitySummary } from "./campaign-projection.js";
import { collectionFacetChoices, queryCollection, type CollectionModel } from "./collection-model.js";
import { defaultCollectionView, type CollectionFilter, type CollectionView } from "./collection-view.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { selectOptions } from "./select-options.js";
let browserId = 0;

export class CodexCollectionBrowser extends LitElement {
  static override properties = {
    model: { attribute: false }, view: { attribute: false }, renderEntry: { attribute: false }, storageUnavailable: { type: Boolean },
    pending: { state: true }, facetKey: { state: true }, choice: { state: true },
  };
  declare model: CollectionModel;
  declare view: CollectionView;
  declare renderEntry: (entity: EntitySummary) => TemplateResult;
  declare storageUnavailable: boolean;
  declare private pending: CollectionView;
  declare private facetKey: string;
  declare private choice: string;
  readonly #ui = new UiLocalizationController(this);
  readonly #id = `collection-browser-${++browserId}`;
  constructor() {
    super(); this.view = defaultCollectionView; this.pending = this.view; this.facetKey = ""; this.choice = ""; this.storageUnavailable = false;
  }
  protected override createRenderRoot() { return this; }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("view")) this.pending = this.view;
    if (!this.model) return;
    if (!this.model.facets.some(facet => facet.key === this.facetKey)) this.facetKey = this.model.facets[0]?.key ?? "";
    const choices = this.model.facets.find(facet => facet.key === this.facetKey)?.choices ?? [];
    if (!choices.some(choice => choice.value === this.choice)) this.choice = choices[0]?.value ?? "";
  }
  protected override render() {
    if (!this.model) return nothing;
    const result = queryCollection(this.model, this.view);
    const facet = this.model.facets.find(facet => facet.key === this.facetKey);
    const choices = facet ? collectionFacetChoices(this.model, this.pending, facet.key) : [];
    const group = this.model.facets.find(facet => facet.key === this.view.group);
    return html`<form class="collection-controls" lang=${this.#ui.locale} @submit=${(event: SubmitEvent) => { event.preventDefault(); this.#apply(); }}>
      <div class="collection-control-row">
        <div class="collection-query"><label for=${`${this.#id}-query`}>${uiText("browse.search")}</label><input id=${`${this.#id}-query`} aria-describedby=${`${this.#id}-hint`} type="search" maxlength="512" .value=${this.pending.query}
          @input=${(event: Event) => { this.pending = { ...this.pending, query: (event.target as HTMLInputElement).value }; }} />
          <small id=${`${this.#id}-hint`}>${uiText("browse.searchHint")}</small></div>
      </div>
      ${this.model.facets.some(facet => facet.key === "roster") ? html`<div class="collection-roster" role="group" aria-label=${uiText("browse.roster")}>
        ${["all", "npc", "party"].map(scope => html`<button type="button" class="record-action"
          aria-pressed=${scope === "all" ? !this.pending.filters.some(filter => filter.field === "roster") : this.pending.filters.some(filter => filter.field === "roster" && filter.value === scope)}
          @click=${() => { this.pending = {...this.pending, filters: [...this.pending.filters.filter(filter => filter.field !== "roster"), ...(scope === "all" ? [] : [{field:"roster", value:scope}])]}; this.#apply(); }}
          >${uiText(scope === "all" ? "browse.rosterAll" : scope === "npc" ? "browse.rosterNPC" : "browse.rosterParty")}</button>`)}
      </div>` : nothing}
      <details class="collection-view-options" ?open=${this.view.sort !== "name" || this.view.direction !== "asc" || this.view.group !== ""}>
        <summary>${uiText("browse.viewOptions")} <span>${this.model.sorts.find(sort => sort.key === this.view.sort)?.label ?? uiText("Name")} · ${uiText(this.view.direction === "desc" ? "browse.descending" : "browse.ascending")}${group ? ` · ${group.label}` : ""}</span></summary>
        <div class="collection-control-row">
        <label><span>${uiText("browse.sort")}</span><select .value=${this.model.sorts.some(sort => sort.key === this.pending.sort) ? this.pending.sort : "name"}
          @change=${(event: Event) => { this.pending = { ...this.pending, sort: (event.target as HTMLSelectElement).value }; }}>
          ${selectOptions(this.model.sorts.map(sort => ({ value: sort.key, label: sort.label })), this.model.sorts.some(sort => sort.key === this.pending.sort) ? this.pending.sort : "name")}</select></label>
        <label><span>${uiText("browse.direction")}</span><select .value=${this.pending.direction}
          @change=${(event: Event) => { this.pending = { ...this.pending, direction: (event.target as HTMLSelectElement).value === "desc" ? "desc" : "asc" }; }}>
          ${selectOptions([{ value: "asc", label: uiText("browse.ascending") }, { value: "desc", label: uiText("browse.descending") }], this.pending.direction)}</select></label>
        <label><span>${uiText("browse.group")}</span><select .value=${this.model.facets.some(facet => facet.key === this.pending.group) ? this.pending.group : ""}
          @change=${(event: Event) => { this.pending = { ...this.pending, group: (event.target as HTMLSelectElement).value }; }}>
          ${selectOptions([{ value: "", label: uiText("browse.ungrouped") }, ...this.model.facets.map(facet => ({ value: facet.key, label: facet.label }))], this.pending.group)}</select></label>
        </div>
      </details>
      ${this.model.facets.length ? html`<details class="collection-filter-picker"><summary>${uiText("browse.filters")} (${this.pending.filters.length})</summary>
        <p class="field-help">${uiText("browse.logic")}</p>
        <div class="collection-control-row">
          <label><span>${uiText("browse.filterBy")}</span><select .value=${this.facetKey} @change=${(event: Event) => { this.facetKey = (event.target as HTMLSelectElement).value; }}>
            ${selectOptions(this.model.facets.map(facet => ({ value: facet.key, label: facet.label })), this.facetKey)}</select></label>
          <label class="collection-filter-value"><span>${uiText("browse.value")}</span><select .value=${this.choice} @change=${(event: Event) => { this.choice = (event.target as HTMLSelectElement).value; }}>
            ${selectOptions(choices.map(choice => ({ value: choice.value, label: `${choice.label} (${choice.count})` })), this.choice)}</select></label>
          <button type="button" class="record-action" ?disabled=${!facet?.choices.length || this.pending.filters.length >= 32 || this.pending.filters.some(filter => filter.field === this.facetKey && filter.value === this.choice)}
            @click=${() => { this.pending = { ...this.pending, filters: [...this.pending.filters, { field: this.facetKey, value: this.choice }] }; }}>${uiText("browse.add")}</button>
        </div>
      </details>` : nothing}
      ${this.pending.filters.length ? html`<ul class="collection-filter-chips" aria-label=${uiText("browse.filters")}>
        ${this.pending.filters.map(filter => html`<li><button type="button" class="record-action" aria-label=${uiText("browse.remove", this.#filterLabel(filter))}
          @click=${() => { this.pending = { ...this.pending, filters: this.pending.filters.filter(item => item !== filter) }; this.#apply(); }}>
          ${this.#filterLabel(filter).field}: ${this.#filterLabel(filter).value} <span aria-hidden="true">×</span></button></li>`)}
      </ul>` : nothing}
      <div class="collection-view-actions"><button type="submit" class="record-action primary-record-action">${uiText("browse.apply")}</button>
        <button type="button" class="record-action" ?disabled=${!this.pending.query && !this.pending.filters.length && !this.view.query && !this.view.filters.length}
          @click=${() => { this.pending = { ...this.pending, query: "", filters: [] }; this.#apply(); }}>${uiText("browse.clear")}</button></div>
    </form>
    ${this.storageUnavailable ? html`<p role="status">${uiText("browse.storageUnavailable")}</p>` : nothing}
    <p class="collection-result-count" role="status" aria-atomic="true">${this.#ui.plural("browse.count", this.model.entries.length, { shown: result.count, total: this.model.entries.length })}</p>
    ${group?.multiple ? html`<p class="field-help">${uiText("browse.multipleGroups")}</p>` : nothing}
    ${result.count === 0 ? html`<p class="empty-state">${uiText(this.model.entries.length ? "browse.noMatches" : "browse.empty")}</p>` :
      repeat(result.groups, group => group.key, group => html`<section class="collection-result-group">
        ${group.label ? html`<h2 class="record-section-title">${group.label} <span>(${group.entries.length})</span></h2>` : nothing}
        <div class="record-ledger">${repeat(group.entries, entity => entity.key, entity => this.renderEntry(entity))}</div>
      </section>`)}
    `;
  }
  #filterLabel(filter: CollectionFilter): { field: string; value: string } {
    const facet = this.model.facets.find(facet => facet.key === filter.field);
    return { field: facet?.label ?? uiText("browse.unavailable"), value: facet?.choices.find(choice => choice.value === filter.value)?.label ?? uiText("browse.unavailable") };
  }
  #apply(): void {
    const view = { ...this.pending, sort: this.model.sorts.some(sort => sort.key === this.pending.sort) ? this.pending.sort : "name",
      group: this.model.facets.some(facet => facet.key === this.pending.group) ? this.pending.group : "",
      filters: this.pending.filters.filter(filter => this.model.facets.some(facet => facet.key === filter.field)) };
    this.dispatchEvent(new CustomEvent<CollectionView>("collection-view-change", { detail: view, bubbles: true, composed: true }));
  }
}

customElements.define("codex-collection-browser", CodexCollectionBrowser);
