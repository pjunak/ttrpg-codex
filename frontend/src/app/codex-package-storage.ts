import { LitElement, html, nothing } from "lit";
import { AddonStorageClient, PackageStorageError, type PackageStorage, type StoredPackage } from "../core/addon-storage.js";
import { UiLocalizationController, type MessageKey } from "./ui-localization.js";
import { addonPackageReviewHash } from "./routes.js";

export class CodexPackageStorage extends LitElement {
  static override properties = {
    csrfToken: { attribute: false }, inventoryRevision: { attribute: false },
    pointId: { attribute: false }, expectedRevision: { attribute: false }, disabled: { attribute: false },
    storage: { state: true }, pending: { state: true }, error: { state: true },
  };
  declare csrfToken: string;
  declare inventoryRevision: string;
  declare pointId: number;
  declare expectedRevision: number;
  declare disabled: boolean;
  declare private storage: PackageStorage | undefined;
  declare private pending: boolean;
  declare private error: MessageKey | undefined;
  readonly #ui = new UiLocalizationController(this);
  #request = new AbortController();
  #loaded = "";
  constructor() {
    super(); this.csrfToken = ""; this.inventoryRevision = ""; this.pointId = 0;
    this.expectedRevision = 0; this.disabled = false; this.pending = false;
  }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void {
    super.connectedCallback(); this.#request = new AbortController(); this.#loaded = ""; this.requestUpdate();
  }
  override disconnectedCallback(): void {
    this.#request.abort(); this.pending = false; this.storage = undefined; super.disconnectedCallback();
  }
  #key(): string { return JSON.stringify([this.csrfToken, this.inventoryRevision, this.pointId, this.expectedRevision]); }
  protected override willUpdate(): void {
    const key = this.#key();
    if (!this.pending && key !== this.#loaded) { this.#loaded = key; void this.#load(); }
  }
  #ready(ready: boolean): void {
    this.dispatchEvent(new CustomEvent("addon-storage-ready", { detail: ready, bubbles: true, composed: true }));
  }
  #accept(storage: PackageStorage): void { this.storage = storage; this.#ready(storage.packages.every(item => item.active)); }
  async #load(): Promise<void> {
    this.#ready(false);
    const result = await this.#run(client => this.pointId ? client.recovery(this.pointId, this.expectedRevision) : client.status());
    if (result) this.#accept(result);
  }
  async #run<T>(operation: (client: AddonStorageClient) => Promise<T>, mutating = false): Promise<T | undefined> {
    if (this.pending || mutating && this.disabled) return undefined;
    const signal = this.#request.signal, key = this.#key();
    this.pending = true; this.error = undefined;
    if (mutating) this.dispatchEvent(new CustomEvent("addon-storage-busy", { detail: true, bubbles: true, composed: true }));
    try {
      const result = await operation(new AddonStorageClient(this.csrfToken, signal));
      return !signal.aborted && key === this.#key() ? result : undefined;
    } catch (error) {
      if (!signal.aborted && key === this.#key()) {
        this.storage = undefined;
        if (error instanceof PackageStorageError && error.status === 404) this.#ready(true);
        else { this.error = error instanceof PackageStorageError && error.code === "REVIEW_STALE" ? "storage.stale" : "storage.failed"; this.#ready(false); }
      }
      return undefined;
    } finally {
      if (!signal.aborted) {
        this.pending = false;
        if (mutating) this.dispatchEvent(new CustomEvent("addon-storage-busy", { detail: false, bubbles: true, composed: true }));
      }
    }
  }
  async #restore(item: StoredPackage): Promise<void> {
    const restored = await this.#run(client => client.restore(item), true);
    if (restored) this.dispatchEvent(new CustomEvent("addon-package-restored", { detail: restored, bubbles: true, composed: true }));
  }
  async #prepare(): Promise<void> {
    const result = await this.#run(client => client.recovery(this.pointId, this.expectedRevision, true), true);
    if (result) this.#accept(result);
  }
  async #retry(): Promise<void> {
    const result = await this.#run(client => client.retry(), true);
    if (result) { if (this.pointId) await this.#load(); else this.#accept(result); }
  }
  protected override render() {
    const t = this.#ui.t.bind(this.#ui), storage = this.storage;
    const blocked = this.pending || this.disabled, packages = storage?.packages ?? [];
    const missing = packages.some(item => !item.available);
    const rows = html`<ul>${packages.map(item => html`<li>
      <strong>${item.addonId} · ${item.version}</strong>
      <details><summary>${t("addons.generation")}</summary><code>${item.generationId}</code></details>
      ${item.active ? html`<p>${t("storage.current")}</p>` : this.pointId ?
        item.available && !missing ? html`<a href=${addonPackageReviewHash(item.addonId, item.generationId)}>${t("storage.review")}</a>` :
        item.available ? html`<p>${t("storage.ready")}</p>` : !item.downloadable ? html`<p>${t("storage.manualZip")}</p>` : nothing :
        item.available ? html`<p>${t("storage.preserved")}</p>` :
        item.downloadable ? html`<button ?disabled=${blocked} @click=${() => void this.#restore(item)}>${t("storage.restore")}</button>` :
        html`<p>${t("storage.manualZip")}</p>`}
    </li>`)}</ul>`;
    return html`
      ${this.pending ? html`<p role="status">${t("storage.loading")}</p>` : nothing}
      ${this.error ? html`<p role="alert">${t(this.error)}</p><button ?disabled=${blocked} @click=${() => void this.#load()}>${t("github.retry")}</button>` : nothing}
      ${storage ? html`
        ${this.pointId ? html`<h4>${t("storage.required")}</h4><p>${t("storage.prepareHelp")}</p>${rows}
          ${missing ? html`<button ?disabled=${blocked || packages.some(item => !item.available && !item.downloadable)} @click=${() => void this.#prepare()}>${t("storage.prepare")}</button>` : nothing}
        ` : html`<p class="settings-hint">${t(storage.automatic ? "storage.automatic" : "storage.manual")}</p>
          ${packages.length ? html`<details class="addon-package-history"><summary>${t("storage.history")}</summary><p>${t("storage.historyHelp")}</p>${rows}</details>` : nothing}`}
        ${storage.pending ? html`<p role="status">${t("storage.pending")}</p><button ?disabled=${blocked} @click=${() => void this.#retry()}>${t("storage.retry")}</button>` : nothing}
      ` : nothing}`;
  }
}
customElements.define("codex-package-storage", CodexPackageStorage);
