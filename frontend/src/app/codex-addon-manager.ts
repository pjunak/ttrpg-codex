import { LitElement, html, nothing } from "lit";
import { AddonAdminClient, type AddonReview, type AddonSnapshot } from "../core/addon-admin.js";
import { UiLocalizationController, type MessageKey } from "./ui-localization.js";

export class CodexAddonManager extends LitElement {
  static override properties = { csrfToken: { attribute: false }, snapshots: { state: true }, review: { state: true }, pending: { state: true }, error: { state: true }, message: { state: true }, grants: { state: true } };
  declare csrfToken: string;
  declare private snapshots: AddonSnapshot[];
  declare private review: AddonReview | undefined;
  declare private pending: boolean;
  declare private error: string;
  declare private message: string;
  declare private grants: string[];
  #request = new AbortController();
  readonly #ui = new UiLocalizationController(this);
  constructor() { super(); this.snapshots = []; this.review = undefined; this.pending = false; this.error = ""; this.message = ""; this.grants = []; }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#request = new AbortController(); void this.#run(async client => { this.snapshots = await client.inventory(); }, false); }
  override disconnectedCallback(): void { this.#request.abort(); super.disconnectedCallback(); }

  protected override render() {
    const t = this.#ui.t.bind(this.#ui);
    return html`<section class="settings-ledger addon-manager" aria-busy=${this.pending}>
      <header class="settings-ledger-heading"><div><span class="settings-category-mark" aria-hidden="true">🧩</span><div><h2>${t("addons.title")}</h2><p>${t("addons.intro")}</p></div></div>
        <button ?disabled=${this.pending} @click=${() => this.#run(async client => { this.review = undefined; this.snapshots = await client.inventory(); })}>${t("addons.refresh")}</button></header>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}${this.message ? html`<p role="status">${this.message}</p>` : nothing}
      <form class="addon-upload" @submit=${this.#upload}><label>${t("addons.file")}<input type="file" accept=".zip,application/zip" ?disabled=${this.pending} name="package"></label><button ?disabled=${this.pending}>${t("addons.upload")}</button></form>
      ${this.review ? this.#reviewPanel(this.review) : nothing}
      ${this.pending && !this.snapshots.length ? html`<p role="status">${t("addons.loading")}</p>` : !this.snapshots.length ? html`<p>${t("addons.empty")}</p>` : nothing}
      <div class="addon-list">${this.snapshots.map(snapshot => this.#addonRow(snapshot))}</div>
    </section>`;
  }
  #addonRow(snapshot: AddonSnapshot) {
    const t = this.#ui.t.bind(this.#ui), state = snapshot.state;
    const active = snapshot.generations.find(generation => generation.generationId === state.activeGenerationId);
    return html`<article class="addon-row" data-addon-id=${state.addonId}>
      <header><div><h3>${state.addonId}</h3><p>${active ? html`${active.version} · ${t("addons.active")}` : t("addons.inactive")}${snapshot.runtimeState ? ` · ${snapshot.runtimeState}` : ""}</p></div>
      ${active ? html`<div class="addon-actions"><button ?disabled=${this.pending} @click=${() => this.#action(snapshot, "reload")}>${t("addons.reload")}</button><button ?disabled=${this.pending} @click=${() => this.#action(snapshot, "disable")}>${t("addons.disable")}</button></div>` : nothing}</header>
      <details ?open=${!active}><summary>${t("addons.versions")}</summary><ul>${snapshot.generations.map(generation => html`<li data-generation=${generation.generationId}>
        <div><strong>${generation.version}</strong> ${generation.generationId === state.activeGenerationId ? t("addons.active") : ""}<small>${this.#ui.relativeDate(generation.installedAt)}</small>
          ${generation.lastError ? html`<p role="alert">${generation.lastError}</p>` : nothing}<details><summary>${t("addons.generation")}</summary><code>${generation.generationId}</code></details></div>
        ${generation.generationId !== state.activeGenerationId ? html`<button ?disabled=${this.pending} @click=${() => this.#prepare(state.addonId, generation.generationId)}>${t(active ? "addons.rollback" : "addons.review")}</button>` : nothing}</li>`)}</ul></details>
      ${snapshot.events.length ? html`<details><summary>${t("addons.history")}</summary><ul>${snapshot.events.map(event => html`<li><div>${event.kind}<small>${this.#ui.relativeDate(event.occurredAt)}</small>${event.message ? html`<p>${event.message}</p>` : nothing}</div></li>`)}</ul></details>` : nothing}
    </article>`;
  }
  #reviewPanel(review: AddonReview) {
    const t = this.#ui.t.bind(this.#ui);
    const changes = review.changes.filter(change => change.added.length + change.changed.length + change.removed.length);
    return html`<section class="addon-review" aria-labelledby="addon-review-title">
      <h3 id="addon-review-title">${t("addons.review")}: ${review.name}</h3>
      <p>${review.currentVersion ? `${t("addons.current")}: ${review.currentVersion} → ` : ""}${t("addons.target")}: ${review.version}</p>
      <details><summary>${t("addons.generation")}</summary><code>${review.generationId}</code></details>
      <h4>${t("addons.changes")}</h4>${review.runtimeChanged ? html`<p>${t("addons.runtimeChanged")}</p>` : nothing}
      ${!changes.length && !review.runtimeChanged ? html`<p>${t("addons.noChanges")}</p>` : nothing}
      <ul>${changes.map(change => html`<li><strong>${t(`addons.${change.category}` as MessageKey)}</strong>${(["added", "changed", "removed"] as const).map(kind => change[kind].length ? html`<p>${t(`addons.${kind}`)}: ${change[kind].join(", ")}</p>` : nothing)}</li>`)}</ul>
      ${review.restarted.length ? html`<p>${t("addons.restart")}: ${review.restarted.join(", ")}</p>` : nothing}
      <fieldset ?disabled=${this.pending}><legend>${t("addons.permissions")}</legend><p>${t("addons.grantHint")}</p>
        ${review.permissions.length ? review.permissions.map(permission => html`<label class="addon-permission"><input type="checkbox" .checked=${this.grants.includes(permission.id)}
          @change=${(event: Event) => { this.grants = (event.target as HTMLInputElement).checked ? [...this.grants, permission.id] : this.grants.filter(id => id !== permission.id); }}>
          <span><strong>${permission.id}</strong> ${review.required.includes(permission.id) ? `(${t("addons.required")})` : ""}<small>${permission.resources.join(", ")}</small><span>${permission.reason}</span></span></label>`) : html`<p>${t("addons.noPermissions")}</p>`}
      </fieldset>
      ${review.blockers.length ? html`<div role="alert"><h4>${t("addons.blocked")}</h4><ul>${review.blockers.map(blocker => html`<li>${blocker.message}</li>`)}</ul></div>` : nothing}
      <div class="addon-actions"><button ?disabled=${this.pending || review.blockers.length > 0 || review.required.some(id => !this.grants.includes(id))}
        @click=${() => this.#activate(review)}>${t("addons.approve")}</button><button ?disabled=${this.pending} @click=${() => { this.review = undefined; }}>${t("addons.cancel")}</button></div>
    </section>`;
  }
  readonly #upload = (event: SubmitEvent): void => {
    event.preventDefault(); if (this.pending) return;
    const form = event.currentTarget as HTMLFormElement, file = form.querySelector<HTMLInputElement>("input")?.files?.[0];
    if (!file || !file.size || file.size > 128 * 1024 * 1024) { this.error = this.#ui.t("addons.fileRequired"); return; }
    void this.#run(async client => { const generation = await client.stage(file); this.snapshots = await client.inventory(); this.review = await client.review(generation.addonId, generation.generationId); this.grants = []; form.reset(); });
  };
  #prepare(id: string, generation: string): void { void this.#run(async client => { this.review = await client.review(id, generation); this.grants = []; }); }
  #activate(review: AddonReview): void { void this.#run(async client => { await client.activate(review, this.grants); this.review = undefined; this.snapshots = await client.inventory(); this.message = this.#ui.t("addons.done"); }); }
  #action(snapshot: AddonSnapshot, action: "reload" | "disable"): void {
    if (action === "disable" && !window.confirm(this.#ui.t("addons.disableConfirm"))) return;
    void this.#run(async client => { await client.action(snapshot, action); this.review = undefined; this.snapshots = await client.inventory(); this.message = this.#ui.t("addons.done"); });
  }
  async #run(operation: (client: AddonAdminClient) => Promise<void>, mutating = true): Promise<void> {
    if (this.pending) return;
    const request = this.#request; this.pending = true; this.error = ""; this.message = "";
    if (mutating) this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: true, bubbles: true, composed: true }));
    try { await operation(new AddonAdminClient(this.csrfToken, request.signal)); }
    catch (error) { if (!request.signal.aborted) { this.review = undefined; this.error = `${this.#ui.t("addons.failed")} ${error instanceof Error ? error.message : ""}`; } }
    finally { if (!request.signal.aborted) { this.pending = false; if (mutating) this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: false, bubbles: true, composed: true })); } }
  }
}
customElements.define("codex-addon-manager", CodexAddonManager);
