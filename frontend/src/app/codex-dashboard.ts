import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import {
  projectDashboard,
  type DashboardEvent,
  type DashboardModel,
  type EntitySummary,
} from "./campaign-projection.js";
import { campaignPages, collectionHash } from "./routes.js";

export class CodexDashboard extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    partyOnly: { type: Boolean },
  };

  declare campaign: CampaignDataset | undefined;
  declare partyOnly: boolean;

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
          ${model.identity.tagline === "" ? nothing : html`<p>${model.identity.tagline}</p>`}
          <span class="campaign-title-rule" aria-hidden="true"></span>
        </header>

        ${this.#partySection(model, true)}
        ${this.#lastSession(model)}
        ${this.#recent(model)}
        ${this.#archiveIndex(model)}
      </article>
    `;
  }

  #partyPage(model: DashboardModel) {
    return html`
      <article class="campaign-dashboard party-page" aria-labelledby="party-title">
        <header class="page-heading">
          <a href="#/" class="breadcrumb-link">Campaign overview</a>
          <h1 id="party-title">The party</h1>
          <p>The adventurers and companions at the center of the campaign.</p>
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
          <h2 id="party-heading">The company</h2>
          ${compact ? html`<a href="#/party">Open party roster</a>` : nothing}
        </div>
        ${empty
          ? html`<p class="empty-state">No party members have been recorded yet.</p>`
          : html`
            <div class="party-roster">
              ${model.party.map((member) => this.#partyMember(member))}
            </div>
            ${model.companions.length === 0 ? nothing : html`
              <div class="companion-roster" aria-label="Party companions">
                ${model.companions.map((companion) => this.#companion(companion))}
              </div>
            `}
          `}
      </section>
    `;
  }

  #partyMember(member: EntitySummary) {
    return html`
      <a class="party-member" href=${member.route}>
        ${portrait(member)}
        <span class="party-member-copy">
          <strong>${member.name}</strong>
          ${member.title === "" ? nothing : html`<span>${member.title}</span>`}
        </span>
        ${member.status === "" ? nothing : html`
          <span class=${`status-mark status-${safeToken(member.status)}`} title=${member.status}></span>
        `}
      </a>
    `;
  }

  #companion(companion: EntitySummary) {
    return html`
      <a class="companion" href=${companion.route}>
        <span class="companion-mark" aria-hidden="true">${companion.icon ?? "♞"}</span>
        <span><strong>${companion.name}</strong>${companion.title === "" ? nothing : ` · ${companion.title}`}</span>
      </a>
    `;
  }

  #lastSession(model: DashboardModel) {
    if (model.lastSession === undefined) return nothing;
    return html`
      <section class="chronicle-section session-section" aria-labelledby="session-heading">
        <div class="section-heading">
          <h2 id="session-heading">Last session</h2>
          <a href="#/events">Open timeline</a>
        </div>
        <div class="session-number">Session ${model.lastSession}</div>
        <ol class="session-events">
          ${model.lastSessionEvents.map((event) => this.#sessionEvent(event))}
        </ol>
      </section>
    `;
  }

  #sessionEvent(event: DashboardEvent) {
    const references = [
      event.characters > 0 ? `${event.characters} ${event.characters === 1 ? "character" : "characters"}` : "",
      event.locations > 0 ? `${event.locations} ${event.locations === 1 ? "place" : "places"}` : "",
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
        <div class="section-heading"><h2 id="recent-heading">Recently changed</h2></div>
        <div class="recent-ledger">
          ${model.recent.map((entity) => html`
            <a href=${entity.route}>
              <span>${entity.name}</span>
              <time datetime=${entity.updatedAt ?? ""}>${relativeDate(entity.updatedAt)}</time>
            </a>
          `)}
        </div>
      </section>
    `;
  }

  #archiveIndex(model: DashboardModel) {
    return html`
      <nav class="archive-index" aria-label="Campaign archive index">
        <h2>Campaign archive</h2>
        <div>
          ${campaignPages.map((page) => html`
            <a href=${collectionHash(page)}>
              <span class="archive-index-icon" aria-hidden="true">${page.icon}</span>
              <span>${page.plural}</span>
              <strong>${model.counts[page.id] ?? 0}</strong>
            </a>
          `)}
        </div>
      </nav>
    `;
  }
}

function portrait(entity: EntitySummary) {
  const style = entity.attitudeRing === undefined ? nothing : `--attitude-ring: ${entity.attitudeRing}`;
  if (entity.portrait !== undefined) {
    return html`<span class="party-portrait" style=${style}><img src=${entity.portrait} alt="" loading="lazy" /></span>`;
  }
  const initial = [...entity.name.trim()][0]?.toLocaleUpperCase() ?? "?";
  return html`<span class="party-portrait portrait-fallback" style=${style} aria-hidden="true">${initial}</span>`;
}

function safeToken(value: string): string {
  return /^[a-z][a-z0-9-]*$/u.test(value) ? value : "unknown";
}

function relativeDate(value: string | undefined): string {
  if (value === undefined) return "";
  const instant = Date.parse(value);
  const elapsed = Date.now() - instant;
  if (!Number.isFinite(elapsed) || elapsed < 0) return new Date(instant).toLocaleDateString();
  const days = Math.floor(elapsed / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(instant).toLocaleDateString();
}

if (!customElements.get("codex-dashboard")) {
  customElements.define("codex-dashboard", CodexDashboard);
}
