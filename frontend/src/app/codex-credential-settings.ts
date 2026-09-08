import { LitElement, html, nothing } from "lit";
import { changePassword, CredentialRequestError, getCredentialStatus, type CredentialStatus } from "../core/credentials.js";
import { UiLocalizationController } from "./ui-localization.js";

type Role = "dm" | "player";
interface Draft { current: string; password: string; confirmation: string; disable: boolean }
const blank = (): Draft => ({ current: "", password: "", confirmation: "", disable: false });

export class CodexCredentialSettings extends LitElement {
  static override properties = { csrfToken: { attribute: false }, status: { state: true }, loading: { state: true }, saving: { state: true }, message: { state: true } };
  declare csrfToken: string;
  declare status: CredentialStatus | undefined;
  declare loading: boolean;
  declare saving: boolean;
  declare message: string;
  #ui = new UiLocalizationController(this);
  #abort = new AbortController();
  #drafts: Record<Role, Draft> = { dm: blank(), player: blank() };
  #reloadRequired = false;
  #success = false;
  constructor() { super(); this.csrfToken = ""; this.loading = false; this.saving = false; this.message = ""; }
  protected override createRenderRoot(): HTMLElement { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#abort = new AbortController(); void this.#load(); }
  override disconnectedCallback(): void {
    this.#abort.abort(); this.#drafts = { dm: blank(), player: blank() }; this.status = undefined; this.loading = false; this.saving = false;
    super.disconnectedCallback();
  }

  protected override render() {
    return html`<section class="settings-ledger settings-account-panel" aria-labelledby="credentials-title">
      <header class="settings-ledger-heading"><div><span class="settings-category-mark" aria-hidden="true">🖥</span><div>
        <h2 id="credentials-title">${this.#ui.t("credentials.title")}</h2><p>${this.#ui.t("credentials.intro")}</p>
      </div></div></header>
      <button type="button" ?disabled=${this.loading || this.saving} @click=${() => void this.#load()}>${this.#ui.t(this.loading ? "credentials.loading" : "credentials.refresh")}</button>
      ${this.message ? html`<p role=${this.#success ? "status" : "alert"}>${this.#message()}</p>` : nothing}
      ${this.status ? html`${this.#form("dm")}${this.#form("player")}` : nothing}
    </section>`;
  }

  #message(): string {
    switch (this.message) {
      case "saved": return this.#ui.t("credentials.saved");
      case "mismatch": return this.#ui.t("credentials.mismatch");
      case "currentIncorrect": return this.#ui.t("credentials.currentIncorrect");
      case "policy": return this.#ui.t("credentials.policy");
      case "forbidden": return this.#ui.t("credentials.forbidden");
      case "conflict": return this.#ui.t("credentials.conflict");
      case "rateLimited": return this.#ui.t("credentials.rateLimited");
      case "loadFailed": return this.#ui.t("credentials.loadFailed");
      default: return this.#ui.t("credentials.failed");
    }
  }

  #form(role: Role) {
    const draft = this.#drafts[role];
    return html`<form class="settings-password-card" data-role=${role} @submit=${(event: SubmitEvent) => void this.#save(event, role)}>
      <div class="settings-password-card-head"><h3>${this.#ui.t(role === "dm" ? "credentials.dm" : "credentials.player")}</h3>
        <span class="settings-password-status">${this.#ui.t(role === "dm" || this.status?.playerEnabled ? "credentials.enabled" : "credentials.disabled")}</span></div>
      <p class="settings-hint">${this.#ui.t(role === "dm" ? "credentials.dmEffect" : "credentials.playerEffect")}</p>
      <fieldset ?disabled=${this.saving || this.loading}><div class="settings-password-fields">
        ${this.#field(role, "current", this.#ui.t("credentials.current"), "current-password")}
        ${this.#field(role, "password", this.#ui.t("credentials.new"), "new-password")}
        ${this.#field(role, "confirmation", this.#ui.t("credentials.confirm"), "new-password")}
      </div>
      ${role === "player" ? html`<label class="settings-password-disable"><input type="checkbox" .checked=${draft.disable} @change=${(event: Event) => {
        draft.disable = (event.currentTarget as HTMLInputElement).checked; draft.password = ""; draft.confirmation = ""; this.#publish(); this.requestUpdate();
      }} />${this.#ui.t("credentials.disable")}</label>` : nothing}
      <button class="primary" type="submit" ?disabled=${this.#reloadRequired}>${this.#ui.t(this.saving ? "settings.saving" : draft.disable ? "credentials.disableSave" : "credentials.save")}</button>
      </fieldset>
    </form>`;
  }

  #field(role: Role, key: "current" | "password" | "confirmation", label: string, autocomplete: string) {
    const disabled = key !== "current" && this.#drafts[role].disable;
    return html`<label class="settings-field"><span>${label}</span><input type="password" autocomplete=${autocomplete} .value=${this.#drafts[role][key]}
      ?disabled=${disabled} ?required=${!disabled} minlength=${key === "current" ? 1 : 4} maxlength="4096" @input=${(event: Event) => {
        this.#drafts[role][key] = (event.currentTarget as HTMLInputElement).value; this.#publish();
      }} /></label>`;
  }

  #publish(): void {
    const dirty = Object.values(this.#drafts).some(draft => draft.current !== "" || draft.password !== "" || draft.confirmation !== "" || draft.disable);
    this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty, saving: this.saving }, bubbles: true, composed: true }));
  }

  async #load(): Promise<void> {
    if (this.loading || this.saving) return;
    const signal = this.#abort.signal; this.loading = true;
    try { const status = await getCredentialStatus(signal); if (!signal.aborted) { this.status = status; this.#reloadRequired = false; this.message = ""; } }
    catch { if (!signal.aborted) { this.message = "loadFailed"; this.#success = false; } }
    finally { if (!signal.aborted) this.loading = false; }
  }

  async #save(event: SubmitEvent, role: Role): Promise<void> {
    event.preventDefault();
    if (!this.status || this.saving || this.loading || this.#reloadRequired) return;
    const draft = this.#drafts[role]; this.#success = false;
    if (!draft.disable && draft.password !== draft.confirmation) { this.message = "mismatch"; return; }
    const signal = this.#abort.signal; this.saving = true; this.message = ""; this.#publish();
    try {
      const status = await changePassword({ role, currentPassword: draft.current, newPassword: draft.disable ? "" : draft.password, expectedRevision: this.status.revision }, this.csrfToken, signal);
      if (signal.aborted) return;
      this.status = status; this.#drafts[role] = blank(); this.#success = true; this.message = "saved";
    } catch (error) {
      if (signal.aborted) return;
      this.message = error instanceof CredentialRequestError ? error.code : "failed";
      this.#reloadRequired = this.message === "conflict" || this.message === "failed";
    } finally { if (!signal.aborted) { this.saving = false; this.#publish(); } }
  }
}
customElements.define("codex-credential-settings", CodexCredentialSettings);
