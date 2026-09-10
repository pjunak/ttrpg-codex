import type { Page } from 'playwright';
import type { FixtureRecord } from './fixture-types.mts';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

interface SheetSnapshot {
  classes: { subclass: string }[];
  subclass: string;
  baseStats: Record<string, number>;
  abilities: Record<string, number>;
  extraFeats: { name: string }[];
  inventory: { id: string; name: string; ref: string; location: string; qty: number; snapshot: { name: string } }[];
  currency: Record<string, number>;
  spellbook: Record<string, string[]>;
  hp: number; maxHp: number; notes: string; homebrew: Record<string, unknown>;
}
export async function exerciseCzechSheet({ page, key, mobile, output, get, write }: {
  page: Page; key: string; mobile: boolean; output: string;
  get: (key: string) => Promise<FixtureRecord<SheetSnapshot>>;
  write: (page: Page, action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const sheet = page.locator('.dnd-sheet-shell');
  await sheet.getByRole('button', { name: 'Upravit deník', exact: true }).click();
  await sheet.getByRole('spinbutton', { name: 'Síla', exact: true }).waitFor();
  await sheet.getByRole('button', { name: 'Čachry: bez zdatnosti', exact: true }).waitFor();
  await write(page, () => sheet.getByRole('button', { name: 'Snížit životy', exact: true }).click());
  await write(page, () => sheet.getByRole('combobox', { name: 'Přesunout: Rope', exact: true }).selectOption('ready'));
  await sheet.screenshot({ path: resolve(output, `czech-play-${mobile ? 'phone' : 'desktop'}.png`) });

  await sheet.getByRole('tab', { name: 'Tvorba postavy', exact: true }).click();
  await sheet.getByRole('button', { name: 'Načíst tvorbu postavy', exact: true }).click();
  await sheet.getByLabel('Druh', { exact: true }).waitFor();
  await write(page, () => sheet.getByRole('combobox', { name: 'Obor povolání 1', exact: true }).selectOption('abjurer'));
  await write(page, async () => { const score = sheet.getByLabel('Základ INT', { exact: true }); await score.fill('15'); await score.press('Tab'); });
  const origin = sheet.locator('.dnd-builder-choices fieldset').filter({ has: page.getByLabel('bgasi INT', { exact: true }) });
  await write(page, async () => { const amount = origin.getByLabel('bgasi INT', { exact: true }); await amount.fill('2'); await amount.press('Tab'); });
  await origin.getByText('Přiděleno 2 / 3 bodů vlastností', { exact: true }).waitFor();
  await sheet.getByRole('button', { name: 'Přidat odbornost nebo odměnu', exact: true }).click();
  const reward = page.getByRole('dialog', { name: 'Přidat odbornost nebo odměnu', exact: true });
  await reward.getByRole('textbox', { name: 'Název vlastní odměny' }).fill('Friend of River');
  await reward.getByRole('textbox', { name: 'Poznámka ke zdroji' }).fill('Dar od přátel');
  await write(page, () => reward.getByRole('button', { name: 'Přidat odměnu', exact: true }).click());
  await sheet.getByRole('tab', { name: 'Wizard 5', exact: true }).click();
  const level = sheet.locator('[data-builder-level="wizard:3"]'); await level.locator(':scope > summary').click();
  await level.getByRole('combobox', { name: 'Obor povolání: Wizard', exact: true }).waitFor();
  assert.equal(await sheet.locator('.dse-builder-main').evaluate(main => {
    const bounds = main.getBoundingClientRect();
    return [...main.querySelectorAll('.dnd-builder-class-row > *')].every(control => {
      const box = control.getBoundingClientRect(); return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
    });
  }), true, 'Translated class controls must remain inside the Builder');
  await sheet.locator('.dse-builder-shell').screenshot({ path: resolve(output, `czech-builder-${mobile ? 'phone' : 'desktop'}.png`) });
  const built = (await get(key)).value;
  assert.equal(built.classes[0].subclass, 'abjurer'); assert.equal(built.subclass, 'Abjurer');
  assert.equal(built.baseStats.INT, 15); assert.equal(built.abilities.INT, 17);
  assert.equal(built.extraFeats.at(-1)!.name, 'Friend of River');

  await sheet.getByRole('tab', { name: 'Deník postavy', exact: true }).click();
  await sheet.getByRole('button', { name: '＋ Přidat předmět', exact: true }).click();
  const equipment = page.getByRole('dialog', { name: 'Přidat vybavení', exact: true });
  await equipment.getByRole('button', { name: 'Otevřít: Zbraně', exact: true }).click();
  await equipment.getByRole('button', { name: 'Otevřít: martial', exact: true }).click();
  await equipment.getByRole('button', { name: 'Otevřít: melee', exact: true }).click();
  await equipment.getByRole('searchbox', { name: 'Hledat vybavení', exact: true }).fill('Longsword');
  await equipment.getByRole('button', { name: 'Vybrat: Longsword', exact: true }).click();
  await equipment.getByRole('textbox', { name: 'Název vlastního předmětu' }).fill('Klíč River');
  await equipment.getByRole('button', { name: 'Vybrat vlastní předmět', exact: true }).click();
  await equipment.screenshot({ path: resolve(output, `czech-equipment-${mobile ? 'phone' : 'desktop'}.png`) });
  await write(page, () => equipment.getByRole('button', { name: 'Přidat předměty do batohu' }).click());
  const inventory = (await get(key)).value.inventory;
  assert.equal(inventory.find((item: Record<string, unknown>) => item.ref === 'longsword')!.snapshot.name, 'Longsword');
  assert.equal(inventory.find((item: Record<string, unknown>) => item.name === 'Klíč River')!.location, 'pack');
  assert.equal(inventory.find((item: Record<string, unknown>) => item.id === 'rope')!.location, 'ready');

  await sheet.getByRole('tab', { name: 'Kniha kouzel', exact: true }).click();
  await sheet.getByRole('button', { name: 'Spravovat kouzla povolání' }).click();
  await write(page, () => sheet.getByRole('combobox', { name: 'Sesílací vlastnost: Magic Initiate', exact: true }).selectOption('WIS'));
  const choice = sheet.locator('[data-grant="feat:magic-initiate:mi-spell"]');
  await choice.getByRole('combobox').selectOption('cure-wounds');
  await write(page, () => choice.getByRole('button', { name: 'Vybrat kouzlo', exact: true }).click());
  const granted = sheet.locator('[data-granted-spell="feat:magic-initiate:cure-wounds"]');
  await granted.getByRole('combobox').selectOption('charge-cure-wounds');
  await write(page, () => granted.getByRole('button', { name: 'Seslat získané kouzlo' }).click());
  await sheet.getByRole('searchbox', { name: 'Hledat kouzla', exact: true }).fill('Alarm');
  const alarm = sheet.locator('[data-spell="alarm"]');
  await alarm.getByRole('button', { name: 'Opsat · 50 zl', exact: true }).click();
  const copying = page.getByRole('dialog', { name: 'Opsat kouzlo' });
  await copying.getByRole('combobox', { name: 'Svitek ke spotřebování' }).selectOption('scroll');
  await copying.getByRole('button', { name: 'Zkontrolovat opisování' }).click();
  const review = page.getByRole('dialog', { name: 'Zkontrolovat opis kouzla' });
  await review.getByText('Zlato: 100 → 50', { exact: true }).waitFor();
  assert.equal((await get(key)).value.currency.gp, 100);
  await review.screenshot({ path: resolve(output, `czech-copy-${mobile ? 'phone' : 'desktop'}.png`) });
  await write(page, () => review.getByRole('button', { name: 'Použít změny' }).click());
  const copied = (await get(key)).value;
  assert.equal(copied.currency.gp, 50); assert.equal(copied.inventory.find((item: Record<string, unknown>) => item.id === 'scroll')!.qty, 1);
  assert.ok(copied.spellbook.wizard.includes('alarm'));
  await write(page, () => alarm.getByRole('button', { name: 'Seslat jako rituál' }).click());
  await sheet.getByText('Rituál byl seslán. Žádná pozice kouzla nebyla spotřebována.', { exact: true }).waitFor();

  await sheet.getByRole('tab', { name: 'Boj', exact: true }).click();
  const beforeRest = await get(key);
  await sheet.getByRole('button', { name: 'Krátký odpočinek', exact: true }).click();
  await page.getByRole('dialog', { name: 'Zkontrolovat krátký odpočinek' }).getByRole('button', { name: 'Zrušit' }).click();
  assert.deepEqual(await get(key), beforeRest);
  await sheet.getByRole('button', { name: 'Dlouhý odpočinek', exact: true }).click();
  const rest = page.getByRole('dialog', { name: 'Zkontrolovat dlouhý odpočinek' });
  await rest.getByText(/^Životy:/).waitFor();
  await write(page, () => rest.getByRole('button', { name: 'Použít změny' }).click());
  await sheet.getByRole('tab', { name: 'Poznámky', exact: true }).click();
  await write(page, async () => { const notes = sheet.getByRole('textbox', { name: 'Poznámky deníku' }); await notes.fill('Vzkaz pro River.'); await sheet.getByRole('tab', { name: 'Deník postavy', exact: true }).click(); });
  const final = (await get(key)).value;
  assert.equal(final.hp, final.maxHp); assert.equal(final.notes, 'Vzkaz pro River.');
  assert.deepEqual(final.homebrew, { clue: 'blue lantern' });
  await page.reload(); await sheet.getByRole('tab', { name: 'Deník postavy', exact: true }).waitFor();
  await sheet.getByText('Klíč River', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}
