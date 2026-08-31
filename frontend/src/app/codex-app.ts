import { LitElement, css, html } from "lit";
import {
  getAuth,
  getHealth,
  login as loginSession,
  logout as logoutSession,
  type AuthState,
  type Health,
} from "../core/api.js";
import {
  createBrowserAddonComposition,
  type BrowserAddonComposition,
} from "./browser-addons.js";

type Readiness =
  | { state: "checking" }
  | { state: "ready"; health: Health }
  | { state: "unavailable"; message: string };

type Authority =
  | { state: "checking" }
  | { state: "known"; auth: AuthState };

type AddonState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; active: number; revision: string; failures: number }
  | { state: "degraded"; message: string };

export class CodexApp extends LitElement {
  static override styles = css`
    :host {
      display: grid;
      min-height: 100vh;
      place-items: center;
      padding: 2rem;
      background:
        linear-gradient(115deg, rgb(195 164 100 / 6%), transparent 38%),
        #15171c;
    }

    main {
      position: relative;
      width: min(42rem, 100%);
      padding: clamp(1.5rem, 5vw, 3rem) clamp(1.5rem, 6vw, 3.5rem);
      overflow: hidden;
      border: 1px solid #494941;
      border-radius: 0.45rem;
      background: #252933;
      box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 36%);
    }

    main::before {
      position: absolute;
      inset: 0 auto 0 0.8rem;
      width: 0.5rem;
      background: radial-gradient(circle, #c3a464 0 1.5px, transparent 2px) center / 0.5rem 1.1rem repeat-y;
      content: "";
      opacity: 0.62;
      pointer-events: none;
    }

    p {
      color: #c9c6ba;
      line-height: 1.6;
    }

    h1 {
      margin: 0;
      color: #ded4bc;
      font-family: Palatino, "Palatino Linotype", Georgia, serif;
      font-size: clamp(2rem, 7vw, 4rem);
      font-weight: 500;
      letter-spacing: -0.04em;
    }

    .eyebrow {
      margin: 0 0 0.75rem;
      color: #c3a464;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .status,
    .account {
      display: flex;
      gap: 0.65rem;
      align-items: center;
      margin-top: 1rem;
      color: #d5d2c8;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 0.9rem;
    }

    .host-status {
      margin-top: 2rem;
      padding-top: 1.25rem;
      border-top: 1px solid #41433f;
    }

    .indicator {
      width: 0.65rem;
      height: 0.65rem;
      flex: 0 0 auto;
      border-radius: 50%;
      background: #918f87;
      box-shadow: 0 0 0 0.25rem rgb(145 143 135 / 12%);
    }

    .indicator.ready {
      background: #8ca982;
    }

    .indicator.unavailable {
      background: #c87768;
    }

    form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.75rem;
      margin-top: 1.5rem;
    }

    input,
    button {
      min-height: 2.75rem;
      border: 1px solid #55584f;
      border-radius: 0.3rem;
      font: inherit;
    }

    input {
      min-width: 0;
      padding: 0.65rem 0.8rem;
      color: #f0eadb;
      background: #191c23;
    }

    button {
      padding: 0.65rem 1rem;
      color: #211d15;
      background: #c3a464;
      cursor: pointer;
    }

    button.secondary {
      min-height: 2.25rem;
      margin-left: auto;
      padding: 0.35rem 0.75rem;
      color: #d5d2c8;
      background: transparent;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.6;
    }

    input:focus-visible,
    button:focus-visible {
      outline: 2px solid #ded4bc;
      outline-offset: 3px;
    }

    .error {
      margin: 0.75rem 0 0;
      color: #e6a298;
      font-size: 0.9rem;
    }

    @media (max-width: 32rem) {
      form {
        grid-template-columns: 1fr;
      }
    }
  `;

  static override properties = {
    readiness: { state: true },
    authority: { state: true },
    addonState: { state: true },
    busy: { state: true },
    errorMessage: { state: true },
  };

  declare private readiness: Readiness;
  declare private authority: Authority;
  declare private addonState: AddonState;
  declare private busy: boolean;
  declare private errorMessage: string;
  #request: AbortController | undefined;
  #addons: BrowserAddonComposition | undefined;
  #addonOwner = 0;

  constructor() {
    super();
    this.readiness = { state: "checking" };
    this.authority = { state: "checking" };
    this.addonState = { state: "idle" };
    this.busy = false;
    this.errorMessage = "";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#request = new AbortController();
    void this.#bootstrap(this.#request.signal);
  }

  override disconnectedCallback(): void {
    this.#request?.abort("component-disconnected");
    this.#request = undefined;
    void this.#stopAddons();
    super.disconnectedCallback();
  }

  protected override render() {
    return html`
      <main>
        <p class="eyebrow">Campaign archive</p>
        <h1>TTRPG Codex</h1>
        <p>
          Sign in to open the campaign tools and the add-ons available to your role.
        </p>
        ${this.#hostStatusTemplate()}
        ${this.#authorityTemplate()}
        ${this.errorMessage === "" ? null : html`<p class="error" role="alert">${this.errorMessage}</p>`}
      </main>
    `;
  }

