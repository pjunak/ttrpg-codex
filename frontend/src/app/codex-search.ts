import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import { searchCampaign, type CampaignSearchResult } from "./campaign-search.js";
import { UiLocalizationController, uiCollectionLabel } from "./ui-localization.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { AddonLinksController } from "./addon-links-controller.js";

export class CodexSearch extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    registry: { attribute: false }, actorRole: { attribute: false },
    query: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  readonly #links = new AddonLinksController(this, () => ({ registry: this.registry, role: this.actorRole }));
  declare private query: string;
  readonly #ui = new UiLocalizationController(this);

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
    const addons = this.#links.search(this.query);
    const count = groups.reduce((total, group) => total + group.results.length, 0) + addons.results.reduce((total, result) => total + result.matches.length, 0);
    const searched = this.query.trim() !== "";
    return html`
      <article class="search-page" aria-labelledby="search-title">
        <header class="search-heading">
          <p class="page-kicker">${this.#ui.t("search.kicker")}</p>
          <h1 id="search-title">${this.#ui.t("search.title")}</h1>
          <p>${this.#ui.t("search.intro")}</p>
          <label class="campaign-search-field">
            <span class="visually-hidden">${this.#ui.t("search.label")}</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              .value=${this.query}
              placeholder=${this.#ui.t("search.placeholder")}
              autocomplete="off"
              @input=${this.#onInput}
            />
          </label>
        </header>
        <div class="search-results" aria-live="polite">
          ${!searched
            ? html`<p class="search-prompt">${this.#ui.t("search.prompt")}</p>`
            : count === 0 && !addons.loading && !addons.results.some(result => result.failed)
              ? html`<p class="empty-state">${this.#ui.t("search.empty", { query: this.query.trim() })}</p>`
              : html`
                <p class="search-count">${this.#ui.plural("search.count", count)}</p>
                ${groups.map((group) => html`
                  <section class="search-group" aria-labelledby=${`search-group-${group.page.id}`}>
                    <header>
                      <h2 id=${`search-group-${group.page.id}`}><span aria-hidden="true">${group.page.icon}</span>${uiCollectionLabel(group.page.id, "other")}</h2>
                      <span>${group.results.length}</span>
                    </header>
                    <div>${group.results.map((result) => searchResult(result))}</div>
                  </section>
                `)}
                ${addons.results.filter(result => result.matches.length).map(result => html`
                  <section class="search-group" aria-label=${result.active.descriptor.label}>
                    <header><h2>${result.active.descriptor.label}</h2><span>${result.matches.length}</span></header>
                    <div>${result.matches.map(match => html`<a class="search-result" href=${match.href}>
                      <span><strong>${match.label}</strong></span>${match.description ? html`<p>${match.description}</p>` : nothing}
                    </a>`)}</div>
                  </section>
                `)}
              `}
          ${addons.loading ? html`<p role="status">${this.#ui.t("wiki.loading")}</p>` : nothing}
          ${addons.results.some(result => result.failed) ? html`<p role="status">${this.#ui.t("wiki.failed")}
            <button type="button" @click=${this.#links.retry}>${this.#ui.t("wiki.retry")}</button></p>` : nothing}
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
