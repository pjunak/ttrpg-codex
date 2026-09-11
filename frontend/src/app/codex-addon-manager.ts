import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { AddonContributionsController } from "./addon-contributions-controller.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";
import { AddonAdminClient, type AddonReview, type AddonSnapshot } from "../core/addon-admin.js";
import { UiLocalizationController, uiSourceLabel, uiText, type MessageKey } from "./ui-localization.js";
import { uiRequestError } from "./ui-errors.js";
import "./codex-addon-github.js";
import "./codex-addon-configuration.js";
import "./codex-addon-settings.js";
import type { InstalledGeneration } from "../core/addon-admin.js";
import type { AddonUninstallReview } from "../core/addon-uninstall.js";
import { HostRequestError } from "../core/api.js";

export class CodexAddonManager extends LitElement {
  static override properties = { csrfToken: { attribute: false }, snapshots: { state: true }, review: { state: true }, removal: { state: true }, pending: { state: true }, error: { state: true }, message: { state: true }, grants: { state: true }, registry: { attribute: false }, actorRole: { attribute: false }, canManage: { attribute: false }, addonTarget: { attribute: false } };
  declare csrfToken: string;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  declare canManage: boolean;
  declare addonTarget: string | null | undefined;
  readonly #contributions = new AddonContributionsController(this, () => ({ registry: this.registry, role: this.actorRole }));
  #inventoryLoaded = false;
  declare private snapshots: AddonSnapshot[];
  declare private review: AddonReview | undefined;
  declare private removal: AddonUninstallReview | undefined;
  declare private pending: boolean;
  declare private error: string;
  declare private message: string;
  declare private grants: string[];
  #request = new AbortController();
  #githubBusy = false;
  #configurationBusy = false;
  get #busy(): boolean { return this.pending || this.#githubBusy || this.#configurationBusy; }
  readonly #ui = new UiLocalizationController(this);
  constructor() { super(); this.canManage = false; this.snapshots = []; this.review = undefined; this.pending = false; this.error = ""; this.message = ""; this.grants = []; }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#request = new AbortController(); this.#inventoryLoaded = false; this.requestUpdate(); }
  override disconnectedCallback(): void { this.#request.abort(); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("canManage")) {
      this.#request.abort(); this.#request = new AbortController(); this.#inventoryLoaded = false;
      this.snapshots = []; this.review = undefined; this.removal = undefined; this.pending = false;
      this.#githubBusy = false; this.#configurationBusy = false; this.error = ""; this.message = "";
    }
    if (this.isConnected && this.canManage && !this.#inventoryLoaded && !this.#busy) {
      this.#inventoryLoaded = true;
      void this.#run(async client => { this.snapshots = await client.inventory(); }, false);
    }
  }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("review") && this.review || changed.has("removal") && this.removal) {
      this.querySelector(".addon-review")?.scrollIntoView({ block: "start" });
      this.querySelector<HTMLElement>("#addon-review-title")?.focus({ preventScroll: true });
    }
  }

  protected override render() {
    const t = this.#ui.t.bind(this.#ui);
    const addonIds = [...new Set(this.#contributions.list("settings").map(active => active.addonId))].sort();
    if (!this.canManage) return html`<section class="settings-ledger addon-manager">
      <header class="settings-ledger-heading"><div><h2>${t("addons.title")}</h2><p>${t("addons.settingsIntro")}</p></div></header>
      ${this.#missingSettings(addonIds)}
      ${!addonIds.length && !this.addonTarget ? html`<p>${t("addons.settingsEmpty")}</p>` : nothing}
      <div class="addon-list">${repeat(addonIds, id => id, id => html`<article class="addon-row" data-addon-id=${id}>
        <header><h3>${id}</h3></header>${this.#settings(id)}</article>`)}</div>
    </section>`;
    return html`<section class="settings-ledger addon-manager" aria-busy=${this.#busy}>
      <header class="settings-ledger-heading"><div><span class="settings-category-mark" aria-hidden="true">🧩</span><div><h2>${t("addons.title")}</h2><p>${t("addons.intro")}</p></div></div>
        <button ?disabled=${this.#busy} @click=${() => this.#run(async client => { this.review = undefined; this.snapshots = await client.inventory(); })}>${t("addons.refresh")}</button></header>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}${this.message ? html`<p role="status">${this.message}</p>` : nothing}
      <codex-addon-configuration .csrfToken=${this.csrfToken} .disabled=${this.pending || this.#githubBusy}
        @addon-lifecycle-request=${(event: Event) => { if (!this.#confirmLifecycle()) event.preventDefault(); }}
        .inventoryRevision=${JSON.stringify(this.snapshots.map(snapshot => [snapshot.state, snapshot.generations.map(generation => generation.generationId)]))}
        @addon-admin-busy=${(event: CustomEvent<boolean>) => { this.#configurationBusy = event.detail; if (event.detail) { this.review = undefined; this.removal = undefined; } this.requestUpdate(); }}
        @addon-configuration-applied=${async () => { this.review = undefined; this.snapshots = await new AddonAdminClient(this.csrfToken, this.#request.signal).inventory().catch(() => this.snapshots); }}></codex-addon-configuration>
      <codex-addon-github .csrfToken=${this.csrfToken} .snapshots=${this.snapshots} .disabled=${this.pending || this.#configurationBusy}
        @addon-admin-busy=${(event: CustomEvent<boolean>) => { this.#githubBusy = event.detail; if (event.detail) { this.review = undefined; this.removal = undefined; } this.requestUpdate(); }}
        @github-package-staged=${(event: CustomEvent<InstalledGeneration>) => { void this.#run(async client => { this.snapshots = await client.inventory(); this.review = await client.review(event.detail.addonId, event.detail.generationId); this.grants = []; }); }}></codex-addon-github>
      <form class="addon-upload" @submit=${this.#upload}><label>${t("addons.file")}<input type="file" accept=".zip,application/zip" ?disabled=${this.#busy} name="package"></label><button ?disabled=${this.#busy}>${t("addons.upload")}</button></form>
      ${this.review ? this.#reviewPanel(this.review) : nothing}
      ${this.removal ? this.#uninstallPanel(this.removal) : nothing}
      ${this.pending && !this.snapshots.length ? html`<p role="status">${t("addons.loading")}</p>` : !this.snapshots.length ? html`<p>${t("addons.empty")}</p>` : nothing}
      ${this.#missingSettings(addonIds)}
      <div class="addon-list">${repeat(this.snapshots, snapshot => snapshot.state.addonId, snapshot => this.#addonRow(snapshot))}</div>
    </section>`;
  }
  #missingSettings(addonIds: readonly string[]) {
    return this.addonTarget && !addonIds.includes(this.addonTarget)
      ? html`<p role="status">${this.#ui.t("addons.settingsUnavailable")}</p>` : nothing;
  }
  #settings(addonId: string) {
    return html`<codex-addon-settings .registry=${this.registry} .actorRole=${this.actorRole} .addonId=${addonId}
      .initiallyOpen=${this.addonTarget === addonId} ?inert=${this.#busy}></codex-addon-settings>`;
  }
  #addonRow(snapshot: AddonSnapshot) {
    const t = this.#ui.t.bind(this.#ui), state = snapshot.state;
    const active = snapshot.generations.find(generation => generation.generationId === state.activeGenerationId);
    return html`<article class="addon-row" data-addon-id=${state.addonId}>
      <header><div><h3>${state.addonId}</h3><p>${active ? html`${active.version} · ${t("addons.active")}` : t("addons.inactive")}${snapshot.runtimeState ? ` · ${uiSourceLabel(snapshot.runtimeState)}` : ""}</p></div>
      <div class="addon-actions">${active ? html`<button ?disabled=${this.#busy} @click=${() => this.#action(snapshot, "reload")}>${t("addons.reload")}</button><button ?disabled=${this.#busy} @click=${() => this.#action(snapshot, "disable")}>${t("addons.disable")}</button>` : nothing}
        <button ?disabled=${this.#busy} @click=${() => this.#prepareUninstall(state.addonId)}>${t("addons.uninstall")}</button></div></header>
      ${this.#settings(state.addonId)}
      <details ?open=${!active}><summary>${t("addons.versions")}</summary><ul>${snapshot.generations.map(generation => html`<li data-generation=${generation.generationId}>
        <div><strong>${generation.version}</strong> ${generation.generationId === state.activeGenerationId ? t("addons.active") : ""}<small>${this.#ui.relativeDate(generation.installedAt)}</small>
          ${generation.lastError ? html`<p role="alert">${t("addons.failed")}</p><details><summary>${uiText("Technical details")}</summary><p>${generation.lastError}</p></details>` : nothing}<details><summary>${t("addons.generation")}</summary><code>${generation.generationId}</code></details></div>
        ${generation.generationId !== state.activeGenerationId ? html`<button ?disabled=${this.#busy} @click=${() => this.#prepare(state.addonId, generation.generationId)}>${t(active ? "addons.rollback" : "addons.review")}</button>` : nothing}</li>`)}</ul></details>
      ${snapshot.events.length ? html`<details><summary>${t("addons.history")}</summary><ul>${snapshot.events.map(event => html`<li><div>${uiSourceLabel(event.kind)}<small>${this.#ui.relativeDate(event.occurredAt)}</small>${event.message ? html`<details><summary>${uiText("Technical details")}</summary><p>${event.message}</p></details>` : nothing}</div></li>`)}</ul></details>` : nothing}
    </article>`;
  }
  #reviewPanel(review: AddonReview) {
    const t = this.#ui.t.bind(this.#ui);
    const changes = review.changes.filter(change => change.added.length + change.changed.length + change.removed.length);
    return html`<section class="addon-review" aria-labelledby="addon-review-title">
      <h3 id="addon-review-title" tabindex="-1">${t("addons.review")}: ${review.name}</h3>
      <p>${review.currentVersion ? `${t("addons.current")}: ${review.currentVersion} → ` : ""}${t("addons.target")}: ${review.version}</p>
      <details><summary>${t("addons.generation")}</summary><code>${review.generationId}</code></details>
      ${review.rulesetName ? html`<p>${t("configuration.defines", { ruleset: review.rulesetName })}</p>` : review.supportedRulesets.length ? html`<p>${t("configuration.supports", { rulesets: review.supportedRulesets.join(", ") })}</p>` : nothing}
      ${review.disabledSources.length ? html`<p>${t("configuration.initialOff", { books: review.disabledSources.join(", ") })}</p>` : nothing}
      <h4>${t("addons.changes")}</h4>${review.runtimeChanged ? html`<p>${t("addons.runtimeChanged")}</p>` : nothing}
      ${!changes.length && !review.runtimeChanged ? html`<p>${t("addons.noChanges")}</p>` : nothing}
      <ul>${changes.map(change => html`<li><strong>${t(`addons.${change.category}` as MessageKey)}</strong>${(["added", "changed", "removed"] as const).map(kind => change[kind].length ? html`<p>${t(`addons.${kind}`)}: ${change[kind].join(", ")}</p>` : nothing)}</li>`)}</ul>
      ${review.restarted.length ? html`<p>${t("addons.restart")}: ${review.restarted.join(", ")}</p>` : nothing}
      <fieldset ?disabled=${this.#busy}><legend>${t("addons.permissions")}</legend><p>${t("addons.grantHint")}</p>
        ${review.permissions.length ? review.permissions.map(permission => html`<label class="addon-permission"><input type="checkbox" .checked=${this.grants.includes(permission.id)}
          @change=${(event: Event) => { this.grants = (event.target as HTMLInputElement).checked ? [...this.grants, permission.id] : this.grants.filter(id => id !== permission.id); }}>
          <span><strong>${permission.id}</strong> ${review.required.includes(permission.id) ? `(${t("addons.required")})` : ""}<small>${permission.resources.join(", ")}</small><span>${permission.reason}</span></span></label>`) : html`<p>${t("addons.noPermissions")}</p>`}
      </fieldset>
      ${review.blockers.length ? html`<div role="alert"><h4>${t("addons.blocked")}</h4><ul>${review.blockers.map(blocker => html`<li>${blockerMessage(blocker.code)}<details><summary>${uiText("Technical details")}</summary><code>${blocker.code}</code><p>${blocker.message}</p></details></li>`)}</ul></div>` : nothing}
      <div class="addon-actions"><button ?disabled=${this.#busy || review.blockers.length > 0 || review.required.some(id => !this.grants.includes(id))}
        @click=${() => this.#activate(review)}>${t("addons.approve")}</button><button ?disabled=${this.#busy} @click=${() => { this.review = undefined; }}>${t("addons.cancel")}</button></div>
    </section>`;
  }
  #uninstallPanel(review: AddonUninstallReview) {
    const t = this.#ui.t.bind(this.#ui);
    const restarting = review.stopped.filter(id => id !== review.addonId && !review.effects.some(effect => effect.addonId === id && effect.disabled));
    return html`<section class="addon-review addon-uninstall-review" aria-labelledby="addon-review-title">
      <h3 id="addon-review-title" tabindex="-1">${t("addons.uninstallReview")}: ${review.name}</h3>
      <p>${review.addonId} · ${review.version}</p><p>${t("addons.uninstallHelp")}</p><p>${t("addons.uninstallKeep")}</p>
      ${review.rulesetName ? html`<p>${t("addons.uninstallRules", { ruleset: review.rulesetName })}</p>` : nothing}
      ${review.unlinksSource ? html`<p>${t("addons.uninstallSource")}</p>` : nothing}
      ${[true, false].map(disabled => {
        const effects = review.effects.filter(effect => effect.disabled === disabled);
        return effects.length ? html`<h4>${t(disabled ? "addons.uninstallDisable" : "addons.uninstallOptional")}</h4>${!disabled ? html`<p>${t("addons.uninstallReconnect")}</p>` : nothing}<ul>${effects.map(effect => html`<li>${effect.name}${effect.name !== effect.addonId ? ` (${effect.addonId})` : ""}<small>${effect.reasons.join(", ")}</small></li>`)}</ul>` : nothing;
      })}
      ${review.stopped.length ? html`<p>${t("addons.uninstallStop", { addons: review.stopped.join(", ") })}</p>` : nothing}
      <p>${restarting.length ? t("configuration.restart", { addons: restarting.join(", ") }) : t("configuration.noRestart")}</p>
      <h4>${t("addons.uninstallData")}</h4>${review.retainedData.length ? html`<ul>${review.retainedData.map(data => html`<li>${data.id} · ${t("addons.uninstallDocuments", { count: data.documents })}</li>`)}</ul>` : html`<p>${t("addons.uninstallNoData")}</p>`}
      <div class="addon-actions"><button ?disabled=${this.#busy} @click=${() => this.#uninstall(review)}>${t("addons.uninstallConfirm")}</button><button ?disabled=${this.#busy} @click=${() => { this.removal = undefined; }}>${t("addons.cancel")}</button></div>
    </section>`;
  }
  #prepareUninstall(addonId: string): void { void this.#run(async client => { this.review = undefined; this.removal = await client.reviewUninstall(addonId); }); }
  #uninstall(review: AddonUninstallReview): void {
    if (!this.#confirmLifecycle()) return;
    void this.#run(async client => {
      const result = await client.uninstall(review);
      this.removal = undefined;
      this.message = this.#ui.t(result.failures.length || result.recoveryError ? "addons.uninstallRecovery" : "addons.uninstalled");
      this.error = [result.recoveryError, ...result.failures.map(failure => `${failure.addonId}: ${failure.error}`)].filter(Boolean).join(" ");
      this.snapshots = await client.inventory();
    }, true, true);
  }
  readonly #upload = (event: SubmitEvent): void => {
    event.preventDefault(); if (this.#busy) return;
    const form = event.currentTarget as HTMLFormElement, file = form.querySelector<HTMLInputElement>("input")?.files?.[0];
    if (!file || !file.size || file.size > 128 * 1024 * 1024) { this.error = this.#ui.t("addons.fileRequired"); return; }
    void this.#run(async client => { const generation = await client.stage(file); this.snapshots = await client.inventory(); this.review = await client.review(generation.addonId, generation.generationId); this.grants = []; form.reset(); });
  };
  #prepare(id: string, generation: string): void { void this.#run(async client => { this.review = await client.review(id, generation); this.grants = []; }); }
  #activate(review: AddonReview): void { if (!this.#confirmLifecycle()) return; void this.#run(async client => { await client.activate(review, this.grants); this.review = undefined; this.snapshots = await client.inventory(); this.message = this.#ui.t("addons.done"); }); }
  #action(snapshot: AddonSnapshot, action: "reload" | "disable"): void {
    if (!this.#confirmLifecycle()) return;
    if (action === "disable" && !window.confirm(this.#ui.t("addons.disableConfirm"))) return;
    void this.#run(async client => { await client.action(snapshot, action); this.review = undefined; this.snapshots = await client.inventory(); this.message = this.#ui.t("addons.done"); });
  }
  async #run(operation: (client: AddonAdminClient) => Promise<void>, mutating = true, uninstalling = false): Promise<void> {
    if (this.#busy || !this.canManage) return;
    const request = this.#request; this.pending = true; this.error = ""; this.message = ""; this.removal = undefined;
    if (mutating) this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: true, bubbles: true, composed: true }));
    try { await operation(new AddonAdminClient(this.csrfToken, request.signal)); }
    catch (error) { if (!request.signal.aborted) { this.review = undefined; this.error = `${this.#ui.t("addons.failed")} ${uninstalling && error instanceof HostRequestError && error.status === 409 ? this.#ui.t("addons.uninstallConflict") : uiRequestError(error)}`; } }
    finally { if (!request.signal.aborted) { this.pending = false; if (mutating) this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: false, bubbles: true, composed: true })); } }
  }
  #confirmLifecycle(): boolean {
    const edits = this.registry?.edits.state();
    if (edits?.saving) { this.error = this.#ui.t("addons.settingsSaving"); return false; }
    return confirmDiscardUnsavedEdit(edits?.dirty === true, message => window.confirm(message));
  }
}
customElements.define("codex-addon-manager", CodexAddonManager);

function blockerMessage(code: string): string {
  switch (code) {
    case "RULESET": return uiText("Review the package compatibility before activation.");
    case "COMPATIBILITY": return uiText("Review the package compatibility before activation.");
    case "DEPENDENCY": case "DEPENDENT_INCOMPATIBLE": return uiText("Resolve the required add-on dependencies before activation.");
    case "SERVICE": return uiText("Resolve service-provider conflicts before activation.");
    case "DATA_REVIEW": return uiText("Review the stored data and the package data definitions.");
    case "RECOVERY_REQUIRED": return uiText("Recovery is required before this add-on can be activated.");
    default: return uiText("Activation is blocked. Review the technical details.");
  }
}
