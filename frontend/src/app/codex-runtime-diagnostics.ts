import { LitElement, html, nothing } from "lit";
import type { AddonSnapshot } from "../core/addon-admin.js";
import { browserDiagnostics } from "../addons/browser-diagnostics.js";
import { UiLocalizationController } from "./ui-localization.js";

export class CodexRuntimeDiagnostics extends LitElement {
  static override properties = { snapshot: { attribute: false } };
  declare snapshot: AddonSnapshot | undefined;
  readonly #ui = new UiLocalizationController(this);
  #unsubscribe: (() => void) | undefined;
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void { super.connectedCallback(); this.#unsubscribe = browserDiagnostics.subscribe(() => this.requestUpdate()); }
  override disconnectedCallback(): void { this.#unsubscribe?.(); this.#unsubscribe = undefined; super.disconnectedCallback(); }
  protected override render() {
    const snapshot = this.snapshot;
    if (!snapshot) return nothing;
    const t = this.#ui.t.bind(this.#ui), runtime = snapshot.runtime;
    const browser = browserDiagnostics.list().filter(entry => !entry.addonId || entry.addonId === snapshot.state.addonId);
    return html`<details class="runtime-diagnostics"><summary>${t("diagnostics.title")}</summary>
      <p>${t("diagnostics.help")}</p>
      ${runtime ? html`<h4>${t("diagnostics.worker")}</h4><dl>
        <dt>${t("diagnostics.health")}</dt><dd>${runtime.health?.status ?? snapshot.runtimeState}${runtime.health?.at ? ` · ${this.#ui.relativeDate(runtime.health.at)}` : ""}</dd>
        ${runtime.startedAt ? html`<dt>${t("diagnostics.started")}</dt><dd>${this.#ui.relativeDate(runtime.startedAt)}</dd>` : nothing}
        ${runtime.exitedAt ? html`<dt>${t("diagnostics.exited")}</dt><dd>${this.#ui.relativeDate(runtime.exitedAt)}${runtime.exitCode === undefined ? "" : ` · ${runtime.exitCode}`}</dd>` : nothing}
      </dl>
      ${runtime.lastError ? html`<p><code>${runtime.lastError}</code></p>` : nothing}
      ${runtime.requests.length ? html`<details><summary>${t("diagnostics.requests")}</summary><ol>
        ${[...runtime.requests].reverse().map(entry => html`<li>
          <code>${entry.method}</code> · <strong>${entry.outcome}</strong> · ${entry.milliseconds} ms · ${this.#ui.relativeDate(entry.at)}
          <p>${t("diagnostics.request")}: <code>${entry.requestRef || "—"}</code> · ${t("diagnostics.correlation")}: <code>${entry.correlationRef || "—"}</code></p>
        </li>`)}
      </ol></details>` : nothing}` : nothing}
      <h4>${t("diagnostics.browser")}</h4>
      ${browser.length ? html`<ol>${[...browser].reverse().map(entry => html`<li>
        <strong>${t(`diagnostics.phase.${entry.phase}`)}</strong> · <code>${entry.code}</code> · ${this.#ui.relativeDate(entry.at)}
        <p><code>${entry.reference}</code>${entry.generationId ? html` · <code title=${entry.generationId}>${entry.generationId.slice(0, 12)}</code>` : nothing}</p>
      </li>`)}</ol>` : html`<p>${t("diagnostics.empty")}</p>`}
    </details>`;
  }
}
customElements.define("codex-runtime-diagnostics", CodexRuntimeDiagnostics);
