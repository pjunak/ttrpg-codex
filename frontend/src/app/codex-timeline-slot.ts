import { LitElement, html, nothing } from "lit";
import { BrowserContributionOutlet } from "../addons/contribution-outlet.js";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { UiLocalizationController } from "./ui-localization.js";
import { isTimelineSlot, timelineSlotContext, type TimelineSlotContext } from "./timeline-contributions.js";
/** One per visible slot instance; the outer timeline retains ownership of cards and edits. */
export class CodexTimelineSlot extends LitElement {
  static override properties = { registry: { attribute: false }, actorRole: { attribute: false }, context: { attribute: false }, error: { state: true } };
  declare registry: BrowserContributionRegistry | undefined;
  declare actorRole: BrowserRole | undefined;
  declare context: TimelineSlotContext;
  declare private error: boolean;
  #outlet: BrowserContributionOutlet | undefined;
  #observer: IntersectionObserver | undefined;
  #visible = false;
  #signature = "";
  readonly #ui = new UiLocalizationController(this);
  constructor() {
    super(); this.registry = undefined; this.actorRole = undefined; this.error = false;
    this.context = { slot: "timeline:toolbar", editing: false, sitting: null, events: [] };
  }
  protected override createRenderRoot() { return this; }
  override connectedCallback(): void {
    super.connectedCallback();
    // Defer unopened columns and collapsed cards; retain started widgets until their slot leaves the board.
    this.#observer = new IntersectionObserver(entries => {
      if (this.isConnected && entries.some(entry => entry.isIntersecting)) {
        this.#visible = true; this.#observer?.disconnect(); this.requestUpdate();
      }
    });
    this.#observer.observe(this);
  }
  override disconnectedCallback(): void {
    this.#observer?.disconnect(); this.#observer = undefined; this.#outlet?.dispose(); this.#outlet = undefined;
    this.#visible = false; this.#signature = ""; super.disconnectedCallback();
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("registry") || changed.has("actorRole")) { this.#outlet?.dispose(); this.#outlet = undefined; this.#signature = ""; }
  }
  protected override render() {
    return html`<div data-timeline-slot-root></div>${this.error ? html`<p class="tl-message" role="alert">${this.#ui.t("timeline.addonFailed")}
      <button @click=${() => { this.error = false; this.#signature = ""; this.requestUpdate(); }}>${this.#ui.t("graph.retry")}</button></p>` : nothing}`;
  }
  protected override updated(): void {
    if (!this.isConnected || !this.#visible || !this.registry || !this.actorRole) return;
    const signature = JSON.stringify(this.context);
    if (!this.#outlet) this.#outlet = new BrowserContributionOutlet({
      document: this.ownerDocument, root: this.querySelector<HTMLElement>("[data-timeline-slot-root]")!, registry: this.registry, surface: "slot", role: this.actorRole,
      compact: true, isolatedHostContext: true, include: active => isTimelineSlot(active, this.context.slot),
      hostContext: active => timelineSlotContext(this.context, active), onError: () => { this.error = true; },
    });
    else if (signature !== this.#signature) this.#outlet.refresh();
    this.#signature = signature;
  }
}
customElements.define("codex-timeline-slot", CodexTimelineSlot);
