import type { CleanupReview, CleanupScope, CleanupResult } from "../core/addon-cleanup.js";
import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { AddonContributionsController } from "./addon-contributions-controller.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";
import { AddonAdminClient, type AddonReview, type AddonSnapshot } from "../core/addon-admin.js";
import { UiLocalizationController, uiSourceLabel, uiText, type MessageKey } from "./ui-localization.js";
import { uiRequestError } from "./ui-errors.js";
import "./codex-addon-install.js";
import "./codex-package-storage.js";
import { AddonGitHubController } from "./addon-github-controller.js";
import { AddonGitHubClient, type GitHubDiscovery } from "../core/addon-github.js";
import { githubTokenHelp } from "./github-access.js";
import { githubCandidateDetails } from "./github-candidate-details.js";
import { containDialogTab } from "./dialog-focus.js";
import { type CodexAddonConfiguration, type ConfigurationAddon } from "./codex-addon-configuration.js";
import "./codex-addon-configuration.js";
import { addonSettingsHash } from "./routes.js";
import "./codex-addon-settings.js";
import type { InstalledGeneration } from "../core/addon-admin.js";
import type { AddonUninstallReview } from "../core/addon-uninstall.js";
import { HostRequestError } from "../core/api.js";

export class CodexAddonManager extends LitElement {
  static override properties = { csrfToken: { attribute: false }, snapshots: { state: true }, review: { state: true }, removal: { state: true }, cleanup: { state: true }, pending: { state: true }, error: { state: true }, message: { state: true }, grants: { state: true }, registry: { attribute: false }, actorRole: { attribute: false }, canManage: { attribute: false }, addonTarget: { attribute: false }, addonGeneration: { attribute: false }, installOpen: { state: true }, installTarget: { state: true }, staged: { state: true }, activeTab: { state: true }, configurationAddons: { state: true }, configurationError: { state: true } };
  declare csrfToken: string;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  declare canManage: boolean;
  declare addonTarget: string | null | undefined;
  declare addonGeneration: string | undefined;
  readonly #contributions = new AddonContributionsController(this, () => ({ registry: this.registry, role: this.actorRole }));
  declare private activeTab: string;
  declare private configurationError: string;
  declare private configurationAddons: readonly ConfigurationAddon[];
  #visibleTab = "";
  #inventoryLoaded = false;
  declare private snapshots: AddonSnapshot[];
  declare private review: AddonReview | undefined;
  declare private cleanup: CleanupReview | undefined;
  declare private removal: AddonUninstallReview | undefined;
  declare private pending: boolean;
  declare private error: string;
  declare private message: string;
  declare private grants: string[];
  #request = new AbortController();
  declare private installOpen: boolean;
  declare private installTarget: string;
  declare private staged: InstalledGeneration | undefined;
  #opener: HTMLElement | null = null;
  #installBusy = false;
  #configurationBusy = false;
  #storageBusy = false;
  #requestedReview = "";
  get #busy(): boolean { return this.pending || this.#github.pending || this.#installBusy || this.#configurationBusy || this.#storageBusy; }
  readonly #ui = new UiLocalizationController(this);
  readonly #github = new AddonGitHubController(this, () => this.csrfToken, key => this.#ui.t(key));
  constructor() { super(); this.activeTab = ""; this.configurationAddons = []; this.configurationError = ""; this.canManage = false; this.snapshots = []; this.review = undefined; this.pending = false; this.error = ""; this.message = ""; this.grants = []; this.installOpen = false; this.installTarget = ""; }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#request = new AbortController(); this.#inventoryLoaded = false; this.requestUpdate(); }
  override disconnectedCallback(): void {
    this.#requestedReview = ""; this.#storageBusy = false;
    this.#request.abort(); this.#installBusy = false; this.#configurationBusy = false; this.pending = false;
    this.installOpen = false; this.staged = undefined; this.review = undefined; this.removal = undefined; this.cleanup = undefined; super.disconnectedCallback();
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("addonTarget") || changed.has("addonGeneration")) { this.activeTab = this.addonGeneration ? "" : this.addonTarget ?? ""; this.#requestedReview = ""; }
    if (changed.has("canManage")) {
      this.configurationAddons = []; this.configurationError = "";
      this.#request.abort(); this.#request = new AbortController(); this.#inventoryLoaded = false;
      this.snapshots = []; this.review = undefined; this.removal = undefined; this.cleanup = undefined; this.pending = false;
      this.#requestedReview = ""; this.#storageBusy = false;
      this.#github.reset(); this.#installBusy = false; this.installOpen = false; this.staged = undefined; this.#configurationBusy = false; this.error = ""; this.message = "";
    }
    if (this.isConnected && this.canManage && !this.#inventoryLoaded && !this.#busy) {
      this.#inventoryLoaded = true;
      void this.#run(async client => { this.snapshots = await client.inventory(); await this.#github.refresh(); }, false);
    }
  }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    const requested = this.addonTarget && this.addonGeneration ? this.addonTarget + ":" + this.addonGeneration : "";
    if (requested && this.canManage && this.#inventoryLoaded && !this.#busy && requested !== this.#requestedReview) {
      this.#requestedReview = requested; this.activeTab = "";
      const generation = this.snapshots.find(snapshot => snapshot.state.addonId === this.addonTarget)?.generations.find(item => item.generationId === this.addonGeneration);
      if (generation) this.#prepare(generation.addonId, generation.generationId);
      else this.error = this.#ui.t("storage.prepareFirst");
    }
    const selected = this.#selectedTab();
    if (selected !== this.#visibleTab) {
      this.#visibleTab = selected;
      this.querySelector<HTMLElement>(".addon-settings-tabs [aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    const dialog = this.querySelector<HTMLDialogElement>(".addon-install-dialog");
    if (dialog && !dialog.open) { dialog.showModal(); dialog.querySelector<HTMLElement>("h3")?.focus(); }
    if (changed.has("review") && this.review || changed.has("removal") && this.removal || changed.has("cleanup") && this.cleanup) {
      this.querySelector(".addon-review")?.scrollIntoView({ block: "start" });
      this.querySelector<HTMLElement>("#addon-review-title")?.focus({ preventScroll: true });
    }
  }

  #tabs(): ConfigurationAddon[] {
    const addons = new Map(this.configurationAddons.map(addon => [addon.id, addon]));
    for (const active of this.#contributions.list("settings")) {
      if (!addons.has(active.addonId)) addons.set(active.addonId, { id: active.addonId, name: active.addonId });
    }
    return [...(this.canManage ? [{ id: "", name: this.#ui.t("addons.management") }] : []),
      ...[...addons.values()].sort((a, b) => a.id.localeCompare(b.id))];
  }
  #selectedTab(tabs = this.#tabs()): string { return tabs.some(tab => tab.id === this.activeTab) ? this.activeTab : tabs[0]?.id ?? ""; }
  #selectTab(id: string): void { this.activeTab = id; }
  readonly #tabKey = (event: KeyboardEvent): void => {
    const buttons = [...this.querySelectorAll<HTMLButtonElement>(".addon-settings-tabs [role=tab]")];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    const button = buttons[next]!; this.#selectTab(button.dataset["addonTab"]!); button.focus();
  };
  protected override render() {
    const t = this.#ui.t.bind(this.#ui), tabs = this.#tabs(), selected = this.#selectedTab(tabs);
    const addonIds = [...new Set(this.#contributions.list("settings").map(active => active.addonId))].sort();
    return html`<section class="settings-ledger addon-manager" aria-busy=${this.#busy}>
      <header class="settings-ledger-heading"><div><span class="settings-category-mark" aria-hidden="true">🧩</span><div><h2>${t("addons.title")}</h2><p>${t(this.canManage ? "addons.intro" : "addons.settingsIntro")}</p></div></div></header>
      ${tabs.length ? html`<div class="addon-settings-tabs" role="tablist" aria-label=${t("addons.title")} @keydown=${this.#tabKey}>
        ${repeat(tabs, tab => tab.id, tab => html`<button type="button" role="tab" id=${`addon-tab-${tab.id ? "addon-" + tab.id : "management"}`} data-addon-tab=${tab.id}
          aria-selected=${tab.id === selected} aria-controls=${tab.id ? "addon-settings-panel" : "addon-management-panel"} tabindex=${tab.id === selected ? 0 : -1}
          @click=${() => this.#selectTab(tab.id)}>${tab.name}</button>`)}
      </div>` : nothing}
      ${this.#missingSettings(tabs.map(tab => tab.id))}
        ${this.error && !this.installOpen ? html`<p role="alert">${this.error}</p><button ?disabled=${this.#busy} @click=${() => this.#checkUpdates()}>${t("github.retry")}</button>` : nothing}
        ${this.#github.error ? html`<p role="alert">${this.#github.error}</p>` : nothing}
        ${this.message || this.#github.message ? html`<p role="status">${this.#github.message || this.message}</p>` : nothing}
      ${this.canManage && !this.configurationAddons.some(addon => addon.id === selected) && this.configurationError ? html`<p role="alert">${this.configurationError}</p><button ?disabled=${this.#busy} @click=${() => this.querySelector<CodexAddonConfiguration>("codex-addon-configuration")?.refresh()}>${t("configuration.refresh")}</button>` : nothing}
      ${!tabs.length && !this.addonTarget ? html`<p>${t("addons.settingsEmpty")}</p>` : nothing}
      ${this.canManage ? html`<div id="addon-management-panel" role="tabpanel" aria-labelledby="addon-tab-management" tabindex="0" ?hidden=${selected !== ""}>
        <div class="addon-actions addon-toolbar"><button ?disabled=${this.#busy} @click=${() => this.#checkUpdates()}>${t(this.#github.pending ? "github.checking" : "github.check")}</button>
          <button ?disabled=${this.#busy} @click=${() => this.#prepareCleanup({ keepInactive: 0 })}>${t("cleanup.open")}</button>
          <button class="addon-primary" ?disabled=${this.#busy} @click=${() => this.#openInstall()}>${t("github.add")}</button></div>
        <codex-package-storage .csrfToken=${this.csrfToken} .disabled=${this.#busy}
          .inventoryRevision=${JSON.stringify(this.snapshots.map(snapshot => [snapshot.state, snapshot.generations.map(item => item.generationId)]))}
          @addon-storage-busy=${(event: CustomEvent<boolean>) => { this.#storageBusy = event.detail; this.requestUpdate(); this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: event.detail, bubbles: true, composed: true })); }}
          @addon-package-restored=${(event: CustomEvent<InstalledGeneration>) => { this.#openInstall(); this.staged = event.detail; this.#loadReview(); }}></codex-package-storage>
        ${this.installOpen ? this.#installDialog() : nothing}
        ${this.removal ? this.#uninstallPanel(this.removal) : nothing}
        ${this.cleanup ? this.#cleanupPanel(this.cleanup) : nothing}
        ${this.pending && !this.snapshots.length ? html`<p role="status">${t("addons.loading")}</p>` : !this.snapshots.length ? html`<p>${t("addons.empty")}</p>` : nothing}
        <div class="addon-list">${repeat(this.snapshots, snapshot => snapshot.state.addonId, snapshot => this.#addonRow(snapshot))}</div>
        ${this.#tokens()}
      </div>` : nothing}
      <div id="addon-settings-panel" role="tabpanel" aria-labelledby=${selected ? `addon-tab-addon-${selected}` : nothing} tabindex="0" ?hidden=${!selected}>
        ${selected ? html`<h3>${tabs.find(tab => tab.id === selected)?.name}</h3><a class="addon-settings-link" href=${addonSettingsHash(selected)}>${t("addons.settingsLink")}</a>` : nothing}
        ${this.canManage ? html`<codex-addon-configuration .csrfToken=${this.csrfToken} .addonId=${selected} .disabled=${this.pending || this.#github.pending || this.#installBusy || this.#storageBusy}
          @addon-configuration-error=${(event: CustomEvent<string>) => { this.configurationError = event.detail; }}
          @addon-configuration-discovered=${(event: CustomEvent<readonly ConfigurationAddon[]>) => { this.configurationAddons = event.detail; }}
          @addon-lifecycle-request=${(event: Event) => { if (!this.#confirmLifecycle()) event.preventDefault(); }}
          .inventoryRevision=${JSON.stringify(this.snapshots.map(snapshot => [snapshot.state, snapshot.generations.map(generation => generation.generationId)]))}
          @addon-admin-busy=${(event: CustomEvent<boolean>) => { this.#configurationBusy = event.detail; if (event.detail) { this.review = undefined; this.removal = undefined; } this.requestUpdate(); }}
          @addon-configuration-applied=${async () => { this.review = undefined; this.snapshots = await new AddonAdminClient(this.csrfToken, this.#request.signal).inventory().catch(() => this.snapshots); }}></codex-addon-configuration>` : nothing}
        ${repeat(addonIds, id => id, id => html`<div data-addon-settings=${id} ?hidden=${id !== selected}>${this.#settings(id, id === selected)}</div>`)}
      </div>
    </section>`;
  }
  #openInstall(target = ""): void {
    if (this.#busy) return;
    this.#opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.installTarget = target; this.installOpen = true; this.staged = undefined; this.review = undefined; this.removal = undefined; this.cleanup = undefined; this.error = "";
  }
  #closeInstall(force = false): void {
    if (this.#busy && !force) return;
    this.querySelector<HTMLDialogElement>(".addon-install-dialog")?.close();
    this.installOpen = false; this.review = undefined; this.staged = undefined;
    void this.updateComplete.then(() => { (this.#opener?.isConnected ? this.#opener : this.querySelector<HTMLElement>(".addon-primary"))?.focus(); });
  }
  #installDialog() {
    const t = this.#ui.t.bind(this.#ui);
    return html`<dialog class="addon-install-dialog" aria-labelledby="addon-install-title" @cancel=${(event: Event) => { event.preventDefault(); this.#closeInstall(); }}
      @keydown=${(event: KeyboardEvent) => containDialogTab(event.currentTarget as HTMLDialogElement, event)}>
      <header><h3 id="addon-install-title" tabindex="-1">${t(this.review || this.staged || this.pending ? "addons.review" : this.installTarget ? "github.editSource" : "github.add")}</h3></header>
      <div class="addon-dialog-body">
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.review ? this.#reviewPanel(this.review) : this.staged || this.pending ? html`<p role="status">${t(this.pending ? "github.preparing" : "github.staged")}</p>
        ${this.staged && !this.pending ? html`<button ?disabled=${this.#busy} @click=${() => this.#loadReview()}>${t("addons.review")}</button>` : nothing}` : html`
        <codex-addon-install .csrfToken=${this.csrfToken} .target=${this.installTarget} .status=${this.#github.status}
          .link=${this.#github.status?.sources.find(link => link.addonId === this.installTarget)} .disabled=${this.pending || this.#github.pending}
          @addon-install-busy=${(event: CustomEvent<boolean>) => { this.#installBusy = event.detail; this.requestUpdate(); this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: event.detail, bubbles: true, composed: true })); }}
          @addon-package-staged=${(event: CustomEvent<InstalledGeneration>) => { this.staged = event.detail; this.#loadReview(); }}
          @addon-source-saved=${() => { this.#closeInstall(); void this.#github.checkAll(); }}></codex-addon-install>`}
      </div>
      ${!this.review ? html`<footer><button ?disabled=${this.#busy} @click=${() => this.#closeInstall()}>${t("github.close")}</button></footer>` : nothing}
    </dialog>`;
  }
  #loadReview(): void {
    const generation = this.staged; if (!generation) return;
    void this.#run(async client => { this.snapshots = await client.inventory(); this.review = await client.review(generation.addonId, generation.generationId); this.grants = []; await this.#github.refresh(); });
  }
  #checkUpdates(): void { void this.#run(async client => { this.snapshots = await client.inventory(); await this.#github.checkAll(); }, false); }
  #source(addonId: string) {
    const t = this.#ui.t.bind(this.#ui), link = this.#github.status?.sources.find(link => link.addonId === addonId), result = this.#github.results[addonId];
    return html`<div class="github-source" data-github-addon=${addonId}>
      ${typeof result === "string" ? html`<p role="alert">${result}</p>` : result ? this.#candidates(result, addonId) : nothing}
      <details><summary>${t("github.updateSource")}${link ? ` · ${link.source.repo}` : ""}</summary>
        ${link ? html`<p><a href=${`https://github.com/${link.source.repo}`} target="_blank" rel="noreferrer">${link.source.repo}</a> · ${t(link.source.channel === "actions" ? "github.actions" : "github.release")}</p>
          <p>${t("github.token")}: ${t(this.#github.status?.credentials.repositories.includes(link.source.repo) ? "github.scopedToken" : `github.token.${this.#github.status?.credentials.defaultSource ?? "none"}`)}</p>` : html`<p>${t("github.manualSource")}</p>`}
        <div class="addon-actions"><button ?disabled=${this.#busy} @click=${() => this.#openInstall(addonId)}>${t(link ? "github.editSource" : "github.connectSource")}</button>
          ${link ? html`<button ?disabled=${this.#busy} @click=${() => this.#github.unlink(link)}>${t("github.unlink")}</button>` : nothing}</div>
      </details></div>`;
  }
  #candidates(result: GitHubDiscovery, addonId: string) {
    const t = this.#ui.t.bind(this.#ui);
    return html`<div class="github-candidates">${!result.candidates.length ? html`<p role="status">${t("github.noPackage")}</p>` : nothing}
      <ul>${result.candidates.map(candidate => html`<li><div class="github-candidate-info"><strong>${t(candidate.active ? "github.current" : "github.available")}</strong>${githubCandidateDetails(candidate, result.source, t, this.#ui.locale)}</div>${candidate.active ? nothing : html`
        <button ?disabled=${this.#busy} @click=${() => {
          this.#openInstall(); void this.#run(async client => {
            this.staged = await new AddonGitHubClient(this.csrfToken, this.#request.signal).stage(result.source, candidate.id, addonId);
            this.snapshots = await client.inventory(); this.review = await client.review(this.staged.addonId, this.staged.generationId); this.grants = [];
          });
        }}>${t("github.download")}</button>`}</li>`)}</ul></div>`;
  }
  #tokens() {
    const status = this.#github.status, t = this.#ui.t.bind(this.#ui); if (!status) return nothing;
    return html`<details class="github-tokens"><summary>${t("github.tokens")}</summary><p>${t("github.tokenHint")}</p>
      <p>${t("github.defaultToken")}: ${t(`github.token.${status.credentials.defaultSource}`)}</p>
      ${status.credentials.environmentConfigured ? html`<p>${t("github.environmentHint")}</p>` : nothing}
      <form class="addon-source-form" @submit=${(event: SubmitEvent) => {
        event.preventDefault(); if (this.#busy) return;
        const form = event.currentTarget as HTMLFormElement, data = new FormData(form), input = form.querySelector<HTMLInputElement>('input[name="token"]');
        if (input) input.value = ""; void this.#github.token(String(data.get("repo") ?? ""), String(data.get("token") ?? ""));
      }}><label>${t("github.tokenScope")}<input name="repo" maxlength="250" placeholder=${t("github.defaultToken")} ?disabled=${this.#busy}></label>
        <label>${t("github.token")}<input name="token" type="password" required minlength="8" maxlength="255" autocomplete="new-password" ?disabled=${this.#busy}></label><button ?disabled=${this.#busy}>${t("github.saveToken")}</button></form>
      <ul>${(status.credentials.defaultSource === "stored" ? ["", ...status.credentials.repositories] : status.credentials.repositories).map(repo => html`<li>${repo || t("github.defaultToken")}
        <button ?disabled=${this.#busy} @click=${() => this.#github.token(repo, "")}>${t("github.removeToken")}</button></li>`)}</ul>
      <details><summary>${t("github.tokenInstructions")}</summary>${githubTokenHelp(t)}</details></details>`;
  }
  #missingSettings(addonIds: readonly string[]) {
    return this.activeTab && !addonIds.includes(this.activeTab)
      ? html`<p role="status">${this.#ui.t("addons.settingsUnavailable")}</p>` : nothing;
  }
  #settings(addonId: string, active: boolean) {
    return html`<codex-addon-settings .registry=${this.registry} .actorRole=${this.actorRole} .addonId=${addonId}
      .active=${active} ?inert=${this.#busy}></codex-addon-settings>`;
  }
  #addonRow(snapshot: AddonSnapshot) {
    const t = this.#ui.t.bind(this.#ui), state = snapshot.state;
    const active = snapshot.generations.find(generation => generation.generationId === state.activeGenerationId);
    return html`<article class="addon-row" data-addon-id=${state.addonId}>
      <header><div><h3>${state.addonId}</h3><p>${active ? html`${active.version} · ${t("addons.active")}` : t("addons.inactive")}${snapshot.runtimeState ? ` · ${uiSourceLabel(snapshot.runtimeState)}` : ""}</p>${active ? html`<small>${t("addons.generation")}: <code title=${active.generationId}>${active.generationId.slice(0, 12)}</code></small>` : nothing}</div>
      <div class="addon-actions">${active ? html`<button ?disabled=${this.#busy} @click=${() => this.#action(snapshot, "reload")}>${t("addons.reload")}</button><button ?disabled=${this.#busy} @click=${() => this.#action(snapshot, "disable")}>${t("addons.disable")}</button>` : nothing}
        <button ?disabled=${this.#busy} @click=${() => this.#prepareUninstall(state.addonId)}>${t("addons.uninstall")}</button></div></header>
      ${this.#source(state.addonId)}
      <details ?open=${!active}><summary>${t("addons.versions")}</summary><p>${t("addons.versionsHint")}</p><ul>${snapshot.generations.map(generation => html`<li data-generation=${generation.generationId}>
        <div><strong>${generation.version}</strong> ${t(generation.generationId === state.activeGenerationId ? "addons.active" : "addons.savedInactive")}<small>${this.#ui.relativeDate(generation.installedAt)}</small>
          ${generation.lastError ? html`<p role="alert">${t("addons.failed")}</p><details><summary>${uiText("Technical details")}</summary><p>${generation.lastError}</p></details>` : nothing}<details><summary>${t("addons.generation")}</summary><code>${generation.generationId}</code></details></div>
        ${generation.generationId !== state.activeGenerationId ? html`<button ?disabled=${this.#busy} @click=${() => this.#prepare(state.addonId, generation.generationId)}>${t(active ? "addons.rollback" : "addons.review")}</button><button ?disabled=${this.#busy} @click=${() => this.#prepareCleanup({ addonId: state.addonId, generationId: generation.generationId })}>${t("cleanup.single")}</button>` : nothing}</li>`)}</ul></details>
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
      ${review.blockers.length ? html`<div role="alert"><h4>${t("addons.blocked")}</h4><ul>${review.blockers.map(blocker => html`<li>${blockerMessage(blocker.code)}${["COMPATIBILITY", "RULESET", "DEPENDENCY", "SERVICE"].includes(blocker.code) ? html`<p class="addon-blocker-reason">${blocker.message}</p>` : nothing}<details><summary>${uiText("Technical details")}</summary><code>${blocker.code}</code>${["COMPATIBILITY", "RULESET", "DEPENDENCY", "SERVICE"].includes(blocker.code) ? nothing : html`<p>${blocker.message}</p>`}</details></li>`)}</ul></div>` : nothing}
      <div class="addon-actions"><button ?disabled=${this.#busy || review.blockers.length > 0 || review.required.some(id => !this.grants.includes(id))}
        @click=${() => this.#activate(review)}>${t("addons.approve")}</button><button ?disabled=${this.#busy} @click=${() => this.#closeInstall()}>${t("addons.cancel")}</button></div>
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
  #cleanupPanel(review: CleanupReview) {
    const t = this.#ui.t.bind(this.#ui);
    return html`<section class="addon-review addon-cleanup-review" aria-labelledby="addon-review-title">
      <h3 id="addon-review-title" tabindex="-1">${t("cleanup.title")}</h3>
      <p>${t("cleanup.help")}</p>
      ${review.scope.generationId ? nothing : html`<label>${t("cleanup.keep")} <select ?disabled=${this.#busy} .value=${String(review.scope.keepInactive)} @change=${(event: Event) => this.#prepareCleanup({ keepInactive: Number((event.target as HTMLSelectElement).value) })}>${[0,1,2,3,4,5].map(n => html`<option value=${n}>${n}</option>`)}</select></label><p>${t("cleanup.policy")}</p>`}
      <p>${t("cleanup.summary", { count: review.removeCount, bytes: review.reclaimableBytes })}</p>
      ${review.pendingCleanups ? html`<p role="status">${t("cleanup.pending")}</p><button ?disabled=${this.#busy} @click=${() => this.#retryCleanup()}>${t("cleanup.retry")}</button>` : nothing}
      ${!review.removeCount ? html`<p>${t("cleanup.empty")}</p>` : nothing}
      <ul>${review.generations.map(g => html`<li data-cleanup-generation=${g.generationId}><div><strong>${g.addonId} · ${g.version}</strong>
        <p>${g.remove ? t("cleanup.remove") : t(`cleanup.${g.protection}` as MessageKey, { points: g.recoveryPointIds.join(", ") })}</p>
        <details><summary>${t("cleanup.details")}</summary><code>${g.generationId}</code>${g.remove ? html`<p>${t("cleanup.files", { count: g.files, bytes: g.bytes })}</p><p>${t("cleanup.effects", { reviews: g.activationReviewIds.length, history: g.historyRecords })}</p>` : nothing}</details>
      </div></li>`)}</ul>
      <div class="addon-actions"><button ?disabled=${this.#busy || !review.removeCount || review.pendingCleanups > 0} @click=${() => this.#applyCleanup(review)}>${t("cleanup.confirm")}</button>
        <button ?disabled=${this.#busy} @click=${() => { this.cleanup = undefined; }}>${t("addons.cancel")}</button></div>
    </section>`;
  }
  #prepareCleanup(scope: CleanupScope): void { void this.#run(async client => { this.cleanup = await client.reviewCleanup(scope); }, false); }
  async #cleanupCompleted(client: AddonAdminClient, result: CleanupResult): Promise<void> {
    this.snapshots = await client.inventory();
    this.message = this.#ui.t(result.complete ? "cleanup.done" : "cleanup.pending", { count: result.removedCount, bytes: result.reclaimedBytes });
    if (!result.complete) this.cleanup = await client.reviewCleanup({ keepInactive: 0 });
  }
  #applyCleanup(review: CleanupReview): void { void this.#run(async client => { await this.#cleanupCompleted(client, await client.cleanup(review)); }); }
  #retryCleanup(): void { void this.#run(async client => { await this.#cleanupCompleted(client, await client.retryCleanups()); }); }
  #prepareUninstall(addonId: string): void { void this.#run(async client => { this.review = undefined; this.removal = await client.reviewUninstall(addonId); }); }
  #uninstall(review: AddonUninstallReview): void {
    if (!this.#confirmLifecycle()) return;
    void this.#run(async client => {
      this.#github.clear(review.addonId);
      for (const effect of review.effects) if (effect.disabled) this.#github.clear(effect.addonId);
      const result = await client.uninstall(review);
      this.removal = undefined;
      this.message = this.#ui.t(result.failures.length || result.recoveryError ? "addons.uninstallRecovery" : "addons.uninstalled");
      this.error = [result.recoveryError, ...result.failures.map(failure => `${failure.addonId}: ${failure.error}`)].filter(Boolean).join(" ");
      this.snapshots = await client.inventory();
    }, true, true);
  }
  #prepare(id: string, generation: string): void { this.#openInstall(); this.staged = this.snapshots.find(snapshot => snapshot.state.addonId === id)?.generations.find(value => value.generationId === generation); this.#loadReview(); }
  #activate(review: AddonReview): void { if (!this.#confirmLifecycle()) return; void this.#run(async client => { this.#github.clear(review.addonId); await client.activate(review, this.grants); this.#closeInstall(true); this.snapshots = await client.inventory(); this.message = this.#ui.t("addons.done"); }); }
  #action(snapshot: AddonSnapshot, action: "reload" | "disable"): void {
    if (!this.#confirmLifecycle()) return;
    if (action === "disable" && !window.confirm(this.#ui.t("addons.disableConfirm"))) return;
    void this.#run(async client => { if (action === "disable") this.#github.clear(snapshot.state.addonId); await client.action(snapshot, action); this.review = undefined; this.snapshots = await client.inventory(); this.message = this.#ui.t("addons.done"); });
  }
  async #run(operation: (client: AddonAdminClient) => Promise<void>, mutating = true, uninstalling = false): Promise<void> {
    if (this.#busy || !this.canManage) return;
    const request = this.#request; this.pending = true; this.error = ""; this.message = ""; this.removal = undefined; this.cleanup = undefined;
    if (mutating) { this.#github.clearFeedback(); this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: true, bubbles: true, composed: true })); }
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
    case "COMPATIBILITY": return uiText("github.incompatible");
    case "DEPENDENCY": case "DEPENDENT_INCOMPATIBLE": return uiText("Resolve the required add-on dependencies before activation.");
    case "SERVICE": return uiText("Resolve service-provider conflicts before activation.");
    case "DATA_REVIEW": return uiText("Review the stored data and the package data definitions.");
    case "DATA_MIGRATION_REQUIRED": return uiText("Saved data uses a different format. Follow the add-on's documented upgrade procedure before activating. Uninstalling and reinstalling keeps this data.");
    case "INVALID_STORED_DOCUMENT": return uiText("A saved record does not match this package's data format. Review the affected record in the technical details and follow the add-on's upgrade instructions.");
    case "DATA_DEFINITION_REMOVED": return uiText("This package no longer declares data that is still saved. Follow the add-on's upgrade instructions before activating.");
    case "RECOVERY_REQUIRED": return uiText("Recovery is required before this add-on can be activated.");
    default: return uiText("Activation is blocked. Review the technical details.");
  }
}
