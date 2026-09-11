import type { Page, Locator } from 'playwright';
export async function closePlannerEditor(page: Page, locale = 'en') {
  const dialog = page.getByRole('dialog', { name: locale === 'cs' ? 'Upravit plánovací položku' : 'Edit planning item', exact: true });
  if (await dialog.count()) await dialog.getByRole('button', { name: locale === 'cs' ? 'Zavřít editor' : 'Close editor', exact: true }).click();
  const reader = page.locator('.dm-planning-reader');
  if (await reader.count()) await reader.getByRole('button', { name: locale === 'cs' ? 'Zavřít čtečku' : 'Close reader', exact: true }).click();
}

export async function plannerTab(page: Page, name: string) {
  await page.locator(".dm-planner-dialog").waitFor(); if (await page.locator(".dm-planning-reader").count()) await page.getByRole("button", { name: "Edit item", exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit planning item', exact: true }).getByRole('tab', { name, exact: true }).click();
}

export async function editPlannerCard(page: Page, card: Locator, tab = 'Details') {
  await closePlannerEditor(page);
  await page.locator('.dm-planner-shell[aria-busy="false"]').waitFor();
  await card.dblclick();
  await plannerTab(page, tab);
}
