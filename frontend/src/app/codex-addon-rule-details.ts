import { LitElement, css, html, nothing } from "lit";
import type { AddonLinkState, AddonLinksController } from "./addon-links-controller.js";
import type { WikiReference } from "../addons/wiki-links.js";
import { UiLocalizationController } from "./ui-localization.js";

import { parseRuleDetails, showRuleDetailsEvent, type RuleDetails } from "../addons/rule-details.js";
interface ResolveDetails { reference: WikiReference; update(state: AddonLinkState): void; dispose?: () => void }
const resolveEvent = "codex-rule-details-resolve";

/** One mounted application supplies the existing generation/role-scoped resolver. */
export function bindRuleDetails(root: HTMLElement, links: AddonLinksController, { presentSDK = true } = {}): () => void {
  const active = new Set<() => void>();
  let presented: CodexAddonRuleDetails | undefined;
  let disposePresented: (() => void) | undefined;
  const show = (event: Event): void => {
    if (!(event instanceof CustomEvent) || event.defaultPrevented) return;
    const data = event.detail as { details: RuleDetails; signal: AbortSignal; closed?: () => void };
    if (!data || !(data.signal instanceof AbortSignal) || data.signal.aborted) return;
    const details = parseRuleDetails(data.details); event.preventDefault(); disposePresented?.();
    const trigger = root.ownerDocument.activeElement;
    const element = new CodexAddonRuleDetails(); element.details = details; element.style.cssText = "position:fixed;left:50%;top:25%;z-index:1000"; root.append(element); presented=element;
    let disposed = false;
    const dispose=():void=>{if(disposed)return;disposed=true;data.signal.removeEventListener("abort",dispose);element.remove();if(presented===element){presented=undefined;disposePresented=undefined;}if(typeof data.closed === "function")data.closed();};
    disposePresented=dispose;
    data.signal.addEventListener("abort",dispose,{once:true});
    element.addEventListener("rule-details-closed",()=>{dispose();if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus();},{once:true});
    void element.updateComplete.then(()=>{if(element.isConnected)element.show();});
  };
  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as ResolveDetails;
    if (!detail || typeof detail.update !== "function" || typeof detail.reference !== "object" || detail.reference === null) return;
    const reference = detail.reference;
    if ("path" in reference ? typeof reference.path !== "string" || reference.path.length > 2000 : typeof reference.label !== "string" || typeof reference.hint !== "string" || reference.label.length > 200 || reference.hint.length > 300) return;
    event.stopPropagation(); const update = (): void => detail.update(links.resolve(reference));
    const unsubscribe = links.subscribe(update); const dispose = (): void => { unsubscribe(); active.delete(dispose); };
    active.add(dispose); detail.dispose = dispose; update();
  };
  root.addEventListener(resolveEvent, listener);
  if (presentSDK) root.ownerDocument.addEventListener(showRuleDetailsEvent,show);
  return () => { disposePresented?.(); root.ownerDocument.removeEventListener(showRuleDetailsEvent,show); root.removeEventListener(resolveEvent, listener); for (const dispose of active) dispose(); };
}

