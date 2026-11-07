import { isPlayerPreview, playerPreviewMarker } from "../core/player-preview.js";
import { canonicalAppHref } from "./routes.js";

/** Paths the server answers itself; every other path is a page of the app. */
const serverPath = /^\/(?:api|assets|icons-defaults)(?:\/|$)|^\/logo\.svg$/u;

/** The page the address bar shows, in canonical form. */
export function currentAppHref(): string {
  return canonicalAppHref(`${window.location.pathname}${window.location.search}`);
}

/** The URL written to history for `href`; a preview tab keeps its marker. */
export function addressFor(href: string): string {
  return isPlayerPreview() ? `${href}${playerPreviewMarker}` : href;
}

/**
 * The canonical page address that `href` opens, or `undefined` when it leaves
 * the app: another origin or scheme, a server path, or a fragment of this page.
 */
export function appNavigationHref(href: string): string | undefined {
  if (href.startsWith("#")) return undefined;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== window.location.origin ||
    serverPath.test(url.pathname)
  )
    return undefined;
  return canonicalAppHref(`${url.pathname}${url.search}`);
}

export const navigationRequestEvent = "codex-navigate";

export interface NavigationRequest {
  readonly href: string;
  /** Rewrite the current history entry instead of adding one. */
  readonly replace?: boolean;
  /** The caller already asked about unsaved changes. */
  readonly confirmed?: boolean;
}

/**
 * Asks the app to open `href`. Returns false when the app refused, for example
 * because the user kept unsaved changes.
 */
export function requestNavigation(
  href: string,
  options: Omit<NavigationRequest, "href"> = {},
): boolean {
  return window.dispatchEvent(
    new CustomEvent<NavigationRequest>(navigationRequestEvent, {
      cancelable: true,
      detail: { href, ...options },
    }),
  );
}
