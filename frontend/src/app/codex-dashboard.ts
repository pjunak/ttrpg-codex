import { previewResourceURL } from "../core/player-preview.js";
import { cardEditLink } from "../ui/card-actions.js";
import { artwork } from "../ui/artwork.js";
import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import {
  projectCampaignIdentity,
  projectDashboard,
  type DashboardEvent,
  type DashboardModel,
  type EntitySummary,
} from "./campaign-projection.js";
import { campaignPages, parseAppRoute, recordEditHash } from "./routes.js";
import { describeActivity } from "./campaign-activity.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { campaignIdentityRecord, type CampaignIdentityField } from "./campaign-identity.js";
import { reportEditState } from "./unsaved-edit.js";
import { pencilIcon } from "./edit-icon.js";
import { saveCampaign } from "./campaign-writes.js";
import { InlineDraftController, type InlineDraft } from "./inline-draft.js";
import type { InlineControl } from "./codex-inline-field.js";
import "./codex-inline-field.js";

export class CodexDashboard extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    partyOnly: { type: Boolean },
    canManageCampaign: { type: Boolean },
    authenticated: { type: Boolean },
    canEdit: { type: Boolean },
    busy: { type: Boolean },
  };

  declare campaign: CampaignDataset | undefined;
  declare partyOnly: boolean;
  declare canManageCampaign: boolean;
  declare authenticated: boolean;
  declare canEdit: boolean;
  /** The app is saving or otherwise busy, so no write may start. */
  declare busy: boolean;
  /** The name and tagline edited in place; one of them at a time. */
  readonly #identity = new InlineDraftController(this);
  #dirty = false;
  readonly #ui = new UiLocalizationController(this);

  constructor() {
    super();
    this.campaign = undefined;
    this.partyOnly = false;
    this.canManageCampaign = false;
    this.authenticated = false;
    this.canEdit = false;
    this.busy = false;
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
    if (changed.has("partyOnly") || (changed.has("canManageCampaign") && !this.canManageCampaign))
      this.#identity.discardAll();
  }

  protected override updated(): void {
    if (this.#identity.dirty === this.#dirty) return;
    this.#dirty = this.#identity.dirty;
    reportEditState(this, { dirty: this.#dirty });
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
    const shown = value || (this.authenticated ? this.#ui.t("dashboard.taglinePlaceholder") : "");
    const text =
      field === "name"
        ? html`<h1 id="campaign-title">${shown}</h1>`
        : html`<p class=${value ? "" : "is-placeholder"}>${shown}</p>`;
    if (this.canManageCampaign) {
      // The identity saves as one record, so only one of its fields is open at a time.
      const other = this.#identity.drafts.length > 0 && this.#identity.get(field) === undefined;
      const control: InlineControl = { kind: "text", maxLength: 500, required: field === "name" };
      return html`<codex-inline-field class=${`campaign-identity-row identity-${field}`}
        .name=${field} .label=${label} .editLabel=${label} .value=${value} .display=${text} linked
        .control=${control} .commit=${"explicit"} .canEdit=${true} ?disabled=${other}
        .draft=${this.#identity.get(field)} .begin=${() => this.#openIdentity(field)}></codex-inline-field>`;
    }
    // Others see the pencil too: it asks visitors to sign in and tells players who edits.
    return html`
      <div class="campaign-identity-row">
        ${text}
        <button class="campaign-identity-pen inline-edit-button" type="button" aria-label=${label}
          title=${this.authenticated ? this.#ui.t("dashboard.dmIdentity") : label}
          ?disabled=${this.busy || this.authenticated}
          @click=${() => this.#requestSignIn()}>${pencilIcon()}</button>
      </div>`;
  }

  #openIdentity(field: CampaignIdentityField): InlineDraft {
    const saved = () => ({
      base:
        this.campaign === undefined ? 0 : (campaignIdentityRecord(this.campaign)?.revision ?? 0),
      value: this.campaign === undefined ? "" : projectCampaignIdentity(this.campaign)[field],
    });
    return this.#identity.open(field, () => ({
      ...saved(),
      current: saved,
      rebase: (result) => campaignIdentityRecord(result.campaign)?.revision ?? 0,
      save: (value, base) =>
        saveCampaign(this, "identity", {
          field,
          value: String(value),
          expectedRevision: base as number,
        }),
      required: field === "name",
    }));
  }

  #requestSignIn(): void {
    this.dispatchEvent(new CustomEvent("campaign-sign-in", { bubbles: true, composed: true }));
  }

  readonly #addPartyMember = (): void => {
    if (this.busy) return;
    if (!this.authenticated) {
      this.#requestSignIn();
      return;
    }
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
              @click=${this.#addPartyMember} ?disabled=${this.busy}>＋ ${this.#ui.t("dashboard.add")}</button>
          </div>
        </div>
        ${
          empty
            ? html`<p class="empty-state">${this.#ui.t("dashboard.emptyParty")}</p>`
            : html`
            <div class="party-roster">
              ${model.party.map((member) => this.#partyMember(member))}
              ${model.companions.map((companion) => this.#companion(companion))}
            </div>
          `
        }
      </section>
    `;
  }

  #cardEdit(entity: EntitySummary) {
    const route = parseAppRoute(entity.route);
    return this.canEdit && route.kind === "record"
      ? cardEditLink(
          recordEditHash(route.page, route.key, this.partyOnly ? "#/party" : "#/"),
          uiText("Edit {0}", { "0": entity.name }),
        )
      : nothing;
  }

  #partyMember(member: EntitySummary) {
    return html`<div class="party-record-card ui-card">
      <a class="party-member" href=${member.route}>
        ${portrait(member)}
        <span class="party-member-copy">
          <strong>${member.status === "" ? nothing : html`<i class=${`status-mark status-${safeToken(member.status)}`} title=${member.statusLabel}></i>`}${member.name}</strong>
          ${member.title === "" ? nothing : html`<span>${member.title}</span>`}
        </span>
      </a>${this.#cardEdit(member)}
    </div>`;
  }

  #companion(companion: EntitySummary) {
    return html`<div class="party-record-card ui-card">
      <a class="companion" href=${companion.route}>
        ${artwork({ source: previewResourceURL(companion.portrait), className: "companion-mark", fallback: companion.icon ?? "🐾", loading: "lazy" })}
        <strong>${companion.name}</strong>
        ${companion.title === "" ? nothing : html`<span>${companion.title}</span>`}
      </a>${this.#cardEdit(companion)}
    </div>`;
  }

  #lastSession(model: DashboardModel) {
    return html`
      <section class="chronicle-section session-section" aria-labelledby="session-heading">
        <div class="section-heading">
          <h2 id="session-heading"><span aria-hidden="true">🕯</span> ${this.#ui.t("dashboard.lastSession")}</h2>
          ${model.lastSession === undefined ? nothing : html`<span class="session-number">${this.#ui.t("dashboard.session", { n: model.lastSession })}</span>`}
        </div>
        ${
          model.lastSession === undefined
            ? html`<p class="empty-state">${this.#ui.t("dashboard.emptySession")} <a href="#/timeline">${this.#ui.t("dashboard.openTimeline")}</a></p>`
            : html`<ol class="session-events">
          ${model.lastSessionEvents.map((event) => this.#sessionEvent(event))}
        </ol>`
        }
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
        ${
          model.recent.length === 0
            ? html`<p class="empty-state">${this.#ui.t("dashboard.emptyRecent")}</p>`
            : html`<div class="recent-ledger">
          ${model.recent.map(
            (entity) => html`
            <a href=${entity.route}>
              <span><i class="recent-kind" aria-hidden="true">${campaignPages.find((page) => entity.route.startsWith(`#/${page.id}/`))?.icon ?? "📜"}</i>${entity.name}
                <small class="recent-summary">${describeActivity(this.campaign!, entity)}</small></span>
              <time datetime=${entity.updatedAt ?? ""}>${this.#ui.relativeDate(entity.updatedAt)}</time>
            </a>
          `,
          )}
        </div>`
        }
      </section>
    `;
  }
}

function portrait(entity: EntitySummary) {
  return artwork({
    source: previewResourceURL(entity.portrait),
    className: `party-portrait${entity.portrait === undefined ? " portrait-fallback" : ""}`,
    fallback: entity.icon ?? "🛡",
    style:
      entity.attitudeRing === undefined ? undefined : `--attitude-ring: ${entity.attitudeRing}`,
    loading: "lazy",
  });
}

function safeToken(value: string): string {
  return /^[a-z][a-z0-9-]*$/u.test(value) ? value : "unknown";
}

if (!customElements.get("codex-dashboard")) {
  customElements.define("codex-dashboard", CodexDashboard);
}