export class CodexAddonRuleDetails extends LitElement {
  static override properties = { details: { attribute: false }, link: { state: true }, opened: { state: true }, compact: { type: Boolean } };
  declare compact: boolean;
  readonly #ui = new UiLocalizationController(this);
  declare details: RuleDetails; declare private link: AddonLinkState; declare private opened: boolean;
  #dispose: (() => void) | undefined; #pinned = false; #hide: ReturnType<typeof setTimeout> | undefined;
  #dismissed = false;
  #trail: RuleDetails[] = [];
  readonly #id = `rule-detail-${crypto.randomUUID()}`;
  static override styles = css`
    :host{display:inline;--detail-border:var(--border-subtle,#777)}button,a{font:inherit;color:inherit}button.trigger{border:0;border-bottom:1px dotted currentColor;background:transparent;padding:.1em .15em;cursor:pointer;text-align:inherit;min-height:24px;color:var(--accent-gold,#795400);scroll-margin-block:6rem}
    :is(button,a):focus-visible{outline:2px solid var(--accent-gold,#795400);outline-offset:3px}
    [popover]{position:fixed;inset:auto;margin:0;width:min(26rem,calc(100vw - 2rem));max-height:min(70vh,36rem);overflow:auto;box-sizing:border-box;padding:1rem;border:1px solid var(--detail-border);border-radius:.6rem;background:var(--bg-raised,#fff);color:var(--text-parchment,#222);box-shadow:0 10px 35px #0004;font:400 .95rem/1.5 system-ui}
    h3,p{margin:.25rem 0 .7rem}h3{font-size:1.1rem}button.close{float:right;min-width:32px;min-height:32px;margin-left:1rem}dl{display:grid;grid-template-columns:1fr 1fr;gap:.4rem}dd{margin:0;overflow-wrap:anywhere}.sources{display:flex;gap:.5rem;flex-wrap:wrap}a{display:block;margin-top:.8rem;min-height:24px}small{display:block}
  `;
  constructor() { super(); this.details = { label: "Rule details" }; this.link = { status: "missing" }; this.opened = false; this.compact = false;
    this.addEventListener("keydown", event => { if (event.key === "Escape" && this.opened) { event.preventDefault(); event.stopPropagation(); this.#close(); this.renderRoot.querySelector<HTMLButtonElement>(".trigger")?.focus(); } });
    this.addEventListener("rule-details-follow", event => { if(event.target===this||!(event instanceof CustomEvent))return; event.preventDefault(); event.stopPropagation(); const data=event.detail as {details:RuleDetails;pin:boolean}; if(data.pin){this.#trail.push(this.details);this.details=parseRuleDetails(data.details);this.#pinned=true;void this.updateComplete.then(()=>this.renderRoot.querySelector<HTMLElement>("h3")?.focus());} });
  }
  override disconnectedCallback(): void { this.#dispose?.(); this.#dispose = undefined; clearTimeout(this.#hide); this.#stopPositioning(); super.disconnectedCallback(); }
  show(): void { this.#show(true); }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("details")) {
      this.#dispose?.(); this.#dispose = undefined; this.link = { status: "missing" };
      const reference = this.details?.wiki ?? (this.details?.reference ? { label: this.details.label, hint: `${this.details.reference.kind}:${this.details.reference.id}` } : undefined);
      if (reference) { const request: ResolveDetails = { reference, update: state => { if (this.isConnected) this.link = state; } }; this.dispatchEvent(new CustomEvent(resolveEvent, { bubbles: true, composed: true, detail: request })); this.#dispose = request.dispose; }
    }
    if (this.opened) this.#position();
  }
  #show(pin: boolean): void {
    if(!this.dispatchEvent(new CustomEvent("rule-details-follow",{bubbles:true,composed:true,cancelable:true,detail:{details:this.details,pin}})))return;
    if (this.#dismissed && !pin) return;
    this.#dismissed = false;
    clearTimeout(this.#hide); this.#pinned ||= pin;
    const popover = this.renderRoot.querySelector<HTMLElement>("[popover]"); if (!popover) return;
    if (!popover.matches(":popover-open")) popover.showPopover();
    this.opened = true;
    this.#position();
    window.addEventListener("resize", this.#position);
    window.addEventListener("scroll", this.#position, true);
    if (pin) popover.querySelector<HTMLElement>("h3")?.focus();
  }
  #position = (): void => {
    const popover = this.renderRoot.querySelector<HTMLElement>("[popover]");
    if (!this.opened || !popover) return;
    const trigger = this.renderRoot.querySelector("button.trigger")!.getBoundingClientRect();
    const below = Math.max(0, innerHeight - trigger.bottom - 14), above = Math.max(0, trigger.top - 14);
    const useBelow = below >= Math.min(0.7 * innerHeight, 400) || below >= above;
    popover.style.maxHeight = `${Math.max(32, Math.min(0.7 * innerHeight, useBelow ? below : above))}px`;
    const bounds = popover.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(innerWidth - bounds.width - 8, trigger.left))}px`;
    popover.style.top = `${Math.max(8, useBelow ? trigger.bottom + 6 : trigger.top - bounds.height - 6)}px`;
  };
  #stopPositioning(): void { window.removeEventListener("resize", this.#position); window.removeEventListener("scroll", this.#position, true); }
  #close = (): void => { this.#dismissed = true; this.#stopPositioning(); this.renderRoot.querySelector<HTMLElement>("[popover]")?.hidePopover(); this.#pinned = false; this.opened = false; this.dispatchEvent(new Event("rule-details-closed")); };
  #leave = (): void => { clearTimeout(this.#hide); this.#hide = setTimeout(() => { if (!this.#pinned && !this.matches(":focus-within")) this.#close(); }, 180); };
  protected override render() {
    let data: RuleDetails;
    try { data=parseRuleDetails(this.details); } catch { return html`<span>${this.#ui.t("ruleDetails.unavailable")}</span>`; }
    const explanation = data.explanation, summary = data.summary ?? (this.link.status === "resolved" ? this.link.description : "");
    return html`<button type="button" class="trigger" aria-label=${this.compact ? this.#ui.t("ruleDetails.for", { name: data.label }) : data.label} aria-haspopup="dialog" aria-expanded=${this.opened} aria-controls=${this.#id}
      @pointerenter=${(event: PointerEvent) => { if (event.pointerType === "mouse") { this.#dismissed = false; this.#show(false); } }} @pointerleave=${this.#leave}
      @focus=${() => this.#show(false)} @blur=${this.#leave} @click=${() => this.#show(true)}>${this.compact ? "ⓘ" : data.label}</button>
      <div id=${this.#id} popover="auto" role="dialog" aria-labelledby=${`${this.#id}-title`} @pointerenter=${() => clearTimeout(this.#hide)} @pointerleave=${this.#leave}
        @toggle=${(event: ToggleEvent) => { const wasOpen = this.opened; this.opened = event.newState === "open"; if (!this.opened) { this.#pinned = false; this.#stopPositioning(); if (wasOpen) this.dispatchEvent(new Event("rule-details-closed")); } }}>
        <button type="button" class="close" aria-label=${this.#ui.t("ruleDetails.close")} @click=${() => { this.#close(); this.renderRoot.querySelector<HTMLButtonElement>(".trigger")?.focus(); }}>×</button>
        <h3 id=${`${this.#id}-title`} tabindex="-1">${explanation?.label ?? data.label}</h3>
        ${this.#trail.length ? html`<button type="button" @click=${()=>{this.details=this.#trail.pop()!;}}>${this.#ui.t("ruleDetails.back")}</button>` : nothing}
        ${summary ? html`<p>${summary}</p>` : nothing}
        ${explanation ? html`<p><strong>${display(explanation.value)} ${explanation.unit ?? ""}</strong></p><p>${explanation.formula}</p>
          ${explanation.minimum !== undefined || explanation.maximum !== undefined ? html`<p>${this.#ui.t("ruleDetails.bounds", { min: explanation.minimum ?? "—", max: explanation.maximum ?? "—" })}</p>` : nothing}
          <dl>${explanation.terms.map(term => html`<dt>${term.label}${term.status ? html`<small>${term.status}</small>` : nothing}</dt><dd>${display(term.value)}</dd>`)}</dl>
          <div class="sources">${explanation.sources.map(reference => { const saved = data.savedSources?.find(source => source.reference.kind === reference.kind && source.reference.id === reference.id); return html`<codex-addon-rule-details .details=${{ label: saved?.name ?? reference.id, reference, ...(saved ? { summary: saved.summary, savedSources: [saved] } : {}) }}></codex-addon-rule-details>`; })}</div>` : nothing}
        ${data.savedSources?.length ? html`<details><summary>${this.#ui.t("ruleDetails.evidence")}</summary>${data.savedSources.map(source => html`<p>${source.name}<small style="overflow-wrap:anywhere">SHA-256: ${source.hash}</small></p>`)}</details>` : nothing}
        ${this.link.status === "resolved" ? html`<a href=${this.link.href}>${this.#ui.t(data.savedSources?.length ? "ruleDetails.current" : "ruleDetails.open")}</a>` : data.reference || data.wiki ? html`<p role="status">${this.#ui.t(this.link.status === "loading" ? "ruleDetails.loading" : "ruleDetails.missing")}</p>` : nothing}
      </div>`;
  }
}
function display(value: unknown): string { if (value === undefined || value === null) return "—"; if (Array.isArray(value)) return value.map(display).join(", "); if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}: ${display(item)}`).join("; "); return String(value); }
customElements.define("codex-addon-rule-details", CodexAddonRuleDetails);
