import { LitElement, html, nothing } from "lit";
import { AddonGitHubClient, GitHubRequestError, type GitHubSource, type GitHubStatus, type GitHubDiscovery, type GitHubLink } from "../core/addon-github.js";
import type { AddonSnapshot, InstalledGeneration } from "../core/addon-admin.js";
import { UiLocalizationController } from "./ui-localization.js";
import { uiRequestError } from "./ui-errors.js";

export class CodexAddonGitHub extends LitElement {
  static override properties = { csrfToken: { attribute: false }, snapshots: { attribute: false }, disabled: { type: Boolean }, status: { state: true }, pending: { state: true }, error: { state: true }, message: { state: true }, discoveries: { state: true }, channel: { state: true }, target: { state: true } };
  declare csrfToken: string;
  declare snapshots: AddonSnapshot[];
  declare disabled: boolean;
  declare private status: GitHubStatus | undefined;
  declare private pending: boolean;
  declare private error: string;
  declare private message: string;
  declare private discoveries: Record<string, GitHubDiscovery | string>;
  declare private channel: "release" | "actions";
  declare private target: string;
  #request = new AbortController();
  readonly #ui = new UiLocalizationController(this);
  constructor() { super(); this.snapshots = []; this.disabled = false; this.pending = false; this.error = ""; this.message = ""; this.discoveries = {}; this.channel = "actions"; this.target = ""; }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#request = new AbortController(); void this.refresh(); }
  override disconnectedCallback(): void { this.#request.abort(); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void { if (changed.has("snapshots")) this.discoveries = {}; }
  async refresh(): Promise<void> { await this.#run(async client => { this.status = await client.status(); this.discoveries = {}; }); }
  get #busy(): boolean { return this.pending || this.disabled; }
  protected override render() {
    const t = this.#ui.t.bind(this.#ui), status = this.status;
    return html`<section class="addon-github" aria-busy=${this.pending}>
      <h3>${t("github.title")}</h3><p>${t("github.intro")}</p>
      ${this.error ? html`<p role="alert">${this.error}</p><button ?disabled=${this.#busy} @click=${() => this.refresh()}>${t("addons.refresh")}</button>` : nothing}
      ${this.message ? html`<p role="status">${this.message}</p>` : nothing}
      <form class="addon-source-form" @submit=${this.#connect}>
        <label>${t("github.target")}<select name="target" .value=${this.target} ?disabled=${this.#busy} @change=${(e: Event) => { this.target = (e.target as HTMLSelectElement).value; this.discoveries = {}; }}><option value="">${t("github.new")}</option>${this.snapshots.map(s => html`<option value=${s.state.addonId}>${s.state.addonId}</option>`)}</select></label>
        <label>${t("github.repo")}<input name="repo" required placeholder="owner/repository" maxlength="250" ?disabled=${this.#busy}></label>
        <label>${t("github.channel")}<select name="channel" .value=${this.channel} ?disabled=${this.#busy} @change=${(e: Event) => { this.channel = (e.target as HTMLSelectElement).value as "release" | "actions"; }}><option value="actions">${t("github.actions")}</option><option value="release">${t("github.release")}</option></select></label>
        ${this.channel === "actions" ? html`<label>${t("github.branch")}<input name="branch" maxlength="200" placeholder=${t("github.defaultBranch")} ?disabled=${this.#busy}></label><label>${t("github.artifact")}<input name="artifact" maxlength="200" value="reviewed-package" ?disabled=${this.#busy}></label>` : nothing}
        <button ?disabled=${this.#busy || !status}>${t(this.target ? "github.link" : "github.find")}</button>
      </form>
      ${this.#candidates("")}
      ${status ? html`<div class="addon-actions"><button ?disabled=${this.#busy || !status.sources.length} @click=${() => this.#checkAll()}>${t("github.checkAll")}</button></div>
        <ul class="github-sources">${status.sources.map(link => this.#sourceRow(link))}</ul>
        <details class="github-tokens" open><summary>${t("github.tokens")}</summary><p>${t("github.tokenHint")}</p>
          <p>${t("github.defaultToken")}: ${t(`github.token.${status.credentials.defaultSource}`)}</p>
          ${status.credentials.environmentConfigured ? html`<small>${t("github.environmentHint")}</small>` : nothing}
          <form class="addon-source-form" @submit=${this.#saveToken}><label>${t("github.tokenScope")}<input name="repo" maxlength="250" placeholder=${t("github.defaultToken")} ?disabled=${this.#busy}></label>
            <label>${t("github.token")}<input name="token" type="password" required minlength="8" maxlength="255" autocomplete="new-password" ?disabled=${this.#busy}></label><button ?disabled=${this.#busy}>${t("github.saveToken")}</button></form>
          <ul>${status.credentials.defaultSource === "stored" ? html`<li>${t("github.defaultToken")}<button ?disabled=${this.#busy} @click=${() => this.#removeToken("")}>${t("github.removeToken")}</button></li>` : nothing}
            ${status.credentials.repositories.map(repo => html`<li>${repo}<button ?disabled=${this.#busy} @click=${() => this.#removeToken(repo)}>${t("github.removeToken")}</button></li>`)}</ul>
        </details>` : nothing}
    </section>`;
  }
  #sourceRow(link: GitHubLink) {
    const t = this.#ui.t.bind(this.#ui), snapshot = this.snapshots.find(s => s.state.addonId === link.addonId), active = snapshot?.generations.find(g => g.generationId === snapshot.state.activeGenerationId);
    return html`<li class="github-source" data-github-addon=${link.addonId}><div><strong>${link.addonId}</strong>${active ? html` · ${active.version}` : nothing}
      <small><a href=${`https://github.com/${link.source.repo}`} target="_blank" rel="noreferrer">${link.source.repo}</a> · ${t(link.source.channel === "actions" ? "github.actions" : "github.release")}${link.source.channel === "actions" ? ` · ${link.source.branch || t("github.defaultBranch")} · ${link.source.artifact}` : ""}</small>
      <small>${t("github.token")}: ${t(this.status?.credentials.repositories.includes(link.source.repo) ? "github.scopedToken" : `github.token.${this.status?.credentials.defaultSource ?? "none"}`)}</small></div>
      <div class="addon-actions"><button ?disabled=${this.#busy} @click=${() => this.#run(async client => { await this.#check(client, link); })}>${t("github.check")}</button>
      <button ?disabled=${this.#busy} @click=${() => this.#run(async client => { this.status = await client.source(link, true); this.discoveries = {}; })}>${t("github.unlink")}</button></div>${this.#candidates(link.addonId)}</li>`;
  }
  #candidates(addonId: string) {
    const discovery = this.discoveries[addonId], t = this.#ui.t.bind(this.#ui);
    if (!discovery) return nothing;
    if (typeof discovery === "string") return html`<p role="alert">${discovery}</p>`;
    return html`<div class="github-candidates"><ul>${discovery.candidates.map(candidate => html`<li><div><strong>${candidate.name}</strong><small>${candidate.version}</small></div>
      ${candidate.active ? html`<p role="status">${t("github.current")}</p>` : html`<button ?disabled=${this.#busy} @click=${() => this.#stage(discovery, candidate.id, addonId)}>${t("github.download")}</button>`}</li>`)}</ul></div>`;
  }
  async #stage(discovery: GitHubDiscovery, candidateId: string, addonId: string): Promise<void> {
    let generation: InstalledGeneration | undefined;
    await this.#run(async client => { generation = await client.stage(discovery.source, candidateId, addonId); this.discoveries = {}; this.status = await client.status(); });
    if (generation && !this.#request.signal.aborted) this.dispatchEvent(new CustomEvent("github-package-staged", { detail: generation, bubbles: true, composed: true }));
  }
  readonly #connect = (event: SubmitEvent): void => {
    event.preventDefault(); if (this.#busy) return;
    const data = new FormData(event.currentTarget as HTMLFormElement), target = String(data.get("target") ?? "");
    const source: GitHubSource = { repo: String(data.get("repo") ?? ""), channel: this.channel, branch: String(data.get("branch") ?? ""), artifact: String(data.get("artifact") ?? "") };
    void this.#run(async client => {
      this.discoveries = {};
      if (target) { this.status = await client.source({ addonId: target, source, revision: this.status?.sources.find(s => s.addonId === target)?.revision ?? 0 });
        const linked = this.status.sources.find(s => s.addonId === target); if (linked) await this.#check(client, linked);
      } else { this.discoveries = { "": await client.discover(source) }; }
    });
  };
  readonly #saveToken = (event: SubmitEvent): void => {
    event.preventDefault(); if (this.#busy) return;
    const form = event.currentTarget as HTMLFormElement, data = new FormData(form), token = String(data.get("token") ?? ""), repo = String(data.get("repo") ?? "");
    const input = form.querySelector<HTMLInputElement>('input[name="token"]'); if (input) input.value = "";
    void this.#run(async client => { this.status = await client.token(repo, token); this.discoveries = {}; this.message = this.#ui.t("github.tokenSaved"); });
  };
  #removeToken(repo: string): void { void this.#run(async client => { this.status = await client.token(repo, ""); this.discoveries = {}; this.message = this.#ui.t("github.tokenSaved"); }); }
  async #check(client: AddonGitHubClient, link: GitHubLink): Promise<void> {
    try { this.discoveries = { ...this.discoveries, [link.addonId]: await client.discover(link.source, link.addonId) }; }
    catch (error) { if (!this.#request.signal.aborted) this.discoveries = { ...this.discoveries, [link.addonId]: this.#errorMessage(error) }; }
  }
  #checkAll(): void { void this.#run(async client => { this.discoveries = {}; for (const link of this.status?.sources ?? []) { if (this.#request.signal.aborted) break; await this.#check(client, link); } }); }
  #errorMessage(error: unknown): string {
    if (!(error instanceof GitHubRequestError)) return uiRequestError(error);
    const t = this.#ui.t.bind(this.#ui);
    switch (error.code) {
      case "GITHUB_INVALID": return t("github.invalid");
      case "GITHUB_IDENTITY": return t("github.identity");
      case "GITHUB_PACKAGE": return t("github.invalidPackage");
      case "GITHUB_NO_PACKAGE": return t("github.noPackage");
      case "GITHUB_UNAVAILABLE": return t("github.unavailable");
      default: return uiRequestError(error);
    }
  }
  async #run(operation: (client: AddonGitHubClient) => Promise<void>): Promise<void> {
    if (this.pending) return;
    const request = this.#request; this.pending = true; this.error = ""; this.message = "";
    this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: true, bubbles: true, composed: true }));
    try { await operation(new AddonGitHubClient(this.csrfToken, request.signal)); }
    catch (error) { if (!request.signal.aborted) { this.discoveries = {}; this.error = this.#errorMessage(error); } }
    finally { if (!request.signal.aborted) { this.pending = false; this.dispatchEvent(new CustomEvent("addon-admin-busy", { detail: false, bubbles: true, composed: true })); } }
  }
}
customElements.define("codex-addon-github", CodexAddonGitHub);
