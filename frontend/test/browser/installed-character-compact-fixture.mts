import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { openBuilder, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";

const control = (key: string): string => '[data-focus-key=' + JSON.stringify(key) + ']';

export function registerCompactTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en", "cs"]) test("Compact mockup uses real cards, Equipment dialogs and class navigation (" + locale + ")", { skip: !enabled, timeout: 120000 }, async t => {
    const f = fixture(), key = "compact-final-" + locale, initial = await readyCharacter(f, key), input = initial.state.inputs;
    const item = (id: string, kind: string, ref: string, location: string) => ({ id, name: "Personal " + id, reference: { kind, id: ref }, quantity: 1, location, attuned: false, acquisition: "Reward", notes: "Keep " + id });
    input.play.inventory = [
      { ...item("armor", "armor", "chain-mail", "equipped"), bodyPlacement: "body" },
      item("blade", "weapon", "longsword", "equipped"), item("shield", "armor", "shield", "equipped"),
      { ...item("dagger", "weapon", "dagger", "carried"), containerId: "pouch", quantity: 2 },
      { ...item("ring", "magic-item", "ring-of-protection", "equipped"), bodyPlacement: "other", attuned: true },
    ];
    input.play.containers = [{ id: "pouch", name: "Utility pouch" }]; input.play.hp = 5; input.play.inspiration = true;
    input.play.currency = { cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 }; input.play.quickUse = ["dagger"];
    let stored = await save(f, key, input, initial.revision, "inventory");
    for (const [hand, itemId] of [["main", "blade"], ["off", "shield"]]) stored = await f.call("save", { key, operation: "play", operationId: key + hand, expectedRevision: stored.revision, summary: "Choose hands", change: { operation: "set-hand", hand, itemId } });
    assert.equal(stored.status, "ready");
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    const text = locale === "cs" ? { saved: /^Uloženo$/, inspiration: "Inspirace", search: "Hledat v inventáři", sort: "Řadit podle", add: "Přidat předmět", find: "Najít předmět v katalogu", addDagger: "Přidat: Dagger", selected: "Přidat vybrané předměty", addTo: "Přidat do", close: "Zavřít" } : { saved: /^Saved$/, inspiration: "Inspiration", search: "Search inventory", sort: "Sort by", add: "Add item", find: "Find catalog item", addDagger: "Add Dagger", selected: "Add selected items", addTo: "Add to", close: "Close" };
    assert.equal(await sheet.locator("#dnd-builder-tab-levels").count(), 0);
    await sheet.locator("#dnd-tab-sheet").click();
    assert.equal(await sheet.locator('.dnd-sheet-tabs [role="tab"] > svg[aria-hidden="true"]').count(), 6);
    assert.equal(await sheet.getByLabel(locale === "cs" ? "Aktuální životy" : "Current HP", { exact: true }).count(), 1);
    assert.equal(await sheet.getByRole("meter", { name: locale === "cs" ? "Aktuální zdraví" : "Current health", exact: true }).getAttribute("aria-valuenow"), "5");
    await sheet.locator(".dsc-size").getByRole("button", { name: locale === "cs" ? "Střední" : "Medium", exact: true }).waitFor();
    assert.equal(await sheet.locator(".dse-coins").count(), 0); assert.equal(await sheet.locator(".dse-backpack").count(), 0);
    const boxes = await sheet.locator(".dsc-vitals > *").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return [r.x, r.width, r.height]; }));
    await sheet.locator("#dnd-tab-combat").click();
    assert.deepEqual(await sheet.locator(".dsc-vitals > *").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return [r.x, r.width, r.height]; })), boxes);
    assert.equal(await sheet.locator(".dsc-combat-ability").count(), 6); assert.equal(await sheet.locator(".dsc-combat-ability .dse-number").count(), 0);
    await sheet.getByRole("checkbox", { name: text.inspiration, exact: true }).uncheck(); await status.filter({ hasText: text.saved }).waitFor();
    assert.equal((await read()).state.inputs.play.inspiration, false);
    await sheet.locator(control("vitals/current-hp")).fill("4"); await status.filter({ hasText: text.saved }).waitFor();
    assert.equal((await read()).state.inputs.play.hp, 4);
    for (const tab of ["sheet", "combat", "equipment"]) {
      await sheet.locator("#dnd-tab-" + tab).click();
      await page.screenshot({ path: resolve(f.output, "compact-final-" + tab + "-" + locale + ".png"), fullPage: true });
    }
    const frames: { height: number; width: number; retained: string; content: number; tab: string }[] = [];
    // Full-page screenshots can temporarily resize the viewport. Measure the
    // settled layout after visiting each tab at the restored viewport size.
    for (const tab of ["sheet", "combat", "equipment", "tools"]) {
      await sheet.locator("#dnd-tab-" + tab).click();
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    }
    for (const tab of ["sheet", "combat", "equipment", "tools"]) {
      await sheet.locator("#dnd-tab-" + tab).click();
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      frames.push(await sheet.locator(".dnd-sheet-shell").evaluate((node, tab) => ({ height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width, retained: (node as HTMLElement).style.getPropertyValue("--dsc-content-height"), content: node.querySelector(".dnd-sheet-panel")!.getBoundingClientRect().height, tab }), tab));
    }
    assert.ok(Math.max(...frames.map(frame => frame.height)) - Math.min(...frames.map(frame => frame.height)) <= 1, "Visited tabs keep their outer frame: " + JSON.stringify(frames));
    await sheet.locator("#dnd-tab-equipment").click();
    assert.equal(await sheet.locator(".dsc-body-slot").count(), 10);
    assert.equal(await sheet.getByLabel("GP", { exact: true }).inputValue(), "4");
    await sheet.getByLabel("EP", { exact: true }).fill("17"); await status.filter({ hasText: text.saved }).waitFor();
    await sheet.locator(control("placement/body")).click();
    await sheet.locator(control("placement/stow/armor")).click(); await status.filter({ hasText: text.saved }).waitFor();
    assert.equal((await read()).state.inputs.play.inventory[0].location, "carried");
    await sheet.locator(control("placement/choose/armor")).click(); await status.filter({ hasText: text.saved }).waitFor();
    assert.deepEqual((await read()).state.inputs.play.inventory[0], input.play.inventory[0]);
    await sheet.getByRole("dialog").getByRole("button", { name: text.close, exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-focus-key") === "placement/body");
    await sheet.locator(control("storage/open/pouch")).click();
    let dialog = sheet.getByRole("dialog");
    await dialog.getByLabel(text.search, { exact: true }).fill("dagger"); await dialog.getByLabel(text.sort, { exact: true }).selectOption("quantity");
    await dialog.getByRole("button", { name: text.add, exact: true }).click();
    await dialog.getByLabel(text.find, { exact: true }).fill("dagger"); await dialog.getByRole("button", { name: text.addDagger, exact: true }).click();
    await dialog.getByLabel(text.addTo, { exact: true }).selectOption("dagger"); await dialog.getByRole("button", { name: text.selected, exact: true }).click();
    await status.filter({ hasText: text.saved }).waitFor();
    assert.equal(await dialog.getByLabel(text.search, { exact: true }).inputValue(), "dagger"); assert.equal(await dialog.getByLabel(text.sort, { exact: true }).inputValue(), "quantity");
    let current = await read(); assert.equal(current.state.inputs.play.inventory.length, input.play.inventory.length);
    assert.deepEqual(current.state.inputs.play.inventory[3], { ...input.play.inventory[3], quantity: 3 });
    assert.equal(current.state.inputs.play.currency.ep, 17);
    await dialog.getByRole("button", { name: text.add, exact: true }).click();
    await dialog.getByLabel(text.find, { exact: true }).fill("dagger"); await dialog.getByRole("button", { name: text.addDagger, exact: true }).click();
    await dialog.getByRole("button", { name: text.selected, exact: true }).click(); await status.filter({ hasText: text.saved }).waitFor();
    current = await read(); assert.equal(current.state.inputs.play.inventory.length, input.play.inventory.length + 1);
    assert.equal(current.state.inputs.play.inventory[5].containerId, "pouch"); assert.notEqual(current.state.inputs.play.inventory[5].id, "dagger");
    await dialog.getByRole("button", { name: text.add, exact: true }).click(); await dialog.getByRole("button", { name: text.close, exact: true }).click();
    assert.equal(await dialog.getByLabel(text.search, { exact: true }).inputValue(), "dagger");
    await dialog.getByRole("button", { name: text.close, exact: true }).click();
    for (const width of [1360, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(width => { document.documentElement.style.fontSize = width < 500 ? "200%" : ""; document.documentElement.dataset.theme = width === 1024 || width === 320 ? "moonlit" : "classic"; }, width);
      for (const tab of ["sheet", "combat", "equipment", "builder"]) {
        await sheet.locator("#dnd-tab-" + tab).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, locale + " " + width + " " + tab);
        if (width === 320) await page.screenshot({ path: resolve(f.output, "compact-final-" + tab + "-phone-" + locale + ".png"), fullPage: true });
      }
    }
    await page.reload(); await page.locator("#character-view-addons").click(); await sheet.locator("#dnd-tab-equipment").click();
    assert.equal(await sheet.getByLabel("EP", { exact: true }).inputValue(), "17");
    assert.deepEqual((await read()).state.inputs, current.state.inputs);
  });
}
