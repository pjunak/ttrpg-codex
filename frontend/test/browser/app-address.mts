import type { Page } from "playwright";

/** The app address a page URL shows: its path and query. */
export function pageAddress(url: string): string {
  const { pathname, search } = new URL(url);
  return pathname + search;
}

/**
 * Opens an app page in place, the way a link click does, so open edits stay in
 * the page and the app may ask before leaving them. Resolves false when the
 * app refused.
 */
export function openInPlace(page: Page, href: string): Promise<boolean> {
  return page.evaluate(
    (href) =>
      window.dispatchEvent(
        new CustomEvent("codex-navigate", { cancelable: true, detail: { href } }),
      ),
    href,
  );
}
