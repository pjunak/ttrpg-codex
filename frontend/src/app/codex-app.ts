import { LitElement, css, html } from "lit";
import { getHealth, type Health } from "../core/api.js";

type Readiness =
  | { state: "checking" }
  | { state: "ready"; health: Health }
  | { state: "unavailable"; message: string };

export class CodexApp extends LitElement {
  static override styles = css`
    :host {
      display: grid;
      min-height: 100vh;
      place-items: center;
      padding: 2rem;
      background:
        radial-gradient(circle at 20% 20%, rgb(83 108 74 / 18%), transparent 32rem),
        #101310;
    }

    main {
      width: min(42rem, 100%);
      padding: clamp(1.5rem, 5vw, 3rem);
      border: 1px solid #394337;
      border-radius: 1.25rem;
      background: rgb(26 31 26 / 92%);
      box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 30%);
    }

    p {
      color: #b9c2b4;
      line-height: 1.6;
    }

    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(2rem, 7vw, 4rem);
      font-weight: 500;
      letter-spacing: -0.04em;
    }

    .eyebrow {
      margin: 0 0 0.75rem;
      color: #a9d18f;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .status {
      display: flex;
      gap: 0.65rem;
      align-items: center;
      margin-top: 2rem;
      padding-top: 1.25rem;
      border-top: 1px solid #313a30;
      color: #d7ded2;
      font-size: 0.9rem;
    }

    .indicator {
      width: 0.65rem;
      height: 0.65rem;
      border-radius: 50%;
      background: #8d9788;
      box-shadow: 0 0 0 0.25rem rgb(141 151 136 / 12%);
    }

    .indicator.ready {
      background: #91cb6f;
    }

    .indicator.unavailable {
      background: #d99c6a;
    }
  `;

  static override properties = {
    readiness: { state: true },
  };

  declare private readiness: Readiness;
  #request: AbortController | undefined;

  constructor() {
    super();
    this.readiness = { state: "checking" };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#request = new AbortController();
    void this.#checkHealth(this.#request.signal);
  }

  override disconnectedCallback(): void {
    this.#request?.abort("component-disconnected");
    this.#request = undefined;
    super.disconnectedCallback();
  }

  protected override render() {
    return html`
      <main>
        <p class="eyebrow">Go + TypeScript rewrite</p>
        <h1>TTRPG Codex</h1>
        <p>
          The new host foundation is running with explicit data, package, and add-on
          lifecycle boundaries.
        </p>
        ${this.#statusTemplate()}
      </main>
    `;
  }

  async #checkHealth(signal: AbortSignal): Promise<void> {
    try {
      const health = await getHealth(signal);
      this.readiness = { state: "ready", health };
    } catch (error: unknown) {
      if (signal.aborted) {
        return;
      }
      this.readiness = {
        state: "unavailable",
        message: error instanceof Error ? error.message : "Unknown health-check failure",
      };
    }
  }

  #statusTemplate() {
    switch (this.readiness.state) {
      case "checking":
        return html`<div class="status"><span class="indicator"></span>Checking host…</div>`;
      case "ready":
        return html`<div class="status">
          <span class="indicator ready"></span>Host ${this.readiness.health.version} ready
        </div>`;
      case "unavailable":
        return html`<div class="status" title=${this.readiness.message}>
          <span class="indicator unavailable"></span>Host is not reachable
        </div>`;
    }
  }
}

if (!customElements.get("codex-app")) {
  customElements.define("codex-app", CodexApp);
}
