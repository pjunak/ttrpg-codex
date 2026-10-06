import { LitElement, html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { UIControlsController } from "../ui/controller.js";
import { repeat } from "lit/directives/repeat.js";
import type { EntitySummary } from "./campaign-projection.js";
import {
  collectionFacetChoices,
  queryCollection,
  type CollectionModel,
} from "./collection-model.js";
import {
  defaultCollectionView,
  type CollectionFilter,
  type CollectionView,
} from "./collection-view.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { selectOptions } from "./select-options.js";
let browserId = 0;

/** One-line browse toolbar: every change applies immediately, as in the original codex. */
export class CodexCollectionBrowser extends LitElement {
  static override properties = {
    model: { attribute: false },
    view: { attribute: false },
    quickFacet: { attribute: false },
    renderEntry: { attribute: false },
    storageUnavailable: { type: Boolean },
    facetKey: { state: true },
  };
  declare model: CollectionModel;
  declare view: CollectionView;
  declare quickFacet: string;
  declare renderEntry: (entity: EntitySummary) => TemplateResult;
  declare storageUnavailable: boolean;
  declare private facetKey: string;
  readonly #ui = new UiLocalizationController(this);
  readonly #id = `collection-browser-${++browserId}`;
  constructor() {
    super();
    new UIControlsController(this);
    this.view = defaultCollectionView;
    this.quickFacet = "";
    this.facetKey = "";
    this.storageUnavailable = false;
  }
  protected override createRenderRoot() {
    return this;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.#closeFilterMenu);
  }
  override disconnectedCallback(): void {
    document.removeEventListener("pointerdown", this.#closeFilterMenu);
    super.disconnectedCallback();
  }
  protected override willUpdate(): void {
    if (!this.model) return;
    if (!this.model.facets.some((facet) => facet.key === this.facetKey))
      this.facetKey = this.model.facets[0]?.key ?? "";
  }
  protected override render() {
    if (!this.model) return nothing;
    const view = this.view;
    const result = queryCollection(this.model, view);
    const facet = this.model.facets.find((facet) => facet.key === this.facetKey);
    const choices = facet ? collectionFacetChoices(this.model, view, facet.key) : [];
    const group = this.model.facets.find((facet) => facet.key === view.group);
    const clearable = view.query !== "" || view.filters.length > 0;
    const sort = this.model.sorts.some((sort) => sort.key === view.sort) ? view.sort : "name";
    return html`<form class="collection-controls" lang=${this.#ui.locale} @submit=${(
      event: SubmitEvent,
    ) => event.preventDefault()}>
      ${this.#quickChips()}
      <div class="collection-toolbar">
        <div class="collection-query">
          <label class="visually-hidden" for=${`${this.#id}-query`}>${uiText("browse.search")}</label>
          <input id=${`${this.#id}-query`} type="search" data-ui="search" maxlength="512"
            placeholder=${uiText("browse.placeholder")} title=${uiText("browse.searchHint")}
            .value=${live(view.query)}
            @codex-query=${(event: Event) =>
              this.#apply({ ...this.view, query: (event.target as HTMLInputElement).value })} />
        </div>
        <label class="collection-select"><span aria-hidden="true">${uiText("browse.sortShort")}</span>
          <select aria-label=${uiText("browse.sort")} .value=${live(sort)}
            @change=${(event: Event) =>
              this.#apply({ ...this.view, sort: (event.target as HTMLSelectElement).value })}>
            ${selectOptions(
              this.model.sorts.map((sort) => ({ value: sort.key, label: sort.label })),
              sort,
            )}</select></label>
        <select class="collection-direction" aria-label=${uiText("browse.direction")} .value=${live(view.direction)}
          @change=${(event: Event) =>
            this.#apply({
              ...this.view,
              direction: (event.target as HTMLSelectElement).value === "desc" ? "desc" : "asc",
            })}>
          ${selectOptions(
            [
              { value: "asc", label: uiText("browse.ascending") },
              { value: "desc", label: uiText("browse.descending") },
            ],
            view.direction,
          )}</select>
        ${
          this.model.facets.length
            ? html`<label class="collection-select"><span aria-hidden="true">${uiText("browse.groupShort")}</span>
          <select aria-label=${uiText("browse.group")} .value=${live(group ? group.key : "")}
            @change=${(event: Event) =>
              this.#apply({ ...this.view, group: (event.target as HTMLSelectElement).value })}>
            ${selectOptions(
              [
                { value: "", label: uiText("browse.ungrouped") },
                ...this.model.facets.map((facet) => ({ value: facet.key, label: facet.label })),
              ],
              group ? group.key : "",
            )}</select></label>
        <details class="collection-filter-picker" @keydown=${this.#filterMenuKey}>
          <summary>${uiText("browse.filters")}${view.filters.length ? ` (${view.filters.length})` : ""}</summary>
          <div class="collection-filter-menu">
            <p class="field-help">${uiText("browse.logic")}</p>
            <label data-ui-field><span>${uiText("browse.filterBy")}</span><select .value=${live(this.facetKey)} @change=${(
              event: Event,
            ) => {
              this.facetKey = (event.target as HTMLSelectElement).value;
            }}>
              ${selectOptions(
                this.model.facets.map((facet) => ({ value: facet.key, label: facet.label })),
                this.facetKey,
              )}</select></label>
            <label class="collection-filter-value" data-ui-field><span>${uiText("browse.value")}</span>
              <select multiple data-ui="chips" @change=${(event: Event) => {
                const values = [...(event.target as HTMLSelectElement).selectedOptions].map(
                  (option) => option.value,
                );
                this.#apply({
                  ...this.view,
                  filters: [
                    ...this.view.filters.filter((filter) => filter.field !== this.facetKey),
                    ...values.map((value) => ({ field: this.facetKey, value })),
                  ].slice(0, 32),
                });
              }}>
                ${choices.map(
                  (choice) =>
                    html`<option value=${choice.value} ?selected=${view.filters.some((filter) => filter.field === this.facetKey && filter.value === choice.value)}>${choice.label} (${choice.count})</option>`,
                )}</select></label>
          </div>
        </details>`
            : nothing
        }
      </div>
      <div class="collection-status">
        ${
          view.filters.length
            ? html`<ul class="collection-filter-chips" aria-label=${uiText("browse.filters")}>
          ${view.filters.map(
            (
              filter,
            ) => html`<li><button type="button" aria-label=${uiText("browse.remove", this.#filterLabel(filter))}
              @click=${() =>
                this.#apply({
                  ...this.view,
                  filters: this.view.filters.filter((item) => item !== filter),
                })}>
              ${this.#filterLabel(filter).field}: ${this.#filterLabel(filter).value} <span aria-hidden="true">×</span></button></li>`,
          )}
        </ul>`
            : nothing
        }
        <p class="collection-result-count" role="status" aria-atomic="true">${this.#ui.plural("browse.count", this.model.entries.length, { shown: result.count, total: this.model.entries.length })}</p>
        ${
          clearable
            ? html`<button type="button" class="collection-clear"
          @click=${() => this.#apply({ ...this.view, query: "", filters: [] })}>${uiText("browse.clear")}</button>`
            : nothing
        }
      </div>
    </form>
    ${this.storageUnavailable ? html`<p role="status">${uiText("browse.storageUnavailable")}</p>` : nothing}
    ${group?.multiple && result.groups.length > 1 ? html`<p class="field-help">${uiText("browse.multipleGroups")}</p>` : nothing}
    ${
      result.count === 0
        ? html`<p class="empty-state">${uiText(this.model.entries.length ? "browse.noMatches" : "browse.empty")}</p>`
        : html`<div class=${`collection-results${result.groups.length > 1 ? " is-grouped" : ""}`}>${repeat(
            result.groups,
            (group) => group.key,
            (group) => html`<section class="collection-result-group">
        ${group.label && result.groups.length > 1 ? html`<h2 class="collection-group-title">${group.label} <span>${group.entries.length}</span></h2>` : nothing}
        <div class="record-ledger">${repeat(
          group.entries,
          (entity) => entity.key,
          (entity) => this.renderEntry(entity),
        )}</div>
      </section>`,
          )}</div>`
    }
    `;
  }
  #quickChips() {
    const facet = this.model.facets.find((facet) => facet.key === this.quickFacet);
    if (!facet) return nothing;
    // Chips come from the whole collection so they stay put while the search narrows.
    const choices = facet.choices.filter((choice) => choice.value !== "" && choice.count > 0);
    if (choices.length < 2 || choices.length > 12) return nothing;
    const active = this.view.filters.filter((filter) => filter.field === facet.key);
    const counts = collectionFacetChoices(this.model, this.view, facet.key);
    const select = (value: string) =>
      this.#apply({
        ...this.view,
        filters: [
          ...this.view.filters.filter((filter) => filter.field !== facet.key),
          ...(value === "" ? [] : [{ field: facet.key, value }]),
        ],
      });
    return html`<div class="collection-quick" role="group" aria-label=${facet.key === "roster" ? uiText("browse.roster") : facet.label}>
      <button type="button" aria-pressed=${active.length === 0} @click=${() => select("")}>${uiText(facet.key === "roster" ? "browse.rosterAll" : "browse.all")}</button>
      ${choices.map(
        (
          choice,
        ) => html`<button type="button" aria-pressed=${active.length === 1 && active[0]!.value === choice.value}
        @click=${() => select(active.length === 1 && active[0]!.value === choice.value ? "" : choice.value)}>${choice.label}
        <span class="collection-quick-count" aria-hidden="true">${counts.find((item) => item.value === choice.value)?.count ?? 0}</span></button>`,
      )}
    </div>`;
  }
  #filterLabel(filter: CollectionFilter): { field: string; value: string } {
    const facet = this.model.facets.find((facet) => facet.key === filter.field);
    return {
      field: facet?.label ?? uiText("browse.unavailable"),
      value:
        facet?.choices.find((choice) => choice.value === filter.value)?.label ??
        uiText("browse.unavailable"),
    };
  }
  readonly #filterMenuKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    const menu = event.currentTarget as HTMLDetailsElement;
    if (!menu.open) return;
    event.stopPropagation();
    menu.open = false;
    menu.querySelector("summary")?.focus();
  };
  readonly #closeFilterMenu = (event: PointerEvent): void => {
    const menu = this.querySelector<HTMLDetailsElement>(".collection-filter-picker");
    // Native select and combobox popups render outside the menu in the top layer.
    if (menu?.open && !event.composedPath().some((node) => node === menu || isPopup(node)))
      menu.open = false;
  };
  #apply(next: CollectionView): void {
    const view = {
      ...next,
      sort: this.model.sorts.some((sort) => sort.key === next.sort) ? next.sort : "name",
      group: this.model.facets.some((facet) => facet.key === next.group) ? next.group : "",
      filters: next.filters.filter((filter) =>
        this.model.facets.some((facet) => facet.key === filter.field),
      ),
    };
    this.dispatchEvent(
      new CustomEvent<CollectionView>("collection-view-change", {
        detail: view,
        bubbles: true,
        composed: true,
      }),
    );
  }
}

function isPopup(node: EventTarget): boolean {
  return node instanceof HTMLElement && node.classList.contains("ui-popup");
}

customElements.define("codex-collection-browser", CodexCollectionBrowser);
