import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import { searchCampaign, type CampaignSearchResult } from "./campaign-search.js";

export class CodexSearch extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    query: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare private query: string;

  constructor() {
    super();
    this.campaign = undefined;
    this.query = "";
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override firstUpdated(): void {
    this.querySelector<HTMLInputElement>("input")?.focus();
  }

  protected override render() {
    if (this.campaign === undefined) return nothing;
    const groups = searchCampaign(this.campaign, this.query);
    const count = groups.reduce((total, group) => total + group.results.length, 0);
    const searched = this.query.trim() !== "";
    return html`
      <article class="search-page" aria-labelledby="search-title">
        <header class="search-heading">
          <p class="page-kicker">Campaign index</p>
          <h1 id="search-title">Search the chronicle</h1>
          <p>Find people, places, events, mysteries, factions, lore, and companions in your current view.</p>
          <label class="campaign-search-field">
            <span class="visually-hidden">Search the campaign</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              .value=${this.query}
              placeholder="Name, title, tag, or remembered phrase"
              autocomplete="off"
              @input=${this.#onInput}
            />
          </label>
        </header>
        <div class="search-results" aria-live="polite">
          ${!searched
            ? html`<p class="search-prompt">Begin typing to search every visible part of the campaign archive.</p>`
            : count === 0
              ? html`<p class="empty-state">Nothing in the current campaign view matches “${this.query.trim()}”.</p>`
              : html`
                <p class="search-count">${count} ${count === 1 ? "entry" : "entries"} found</p>
                ${groups.map((group) => html`
                  <section class="search-group" aria-labelledby=${`search-group-${group.page.id}`}>
                    <header>
                      <h2 id=${`search-group-${group.page.id}`}><span aria-hidden="true">${group.page.icon}</span>${group.page.plural}</h2>
                      <span>${group.results.length}</span>
                    </header>
                    <div>${group.results.map((result) => searchResult(result))}</div>
                  </section>
                `)}
              `}
        </div>
      </article>
    `;
  }

  readonly #onInput = (event: Event): void => {
    this.query = (event.currentTarget as HTMLInputElement).value;
  };
}

function searchResult(result: CampaignSearchResult) {
  return html`
    <a class="search-result" href=${result.route}>
      <span>
        <strong>${result.name}</strong>
        ${result.title === "" ? nothing : html`<small>${result.title}</small>`}
      </span>
      ${result.excerpt === "" ? nothing : html`<p>${result.excerpt}</p>`}
      ${result.visibility === "dm" ? html`<span class="dm-badge">DM</span>` : nothing}
    </a>
  `;
}

if (!customElements.get("codex-search")) {
  customElements.define("codex-search", CodexSearch);
}
