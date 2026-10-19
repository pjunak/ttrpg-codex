import { LitElement, html, type PropertyValues } from "lit";
import { formText } from "../core/forms.js";
import { isPlayerPreview } from "../core/player-preview.js";
import type { AddonState } from "./addon-outlets-controller.js";
import type { Authority, LiveState, Readiness } from "./session-controller.js";
import { uiPlural, uiText, UiLocalizationController, type MessageKey } from "./ui-localization.js";

/**
 * The sidebar's account menu: sign in or out, how the browser add-ons are
 * doing, and whether the host and live updates answer. A player preview tab
 * offers to close the preview instead.
 */
export class CodexAccountMenu extends LitElement {
  static override properties = {
    authority: { attribute: false },
    readiness: { attribute: false },
    liveState: { attribute: false },
    addonState: { attribute: false },
    busy: { type: Boolean },
    signIn: { attribute: false },
    signOut: { attribute: false },
    closePreview: { attribute: false },
  };
  declare authority: Authority;
  declare readiness: Readiness;
  declare liveState: LiveState;
  declare addonState: AddonState;
  declare busy: boolean;
  declare signIn: (password: string) => Promise<void>;
  declare signOut: () => void;
  declare closePreview: () => void;

  constructor() {
    super();
    new UiLocalizationController(this);
    this.authority = { state: "checking" };
    this.readiness = { state: "checking" };
    this.liveState = "connecting";
    this.addonState = { state: "idle" };
    this.busy = false;
    this.signIn = async () => undefined;
    this.signOut = () => undefined;
    this.closePreview = () => undefined;
  }

  protected override createRenderRoot() {
    return this;
  }

  /** Opens the menu on its sign-in form. */
  async openSignIn(): Promise<void> {
    await this.updateComplete;
    const menu = this.querySelector<HTMLDetailsElement>(".account-menu");
    if (menu !== null) menu.open = true;
    this.querySelector<HTMLInputElement>('.account-panel input[name="password"]')?.focus();
  }

  protected override updated(changed: PropertyValues<this>): void {
    // The menu opened only to sign in; give its room back to the navigation.
    const before = changed.get("authority");
    if (
      before?.state === "known" &&
      !before.auth.authenticated &&
      this.authority.state === "known" &&
      this.authority.auth.authenticated
    ) {
      const menu = this.querySelector<HTMLDetailsElement>(".account-menu");
      if (menu !== null) menu.open = false;
    }
  }

  protected override render() {
    return html`<details class="account-menu">
      <summary>${this.#label()}</summary>
      ${this.#panel()}
      <div class="content-statusbar">
        ${this.#hostState()}
        <span class=${`live-state live-${this.liveState}`}><span aria-hidden="true"></span>${uiText(liveMessageKey(this.liveState))}</span>
      </div>
    </details>`;
  }

  #panel() {
    if (isPlayerPreview())
      return html`<section class="account-panel"><p>${uiText("shell.viewingAs")} <strong>${uiText("shell.player")}</strong></p>
      <button class="text-button" type="button" @click=${() => this.closePreview()}>${uiText("preview.close")}</button></section>`;
    if (this.authority.state === "checking")
      return html`<section class="account-panel"><p class="loading-line">${uiText("shell.checkingSession")}</p></section>`;
    if (!this.authority.auth.authenticated)
      return html`
        <section class="account-panel">
          <h2>${uiText("shell.privateArchive")}</h2>
          <form @submit=${this.#submit}>
            <label>
              <span class="visually-hidden">${uiText("shell.passwordLabel")}</span>
              <input name="password" type="password" minlength="4" autocomplete="current-password" placeholder=${uiText("shell.passwordPlaceholder")} required />
            </label>
            <button type="submit" ?disabled=${this.busy}>${uiText("shell.signIn")}</button>
          </form>
        </section>
      `;
    return html`
      <section class="account-panel signed-in">
        <button class="text-button" type="button" @click=${() => this.signOut()} ?disabled=${this.busy}>${uiText("shell.signOut")}</button>
        <small title=${this.#addonTitle()}>${this.#addonLabel()}</small>
      </section>
    `;
  }

  readonly #submit = (event: SubmitEvent): void => {
    event.preventDefault();
    void this.signIn(formText(new FormData(event.currentTarget as HTMLFormElement), "password"));
  };

  #label(): string {
    if (this.authority.state === "checking") return uiText("shell.menu");
    if (!this.authority.auth.authenticated) return uiText("shell.signIn");
    return uiText(this.authority.auth.role === "dm" ? "shell.signedInDm" : "shell.signedInPlayer");
  }

  #addonLabel(): string {
    const state = this.addonState;
    switch (state.state) {
      case "idle":
        return uiText("shell.addonsIdle");
      case "loading":
        return uiText("shell.addonsLoading");
      case "ready":
        return state.failures === 0
          ? uiPlural("shell.browserAddonsRunning", state.active)
          : uiText("shell.addonsActiveFailed", { active: state.active, failed: state.failures });
      case "degraded":
        return uiText("shell.addonsAttention");
    }
  }

  #addonTitle(): string {
    if (this.addonState.state === "ready") return this.addonState.revision;
    if (this.addonState.state === "degraded") return this.addonState.message;
    return this.#addonLabel();
  }

  #hostState() {
    if (this.readiness.state === "checking")
      return html`<span class="host-state"><span aria-hidden="true"></span>${uiText("shell.checkingHost")}</span>`;
    if (this.readiness.state === "unavailable")
      return html`<span class="host-state host-unavailable" title=${this.readiness.message}><span aria-hidden="true"></span>${uiText("shell.hostUnavailable")}</span>`;
    return html`<span class="host-state" title=${`Codex ${this.readiness.health.version}`}><span aria-hidden="true"></span>Codex ${this.readiness.health.version}</span>`;
  }
}

function liveMessageKey(state: LiveState): MessageKey {
  switch (state) {
    case "connecting":
      return "shell.connecting";
    case "connected":
      return "shell.live";
    case "reconnecting":
      return "shell.reconnecting";
  }
}

if (!customElements.get("codex-account-menu"))
  customElements.define("codex-account-menu", CodexAccountMenu);
