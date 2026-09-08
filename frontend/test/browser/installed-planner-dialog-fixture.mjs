export async function closePlannerEditor(page, locale = 'en') {
  const dialog = page.getByRole('dialog', { name: locale === 'cs' ? 'Upravit plánovací položku' : 'Edit planning item', exact: true });
  if (await dialog.count()) await dialog.getByRole('button', { name: locale === 'cs' ? 'Zavřít editor' : 'Close editor', exact: true }).click();
}

export async function plannerTab(page, name) {
  await page.getByRole('dialog', { name: 'Edit planning item', exact: true }).getByRole('tab', { name, exact: true }).click();
}

export async function editPlannerCard(page, card, tab = 'Details') {
  await closePlannerEditor(page);
  await card.dblclick();
  await plannerTab(page, tab);
}