  async #bootstrap(signal: AbortSignal): Promise<void> {
    try {
      const health = await getHealth(signal);
      this.readiness = { state: "ready", health };
    } catch (error: unknown) {
      if (signal.aborted) {
        return;
      }
      this.readiness = { state: "unavailable", message: errorMessage(error) };
      this.authority = { state: "known", auth: anonymousAuth() };
      return;
    }
    try {
      const auth = await getAuth(signal);
      this.authority = { state: "known", auth };
      if (auth.authenticated) {
        await this.#startAddons();
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        return;
      }
      this.authority = { state: "known", auth: anonymousAuth() };
      this.errorMessage = errorMessage(error);
    }
  }

  async #login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.busy || this.#request === undefined) {
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const password = String(new FormData(form).get("password") ?? "");
    this.busy = true;
    this.errorMessage = "";
    try {
      const auth = await loginSession(password, this.#request.signal);
      this.authority = { state: "known", auth };
      form.reset();
      await this.#startAddons();
    } catch (error: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = errorMessage(error);
      }
    } finally {
      this.busy = false;
    }
  }

  async #logout(): Promise<void> {
    if (this.busy || this.#request === undefined) {
      return;
    }
    this.busy = true;
    this.errorMessage = "";
    try {
      await this.#stopAddons();
      await logoutSession(this.#request.signal);
      this.authority = { state: "known", auth: anonymousAuth() };
    } catch (error: unknown) {
      if (!this.#request.signal.aborted) {
        this.errorMessage = errorMessage(error);
      }
    } finally {
      this.busy = false;
    }
  }

  async #startAddons(): Promise<void> {
    await this.#stopAddons();
    const owner = ++this.#addonOwner;
    this.addonState = { state: "loading" };
    const composition = createBrowserAddonComposition(document, {
      onRefresh: (_cause, result) => {
        if (owner !== this.#addonOwner) {
          return;
        }
        this.addonState = {
          state: "ready",
          active: result.lifecycle.active.length,
          revision: result.lifecycle.graphRevision,
          failures: result.lifecycle.activationFailures.length,
        };
      },
      onDiagnostic: (error) => {
        if (owner === this.#addonOwner) {
          this.addonState = { state: "degraded", message: errorMessage(error) };
        }
      },
      onConnectionError: () => {
        if (owner === this.#addonOwner && this.addonState.state === "loading") {
          this.addonState = { state: "degraded", message: "Live updates are reconnecting." };
        }
      },
      onAuthorityLost: () => {
        if (owner !== this.#addonOwner) {
          return;
        }
        this.#addons = undefined;
        this.authority = { state: "known", auth: anonymousAuth() };
        this.addonState = { state: "idle" };
      },
    });
    this.#addons = composition;
    await composition.session.start();
  }

  async #stopAddons(): Promise<void> {
    this.#addonOwner += 1;
    const addons = this.#addons;
    this.#addons = undefined;
    this.addonState = { state: "idle" };
    if (addons !== undefined) {
      const failures = await addons.session.stop();
      if (failures.length > 0) {
        this.errorMessage = `Failed to clean up ${failures.length} browser add-on resource(s).`;
      }
    }
  }

  #hostStatusTemplate() {
    switch (this.readiness.state) {
      case "checking":
        return html`<div class="status host-status"><span class="indicator"></span>Checking host…</div>`;
      case "ready":
        return html`<div class="status host-status">
          <span class="indicator ready"></span>Host ${this.readiness.health.version} ready
        </div>`;
      case "unavailable":
        return html`<div class="status host-status" title=${this.readiness.message}>
          <span class="indicator unavailable"></span>Host is not reachable
        </div>`;
    }
  }

  #authorityTemplate() {
    if (this.authority.state === "checking") {
      return html`<div class="status"><span class="indicator"></span>Checking session…</div>`;
    }
    if (!this.authority.auth.authenticated) {
      return html`
        <form @submit=${this.#login}>
          <input
            name="password"
            type="password"
            minlength="4"
            autocomplete="current-password"
            aria-label="Password"
            placeholder="DM or player password"
            required
          />
          <button type="submit" ?disabled=${this.busy}>Sign in</button>
        </form>
      `;
    }
    return html`
      <div class="account">
        <span class="indicator ready"></span>
        Signed in as ${this.authority.auth.role === "dm" ? "DM" : "player"}
        <button class="secondary" type="button" @click=${this.#logout} ?disabled=${this.busy}>
          Sign out
        </button>
      </div>
      ${this.#addonStatusTemplate()}
    `;
  }

  #addonStatusTemplate() {
    switch (this.addonState.state) {
      case "idle":
        return null;
      case "loading":
        return html`<div class="status"><span class="indicator"></span>Loading browser add-ons…</div>`;
      case "ready":
        return html`<div class="status" title=${this.addonState.revision}>
          <span class=${`indicator ${this.addonState.failures === 0 ? "ready" : "unavailable"}`}></span>
          ${this.addonState.active} browser add-on generation(s) active
          ${this.addonState.failures === 0 ? "" : `; ${this.addonState.failures} failed`}
        </div>`;
      case "degraded":
        return html`<div class="status" title=${this.addonState.message}>
          <span class="indicator unavailable"></span>Browser add-ons need attention
        </div>`;
    }
  }
}

function anonymousAuth(): AuthState {
  return { authenticated: false, role: null, realRole: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown application failure";
}

if (!customElements.get("codex-app")) {
  customElements.define("codex-app", CodexApp);
}
