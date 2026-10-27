import { LitElement, html, nothing } from "lit";
import type { CampaignDataset } from "../core/campaign-data.js";
import {
  campaignSidebar,
  defaultSidebarLayout,
  sidebarPage,
  sidebarSectionLabel,
  type SidebarSection,
} from "./campaign-sidebar.js";
import type { AppRoute } from "./routes.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";

/** Whether the core page `id` (a sidebar entry) is the one `route` shows. */
export function coreRouteActive(route: AppRoute, id: string): boolean {
  if (id.startsWith("graph-"))
    return route.kind === "campaign-graph" && id === `graph-${route.mode}`;
  if (id === "map") return route.kind === "map";
  if (id === "dashboard") return route.kind === "dashboard";
  if (id === "search") return route.kind === "search";
  if (id === "party")
    return route.kind === "party" || (route.kind === "create" && route.preset === "party");
  if (id === "timeline")
    return route.kind === "timeline" || (route.kind === "create" && route.preset === "event");
  if (id === "settings") return route.kind === "settings";
  return (route.kind === "collection" || route.kind === "record") && route.page.id === id;
}

/** The phone's bottom bar: the most used pages and the button that opens the sidebar. */
export function mobileNavigation(route: AppRoute, menuOpen: boolean, toggleMenu: () => void) {
  const current = (id: string) => (coreRouteActive(route, id) ? "page" : nothing);
  return html`
    <nav class="mobile-navigation" aria-label=${uiText("shell.primaryNavigation")}>
      <a href="#/" aria-current=${current("dashboard")}><span aria-hidden="true">🏠</span>${uiText("shell.overview")}</a>
      <a href="#/party" aria-current=${current("party")}><span aria-hidden="true">🛡</span>${uiText("shell.party")}</a>
      <a href="#/search" aria-current=${current("search")}><span aria-hidden="true">🔍</span>${uiText("shell.search")}</a>
      <a href="#/timeline" aria-current=${current("timeline")}><span aria-hidden="true">⏳</span>${uiText("timeline.title")}</a>
      <button type="button" data-menu-toggle aria-expanded=${menuOpen} aria-controls="campaign-sidebar" @click=${toggleMenu}><span aria-hidden="true">☰</span>${uiText("shell.menu")}</button>
    </nav>
  `;
}

/**
 * The sidebar's campaign navigation in the groups the campaign's sidebar
 * settings define. Collapsible groups remember on this device whether they
 * are open; DM-only groups show only to a DM.
 */
export class CodexShellNavigation extends LitElement {
  static override properties = {
    campaign: { attribute: false },
    route: { attribute: false },
    canManage: { type: Boolean },
  };
  declare campaign: CampaignDataset | undefined;
  declare route: AppRoute;
  declare canManage: boolean;
  readonly #open = new Map<string, boolean>();

  constructor() {
    super();
    new UiLocalizationController(this);
    this.campaign = undefined;
    this.route = { kind: "dashboard" };
    this.canManage = false;
  }

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    let layout;
    try {
      layout = campaignSidebar(this.campaign);
    } catch {
      layout = defaultSidebarLayout();
    }
    return html`
      <nav class="core-navigation" aria-label=${uiText("shell.campaignArchive")}>
        ${layout.sections.map((group) => {
          if (group.role === "dm" && !this.canManage) return nothing;
          const entries = group.pages.flatMap((route) => {
            const page = sidebarPage(route);
            return page === undefined ? [] : [page];
          });
          if (entries.length === 0) return nothing;
          const open = !group.collapsible || this.#isOpen(group),
            label = sidebarSectionLabel(group);
          return html`<section class=${`navigation-${group.id}`} data-navigation-section=${group.id}>
            <h2>${
              group.collapsible
                ? html`<button class="sidebar-section-toggle" aria-expanded=${open} @click=${() => this.#toggle(group)}>
              <span aria-hidden="true">${open ? "▾" : "▸"}</span> ${group.icon} ${label}</button>`
                : html`${group.icon} ${label}`
            }</h2>
            <div ?hidden=${!open}>${entries.map(
              (entry) => html`
              <a href=${`#${entry.route}`} aria-current=${coreRouteActive(this.route, entry.id) ? "page" : nothing}>
                <span aria-hidden="true">${entry.icon}</span>${entry.label}
              </a>
            `,
            )}</div>
          </section>`;
        })}
      </nav>
    `;
  }

  #isOpen(section: SidebarSection): boolean {
    const cached = this.#open.get(section.id);
    if (cached !== undefined) return cached;
    try {
      const saved = localStorage.getItem(`sidebar_section_open:${section.id}`);
      if (saved === "0" || saved === "1") return saved === "1";
    } catch {
      /* Optional browser preference. */
    }
    return section.defaultOpen;
  }

  #toggle(section: SidebarSection): void {
    const open = !this.#isOpen(section);
    this.#open.set(section.id, open);
    try {
      localStorage.setItem(`sidebar_section_open:${section.id}`, open ? "1" : "0");
    } catch {
      /* Keep the in-memory preference. */
    }
    this.requestUpdate();
  }
}

if (!customElements.get("codex-shell-navigation"))
  customElements.define("codex-shell-navigation", CodexShellNavigation);
