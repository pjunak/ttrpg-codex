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

export class CodexDashboard extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    partyOnly: { type: Boolean },
  };

  declare campaign: CampaignDataset | undefined;
  declare partyOnly: boolean;
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    this.campaign = undefined;
    this.partyOnly = false;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  protected override render() {
    if (this.campaign === undefined) return nothing;
    const model = projectDashboard(this.campaign);
    return this.partyOnly ? this.#partyPage(model) : this.#dashboard(model);
  }

  #dashboard(model: DashboardModel) {
    return html`
      <article class="campaign-dashboard" aria-labelledby="campaign-title">
        <header class="campaign-title-page">
          <h1 id="campaign-title">${model.identity.name}</h1>
          <p>${model.identity.tagline || this.#ui.t("dashboard.taglinePlaceholder")}</p>
          <span class="campaign-title-rule" aria-hidden="true"></span>
        </header>

        ${this.#partySection(model, true)}
        ${this.#lastSession(model)}
        ${this.#recent(model)}
      </article>
    `;
  }

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
          <h2 id="party-heading"><span aria-hidden="true">🛡</span> ${this.#ui.t("dashboard.company")}</h2>
          ${compact ? html`<a href="#/party">${this.#ui.t("dashboard.openRoster")}</a>` : nothing}
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
        <span class="companion-mark" aria-hidden="true">${companion.portrait === undefined ? companion.icon ?? "🐾" : html`<img src=${companion.portrait} alt="" loading="lazy" />`}</span>
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
        ${model.lastSession === undefined ? html`<p class="empty-state">${this.#ui.t("dashboard.emptySession")} <a href="#/events">${this.#ui.t("dashboard.openTimeline")}</a></p>` : html`<ol class="session-events">
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
    if (model.recent.length === 0) return nothing;
    return html`
      <section class="chronicle-section recent-section" aria-labelledby="recent-heading">
        <div class="section-heading"><h2 id="recent-heading"><span aria-hidden="true">🕘</span> ${this.#ui.t("dashboard.recent")}</h2></div>
        <div class="recent-ledger">
          ${model.recent.map((entity) => html`
            <a href=${entity.route}>
              <span><i class="recent-kind" aria-hidden="true">${campaignPages.find(page => entity.route.startsWith(`#/${page.id}/`))?.icon ?? "📜"}</i>${entity.name}</span>
              <time datetime=${entity.updatedAt ?? ""}>${this.#ui.relativeDate(entity.updatedAt)}</time>
            </a>
          `)}
        </div>
      </section>
    `;
  }

}

function portrait(entity: EntitySummary) {
  const style = entity.attitudeRing === undefined ? nothing : `--attitude-ring: ${entity.attitudeRing}`;
  if (entity.portrait !== undefined) {
    return html`<span class="party-portrait" style=${style}><img src=${entity.portrait} alt="" loading="lazy" /></span>`;
  }
  return html`<span class="party-portrait portrait-fallback" style=${style} aria-hidden="true">${entity.icon ?? "🛡"}</span>`;
}

function safeToken(value: string): string {
  return /^[a-z][a-z0-9-]*$/u.test(value) ? value : "unknown";
}

if (!customElements.get("codex-dashboard")) {
  customElements.define("codex-dashboard", CodexDashboard);
}
