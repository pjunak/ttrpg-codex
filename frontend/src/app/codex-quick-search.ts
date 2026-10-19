import { LitElement, html, nothing } from "lit";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import { containDialogTab } from "../ui/focus.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import "./codex-search.js";

/**
 * Campaign search in a modal dialog, opened with Ctrl K or the sidebar's
 * search link. A result for the page already shown just closes it, and
 * closing returns focus to where the search was opened from.
 */
export class CodexQuickSearch extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    registry: { attribute: false },
    actorRole: { attribute: false },
    currentHash: { attribute: false },
    fallbackFocus: { attribute: false },
    open: { state: true },
  };
  /** The shown campaign; without one the search stays closed. */
  declare campaign: CampaignDataset | undefined;
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  /** The address shown; a link to it closes the search instead of navigating. */
  declare currentHash: string;
  /** Where focus goes when the element the search was opened from is gone. */
  declare fallbackFocus: () => HTMLElement | null;
  declare private open: boolean;
  #returnFocus: HTMLElement | undefined;

  constructor() {
    super();
    new UiLocalizationController(this);
    this.campaign = undefined;
    this.currentHash = "#/";
    this.fallbackFocus = () => null;
    this.open = false;
  }

  protected override createRenderRoot() {
    return this;
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    if (this.campaign === undefined) return;
    this.#returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.open = true;
  }

  /** Closes the search; `restoreFocus` returns focus to where it was opened from. */
  hide(restoreFocus = true): void {
    this.querySelector<HTMLDialogElement>(".quick-search-dialog")?.close();
    this.open = false;
    if (restoreFocus) {
      const previous = this.#returnFocus;
      void this.updateComplete.then(() => {
        if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
        else this.fallbackFocus()?.focus();
      });
    }
    this.#returnFocus = undefined;
  }

  protected override willUpdate(): void {
    if (this.campaign === undefined) this.open = false;
  }

  protected override updated(): void {
    const dialog = this.querySelector<HTMLDialogElement>(".quick-search-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  protected override render() {
    if (!this.open || this.campaign === undefined) return nothing;
    return html`<dialog class="quick-search-dialog" aria-labelledby="quick-search-title"
      @keydown=${(event: KeyboardEvent) => containDialogTab(event.currentTarget as HTMLDialogElement, event)}
      @click=${this.#onClick}
      @cancel=${(event: Event) => {
        event.preventDefault();
        this.hide();
      }}>
      <button type="button" class="record-action quick-search-close" @click=${() => this.hide()}>${uiText("jump.close")}</button>
      <codex-search .quick=${true} .campaign=${this.campaign} .registry=${this.registry}
        .actorRole=${this.actorRole}></codex-search>
    </dialog>`;
  }

  readonly #onClick = (event: MouseEvent): void => {
    const link =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (
      link?.hash === this.currentHash &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      this.hide();
    }
  };
}

if (!customElements.get("codex-quick-search"))
  customElements.define("codex-quick-search", CodexQuickSearch);
