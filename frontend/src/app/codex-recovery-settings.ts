import "./codex-package-storage.js";
import { LitElement, html, nothing } from "lit";
import { recoveryRequest, RecoveryRequestError, type RecoveryAction, type RecoveryListing, type RecoveryPoint } from "../core/recovery.js";
import { UiLocalizationController, type MessageKey } from "./ui-localization.js";

export class CodexRecoverySettings extends LitElement {
  static override properties = { csrfToken: { attribute: false }, listing: { state: true }, busy: { state: true }, message: { state: true }, review: { state: true } };
  declare csrfToken: string;
  declare listing: RecoveryListing | undefined;
  declare busy: boolean;
  declare message: MessageKey | undefined;
  declare review: { action: RecoveryAction; point: RecoveryPoint } | undefined;
  #ui = new UiLocalizationController(this);
  #abort = new AbortController();
  #packageBusy = false;
  #packagesReady = false;
  #failed = false;
  #reloadRequired = false;
  constructor() { super(); this.csrfToken = ""; this.busy = false; }
  protected override createRenderRoot(): HTMLElement { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#abort = new AbortController(); void this.#request(); }
  override disconnectedCallback(): void { this.#abort.abort(); this.review = undefined; this.busy = false; super.disconnectedCallback(); }
  protected override render() {
    const automatic = this.listing?.points.filter(point => point.reason === "save") ?? [];
    return html`<section class="settings-ledger settings-recovery-panel" aria-labelledby="recovery-title">
      <header class="settings-ledger-heading"><div><span class="settings-category-mark" aria-hidden="true">💾</span><div><h2 id="recovery-title">${this.#ui.t("recovery.title")}</h2></div></div>
        <div class="settings-recovery-actions">
          <a class="inline-create-btn" href="/api/backup" download>📥 ${this.#ui.t("recovery.download")}</a>
          <button type="button" ?disabled=${this.busy || !!this.review} @click=${() => void this.#request({ kind: "create" })}>＋ ${this.#ui.t("recovery.create")}</button>
          <button type="button" ?disabled=${this.busy || this.#packageBusy} @click=${() => void this.#request()}>↻ ${this.#ui.t("recovery.refresh")}</button>
        </div>
      </header>
      <p class="settings-hint">${this.#ui.t("recovery.intro")}</p>
      <p class="settings-hint">${this.#ui.t("recovery.offline")} <a href="https://github.com/pjunak/ttrpg-codex/blob/main/docs/SELF_HOSTING.md#verify-and-restore-a-full-backup" target="_blank" rel="noreferrer">${this.#ui.t("recovery.guide")}</a></p>
      ${this.busy ? html`<p role="status">${this.#ui.t("recovery.busy")}</p>` : nothing}
      ${this.message ? html`<p role=${this.#failed ? "alert" : "status"}>${this.#ui.t(this.message)}</p>` : nothing}
      ${this.review ? this.#reviewPanel() : html`
        <form class="settings-revert-row" @submit=${(event: SubmitEvent) => this.#revert(event, automatic)}>
          <label>${this.#ui.t("recovery.revertCount")} <input name="count" type="number" min="1" max=${Math.max(1, automatic.length)} value="1" required ?disabled=${this.busy || !automatic.length} /></label>
          <button type="submit" ?disabled=${this.busy || this.#reloadRequired || !automatic.length}>↶ ${this.#ui.t("recovery.revert")}</button>
        </form>
        ${this.listing ? html`<div class="settings-snapshots">${this.listing.points.length ? this.listing.points.slice(0, 12).map(point => this.#row(point)) : html`<p class="settings-empty">${this.#ui.t("recovery.empty")}</p>`}
          ${this.listing.points.length > 12 ? html`<details class="settings-snapshots-older"><summary>${this.#ui.t("recovery.older", { n: this.listing.points.length - 12 })}</summary>${this.listing.points.slice(12).map(point => this.#row(point))}</details>` : nothing}
        </div>` : nothing}
      `}
    </section>`;
  }
  #date(point: RecoveryPoint): string { return new Intl.DateTimeFormat(this.#ui.locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(point.createdAt)); }
  #row(point: RecoveryPoint) {
    const reason: MessageKey = point.reason === "manual" ? "recovery.manual" : point.reason === "pre-restore" ? "recovery.safety" : "recovery.edit";
    return html`<div class="settings-snapshot-row" data-point-id=${point.id}>
      <span aria-hidden="true">🕒</span><time datetime=${point.createdAt}>${this.#date(point)}</time><span class="settings-snapshot-reason">${this.#ui.t(reason)}</span>
      <span class="settings-row-usage">${Math.max(1, Math.round(point.bytes / 1024))} kB</span>
      <div class="settings-recovery-actions">
        <button type="button" class="settings-btn-edit" aria-label=${`${this.#ui.t("recovery.restore")} ${this.#date(point)}`} ?disabled=${this.busy || this.#reloadRequired} @click=${() => this.#review(point, "restore")}>↶</button>
        <button type="button" class="settings-btn-del" aria-label=${`${this.#ui.t("recovery.delete")} ${this.#date(point)}`} ?disabled=${this.busy || this.#reloadRequired} @click=${() => this.#review(point, "delete")}>🗑</button>
      </div></div>`;
  }
  #review(point: RecoveryPoint, kind: "restore" | "delete"): void {
    if (this.busy || !this.listing || this.#reloadRequired) return;
    this.#showReview(point, { kind, id: point.id, expectedRevision: this.listing.revision });
  }
  #showReview(point: RecoveryPoint, action: RecoveryAction): void {
    this.#packagesReady = false; this.#packageBusy = false;
    this.review = { point, action }; this.message = undefined;
    void this.updateComplete.then(() => this.querySelector<HTMLElement>("#recovery-review-title")?.focus());
  }
  #revert(event: SubmitEvent, points: readonly RecoveryPoint[]): void {
    event.preventDefault();
    const count = Number(new FormData(event.currentTarget as HTMLFormElement).get("count"));
    const point = points[count - 1];
    if (this.busy || this.#reloadRequired || !Number.isSafeInteger(count) || !point || !this.listing) return;
    this.#showReview(point, { kind: "revert", count, expectedRevision: this.listing.revision });
  }
  #reviewPanel() {
    const { point, action } = this.review!;
    const deleting = action.kind === "delete";
    return html`<section class="settings-recovery-review" aria-labelledby="recovery-review-title">
      <h3 id="recovery-review-title" tabindex="-1">${this.#ui.t(deleting ? "recovery.deleteReview" : "recovery.restoreReview")}</h3>
      <p>${this.#date(point)} · ${this.#ui.t("recovery.summary", { records: point.records, documents: point.documents, media: point.media })}</p>
      <p>${this.#ui.t(deleting ? "recovery.deleteEffect" : "recovery.restoreEffect")}</p>
      ${deleting ? nothing : html`<codex-package-storage .csrfToken=${this.csrfToken} .pointId=${point.id} .expectedRevision=${this.listing?.revision ?? 0} .disabled=${this.busy}
        @addon-storage-busy=${(event: CustomEvent<boolean>) => { this.#packageBusy = event.detail; this.requestUpdate(); this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty: false, saving: event.detail }, bubbles: true, composed: true })); }}
        @addon-storage-ready=${(event: CustomEvent<boolean>) => { this.#packagesReady = event.detail; this.requestUpdate(); }}></codex-package-storage>`}
      <div class="settings-recovery-actions"><button type="button" ?disabled=${this.busy || this.#packageBusy || !deleting && !this.#packagesReady} @click=${() => void this.#request(action)}>${this.#ui.t(deleting ? "recovery.delete" : "recovery.restore")}</button>
      <button type="button" ?disabled=${this.busy || this.#packageBusy} @click=${() => { this.review = undefined; }}>${this.#ui.t("recovery.cancel")}</button></div>
    </section>`;
  }
  async #request(action?: RecoveryAction): Promise<void> {
    if (this.busy || this.#packageBusy) return;
    const signal = this.#abort.signal;
    this.busy = true; this.message = undefined; this.#failed = false;
    this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty: false, saving: action !== undefined }, bubbles: true, composed: true }));
    try {
      const listing = await recoveryRequest(signal, this.csrfToken, action);
      if (signal.aborted) return;
      this.listing = listing; this.review = undefined; this.#reloadRequired = false;
      if (action) this.message = action.kind === "create" ? "recovery.created" : action.kind === "delete" ? "recovery.deleted" : "recovery.restored";
    } catch (error: unknown) {
      if (signal.aborted) return;
      this.#failed = true; this.review = undefined; this.#reloadRequired = true;
      const code = error instanceof RecoveryRequestError ? error.code : "failed";
      const keys: Readonly<Record<string, MessageKey>> = { conflict: "recovery.conflict", compatibility: "recovery.compatibility", forbidden: "recovery.forbidden", missing: "recovery.missing" };
      this.message = keys[code] ?? "recovery.failed";
    } finally {
      if (!signal.aborted) {
        this.busy = false;
        this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty: false, saving: false }, bubbles: true, composed: true }));
      }
    }
  }
}
if (!customElements.get("codex-recovery-settings")) customElements.define("codex-recovery-settings", CodexRecoverySettings);
