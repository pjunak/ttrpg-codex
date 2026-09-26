import { LitElement, html, nothing } from "lit";
import { UIControlsController } from "../ui/controller.js";
import { recoveryRequest, RecoveryRequestError, type RecoveryAction, type RecoveryListing, type RecoveryPoint, type RecoveryScope } from "../core/recovery.js";
import { UiLocalizationController, type MessageKey } from "./ui-localization.js";

export class CodexRecoverySettings extends LitElement {
  static override properties = { csrfToken: { attribute: false }, listing: { state: true }, busy: { state: true }, message: { state: true }, review: { state: true }, selection: { state: true } };
  declare private selection: string;
  declare csrfToken: string;
  declare listing: RecoveryListing | undefined;
  declare busy: boolean;
  declare message: MessageKey | undefined;
  declare review: { action: RecoveryAction; point: RecoveryPoint } | undefined;
  #ui = new UiLocalizationController(this);
  #abort = new AbortController();
  #failed = false;
  #reloadRequired = false;
  constructor() { super(); new UIControlsController(this); this.csrfToken = ""; this.busy = false; this.selection = "campaign"; }
  protected override createRenderRoot(): HTMLElement { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#abort = new AbortController(); void this.#request(); }
  override disconnectedCallback(): void { this.#abort.abort(); this.review = undefined; this.busy = false; super.disconnectedCallback(); }
  protected override render() {
    const scope = this.#scope();
    const points = this.listing?.points.filter(point => scope.scope === "campaign" ? point.campaignAvailable : point.addons.some(addon => addon.addonId === scope.addonId)) ?? [];
    const automatic = points.filter(point => point.reason === "save");
    const addons = [...new Set(this.listing?.points.flatMap(point => point.addons.map(addon => addon.addonId)) ?? [])].sort();
    return html`<section class="settings-ledger settings-recovery-panel" aria-labelledby="recovery-title">
      <header class="settings-ledger-heading"><div><span class="settings-category-mark" aria-hidden="true">💾</span><div><h2 id="recovery-title">${this.#ui.t("recovery.title")}</h2></div></div>
        <div class="settings-recovery-actions">
          <a class="inline-create-btn" href="/api/backup" download>📥 ${this.#ui.t("recovery.download")}</a>
          <button type="button" ?disabled=${this.busy || !!this.review} @click=${() => void this.#request({ kind: "create" })}>＋ ${this.#ui.t("recovery.create")}</button>
          <button type="button" ?disabled=${this.busy} @click=${() => void this.#request()}>↻ ${this.#ui.t("recovery.refresh")}</button>
        </div>
      </header>
      <p class="settings-hint">${this.#ui.t("recovery.intro")}</p>
      <div class="settings-revert-row" data-ui-toolbar><label data-ui-field><span>${this.#ui.t("recovery.scope")}</span><select id="recovery-scope" .value=${this.selection} ?disabled=${this.busy || !!this.review} @change=${(event: Event) => { this.selection = (event.target as HTMLSelectElement).value; }}>
        <option value="campaign">${this.#ui.t("recovery.campaign")}</option>
        ${addons.map(addon => html`<option value=${`addon:${addon}`}>${this.#ui.t("recovery.addon", { addon })}</option>`)}
      </select></label></div>
      <p class="settings-hint">${this.#ui.t("recovery.offline")} <a href="https://github.com/pjunak/ttrpg-codex/blob/main/docs/SELF_HOSTING.md#verify-and-restore-a-full-backup" target="_blank" rel="noreferrer">${this.#ui.t("recovery.guide")}</a></p>
      ${this.busy ? html`<p role="status">${this.#ui.t("recovery.busy")}</p>` : nothing}
      ${this.message ? html`<p role=${this.#failed ? "alert" : "status"}>${this.#ui.t(this.message)}</p>` : nothing}
      ${this.review ? this.#reviewPanel() : html`
        <form class="settings-revert-row" @submit=${(event: SubmitEvent) => this.#revert(event, automatic)}>
          <label>${this.#ui.t("recovery.revertCount")} <input name="count" type="number" min="1" max=${Math.max(1, automatic.length)} value="1" required ?disabled=${this.busy || !automatic.length} /></label>
          <button type="submit" ?disabled=${this.busy || this.#reloadRequired || !automatic.length}>↶ ${this.#ui.t("recovery.revert")}</button>
        </form>
        ${this.listing ? html`<div class="settings-snapshots">${points.length ? points.slice(0, 12).map(point => this.#row(point)) : html`<p class="settings-empty">${this.#ui.t("recovery.empty")}</p>`}
          ${points.length > 12 ? html`<details class="settings-snapshots-older"><summary>${this.#ui.t("recovery.older", { n: points.length - 12 })}</summary>${points.slice(12).map(point => this.#row(point))}</details>` : nothing}
        </div>` : nothing}
      `}
    </section>`;
  }
  #date(point: RecoveryPoint): string { return new Intl.DateTimeFormat(this.#ui.locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(point.createdAt)); }
  #scope(): RecoveryScope { return this.selection.startsWith("addon:") ? { scope: "addon", addonId: this.selection.slice(6) } : { scope: "campaign" }; }
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
    this.#showReview(point, { kind, id: point.id, expectedRevision: this.listing.revision, ...this.#scope() });
  }
  #showReview(point: RecoveryPoint, action: RecoveryAction): void {
    this.review = { point, action }; this.message = undefined;
    void this.updateComplete.then(() => { this.querySelector<HTMLElement>("#recovery-review-title")?.focus(); this.querySelector(".settings-recovery-review")?.scrollIntoView({ block: "center" }); });
  }
  #closeReview(): void {
    const previous = this.review;
    this.review = undefined;
    if (previous) void this.updateComplete.then(() => {
      if (!this.isConnected) return;
      const button = this.querySelector<HTMLButtonElement>(`[data-point-id="${previous.point.id}"] .settings-btn-${previous.action.kind === "delete" ? "del" : "edit"}`);
      (button && !button.disabled ? button : this.querySelector<HTMLElement>("#recovery-scope"))?.focus({ preventScroll: true });
    });
  }
  #revert(event: SubmitEvent, points: readonly RecoveryPoint[]): void {
    event.preventDefault();
    const count = Number(new FormData(event.currentTarget as HTMLFormElement).get("count"));
    const point = points[count - 1];
    if (this.busy || this.#reloadRequired || !Number.isSafeInteger(count) || !point || !this.listing) return;
    this.#showReview(point, { kind: "revert", count, expectedRevision: this.listing.revision, ...this.#scope() });
  }
  #reviewPanel() {
    const { point, action } = this.review!;
    const deleting = action.kind === "delete";
    const scope = this.#scope();
    const addon = scope.scope === "addon" ? point.addons.find(addon => addon.addonId === scope.addonId) : undefined;
    const ready = scope.scope === "campaign" || addon?.compatible === true;
    return html`<section class="settings-recovery-review" aria-labelledby="recovery-review-title">
      <h3 id="recovery-review-title" tabindex="-1">${this.#ui.t(deleting ? "recovery.deleteReview" : "recovery.restoreReview")}</h3>
      <p><strong>${scope.scope === "campaign" ? this.#ui.t("recovery.campaign") : this.#ui.t("recovery.addon", { addon: scope.addonId })}</strong> · ${this.#date(point)}</p>
      <p>${this.#ui.t("recovery.summary", { records: scope.scope === "campaign" ? point.records : 0, documents: addon?.documents ?? 0, media: addon?.media ?? point.campaignMedia })}</p>
      <p>${this.#ui.t(deleting ? "recovery.deleteEffect" : scope.scope === "campaign" ? "recovery.restoreEffect" : "recovery.addonEffect")}</p>
      ${!deleting && !ready ? html`<p role="status">${this.#ui.t("recovery.compatibility")}</p>` : nothing}
      <div class="settings-recovery-actions"><button type="button" ?disabled=${this.busy || !deleting && !ready} @click=${() => void this.#request(action)}>${this.#ui.t(deleting ? "recovery.delete" : "recovery.restore")}</button>
      <button type="button" ?disabled=${this.busy} @click=${() => this.#closeReview()}>${this.#ui.t("recovery.cancel")}</button></div>
    </section>`;
  }
  async #request(action?: RecoveryAction): Promise<void> {
    if (this.busy) return;
    const signal = this.#abort.signal;
    this.busy = true; this.message = undefined; this.#failed = false;
    this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty: false, saving: action !== undefined }, bubbles: true, composed: true }));
    try {
      const listing = await recoveryRequest(signal, this.csrfToken, action);
      if (signal.aborted) return;
      this.listing = listing; this.#closeReview(); this.#reloadRequired = false;
      const scope = this.#scope();
      if (scope.scope === "addon" && !listing.points.some(point => point.addons.some(addon => addon.addonId === scope.addonId))) this.selection = "campaign";
      if (action) this.message = action.kind === "create" ? "recovery.created" : action.kind === "delete" ? "recovery.deleted" : "recovery.restored";
    } catch (error: unknown) {
      if (signal.aborted) return;
      this.#failed = true; this.#closeReview(); this.#reloadRequired = true;
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
