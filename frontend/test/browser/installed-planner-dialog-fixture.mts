import type { Page } from "playwright";

export async function closePlannerEditor(page: Page, locale = "en") {
  const dialog = page.getByRole("dialog", {
    name: locale === "cs" ? "Upravit plánovací položku" : "Edit planning item",
    exact: true,
  });
  if (await dialog.count())
    await dialog
      .getByRole("button", {
        name: locale === "cs" ? "Zavřít editor" : "Close editor",
        exact: true,
      })
      .click();
  const reader = page.locator(".dm-planning-reader");
  if (await reader.count())
    await reader
      .getByRole("button", {
        name: locale === "cs" ? "Zavřít čtečku" : "Close reader",
        exact: true,
      })
      .click();
}

/** Jumps to a section of the one-page item editor through its section bar. */
export async function plannerSection(page: Page, name: string) {
  await page.locator(".dm-planner-dialog").waitFor();
  if (await page.locator(".dm-planning-reader").count())
    await page.getByRole("button", { name: "Edit item", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Edit planning item", exact: true })
    .getByRole("navigation", { name: "Sections", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}
