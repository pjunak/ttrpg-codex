import { LitElement, html, nothing } from "lit";
import {
  AddonStorageClient,
  PackageStorageError,
  type PackageStorage,
} from "../core/addon-storage.js";
import { UiLocalizationController } from "./ui-localization.js";

/** The server's package cleanup policy, reloaded when the installation changes. */
export class CodexPackageStorage extends LitElement {
  static override properties = {
    csrfToken: { attribute: false },
    inventoryRevision: { attribute: false },
    storage: { state: true },
    failed: { state: true },
  };
  declare csrfToken: string;
  declare inventoryRevision: string;
  declare private storage: PackageStorage | undefined;
  declare private failed: boolean;
  readonly #ui = new UiLocalizationController(this);
  #request = new AbortController();
  #loaded = "";
  constructor() {
    super();
    this.csrfToken = "";
    this.inventoryRevision = "";
    this.failed = false;
  }
  protected override createRenderRoot() {
    return this;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    this.#loaded = "";
    this.requestUpdate();
  }
  override disconnectedCallback(): void {
    this.#request.abort();
    this.storage = undefined;
    super.disconnectedCallback();
  }
  protected override willUpdate(): void {
    const key = JSON.stringify([this.csrfToken, this.inventoryRevision]);
    if (key !== this.#loaded) {
      this.#loaded = key;
      void this.#load();
    }
  }
  async #load(): Promise<void> {
    this.#request.abort();
    const request = new AbortController();
    this.#request = request;
    this.failed = false;
    try {
      this.storage = await new AddonStorageClient(this.csrfToken, request.signal).status();
    } catch (error) {
      if (request.signal.aborted) return;
      this.storage = undefined;
      // Hosts without package management have nothing to report.
      this.failed = !(error instanceof PackageStorageError && error.status === 404);
    }
  }
  protected override render() {
    const t = this.#ui.t.bind(this.#ui),
      storage = this.storage;
    if (this.failed)
      return html`<p role="alert">${t("storage.failed")}</p>
        <button @click=${() => void this.#load()}>${t("github.retry")}</button>`;
    if (!storage) return nothing;
    return html`<p class="settings-hint">${t(storage.automatic ? "storage.automatic" : "storage.manual")}</p>
      ${storage.pending ? html`<p role="status">${t("storage.pending")}</p>` : nothing}`;
  }
}
customElements.define("codex-package-storage", CodexPackageStorage);
