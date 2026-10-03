import type { Locator } from "playwright";

export async function characterTab(sheet: Locator, tab: string): Promise<void> {
  const dialog = sheet.locator("dialog[open]");
  // A picker may return to Backpack before closing the parent dialog.
  for (let depth = 0; depth < 3 && (await dialog.count()); depth++)
    await dialog.locator(":scope > button").last().click();
  await sheet.locator("#dnd-tab-" + tab).click();
}

export async function inventoryView(sheet: Locator): Promise<void> {
  await sheet.locator("#dnd-tab-tools").waitFor();
  await sheet
    .page()
    .waitForFunction(
      () => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"),
    );
  const compact = (await sheet.getAttribute("data-layout")) === "compact";
  await characterTab(sheet, compact ? "equipment" : "sheet");
  if (compact) {
    await sheet.locator('[data-focus-key="storage/open"]').click();
    const groups = sheet.locator('[data-details-key="pack/containers"]');
    if (
      (await groups.count()) &&
      !(await groups.evaluate((node) => (node as HTMLDetailsElement).open))
    )
      await groups.locator(":scope > summary").click();
  }
}

export async function equipmentView(sheet: Locator): Promise<void> {
  await sheet.locator("#dnd-tab-tools").waitFor();
  await sheet
    .page()
    .waitForFunction(
      () => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"),
    );
  await characterTab(
    sheet,
    (await sheet.getAttribute("data-layout")) === "compact" ? "equipment" : "sheet",
  );
  const controls = sheet.locator('[data-details-key="equipment/controls"]');
  if (
    (await controls.count()) &&
    !(await controls.evaluate((node) => (node as HTMLDetailsElement).open))
  )
    await controls.locator(":scope > summary").click();
}

export async function hpActionsView(sheet: Locator): Promise<void> {
  await characterTab(sheet, "sheet");
  const actions = sheet.locator(".dsc-adjustments");
  if (
    (await actions.count()) &&
    !(await actions.evaluate((node) => (node as HTMLDetailsElement).open))
  )
    await actions.locator(":scope > summary").click();
}

export async function expandCharacterDetails(sheet: Locator): Promise<void> {
  for (const details of await sheet
    .locator('[data-details-key^="exploration/"], [data-details-key^="combat/"]')
    .all())
    if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
      await details.locator(":scope > summary").click();
}
