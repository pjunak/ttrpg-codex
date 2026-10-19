import { LitElement, html, nothing, type PropertyValues } from "lit";
import { AddonAdminClient, AddonAdminRequestError, type AddonReview } from "../core/addon-admin.js";
import type { SchemaReview } from "../core/addon-schema-upgrade.js";
import { HostRequestError } from "../core/api.js";
import { UIControlsController } from "../ui/controller.js";
import { UiLocalizationController } from "./ui-localization.js";
import { uiRequestError } from "./ui-errors.js";
import { AdminRequestController } from "./admin-request-controller.js";
import { BusyLeaseController } from "./busy-lease.js";

export class CodexAddonSchemaUpgrade extends LitElement {
  static override properties = {
    csrfToken: { attribute: false },
    activation: { attribute: false },
    grants: { attribute: false },
    disabled: { type: Boolean },
    review: { state: true },
    open: { state: true },
    uncertain: { state: true },
    refresh: { state: true },
  };
  declare csrfToken: string;
  declare activation: AddonReview | undefined;
  declare grants: readonly string[];
  declare disabled: boolean;
  declare private review: SchemaReview | undefined;
  declare private open: boolean;
  declare private uncertain: boolean;
  declare private refresh: boolean;
  #confirmed: { action: "heal" | "remove"; grants: readonly string[] } | undefined;
  readonly #ui = new UiLocalizationController(this);
  readonly #requests = new AdminRequestController(this);
  /** Held while the data review or its resolution runs, and while its outcome is uncertain. */
  readonly #lease = new BusyLeaseController(this);
  constructor() {
    super();
    new UIControlsController(this);
    this.csrfToken = "";
    this.grants = [];
    this.disabled = false;
    this.open = false;
    this.uncertain = false;
  }
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("activation")) {
      this.#requests.reset();
      if (this.#lease.held) this.#busy(false);
      this.#requests.error = "";
      this.review = undefined;
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
      pending = this.#requests.pending,
      busy = pending || this.disabled;
    return html`<p>${t("update.dataHelp")}</p><button class="ui-button" ?disabled=${busy} @click=${() => this.#open()}>${t("update.continue")}</button>
      ${
        this.open
          ? html`<dialog class="addon-install-dialog addon-data-dialog" data-ui-dialog aria-labelledby="addon-data-title" aria-busy=${pending}
        @cancel=${(event: Event) => {
          event.preventDefault();
          this.#exit();
        }}>
        <header><h3 id="addon-data-title" tabindex="-1">${t("update.dataTitle", { addon: this.activation?.name ?? "" })}</h3></header>
        <div class="addon-dialog-body">
          ${pending ? html`<p role="status">${t(this.#confirmed ? "update.applying" : "update.checking")}</p>` : nothing}
          ${this.#requests.error ? html`<p role="alert">${this.#requests.error}</p>` : nothing}
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
              : !pending
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
      this.#requests.pending ||
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
    if (this.#requests.pending || this.uncertain || this.disabled) return;
    this.querySelector<HTMLDialogElement>("dialog")?.close();
    this.open = false;
    this.dispatchEvent(new CustomEvent("addon-update-exit", { bubbles: true, composed: true }));
  }
  /** Holds the app's busy state and tells the add-on manager to hold its own actions. */
  #busy(value: boolean): void {
    if (value) this.#lease.hold();
    else this.#lease.release();
    this.dispatchEvent(
      new CustomEvent("addon-schema-busy", { detail: value, bubbles: true, composed: true }),
    );
  }
  #refresh(): void {
    this.querySelector<HTMLDialogElement>("dialog")?.close();
    this.open = false;
    this.dispatchEvent(new CustomEvent("addon-update-refresh", { bubbles: true, composed: true }));
  }
  #failure(error: unknown): string {
    this.refresh =
      error instanceof AddonAdminRequestError &&
      [
        "REVIEW_STALE",
        "REVIEW_NOT_FOUND",
        "REVIEW_STATE",
        "REVIEW_BLOCKED",
        "UPDATE_RESTORED",
      ].includes(error.code);
    return error instanceof AddonAdminRequestError && error.code === "UPDATE_RESTORED"
      ? this.#ui.t("update.restored")
      : uiRequestError(error);
  }
  async #prepare(): Promise<void> {
    const activation = this.activation;
    if (this.#requests.pending || !activation) return;
    this.#busy(true);
    await this.#requests.run(
      async (signal) => {
        const review = await new AddonAdminClient(this.csrfToken, signal).reviewUpdateData(
          activation,
        );
        if (!signal.aborted) this.review = review;
      },
      { failure: (error) => this.#failure(error) },
    );
    if (!this.#requests.pending) this.#busy(false);
  }
  async #apply(action?: "heal" | "remove"): Promise<void> {
    const activation = this.activation,
      review = this.review;
    if (this.#requests.pending || this.disabled || !activation || !review) return;
    if (action) this.#confirmed = { action, grants: [...this.grants] };
    const confirmed = this.#confirmed;
    if (!confirmed) return;
    this.#busy(true);
    const done = await this.#requests.run(
      (signal) =>
        new AddonAdminClient(this.csrfToken, signal).resolveUpdate(
          activation,
          review,
          confirmed.action,
          confirmed.grants,
        ),
      {
        failure: (error) => {
          const message = this.#failure(error);
          this.uncertain =
            !(error instanceof HostRequestError) ||
            error.status >= 500 ||
            (error instanceof AddonAdminRequestError && error.code === "RECOVERY_REQUIRED");
          if (!this.uncertain) {
            this.review = undefined;
            this.#confirmed = undefined;
          }
          return message;
        },
      },
    );
    if (done) {
      this.uncertain = false;
      this.#busy(false);
      this.dispatchEvent(
        new CustomEvent("addon-update-applied", { bubbles: true, composed: true }),
      );
    } else if (!this.#requests.pending) this.#busy(this.uncertain);
  }
}
customElements.define("codex-addon-schema-upgrade", CodexAddonSchemaUpgrade);
