import type { Page } from "playwright";
import assert from "node:assert/strict";

export async function unloadBlocked(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

export async function attemptNavigation(page: Page, href: string, accept = false) {
  const dialogSeen = page.waitForEvent("dialog", { timeout: 5000 });
  page.once("dialog", (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
  await page.evaluate((href) => {
    window.dispatchEvent(new CustomEvent("codex-navigate", { cancelable: true, detail: { href } }));
  }, href);
  assert.match((await dialogSeen).message(), /Discard the unsaved changes/u);
}
