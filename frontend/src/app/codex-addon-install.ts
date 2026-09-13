import { LitElement, html, nothing } from "lit";
import { AddonAdminClient, type InstalledGeneration } from "../core/addon-admin.js";
import { AddonGitHubClient, type GitHubDiscovery, type GitHubLink, type GitHubStatus } from "../core/addon-github.js";
import { githubError } from "./addon-github-controller.js";
import { githubTokenHelp, hasGitHubAccess } from "./github-access.js";
import { UiLocalizationController } from "./ui-localization.js";

/** Source selection and inert staging; activation remains owned by the manager. */
export class CodexAddonInstall extends LitElement {
  static override properties = {
    csrfToken: { attribute: false }, target: { attribute: false }, link: { attribute: false }, status: { attribute: false }, disabled: { type: Boolean },
    step: { state: true }, channel: { state: true }, repository: { state: true }, privateRepo: { state: true }, pending: { state: true }, error: { state: true }, discovery: { state: true }, accessStatus: { state: true },
  };
  declare csrfToken: string;
  declare target: string;
  declare link: GitHubLink | undefined;
  declare status: GitHubStatus | undefined;
  declare disabled: boolean;
  declare private step: "source" | "zip" | "github";
  declare private channel: "actions" | "release";
  declare private repository: string;
  declare private privateRepo: boolean;
  declare private pending: boolean;
  declare private error: string;
  declare private discovery: GitHubDiscovery | undefined;
  declare private accessStatus: GitHubStatus | undefined;
  #request = new AbortController();
  #staged: InstalledGeneration | undefined;
  #sourceSaved = false;
  readonly #ui = new UiLocalizationController(this);
  constructor() { super(); this.target = ""; this.disabled = false; this.step = "source"; this.channel = "release"; this.repository = ""; this.privateRepo = false; this.pending = false; this.error = ""; }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void { this.#request.abort(); super.disconnectedCallback(); }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("link") || changed.has("target")) {
      this.step = this.target ? "github" : "source";
      this.repository = this.link?.source.repo ?? "";
      this.channel = this.link?.source.channel ?? "release";
      this.privateRepo = !!this.status?.credentials.repositories.includes(this.repository);
    }
  }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("step")) this.querySelector<HTMLElement>("h4")?.focus();
    if (changed.has("discovery") && this.discovery) this.querySelector<HTMLElement>(".github-candidates h4")?.focus();
  }
  get #busy(): boolean { return this.pending || this.disabled; }
  protected override render() {
    const t = this.#ui.t.bind(this.#ui);
    return html`<div class="addon-install-step" aria-busy=${this.pending}>
      ${this.step !== "source" && !this.target ? html`<button type="button" ?disabled=${this.#busy} @click=${() => { this.step = "source"; this.discovery = undefined; this.error = ""; }}>${t("github.back")}</button>` : nothing}
      <h4 tabindex="-1">${t(this.step === "source" ? "github.chooseSource" : this.step === "zip" ? "github.zip" : "github.repositorySetup")}</h4>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.step === "source" ? html`<p>${t("github.wizardIntro")}</p><div class="addon-source-choices">
        <button type="button" ?disabled=${this.#busy} @click=${() => { this.step = "github"; }}><strong>GitHub</strong><span>${t("github.githubHelp")}</span></button>
        <button type="button" ?disabled=${this.#busy} @click=${() => { this.step = "zip"; }}><strong>${t("github.zip")}</strong><span>${t("github.zipHelp")}</span></button>
      </div>` : this.step === "zip" ? html`<form class="addon-upload" @submit=${this.#upload}>
        <p>${t("github.zipHint")}</p><label>${t("addons.file")}<input type="file" name="package" accept=".zip,application/zip" required ?disabled=${this.#busy}></label>
        <button ?disabled=${this.#busy}>${t(this.pending ? "github.preparing" : "addons.upload")}</button></form>` : this.#githubForm()}
    </div>`;
  }
  #githubForm() {
    const t = this.#ui.t.bind(this.#ui), access = hasGitHubAccess(this.accessStatus ?? this.status, this.repository);
    return html`<form class="addon-source-form addon-install-form" @submit=${this.#discover} @input=${() => { this.discovery = undefined; }} @change=${() => { this.discovery = undefined; }}>
      <label>${t("github.repo")}<input name="repo" required placeholder="owner/repository" maxlength="250" .value=${this.repository} ?disabled=${this.#busy}
        @input=${(event: Event) => { this.repository = (event.target as HTMLInputElement).value; }}></label>
      <label>${t("github.channel")}<select name="channel" .value=${this.channel} ?disabled=${this.#busy}
        @change=${(event: Event) => { this.channel = (event.target as HTMLSelectElement).value as "actions" | "release"; }}>
        <option value="release">${t("github.release")}</option><option value="actions">${t("github.actions")}</option></select></label>
      ${this.channel === "actions" ? html`<details class="addon-build-options"><summary>${t("github.buildOptions")}</summary>
        <p>${t("github.buildDefaults")}</p><label>${t("github.branch")}<input name="branch" maxlength="200" .value=${this.link?.source.branch ?? ""} placeholder=${t("github.defaultBranch")} ?disabled=${this.#busy}></label>
        <label>${t("github.artifact")}<input name="artifact" maxlength="200" .value=${this.link?.source.artifact || "reviewed-package"} ?disabled=${this.#busy}></label></details>` : nothing}
      <label class="addon-private-toggle"><input name="private" type="checkbox" .checked=${this.privateRepo} ?disabled=${this.#busy}
        @change=${(event: Event) => { this.privateRepo = (event.target as HTMLInputElement).checked; }}>${t("github.private")}</label>
      ${this.privateRepo || this.channel === "actions" ? html`<section class="addon-repository-access" aria-label=${t("github.token")}>
        ${this.channel === "actions" ? html`<p>${t("github.actionsToken")}</p>` : nothing}
        ${access ? html`<p role="status">${t("github.savedAccess")}</p>` : nothing}
        <label>${t(access ? "github.replaceToken" : "github.token")}<input name="token" type="password" ?required=${!access} minlength="8" maxlength="255" autocomplete="new-password" ?disabled=${this.#busy}></label>
        ${this.privateRepo ? githubTokenHelp(t) : html`<details><summary>${t("github.tokenInstructions")}</summary>${githubTokenHelp(t)}</details>`}
      </section>` : nothing}
      <button ?disabled=${this.#busy}>${t(this.pending ? "github.finding" : this.target ? "github.link" : "github.find")}</button>
    </form>
    ${this.discovery ? html`<section class="github-candidates"><h4 tabindex="-1">${t("github.choosePackage")}</h4><p>${t("github.reviewHint")}</p>
      ${!this.discovery.candidates.length ? html`<p role="status">${t("github.noPackage")}</p>` : nothing}
      <ul>${this.discovery.candidates.map(candidate => html`<li><div><strong>${candidate.name}</strong><small>${candidate.version}</small></div>
        <button ?disabled=${this.#busy} @click=${() => this.#stage(candidate.id)}>${t("github.download")}</button></li>`)}</ul></section>` : nothing}`;
  }
  readonly #upload = (event: SubmitEvent): void => {
    event.preventDefault(); if (this.#busy) return;
    const file = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>('input[type="file"]')?.files?.[0];
    if (!file?.size || file.size > 128 * 1024 * 1024) { this.error = this.#ui.t("addons.fileRequired"); return; }
    void this.#run(async () => { this.#staged = await new AddonAdminClient(this.csrfToken, this.#request.signal).stage(file); });
  };
  readonly #discover = (event: SubmitEvent): void => {
    event.preventDefault(); if (this.#busy) return;
    const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
    const source = { repo: this.repository, channel: this.channel, branch: String(data.get("branch") ?? ""), artifact: String(data.get("artifact") ?? "") };
    const token = String(data.get("token") ?? "").trim();
    const input = form.querySelector<HTMLInputElement>('input[name="token"]'); if (input) input.value = "";
    this.discovery = undefined;
    void this.#run(async client => {
      if (token) this.accessStatus = await client.token(source.repo, token);
      else this.accessStatus = await client.status();
      const discovery = await client.discover(source, this.target);
      if (this.target) {
        await client.source({ addonId: this.target, source: discovery.source, revision: this.link?.revision ?? 0 });
        this.#sourceSaved = true;
      } else this.discovery = discovery;
    });
  };
  #stage(candidateId: string): void {
    const discovery = this.discovery; if (!discovery) return;
    void this.#run(async client => { this.#staged = await client.stage(discovery.source, candidateId); });
  }
  async #run(operation: (client: AddonGitHubClient) => Promise<void>): Promise<void> {
    if (this.#busy) return;
    const request = this.#request; this.pending = true; this.error = "";
    this.dispatchEvent(new CustomEvent("addon-install-busy", { detail: true, bubbles: true, composed: true }));
    try { await operation(new AddonGitHubClient(this.csrfToken, request.signal)); }
    catch (error) {
      if (!request.signal.aborted) {
        this.error = githubError(error, this.#ui.t.bind(this.#ui));
        // A token save may have succeeded even if its response was lost.
        this.accessStatus = await new AddonGitHubClient(this.csrfToken, request.signal).status().catch(() => this.accessStatus);
      }
    } finally {
      if (!request.signal.aborted) { this.pending = false; this.dispatchEvent(new CustomEvent("addon-install-busy", { detail: false, bubbles: true, composed: true })); }
    }
    if (!request.signal.aborted && this.#staged) this.dispatchEvent(new CustomEvent("addon-package-staged", { detail: this.#staged, bubbles: true, composed: true }));
    if (!request.signal.aborted && this.#sourceSaved) this.dispatchEvent(new CustomEvent("addon-source-saved", { bubbles: true, composed: true }));
  }
}
customElements.define("codex-addon-install", CodexAddonInstall);
