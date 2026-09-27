import { characterTab, inventoryView } from "./installed-character-navigation-fixture.mts";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { openBuilder, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";
import { exported, printOutput, review } from "./installed-character-output-fixture.mts";

const frozen = new Map<string, Awaited<ReturnType<Fixture["call"]>>>();
async function seed(f: Fixture, key: string) {
  const prior = await readyCharacter(f, key), input = prior.state.inputs;
  const item = (id: string, kind: string, ref: string) => ({ id, name: "Personal " + id, reference: { kind, id: ref }, quantity: 1, location: "equipped", attuned: false, acquisition: "Reward", notes: "Keep " + id });
  input.play.inventory = [item("armor", "armor", "chain-mail"), item("amulet", "magic-item", "amulet-of-health"), item("ring", "magic-item", "ring-of-protection"), item("copy", "magic-item", "ring-of-protection")];
  input.play.inventory[1].attuned = true;
  input.play.quickUse = ["ring"]; input.play.inspiration = true; input.play.currency = { cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 };
  return save(f, key, input, prior.revision, "seed");
}
const control = (id: string) => '[data-focus-key="inventory/' + id + '/body-placement"]';
const savedPattern = (locale: string) => locale === "cs" ? /^Uloženo$/ : /^Saved$/;

export function registerPlacementTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en", "cs"]) test("Body placement preserves owned equipment, transfer and print (" + locale + ")", { skip: !enabled, timeout: 120000 }, async t => {
    const f = fixture(), key = "placement-" + locale, initial = await seed(f, key);
    assert.ok(initial.state.inputs.play.inventory.every((item: Record<string, unknown>) => !Object.hasOwn(item, "bodyPlacement")));
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    await inventoryView(sheet);
    for (const [id, placement] of [["armor", "body"], ["amulet", "neck"], ["ring", "other"], ["copy", "other"]]) {
      const select = sheet.locator(control(id!)); await select.focus(); await select.selectOption(placement!);
      await status.filter({ hasText: savedPattern(locale) }).waitFor();
      assert.equal(await select.inputValue(), placement);
      assert.equal(await select.evaluate(node => node === document.activeElement), true);
    }
    let saved = await read();
    assert.deepEqual(saved.state.projection.sheet.derived, initial.state.projection.sheet.derived, "Placement cannot change mechanics");
    assert.deepEqual(saved.state.inputs.play.inventory.map(({ bodyPlacement: _, ...item }: Record<string, any>) => item), initial.state.inputs.play.inventory);
    for (const layout of ["compact", "classic"]) {
      await characterTab(sheet, "tools"); await sheet.getByRole("combobox", { name: locale === "cs" ? "Rozložení deníku" : "Sheet layout", exact: true }).selectOption(layout);
      await inventoryView(sheet);
      for (const width of [1360, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ width, layout }) => { document.documentElement.style.fontSize = width < 500 ? "200%" : ""; document.documentElement.dataset.theme = layout === "compact" ? "classic" : "moonlit"; }, { width, layout });
        const field = sheet.locator(control("amulet")); await field.scrollIntoViewIfNeeded();
        assert.ok((await field.boundingBox())!.height >= 40);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (width === 1360 || width === 320) await page.screenshot({ path: resolve(f.output, "placement-" + locale + "-" + layout + "-" + width + ".png") });
      }
    }
    await page.setViewportSize({ width: 1360, height: 1000 }); await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await sheet.locator('[data-focus-key="inventory/amulet/stow"]').click(); await status.filter({ hasText: savedPattern(locale) }).waitFor();
    saved = await read(); assert.equal(saved.state.inputs.play.inventory[1].bodyPlacement, undefined);
    assert.equal(saved.state.inputs.play.inventory[1].attuned, false); assert.equal(saved.state.inputs.play.inventory[1].location, "stored");
    await sheet.locator('[data-focus-key="inventory/armor/quantity"]').fill("0"); await status.filter({ hasText: savedPattern(locale) }).waitFor();
    saved = await read(); assert.equal(saved.state.inputs.play.inventory[0].bodyPlacement, undefined);
    assert.equal(saved.state.inputs.play.inventory[0].location, "carried");
    const used = await f.call("save", { key, operation: "play", operationId: key + "-consume", expectedRevision: saved.revision, change: { operation: "consume-item", itemId: "ring" }, summary: "Use placed item" });
    assert.equal(used.status, "ready"); assert.equal(used.state.inputs.play.inventory[2].bodyPlacement, undefined);
    assert.equal(used.state.inputs.play.inventory[3].bodyPlacement, "other", "A duplicate source is a different owned instance");
    await page.reload(); await page.locator("#character-view-addons").click(); await inventoryView(sheet);
    assert.equal(await sheet.locator(control("copy")).inputValue(), "other");
    await characterTab(sheet, "tools");
    const transfer = await exported(page, sheet, locale); assert.deepEqual(transfer.inputs.play, used.state.inputs.play);
    transfer.inputs.play.inventory[3].notes = "Imported placed copy";
    await review(sheet, locale, transfer, false);
    await sheet.getByRole("button", { name: locale === "cs" ? "Nahradit postavu" : "Replace character", exact: true }).click();
    await status.filter({ hasText: savedPattern(locale) }).waitFor(); saved = await read();
    assert.equal(saved.state.inputs.play.inventory[3].bodyPlacement, "other");
    const popup = await printOutput(page, sheet, locale);
    assert.match(await popup.locator("body").innerText(), locale === "cs" ? /Umístění na těle: Další nošené předměty/ : /Body placement: Other worn/);
    await popup.close(); await sheet.getByRole("button", { name: locale === "cs" ? "Zavřít" : "Close", exact: true }).click();
    frozen.set(key, saved);
  });

  for (const outcome of ["lost-reply", "disjoint", "conflict", "deleted-item"]) test("Body placement autosave preserves " + outcome, { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = "placement-save-" + outcome, initial = await seed(f, key);
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    await inventoryView(sheet);
    const writes: Record<string, any>[] = [];
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), arriving = new Promise<void>(resolve => { entered = resolve; });
    t.after(() => release());
    await page.route("**/services/call", async route => {
      const body = route.request().postDataJSON();
      if (body?.method !== "save") { await route.continue(); return; }
      writes.push(body.params);
      if (writes.length === 1) {
        if (outcome === "lost-reply") { assert.equal((await route.fetch()).ok(), true); await route.abort("failed"); return; }
        entered(); await held;
      }
      await route.continue();
    });
    await sheet.locator(control("amulet")).selectOption("neck");
    if (outcome === "lost-reply") {
      await status.getByRole("button", { name: "Retry", exact: true }).click();
      await status.filter({ hasText: /^Saved$/ }).waitFor();
      assert.deepEqual(writes[1], writes[0]); assert.equal(writes.length, 2);
      assert.equal((await read()).revision, initial.revision + 1);
    } else {
      await arriving;
      const remote = await read();
      if (outcome === "conflict") remote.state.inputs.play.inventory[1].notes = "Other editor";
      else if (outcome === "deleted-item") remote.state.inputs.play.inventory.splice(1, 1);
      else remote.state.inputs.play.currency.gp = 12;
      await save(f, key, remote.state.inputs, remote.revision, "other"); release();
      await status.filter({ hasText: outcome === "disjoint" ? /^Saved$/ : /edited elsewhere/ }).waitFor();
    }
    const current = await read();
    assert.equal(await sheet.locator(control("amulet")).inputValue(), "neck", "Pending placement is retained for conflict resolution");
    if (outcome === "deleted-item") assert.equal(current.state.inputs.play.inventory.some((item: Record<string, unknown>) => item.id === "amulet"), false);
    else assert.equal(current.state.inputs.play.inventory[1].bodyPlacement, outcome === "conflict" ? undefined : "neck");
    if (outcome === "disjoint") assert.equal(current.state.inputs.play.currency.gp, 12);
  });

  test("Body placement rejects invalid saves and imports without normalizing items", { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = "placement-invalid", initial = await seed(f, key);
    const cases = [
      (input: Record<string, any>) => { input.play.inventory[1].bodyPlacement = "face"; },
      (input: Record<string, any>) => { input.play.inventory[1].bodyPlacement = "unknown"; },
      (input: Record<string, any>) => { input.play.inventory[1].bodyPlacement = "neck"; input.play.inventory[1].location = "stored"; },
      (input: Record<string, any>) => { input.play.inventory[1].bodyPlacement = "neck"; input.play.inventory[1].quantity = 0; },
    ];
    for (const [index, mutate] of cases.entries()) for (const method of ["save", "preview"]) {
      const inputs = structuredClone(initial.state.inputs); mutate(inputs);
      const response = await f.call(method, { key, operation: method === "preview" ? "import" : "build", operationId: key + "-" + index + "-" + method, expectedRevision: initial.revision, inputs, summary: "Invalid placement" });
      assert.equal(response.status, "invalid"); assert.equal(response.token, undefined);
      const saved = await f.call("load", { key }); assert.equal(saved.revision, initial.revision); assert.deepEqual(saved.state, initial.state);
    }
  });
}

export async function verifyFrozenPlacement(t: TestContext, f: Fixture): Promise<void> {
  for (const [key, saved] of frozen) {
    const locale = key.endsWith("-cs") ? "cs" : "en";
    const { page, sheet, read } = await openBuilder(t, f, key, locale);
    try {
      const loaded = await read(); assert.equal(loaded.status, "unavailable"); assert.deepEqual(loaded.state, saved.state);
      await inventoryView(sheet);
      assert.equal(await sheet.locator(control("copy")).count(), 0);
      assert.match(await sheet.locator('[data-item="copy"] .dse-item-placement').innerText(), locale === "cs" ? /Další nošené předměty/ : /Other worn/);
      await characterTab(sheet, "tools");
      assert.deepEqual((await exported(page, sheet, locale)).inputs.play, saved.state.inputs.play);
      const popup = await printOutput(page, sheet, locale);
      assert.match(await popup.locator("body").innerText(), locale === "cs" ? /Umístění na těle: Další nošené předměty/ : /Body placement: Other worn/);
      await popup.close();
    } finally { await page.context().close(); }
  }
}
