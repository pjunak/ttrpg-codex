import { html, nothing, type TemplateResult } from "lit";
import { openContextMenu, type ContextMenuItem } from "../ui/context-menu.js";
import { pencilIcon } from "./edit-icon.js";
import { uiText } from "./ui-localization.js";

/** One step of a page's trail; the last step without a link is the page itself. */
export interface Crumb {
  readonly label: string;
  readonly href?: string;
  readonly icon?: string;
}

/** The pages above this one as large, separate links. */
export function breadcrumbs(crumbs: readonly Crumb[]) {
  return html`<nav class="breadcrumbs" aria-label=${uiText("Breadcrumbs")}><ol>${crumbs.map(
    (crumb) =>
      html`<li>${
        crumb.href === undefined
          ? html`<span class="breadcrumb-current" aria-current="page">${crumb.label}</span>`
          : html`<a class="breadcrumb-link" href=${crumb.href}>${
              crumb.icon
                ? html`<span class="breadcrumb-icon" aria-hidden="true">${crumb.icon}</span>`
                : nothing
            }${crumb.label}</a>`
      }</li>`,
  )}</ol></nav>`;
}

export interface RecordToolbar {
  /** Save feedback, read out as it changes. */
  readonly status?: TemplateResult | typeof nothing | undefined;
  /** The DM/player version switch. */
  readonly versions?: TemplateResult | typeof nothing | undefined;
  readonly edit?:
    { readonly label: string; readonly disabled?: boolean; readonly run: () => void } | undefined;
  /** Rarer actions, built when the menu opens; no menu without items. */
  readonly menu?: (() => readonly ContextMenuItem[]) | undefined;
}

/**
 * A record page's breadcrumbs and its actions in one line: the trail starts
 * where the article starts and the actions sit in the top right corner, so
 * neither pushes the article down. Panels the actions open float below them.
 */
export function recordPageBar(crumbs: readonly Crumb[], tools: RecordToolbar) {
  const menu = tools.menu;
  return html`<div class="record-page-bar">${breadcrumbs(crumbs)}
    <div class="record-toolbar" role="group" aria-label=${uiText("Page actions")}>
      ${tools.status ? html`<span class="record-toolbar-status">${tools.status}</span>` : nothing}
      ${tools.versions ?? nothing}
      ${
        tools.edit
          ? html`<button type="button" class="ui-action record-toolbar-button" ?disabled=${tools.edit.disabled}
          @click=${tools.edit.run}>${pencilIcon()}<span class="record-toolbar-label">${tools.edit.label}</span></button>`
          : nothing
      }
      ${
        menu && menu().length
          ? html`<button type="button" class="ui-action record-toolbar-button" aria-haspopup="menu"
          aria-label=${uiText("More actions")} title=${uiText("More actions")} @click=${(
            event: MouseEvent,
          ) => {
            const button = event.currentTarget as HTMLButtonElement,
              box = button.getBoundingClientRect();
            openContextMenu(button.ownerDocument, { x: box.left, y: box.bottom + 4 }, menu(), {
              returnFocus: button,
            });
          }}><span aria-hidden="true">⋯</span></button>`
          : nothing
      }
    </div></div>`;
}

/** The DM version: the same shield as the DM panel in the sidebar. */
export function dmVersionIcon() {
  return html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    focusable="false"><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z" /></svg>`;
}

/** The player version: what the players see. */
export function playerVersionIcon() {
  return html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle
    cx="12" cy="12" r="3" /></svg>`;
}
