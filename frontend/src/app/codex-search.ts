import { uiText } from "./ui-localization.js";
import { UIControlsController } from "../ui/controller.js";
import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import { searchCampaign } from "./campaign-search.js";
import type { EntitySummary } from "./campaign-projection.js";
import { recentSearchResults } from "./recent-records.js";
import { UiLocalizationController, uiCollectionLabel } from "./ui-localization.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { AddonLinksController } from "./addon-links-controller.js";

export class CodexSearch extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    registry: { attribute: false }, actorRole: { attribute: false },
    query: { state: true },
    quick: { type: Boolean },
  };

  declare campaign: CampaignDataset | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  readonly #links = new AddonLinksController(this, () => ({ registry: this.registry, role: this.actorRole }));
  declare query: string;
  declare quick: boolean;
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super(); new UIControlsController(this);
    this.campaign = undefined;
    this.query = "";
    this.quick = false;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override firstUpdated(): void {
    this.querySelector<HTMLInputElement>("input")?.focus();
  }

  protected override render() {
    if (this.campaign === undefined) return nothing;
    const groups = searchCampaign(this.campaign, this.query, this.quick ? 24 : 60);
    const addons = this.#links.search(this.query);
    const count = groups.reduce((total, group) => total + group.results.length, 0) + addons.results.reduce((total, result) => total + result.matches.length, 0);
    const searched = this.query.trim() !== "";
    const recent = this.quick && !searched ? recentSearchResults(this.campaign, this.actorRole ?? "public") : [];
    return html`
      <article class="search-page" aria-labelledby=${this.quick ? "quick-search-title" : "search-title"} @keydown=${this.#resultKeyDown}>
        <header class="search-heading">
          ${this.quick ? html`<h2 id="quick-search-title">${this.#ui.t("jump.title")}</h2><p id="quick-search-help">${this.#ui.t("jump.help")}</p>` : html`
            <p class="page-kicker">${this.#ui.t("search.kicker")}</p><h1 id="search-title">${this.#ui.t("search.title")}</h1><p>${this.#ui.t("search.intro")}</p>`}
          <div class="campaign-search-field">
            <label class="visually-hidden" for=${this.quick ? "quick-campaign-query" : "campaign-query"}>${this.#ui.t("search.label")}</label>
            <span aria-hidden="true">⌕</span>
            <input
              type="search" data-ui="search" id=${this.quick ? "quick-campaign-query" : "campaign-query"}
              .value=${this.query}
              placeholder=${this.#ui.t("search.placeholder")}
              autocomplete="off"
              maxlength="200"
              aria-describedby=${this.quick ? "quick-search-help" : nothing}
              @codex-query=${this.#onInput}
            />
          </div>
        </header>
        <div class="search-results">
          ${!searched
            ? this.quick ? html`<section class="search-group" aria-label=${this.#ui.t("jump.recent")}>
                <header><h3>${this.#ui.t("jump.recent")}</h3></header>
                ${recent.map(result => searchResult(result))}
                ${recent.length ? nothing : html`<p>${this.#ui.t("jump.empty")}</p>`}
              </section>` : html`<p class="search-prompt">${this.#ui.t("search.prompt")}</p>`
            : count === 0 && !addons.loading && !addons.results.some(result => result.failed)
              ? html`<p class="empty-state" role="status">${this.#ui.t("search.empty", { query: this.query.trim() })}</p>`
              : html`
                <p class="search-count" role="status">${this.#ui.plural("search.count", count)}</p>
                ${groups.map((group) => html`
                  <section class="search-group" aria-label=${uiCollectionLabel(group.page.id, "other")}>
                    <header>
                      <h3><span aria-hidden="true">${group.page.icon}</span>${uiCollectionLabel(group.page.id, "other")}</h3>
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
        ${this.quick ? html`<a class="record-action" href=${`#/search?q=${encodeURIComponent(this.query)}`}>${this.#ui.t("jump.full")}</a>` : nothing}
      </article>
    `;
  }

  readonly #onInput = (event: Event): void => {
    this.query = (event.currentTarget as HTMLInputElement).value;
  };

  readonly #resultKeyDown = (event: KeyboardEvent): void => {
    if (!this.quick || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const input = this.querySelector<HTMLInputElement>("input");
    const links = [...this.querySelectorAll<HTMLAnchorElement>(".search-result")];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === "Enter" && event.target === input && links.length) { event.preventDefault(); links[0]!.click(); return; }
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || event.target !== input && index < 0 || !links.length) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? index + 1 : index < 0 ? links.length - 1 : index - 1;
    if (next < 0) input?.focus();
    else { const link = links[Math.min(next, links.length - 1)]!; link.focus(); link.scrollIntoView({ block: "nearest" }); }
  };
}

function searchResult(result: EntitySummary) {
  return html`
    <a class="search-result" href=${result.route}>
      <span>
        <strong>${result.name}</strong>
        ${result.title === "" ? nothing : html`<small>${result.title}</small>`}
      </span>
      ${result.excerpt === "" ? nothing : html`<p>${result.excerpt}</p>`}
      ${result.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
    </a>
  `;
}

if (!customElements.get("codex-search")) {
  customElements.define("codex-search", CodexSearch);
}
