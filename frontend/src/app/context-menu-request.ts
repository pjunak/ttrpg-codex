import type { ContextMenuItem } from "../ui/context-menu.js";
import type { CampaignPageDefinition } from "./routes.js";

export const contextMenuRequestEvent = "codex-context-menu-request";

/**
 * What a view may add to the app's context menu. The app dispatches one
 * request at the element under the pointer (or the focused element) before it
 * opens a menu; views that own that element fill it in synchronously.
 */
export interface ContextMenuRequestDetail {
  /** Where the menu will open, in client coordinates. */
  readonly point: { readonly x: number; readonly y: number };
  readonly canEdit: boolean;
  /** Why writes are unavailable right now, or "" when they are allowed. */
  readonly writeBlocked: string;
  /** The record this menu is about when the element is not a record link. */
  record?: { readonly page: CampaignPageDefinition; readonly key: string };
  /** Shown after the record's own actions, or alone when there is no record. */
  readonly items: ContextMenuItem[];
  /** Menu title when there is no record. */
  title?: string;
}

export function requestViewMenu(
  target: Element,
  base: Pick<ContextMenuRequestDetail, "point" | "canEdit" | "writeBlocked">,
): ContextMenuRequestDetail {
  const detail: ContextMenuRequestDetail = { ...base, items: [] };
  target.dispatchEvent(new CustomEvent(contextMenuRequestEvent, { bubbles: true, detail }));
  return detail;
}

export function isContextMenuRequest(event: Event): event is CustomEvent<ContextMenuRequestDetail> {
  return event.type === contextMenuRequestEvent && event instanceof CustomEvent;
}
