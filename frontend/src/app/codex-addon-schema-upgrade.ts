import { LitElement, html, nothing, type PropertyValues } from "lit";
import { AddonAdminClient, AddonAdminRequestError, type AddonReview } from "../core/addon-admin.js";
import type { SchemaReview } from "../core/addon-schema-upgrade.js";
import { HostRequestError } from "../core/api.js";
import { UIControlsController } from "../ui/controller.js";
import { UiLocalizationController } from "./ui-localization.js";
import { uiRequestError } from "./ui-errors.js";

export class CodexAddonSchemaUpgrade extends LitElement {
  static override properties = {
    csrfToken: { attribute: false },
    activation: { attribute: false },
    grants: { attribute: false },
    disabled: { type: Boolean },
    review: { state: true },
    pending: { state: true },
    error: { state: true },
    open: { state: true },
    uncertain: { state: true },
    refresh: { state: true },
  };
  declare csrfToken: string;
  declare activation: AddonReview | undefined;
  declare grants: readonly string[];
  declare disabled: boolean;
  declare private review: SchemaReview | undefined;
  declare private pending: boolean;
  declare private error: string;
  declare private open: boolean;
  declare private uncertain: boolean;
  declare private refresh: boolean;
  #request = new AbortController();
  #confirmed: { action: "heal" | "remove"; grants: readonly string[] } | undefined;
  readonly #ui = new UiLocalizationController(this);
  constructor() {
    super();
    new UIControlsController(this);
    this.csrfToken = "";
    this.grants = [];
    this.disabled = false;
    this.pending = false;
    this.error = "";
    this.open = false;
    this.uncertain = false;
  }
  protected override createRenderRoot() {
    return this;
  }
  override disconnectedCallback(): void {
    this.#request.abort();
    this.#busy(false);
    super.disconnectedCallback();
  }
  override connectedCallback(): void {
    super.connectedCallback();
    if (this.#request.signal.aborted) this.#request = new AbortController();
  }
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("activation")) {
      this.#request.abort();
      this.#request = new AbortController();
      this.review = undefined;
      this.pending = false;
      this.error = "";
      this.uncertain = false;
      this.refresh = false;
      this.open = false;
      this.#confirmed = undefined;
    }
  }
  protected override updated(): void {
    const dialog = this.querySelector<HTMLDialogElement>("dialog");
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("h3")?.focus();
    }
  }
  protected override render() {
    const t = this.#ui.t.bind(this.#ui),
      review = this.review,
      busy = this.pending || this.disabled;
    return html`<p>${t("update.dataHelp")}</p><button class="ui-button" ?disabled=${busy} @click=${() => this.#open()}>${t("update.continue")}</button>
      ${
        this.open
          ? html`<dialog class="addon-install-dialog addon-data-dialog" data-ui-dialog aria-labelledby="addon-data-title" aria-busy=${this.pending}
        @cancel=${(event: Event) => {
          event.preventDefault();
          this.#exit();
        }}>
        <header><h3 id="addon-data-title" tabindex="-1">${t("update.dataTitle", { addon: this.activation?.name ?? "" })}</h3></header>
        <div class="addon-dialog-body">
          ${this.pending ? html`<p role="status">${t(this.#confirmed ? "update.applying" : "update.checking")}</p>` : nothing}
          ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
          ${this.uncertain ? html`<p role="status">${t("update.uncertain")}</p>` : nothing}
          ${
            review
              ? html`
            <p>${t("update.scope", { count: review.documents, addon: this.activation?.name ?? "" })}</p>
            <p>${t("update.healHelp")}</p>
            ${review.blockers.length ? html`<p>${t("update.cannotHeal")}</p><details><summary>${t("update.details")}</summary><ul>${review.blockers.map((b) => html`<li>${b.dataId}: ${b.message}</li>`)}</ul></details>` : nothing}
            <p>${t("update.removeHelp")}</p>
            <a class="ui-button" href=${`/api/admin/addon-schema-reviews/${encodeURIComponent(review.reviewId)}/recovery`} download>${t("update.backup")}</a>
            <p class="settings-hint">${t("update.backupHelp")}</p>
          `
              : !this.pending
                ? html`<button ?disabled=${busy} @click=${() => (this.refresh ? this.#refresh() : this.#prepare())}>${t(this.refresh ? "update.refresh" : "github.retry")}</button>`
                : nothing
          }
        </div>
        <footer class="addon-data-actions">
          ${
            this.uncertain
              ? html`<button ?disabled=${busy} @click=${() => this.#apply()}>${t("update.checkResult")}</button>`
              : review
                ? html`
            <button class="ui-button" ?disabled=${busy || !!review.blockers.length || !review.changes.length} @click=${() => this.#apply("heal")}>${t("update.heal")}</button>
            <button class="ui-button" data-ui-variant="danger" ?disabled=${busy} @click=${() => this.#apply("remove")}>${t("update.remove")}</button>
          `
                : nothing
          }
          <button class="ui-button" ?disabled=${busy || this.uncertain} @click=${() => this.#exit()}>${t("update.exit")}</button>
        </footer>
      </dialog>`
          : nothing
      }`;
  }
  #open(): void {
    if (
      this.pending ||
      this.disabled ||
      !this.dispatchEvent(
        new CustomEvent("addon-update-start", { bubbles: true, composed: true, cancelable: true }),
      )
    )
      return;
    this.open = true;
    void this.#prepare();
  }
  #exit(): void {
    if (this.pending || this.uncertain || this.disabled) return;
    this.querySelector<HTMLDialogElement>("dialog")?.close();
    this.open = false;
    this.dispatchEvent(new CustomEvent("addon-update-exit", { bubbles: true, composed: true }));
  }
  #busy(value: boolean): void {
    this.dispatchEvent(
      new CustomEvent("addon-schema-busy", { detail: value, bubbles: true, composed: true }),
    );
  }
  #refresh(): void {
    this.querySelector<HTMLDialogElement>("dialog")?.close();
    this.open = false;
    this.dispatchEvent(new CustomEvent("addon-update-refresh", { bubbles: true, composed: true }));
  }
  #failed(error: unknown): void {
    this.refresh =
      error instanceof AddonAdminRequestError &&
      [
        "REVIEW_STALE",
        "REVIEW_NOT_FOUND",
        "REVIEW_STATE",
        "REVIEW_BLOCKED",
        "UPDATE_RESTORED",
      ].includes(error.code);
    this.error =
      error instanceof AddonAdminRequestError && error.code === "UPDATE_RESTORED"
        ? this.#ui.t("update.restored")
        : uiRequestError(error);
  }
  async #prepare(): Promise<void> {
    if (this.pending || !this.activation) return;
    const request = this.#request;
    this.pending = true;
    this.error = "";
    this.#busy(true);
    try {
      const review = await new AddonAdminClient(this.csrfToken, request.signal).reviewUpdateData(
        this.activation,
      );
      if (!request.signal.aborted) this.review = review;
    } catch (error) {
      if (!request.signal.aborted) this.#failed(error);
    } finally {
      if (!request.signal.aborted) {
        this.pending = false;
        this.#busy(false);
      }
    }
  }
  async #apply(action?: "heal" | "remove"): Promise<void> {
    if (this.pending || this.disabled || !this.activation || !this.review) return;
    if (action) this.#confirmed = { action, grants: [...this.grants] };
    const confirmed = this.#confirmed;
    if (!confirmed) return;
    const request = this.#request;
    this.pending = true;
    this.error = "";
    this.#busy(true);
    try {
      await new AddonAdminClient(this.csrfToken, request.signal).resolveUpdate(
        this.activation,
        this.review,
        confirmed.action,
        confirmed.grants,
      );
      if (!request.signal.aborted) {
        this.uncertain = false;
        this.#busy(false);
        this.dispatchEvent(
          new CustomEvent("addon-update-applied", { bubbles: true, composed: true }),
        );
      }
    } catch (error) {
      if (!request.signal.aborted) {
        this.#failed(error);
        this.uncertain =
          !(error instanceof HostRequestError) ||
          error.status >= 500 ||
          (error instanceof AddonAdminRequestError && error.code === "RECOVERY_REQUIRED");
        if (!this.uncertain) {
          this.review = undefined;
          this.#confirmed = undefined;
        }
      }
    } finally {
      if (!request.signal.aborted) {
        this.pending = false;
        this.#busy(this.uncertain);
      }
    }
  }
}
customElements.define("codex-addon-schema-upgrade", CodexAddonSchemaUpgrade);
