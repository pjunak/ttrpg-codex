import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import { investigationQueue, type InvestigationQueueItem } from "./campaign-investigation.js";
import { uiSourceLabel, uiText, UiLocalizationController } from "./ui-localization.js";
import { pencilIcon } from "./edit-icon.js";

export class CodexInvestigationQueue extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    canEdit: { type: Boolean },
    query: { state: true },
  };
  declare campaign: CampaignDataset;
  declare canEdit: boolean;
  declare private query: string;
  constructor() {
    super();
    new UiLocalizationController(this);
    this.canEdit = false;
    this.query = "";
  }
  protected override createRenderRoot() {
    return this;
  }
  protected override render() {
    if (!this.campaign) return nothing;
    const questions = investigationQueue(this.campaign, this.query);
    const open = questions.filter((item) => !item.answer),
      answered = questions.filter((item) => item.answer);
    return html`<section class="investigation-queue" tabindex="-1" aria-label=${uiText("investigation.queue")}>
      <h2 class="collection-group-title">${uiText("investigation.queue")} <span>${open.length}</span></h2>
      <div class="investigation-toolbar">
        <label class="investigation-search"><span class="visually-hidden">${uiText("investigation.search")}</span>
          <input type="search" maxlength="512" placeholder=${uiText("investigation.search")} .value=${this.query}
            @input=${(event: Event) => {
              this.query = (event.target as HTMLInputElement).value;
            }} /></label>
        <p role="status">${uiText("investigation.count", { open: open.length, total: questions.length })}</p>
      </div>
      ${open.length ? this.#rows(open) : html`<p class="empty-state">${uiText(this.query ? "investigation.noMatches" : "investigation.noOpen")}</p>`}
      <details class="investigation-history"><summary>${uiText("investigation.history")} (${answered.length})</summary>
        ${answered.length ? this.#rows(answered) : html`<p class="empty-state">${uiText("investigation.noAnswers")}</p>`}
      </details>
    </section>`;
  }
  #rows(items: readonly InvestigationQueueItem[]) {
    return html`<ul class="investigation-questions">${items.map(
      (item) => html`<li>
      <div class="investigation-question"><p>${item.text}</p>
        ${item.answer ? html`<div class="investigation-answer"><strong>${uiText("Answer")}</strong><p>${item.answer}</p></div>` : nothing}
      </div>
      <div class="investigation-source"><span class="investigation-kind">${uiSourceLabel(item.kind === "characters" ? "Character" : "Mystery")}</span>
        <a class="article-reference" href=${item.route}>${item.source}</a>
        ${item.visibility === "dm" ? html`<span class="dm-badge">${uiText("DM")}</span>` : nothing}
        ${this.canEdit ? html`<a class="inline-edit-link" href=${item.editRoute} aria-label=${uiText("Edit {0}", { "0": item.source })} title=${uiText("Edit {0}", { "0": item.source })}>${pencilIcon()}</a>` : nothing}
      </div>
    </li>`,
    )}</ul>`;
  }
}
customElements.define("codex-investigation-queue", CodexInvestigationQueue);
