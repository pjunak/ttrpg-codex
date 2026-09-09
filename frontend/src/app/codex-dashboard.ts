import { previewResourceURL } from "../core/player-preview.js";
import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import {
  projectDashboard,
  type DashboardEvent,
  type DashboardModel,
  type EntitySummary,
} from "./campaign-projection.js";
import { campaignPages } from "./routes.js";
import { UiLocalizationController } from "./ui-localization.js";
import { campaignIdentityRecord, type CampaignIdentityField, type CampaignIdentitySaveDetail } from "./campaign-identity.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";

export class CodexDashboard extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    partyOnly: { type: Boolean },
    canManageCampaign: { type: Boolean },
    authenticated: { type: Boolean },
    saving: { type: Boolean },
    editCompletion: { type: Number },
    editing: { state: true },
  };

  declare campaign: CampaignDataset | undefined;
  declare partyOnly: boolean;
  declare canManageCampaign: boolean;
  declare authenticated: boolean;
  declare saving: boolean;
  declare editCompletion: number;
  declare private editing: CampaignIdentityField | undefined;
  #expectedRevision = 0;
  #original = "";
  #draft = "";
  #dirty = false;
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    this.campaign = undefined;
    this.partyOnly = false;
    this.canManageCampaign = false;
    this.authenticated = false;
    this.saving = false;
    this.editCompletion = 0;
    this.editing = undefined;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override render() {
    if (this.campaign === undefined) return nothing;
    const model = projectDashboard(this.campaign);
    return this.partyOnly ? this.#partyPage(model) : this.#dashboard(model);
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("editCompletion") || changed.has("partyOnly") ||
      (changed.has("canManageCampaign") && !this.canManageCampaign)) {
      this.editing = undefined;
      this.#setDirty(false);
    }
  }

  #dashboard(model: DashboardModel) {
    return html`
      <article class="campaign-dashboard" aria-labelledby="campaign-title">
        <header class="campaign-title-page">
          ${this.#identityRow("name", model.identity.name)}
          ${this.#identityRow("tagline", model.identity.tagline)}
          <span class="campaign-title-rule" aria-hidden="true"></span>
        </header>

        ${this.#partySection(model, true)}
        ${this.#lastSession(model)}
        ${this.#recent(model)}
      </article>
    `;
  }

  #identityRow(field: CampaignIdentityField, value: string) {
    const label = this.#ui.t(field === "name" ? "dashboard.editName" : "dashboard.editTagline");
    const editing = this.editing === field;
    const content = editing ? html`
      <input name=${field} aria-label=${label} maxlength="500" ?required=${field === "name"}
        .value=${this.#draft} ?readonly=${this.saving} @input=${this.#onIdentityInput} />
    ` : value || (this.authenticated ? this.#ui.t("dashboard.taglinePlaceholder") : "");
    const text = field === "name" ? html`<h1 id="campaign-title">${content}</h1>` : html`<p>${content}</p>`;
    return editing ? html`
      <form class=${`campaign-identity-form identity-${field}`} @submit=${this.#saveIdentity} @keydown=${this.#identityKey}>
        ${text}
        <div class="identity-actions">
          <button type="submit" ?disabled=${this.saving}>${this.#ui.t(this.saving ? "dashboard.saving" : "dashboard.save")}</button>
          <button type="button" @click=${this.#cancelIdentity} ?disabled=${this.saving}>${this.#ui.t("dashboard.cancel")}</button>
        </div>
      </form>` : html`
      <div class="campaign-identity-row">
        ${text}
        <button class="campaign-identity-pen" type="button" aria-label=${label}
          title=${this.authenticated && !this.canManageCampaign ? this.#ui.t("dashboard.dmIdentity") : label}
          ?disabled=${this.saving || this.editing !== undefined || (this.authenticated && !this.canManageCampaign)}
          @click=${() => this.#startIdentity(field, value)}>✏</button>
      </div>`;
  }

  async #startIdentity(field: CampaignIdentityField, value: string): Promise<void> {
    if (!this.authenticated) { this.#requestSignIn(); return; }
    if (!this.canManageCampaign || this.saving || this.editing !== undefined || this.campaign === undefined) return;
    this.#expectedRevision = campaignIdentityRecord(this.campaign)?.revision ?? 0;
    this.#original = value;
    this.#draft = value;
    this.editing = field;
    await this.updateComplete;
    const input = this.querySelector<HTMLInputElement>(".campaign-identity-form input");
    input?.focus();
    input?.setSelectionRange(value.length, value.length);
  }

  readonly #onIdentityInput = (event: Event): void => {
    this.#draft = (event.currentTarget as HTMLInputElement).value;
    this.#setDirty(this.#draft !== this.#original);
  };

  readonly #identityKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.#cancelIdentity();
    }
    if (event.key === "Enter" && event.isComposing) event.preventDefault();
  };

  readonly #cancelIdentity = (): void => {
    if (!this.saving && confirmDiscardUnsavedEdit(this.#dirty, (message) => window.confirm(message))) {
      void this.#closeIdentity();
    }
  };

  async #closeIdentity(): Promise<void> {
    const field = this.editing;
    this.editing = undefined;
    this.#setDirty(false);
    await this.updateComplete;
    this.querySelector<HTMLButtonElement>(`.campaign-identity-row:${field === "name" ? "first" : "last"}-of-type .campaign-identity-pen`)?.focus();
  }

  readonly #saveIdentity = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!this.canManageCampaign || this.saving || this.editing === undefined) return;
    if (!this.#dirty) { void this.#closeIdentity(); return; }
    this.dispatchEvent(new CustomEvent<CampaignIdentitySaveDetail>("campaign-identity-save", {
      detail: Object.freeze({ field: this.editing, value: this.#draft, expectedRevision: this.#expectedRevision }),
      bubbles: true, composed: true,
    }));
  };

  #setDirty(dirty: boolean): void {
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty }, bubbles: true, composed: true }));
  }

  #requestSignIn(): void {
    this.dispatchEvent(new CustomEvent("campaign-sign-in", { bubbles: true, composed: true }));
  }

  readonly #addPartyMember = (): void => {
    if (this.saving) return;
    if (!this.authenticated) { this.#requestSignIn(); return; }
    window.location.hash = "#/party/new";
  };

  #partyPage(model: DashboardModel) {
    return html`
      <article class="campaign-dashboard party-page" aria-labelledby="party-title">
        <header class="page-heading">
          <a href="#/" class="breadcrumb-link">${this.#ui.t("dashboard.campaignOverview")}</a>
          <h1 id="party-title">${this.#ui.t("dashboard.partyTitle")}</h1>
          <p>${this.#ui.t("dashboard.partyIntro")}</p>
        </header>
        ${this.#partySection(model, false)}
      </article>
    `;
  }

  #partySection(model: DashboardModel, compact: boolean) {
    const empty = model.party.length === 0 && model.companions.length === 0;
    return html`
      <section class="chronicle-section party-section" aria-labelledby="party-heading">
        <div class="section-heading">
          <h2 id="party-heading"><span aria-hidden="true">${model.partyIdentity.badge}</span> ${model.partyIdentity.name}</h2>
          <div class="party-section-actions">
            ${compact ? html`<a href="#/party">${this.#ui.t("dashboard.openRoster")}</a>` : nothing}
            <button class="party-add" type="button" title=${this.#ui.t("dashboard.addPartyMember")}
              @click=${this.#addPartyMember} ?disabled=${this.saving}>＋ ${this.#ui.t("dashboard.add")}</button>
          </div>
        </div>
        ${empty
          ? html`<p class="empty-state">${this.#ui.t("dashboard.emptyParty")}</p>`
          : html`
            <div class="party-roster">
              ${model.party.map((member) => this.#partyMember(member))}
              ${model.companions.map((companion) => this.#companion(companion))}
            </div>
          `}
      </section>
    `;
  }

  #partyMember(member: EntitySummary) {
    return html`
      <a class="party-member" href=${member.route}>
        ${portrait(member)}
        <span class="party-member-copy">
          <strong>${member.status === "" ? nothing : html`<i class=${`status-mark status-${safeToken(member.status)}`} title=${member.statusLabel}></i>`}${member.name}</strong>
          ${member.title === "" ? nothing : html`<span>${member.title}</span>`}
        </span>
      </a>
    `;
  }

  #companion(companion: EntitySummary) {
    return html`
      <a class="companion" href=${companion.route}>
        <span class="companion-mark" aria-hidden="true">${companion.portrait === undefined ? companion.icon ?? "🐾" : html`<img src=${previewResourceURL(companion.portrait)} alt="" loading="lazy" />`}</span>
        <strong>${companion.name}</strong>
        ${companion.title === "" ? nothing : html`<span>${companion.title}</span>`}
      </a>
    `;
  }

  #lastSession(model: DashboardModel) {
    return html`
      <section class="chronicle-section session-section" aria-labelledby="session-heading">
        <div class="section-heading">
          <h2 id="session-heading"><span aria-hidden="true">🕯</span> ${this.#ui.t("dashboard.lastSession")}</h2>
          ${model.lastSession === undefined ? nothing : html`<span class="session-number">${this.#ui.t("dashboard.session", { n: model.lastSession })}</span>`}
        </div>
        ${model.lastSession === undefined ? html`<p class="empty-state">${this.#ui.t("dashboard.emptySession")} <a href="#/timeline">${this.#ui.t("dashboard.openTimeline")}</a></p>` : html`<ol class="session-events">
          ${model.lastSessionEvents.map((event) => this.#sessionEvent(event))}
        </ol>`}
      </section>
    `;
  }

  #sessionEvent(event: DashboardEvent) {
    const references = [
      event.characters > 0 ? this.#ui.plural("dashboard.characterCount", event.characters) : "",
      event.locations > 0 ? this.#ui.plural("dashboard.placeCount", event.locations) : "",
    ].filter((value) => value !== "");
    return html`
      <li>
        <a href=${event.route}>
          <strong>${event.name}</strong>
          ${event.excerpt === "" ? nothing : html`<span>${event.excerpt}</span>`}
          ${references.length === 0 ? nothing : html`<small>${references.join(" · ")}</small>`}
        </a>
      </li>
    `;
  }

  #recent(model: DashboardModel) {
    if (model.recent.length === 0 && !this.authenticated) return nothing;
    return html`
      <section class="chronicle-section recent-section" aria-labelledby="recent-heading">
        <div class="section-heading"><h2 id="recent-heading"><span aria-hidden="true">🕘</span> ${this.#ui.t("dashboard.recent")}</h2></div>
        ${model.recent.length === 0 ? html`<p class="empty-state">${this.#ui.t("dashboard.emptyRecent")}</p>` : html`<div class="recent-ledger">
          ${model.recent.map((entity) => html`
            <a href=${entity.route}>
              <span><i class="recent-kind" aria-hidden="true">${campaignPages.find(page => entity.route.startsWith(`#/${page.id}/`))?.icon ?? "📜"}</i>${entity.name}</span>
              <time datetime=${entity.updatedAt ?? ""}>${this.#ui.relativeDate(entity.updatedAt)}</time>
            </a>
          `)}
        </div>`}
      </section>
    `;
  }

}

function portrait(entity: EntitySummary) {
  const style = entity.attitudeRing === undefined ? nothing : `--attitude-ring: ${entity.attitudeRing}`;
  if (entity.portrait !== undefined) {
    return html`<span class="party-portrait" style=${style}><img src=${previewResourceURL(entity.portrait)} alt="" loading="lazy" /></span>`;
  }
  return html`<span class="party-portrait portrait-fallback" style=${style} aria-hidden="true">${entity.icon ?? "🛡"}</span>`;
}

function safeToken(value: string): string {
  return /^[a-z][a-z0-9-]*$/u.test(value) ? value : "unknown";
}

if (!customElements.get("codex-dashboard")) {
  customElements.define("codex-dashboard", CodexDashboard);
}
