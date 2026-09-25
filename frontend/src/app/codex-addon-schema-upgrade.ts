import { LitElement, html, nothing, type PropertyValues } from "lit";
import { AddonAdminClient } from "../core/addon-admin.js";
import type { SchemaReview } from "../core/addon-schema-upgrade.js";
import { UiLocalizationController } from "./ui-localization.js";
import { uiRequestError } from "./ui-errors.js";

export class CodexAddonSchemaUpgrade extends LitElement {
  static override properties = { csrfToken: { attribute: false }, addonId: {}, generationId: {}, active: { type: Boolean }, disabled: { type: Boolean },
    review: { state: true }, pending: { state: true }, error: { state: true }, uncertain: { state: true } };
  declare csrfToken: string;
  declare addonId: string;
  declare generationId: string;
  declare active: boolean;
  declare disabled: boolean;
  declare private review: SchemaReview | undefined;
  declare private pending: boolean;
  declare private error: string;
  declare private uncertain: boolean;
  #request = new AbortController();
  readonly #ui = new UiLocalizationController(this);
  constructor() { super(); this.csrfToken = ""; this.addonId = ""; this.generationId = ""; this.active = false; this.disabled = false; this.pending = false; this.error = ""; this.uncertain = false; }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void { this.#request.abort(); this.#busy(false); super.disconnectedCallback(); }
  override connectedCallback(): void { super.connectedCallback(); if (this.#request.signal.aborted) { this.#request = new AbortController(); this.pending = false; } }
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("addonId") || changed.has("generationId")) {
      this.#request.abort(); this.#request = new AbortController(); this.review = undefined; this.pending = false; this.error = ""; this.uncertain = false;
    }
  }
  protected override render() {
    const t = this.#ui.t.bind(this.#ui), review = this.review, busy = this.pending || this.disabled;
    return html`<section class="addon-review addon-schema-review" aria-busy=${this.pending}>
      <h4 tabindex="-1" data-schema-title>${t("schema.title")}</h4>
      ${this.active ? html`<p>${t("schema.disable")}</p>` : html`<p>${t("schema.help")}</p>
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        ${this.uncertain ? html`<p role="status">${t("schema.uncertain")}</p>` : nothing}
        ${review ? html`
          <p>${t("schema.values", { count: review.documents })}</p>
          ${review.blockers.length ? html`<p role="alert">${t("schema.blocked")}</p><ul>${review.blockers.map(b => html`<li>${b.dataId}<details><summary>${b.code}</summary>${b.message}</details></li>`)}</ul>` : nothing}
          ${review.changes.length ? html`<h5>${t("schema.changes")}</h5><ul>${review.changes.map(c => html`<li>${c.dataId}: ${c.fromVersion} → ${c.toVersion} · ${t("schema.count", { count: c.documents })}</li>`)}</ul>` : html`<p>${t("schema.empty")}</p>`}
          <details><summary>${t("schema.details")}</summary><code>${review.reviewSha256}</code><ul>${review.changes.map(c => html`<li>${c.dataId}<p><code>${c.fromSha256}</code> → <code>${c.toSha256}</code></p></li>`)}</ul></details>
          <p>${t("schema.recoveryHelp")}</p>
          <a href=${`/api/admin/addon-schema-reviews/${encodeURIComponent(review.reviewId)}/recovery`} download>${t("schema.recovery")}</a>
          ${review.status === "applied" ? html`<p role="status">${t("schema.done")}</p><button ?disabled=${busy} @click=${() => this.dispatchEvent(new CustomEvent("schema-upgrade-applied", { bubbles: true, composed: true }))}>${t("schema.activate")}</button>`
          : html`<p>${t("schema.expiry", { date: new Date(review.expiresAt).toLocaleString(document.documentElement.lang) })}</p><div class="addon-actions">
            <button ?disabled=${busy || this.uncertain || !!review.blockers.length || !review.changes.length} @click=${() => this.#apply(review)}>${t("schema.apply")}</button>
            <button ?disabled=${busy} @click=${() => this.#run(client => client.checkSchema(review))}>${t("schema.check")}</button>
            <button ?disabled=${busy || this.uncertain} @click=${() => this.#prepare()}>${t("schema.new")}</button>
          </div>`}
        ` : html`<button ?disabled=${busy} @click=${() => this.#prepare()}>${t("schema.prepare")}</button>`}
      `}
    </section>`;
  }
  #prepare(): void { void this.#run(client => client.reviewSchema({ addonId: this.addonId, generationId: this.generationId })); }
  #apply(review: SchemaReview): void { void this.#run(client => client.applySchema(review), true); }
  #busy(value: boolean): void { this.dispatchEvent(new CustomEvent("addon-schema-busy", { detail: value, bubbles: true, composed: true })); }
  async #run(operation: (client: AddonAdminClient) => Promise<SchemaReview>, applying = false): Promise<void> {
    if (this.pending || this.disabled || this.active) return;
    const request = this.#request; this.pending = true; this.error = ""; this.#busy(true);
    try { const review = await operation(new AddonAdminClient(this.csrfToken, request.signal)); if (!request.signal.aborted) { this.review = review; this.uncertain = false; } }
    catch (error) { if (!request.signal.aborted) { this.error = uiRequestError(error); if (applying) this.uncertain = true; } }
    finally { if (!request.signal.aborted) { this.pending = false; this.#busy(false); await this.updateComplete; this.querySelector<HTMLElement>("[data-schema-title]")?.focus(); } }
  }
}
customElements.define("codex-addon-schema-upgrade", CodexAddonSchemaUpgrade);
