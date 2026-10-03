import type { Page } from "playwright";
import assert from "node:assert/strict";

export async function unloadBlocked(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

export async function attemptHash(page: Page, hash: string, accept = false) {
  const dialogSeen = page.waitForEvent("dialog", { timeout: 5000 });
  page.once("dialog", (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
  await page.evaluate((hash) => {
    location.hash = hash;
  }, hash);
  assert.match((await dialogSeen).message(), /Discard the unsaved changes/u);
}
