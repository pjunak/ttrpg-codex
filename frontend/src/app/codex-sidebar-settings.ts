import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import { allSidebarRoutes, campaignSidebar, defaultSidebarLayout, moveSidebarPage, sidebarPage, sidebarRecord, type SidebarLayout, type SidebarSection } from "./campaign-sidebar.js";
import { UiLocalizationController } from "./ui-localization.js";
import { confirmDiscardUnsavedEdit } from "./unsaved-edit.js";
import { addonSidebarKey, addonSidebarMode, addonSidebarRecord, type SidebarAddonMode } from "./campaign-sidebar.js";
import type { BrowserNavigationEntry } from "../addons/navigation.js";

export class CodexSidebarSettings extends LitElement {
  static override properties = { campaign: { attribute: false }, addonPages: { attribute: false }, saving: { type: Boolean }, editCompletion: { type: Number }, layout: { state: true }, invalid: { state: true } };
  declare campaign: CampaignDataset | undefined;
  declare saving: boolean;
  declare editCompletion: number;
  declare private layout: SidebarLayout | undefined;
  declare private invalid: boolean;
  declare addonPages: readonly BrowserNavigationEntry[];
  #visibilityCampaign: CampaignDataset | undefined;
  #visibilityChanges: Readonly<Record<string, SidebarAddonMode>> = {};
  #revision = 0;
  #dirty = false;
  #drag: { kind: "section" | "page"; id: string } | undefined;
  readonly #ui = new UiLocalizationController(this);
  constructor() { super(); this.saving = false; this.editCompletion = 0; this.invalid = false; this.addonPages = []; }
  protected override createRenderRoot() { return this; }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("editCompletion") || changed.has("campaign") && !this.#dirty) this.#reset();
  }
  protected override render() {
    return html`<section class="settings-ledger settings-sidebar-panel" aria-labelledby="sidebar-editor-title">
      <header class="settings-ledger-heading"><h2 id="sidebar-editor-title">🧭 ${this.#ui.t("sidebar.title")}</h2></header>
      <p class="settings-hint">${this.#ui.t("sidebar.intro")}</p>
      ${this.invalid ? html`<p role="alert">${this.#ui.t("sidebar.invalid")}</p>` : nothing}
      ${this.layout === undefined ? nothing : html`<fieldset class="settings-sidebar-controls" ?disabled=${this.saving}>
        <div class="settings-edit-actions"><button type="button" @click=${this.#add}>＋ ${this.#ui.t("sidebar.addSection")}</button>
          <button type="button" @click=${this.#defaults}>↺ ${this.#ui.t("sidebar.defaults")}</button></div>
        <div class="sb-editor">${repeat(this.layout.sections, section => section.id, (section, index) => this.#section(section, index))}
          <section class="sb-sec sb-hidden" @dragover=${(event: DragEvent) => this.#allowDrop(event, "page")}
            @drop=${(event: DragEvent) => this.#dropPage(event, "__hidden__", this.layout!.hidden.length)}>
            <h3>${this.#ui.t("sidebar.hidden")}</h3>${this.#pages(this.layout.hidden, "__hidden__")}
          </section>
        </div>
        <section class="sb-addon-panel"><h3>🧩 ${this.#ui.t("sidebar.addonPages")}</h3><p class="settings-hint">${this.#ui.t("sidebar.addonHint")}</p>
          ${this.addonPages.length === 0 ? html`<p class="settings-hint">${this.#ui.t("sidebar.noAddons")}</p>` : this.addonPages.map(page => {
            const key = addonSidebarKey(page), mode = this.#visibilityChanges[key] ?? addonSidebarMode(this.#visibilityCampaign, key);
            return html`<label class="sb-addon-page"><span>${page.label}<small>${page.addonId}</small></span>
              <select aria-label=${this.#ui.t("sidebar.addonVisibility", { name: page.label })} @change=${(event: Event) => {
                this.#visibilityChanges = { ...this.#visibilityChanges, [key]: (event.target as HTMLSelectElement).value as SidebarAddonMode }; this.#setDirty(true); this.requestUpdate();
              }}>${(["everyone", "dm", "hidden"] as const).map(option => html`<option value=${option} ?selected=${mode === option}>${this.#ui.t(option === "everyone" ? "sidebar.everyone" : option === "dm" ? "sidebar.dmOnly" : "sidebar.hidden")}</option>`)}</select></label>`;
          })}
        </section>
        <div class="settings-edit-actions"><button class="primary" type="button" @click=${this.#save}>${this.#ui.t(this.saving ? "settings.saving" : "dashboard.save")}</button>
          <button type="button" @click=${this.#cancel}>${this.#ui.t("dashboard.cancel")}</button></div>
      </fieldset>`}
    </section>`;
  }
  #section(section: SidebarSection, index: number) {
    return html`<section class="sb-sec" data-section=${section.id} @dragover=${(event: DragEvent) => this.#allowDrop(event, "section")}
      @drop=${(event: DragEvent) => this.#dropSection(event, index)}>
      <div class="sb-sec-head">
        <span class="sb-grip" draggable="true" aria-hidden="true" @dragstart=${(event: DragEvent) => this.#startDrag(event, "section", section.id)} @dragend=${() => { this.#drag = undefined; }}>⠿</span>
        <label><span class="visually-hidden">${this.#ui.t("sidebar.sectionName")}</span><input class="sb-sec-label" maxlength="200" .value=${section.label} @input=${(event: Event) => this.#field(section.id, { label: (event.target as HTMLInputElement).value })} /></label>
        <label><span class="visually-hidden">${this.#ui.t("sidebar.icon")}</span><input class="sb-sec-icon" maxlength="100" .value=${section.icon} @input=${(event: Event) => this.#field(section.id, { icon: (event.target as HTMLInputElement).value })} /></label>
        <span class="sb-order-controls"><button type="button" aria-label=${this.#ui.t("sidebar.sectionUp", { name: section.label })} ?disabled=${index === 0} @click=${() => this.#moveSection(section.id, index - 1)}>↑</button>
          <button type="button" aria-label=${this.#ui.t("sidebar.sectionDown", { name: section.label })} ?disabled=${index === this.layout!.sections.length - 1} @click=${() => this.#moveSection(section.id, index + 1)}>↓</button></span>
        <button type="button" aria-label=${this.#ui.t("sidebar.deleteSection", { name: section.label })} @click=${() => this.#delete(section.id)}>🗑</button>
      </div>
      <div class="sb-sec-flags">
        <label><input type="checkbox" .checked=${section.collapsible} @change=${(event: Event) => this.#field(section.id, { collapsible: (event.target as HTMLInputElement).checked })} />${this.#ui.t("sidebar.collapsible")}</label>
        <label><input type="checkbox" .checked=${section.defaultOpen} @change=${(event: Event) => this.#field(section.id, { defaultOpen: (event.target as HTMLInputElement).checked })} />${this.#ui.t("sidebar.defaultOpen")}</label>
        <label><input type="checkbox" .checked=${section.role === "dm"} @change=${(event: Event) => this.#field(section.id, { role: (event.target as HTMLInputElement).checked ? "dm" : "" })} />${this.#ui.t("sidebar.dmOnly")}</label>
      </div>
      <div @dragover=${(event: DragEvent) => this.#allowDrop(event, "page")} @drop=${(event: DragEvent) => this.#dropPage(event, section.id, section.pages.length)}>${this.#pages(section.pages, section.id)}</div>
    </section>`;
  }
  #pages(pages: readonly string[], section: string) {
    return html`<ul class="sb-pages">${repeat(pages, route => route, (route, index) => {
      const page = sidebarPage(route), name = page?.label ?? route;
      return html`<li class="sb-page" data-page=${route} @dragover=${(event: DragEvent) => this.#allowDrop(event, "page")} @drop=${(event: DragEvent) => this.#dropPage(event, section, index)}>
        <span class="sb-grip" draggable="true" aria-hidden="true" @dragstart=${(event: DragEvent) => this.#startDrag(event, "page", route)} @dragend=${() => { this.#drag = undefined; }}>⠿</span>
        <span class="sb-page-label">${page?.icon ?? "·"} ${name}${page === undefined ? html`<small>${this.#ui.t("sidebar.unavailable")}</small>` : nothing}</span>
        <span class="sb-order-controls"><button type="button" aria-label=${this.#ui.t("sidebar.pageUp", { name })} ?disabled=${index === 0} @click=${() => this.#movePage(route, section, index - 1)}>↑</button>
          <button type="button" aria-label=${this.#ui.t("sidebar.pageDown", { name })} ?disabled=${index === pages.length - 1} @click=${() => this.#movePage(route, section, index + 1)}>↓</button></span>
        <select aria-label=${this.#ui.t("sidebar.movePage", { name })} @change=${(event: Event) => this.#movePage(route, (event.target as HTMLSelectElement).value, 128)}>
          ${this.layout!.sections.map(group => html`<option value=${group.id} ?selected=${section === group.id}>${group.label || this.#ui.t("sidebar.newSection")}</option>`)}
          <option value="__hidden__" ?selected=${section === "__hidden__"}>${this.#ui.t("sidebar.hidden")}</option>
        </select>
      </li>`;
    })}${pages.length === 0 ? html`<li class="sb-empty">${this.#ui.t("sidebar.dropHere")}</li>` : nothing}</ul>`;
  }
  #reset(): void {
    if (this.campaign === undefined) return;
    this.#revision = sidebarRecord(this.campaign)?.revision ?? 0; this.invalid = false;
    this.#visibilityCampaign = this.campaign; this.#visibilityChanges = {};
    try { this.layout = campaignSidebar(this.campaign); } catch { this.layout = undefined; this.invalid = true; }
    this.#setDirty(false);
  }
  #setDirty(dirty: boolean): void { this.#dirty = dirty; this.dispatchEvent(new CustomEvent("campaign-edit-dirty", { detail: { dirty }, bubbles: true, composed: true })); }
  #change(layout: SidebarLayout): void { if (!this.saving) { this.layout = layout; this.#setDirty(true); } }
  #field(id: string, fields: Partial<SidebarSection>): void { if (this.layout) this.#change({ ...this.layout, sections: this.layout.sections.map(section => section.id === id ? { ...section, ...fields } : section) }); }
  #movePage(route: string, target: string, index: number): void { if (this.layout) this.#change(moveSidebarPage(this.layout, route, target, index)); }
  #moveSection(id: string, index: number): void {
    if (!this.layout) return;
    const section = this.layout.sections.find(section => section.id === id); if (!section) return;
    const sections = this.layout.sections.filter(section => section.id !== id); sections.splice(index, 0, section); this.#change({ ...this.layout, sections });
  }
  #delete(id: string): void {
    if (!this.layout) return;
    const removed = this.layout.sections.find(section => section.id === id);
    this.#change({ ...this.layout, sections: this.layout.sections.filter(section => section.id !== id), hidden: [...this.layout.hidden, ...(removed?.pages ?? [])] });
  }
  readonly #add = (): void => { if (this.layout && this.layout.sections.length < 32) this.#change({ ...this.layout, sections: [...this.layout.sections, {
    id: `section-${crypto.randomUUID()}`, label: this.#ui.t("sidebar.newSection"), icon: "", collapsible: false, defaultOpen: true, role: "", pages: [],
  }] }); };
  readonly #defaults = (): void => {
    if (!this.layout || !window.confirm(this.#ui.t("sidebar.confirmDefaults"))) return;
    const defaults = defaultSidebarLayout();
    this.#change({ ...this.layout, ...defaults, hidden: allSidebarRoutes(this.layout).filter(route => sidebarPage(route) === undefined) });
  };
  readonly #cancel = (): void => { if (!this.saving && confirmDiscardUnsavedEdit(this.#dirty, message => window.confirm(message))) this.#reset(); };
  readonly #save = (): void => { if (!this.saving && this.layout) this.dispatchEvent(new CustomEvent("campaign-sidebar-save", {
    detail: { expectedRevision: this.#revision, layout: this.layout, ...(Object.keys(this.#visibilityChanges).length > 0 && this.#visibilityCampaign !== undefined ? {
      addonVisibility: { expectedRevision: addonSidebarRecord(this.#visibilityCampaign)?.revision ?? 0, modes: this.#visibilityChanges },
    } : {}) }, bubbles: true, composed: true })); };
  #startDrag(event: DragEvent, kind: "section" | "page", id: string): void {
    if (this.saving) { event.preventDefault(); return; }
    event.stopPropagation(); this.#drag = { kind, id }; event.dataTransfer?.setData("text/plain", id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  #allowDrop(event: DragEvent, kind: "section" | "page"): void { if (!this.saving && this.#drag?.kind === kind) { event.preventDefault(); event.stopPropagation(); } }
  #dropPage(event: DragEvent, section: string, index: number): void {
    if (this.#drag?.kind !== "page" || this.saving) return;
    event.preventDefault(); event.stopPropagation(); this.#movePage(this.#drag.id, section, index); this.#drag = undefined;
  }
  #dropSection(event: DragEvent, index: number): void {
    if (this.#drag?.kind !== "section" || this.saving) return;
    event.preventDefault(); event.stopPropagation(); this.#moveSection(this.#drag.id, index); this.#drag = undefined;
  }
}
customElements.define("codex-sidebar-settings", CodexSidebarSettings);
