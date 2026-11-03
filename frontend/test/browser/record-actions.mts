import type { Locator, Page } from "playwright";

/** A menu entry by its label alone; a row's detail text is part of its accessible name. */
export function menuEntry(page: Page, label: string): Locator {
  return page
    .getByRole("menuitem")
    .filter({ has: page.locator(".ui-menu-label").getByText(label, { exact: true }) });
}

/** Runs an entry of a record page's ⋯ menu. */
export async function recordAction(page: Page, label: string): Promise<void> {
  await page
    .locator(".record-toolbar")
    .getByRole("button", { name: "More actions", exact: true })
    .click();
  await menuEntry(page, label).click();
}

/** Opens a character's wiki editor, which lives in the page's ⋯ menu. */
export async function editWiki(page: Page): Promise<void> {
  await recordAction(page, "Edit wiki");
}

/** Runs an entry of the menu a missing DM or player version opens. */
export async function addVersion(
  page: Page,
  version: "DM" | "player",
  label: string,
): Promise<void> {
  await page.getByRole("button", { name: `Add a ${version} version`, exact: true }).click();
  await menuEntry(page, label).click();
}
