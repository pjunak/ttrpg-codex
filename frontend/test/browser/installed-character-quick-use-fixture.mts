import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { openBuilder, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";
import { openCharacter } from "./installed-character-save-fixture.mts";
import { exported, printOutput, review } from "./installed-character-output-fixture.mts";

const frozen = new Map<string, Awaited<ReturnType<Fixture["call"]>>>();
const messages = (locale: string) => locale === "cs"
  ? { quick: "Rychlé použití", saved: /^Uloženo$/, layout: "Rozložení deníku", replace: "Nahradit postavu", close: "Zavřít", notes: "Poznámky" }
  : { quick: "Quick use", saved: /^Saved$/, layout: "Sheet layout", replace: "Replace character", close: "Close", notes: "Notes" };

async function seed(f: Fixture, key: string, pinned = false) {
  const initial = await readyCharacter(f, key), input = initial.state.inputs;
  const item = (id: string, quantity: number, location = "carried") => ({
    id, name: "Trail supplies", quantity, location, attuned: false, acquisition: "Quest reward", notes: "Keep " + id,
  });
  input.play.inventory = [item("one", 2), item("copy", 3), item("stored", 4, "stored"), item("empty", 0)];
  input.play.inspiration = true; input.play.currency = { cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 };
  if (pinned) input.play.quickUse = ["one", "copy", "stored", "empty"];
  return save(f, key, input, initial.revision, "inventory");
}

export function registerQuickUseTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en", "cs"]) test("Quick use shares owned quantities, depleted pins and saved output (" + locale + ")", { skip: !enabled, timeout: 90000 }, async t => {
    const f = fixture(), key = "quick-use-" + locale, text = messages(locale), initial = await seed(f, key);
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    await sheet.locator("#dnd-tab-sheet").click();
    for (const id of ["one", "copy", "stored", "empty"]) {
      const pin = sheet.locator('[data-focus-key="inventory/' + id + '/quick-use"]');
      await pin.focus(); await pin.press("Space"); await status.filter({ hasText: text.saved }).waitFor();
      assert.equal(await pin.getAttribute("aria-pressed"), "true");
      assert.equal(await pin.evaluate(node => node === document.activeElement), true);
    }
    let saved = await read();
    assert.deepEqual(saved.state.inputs.play.quickUse, ["one", "copy", "stored", "empty"]);
    assert.deepEqual(saved.state.inputs.play.inventory, initial.state.inputs.play.inventory);
    const one = sheet.locator('[data-quick-use-item="one"]'), use = one.locator('[data-focus-key$="/use"]');
    for (const layout of ["compact", "classic"]) {
      await sheet.locator("#dnd-tab-tools").click(); await sheet.getByRole("combobox", { name: text.layout, exact: true }).selectOption(layout);
      for (const width of [1360, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ width, layout }) => { document.documentElement.style.fontSize = width < 500 ? "200%" : ""; document.documentElement.dataset.theme = layout === "compact" ? "classic" : "moonlit"; }, { width, layout });
        for (const tab of ["sheet", "combat"]) {
          await sheet.locator("#dnd-tab-" + tab).click(); await one.scrollIntoViewIfNeeded();
          assert.equal(await sheet.locator("[data-quick-use-item]").count(), 4);
          assert.equal(await use.isEnabled(), true);
          for (const id of ["stored", "empty"]) assert.equal(await sheet.locator('[data-focus-key="quick-use/' + id + '/use"]').isDisabled(), true);
          assert.ok((await use.boundingBox())!.height >= 40);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        if (width === 1360 || width === 320) await page.screenshot({ path: resolve(f.output, "quick-use-" + locale + "-" + layout + "-" + width + ".png") });
      }
    }
    await page.setViewportSize({ width: 1360, height: 1000 }); await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    for (const quantity of [1, 0]) {
      await use.focus(); await use.press("Enter"); await status.filter({ hasText: text.saved }).waitFor();
      saved = await read(); assert.equal(saved.state.inputs.play.inventory[0].quantity, quantity);
      if (quantity) assert.equal(await use.evaluate(node => node === document.activeElement), true, "A usable action keeps keyboard focus");
      assert.deepEqual(saved.state.inputs.play.inventory.slice(1), initial.state.inputs.play.inventory.slice(1));
      assert.deepEqual(saved.state.inputs.play.quickUse, ["one", "copy", "stored", "empty"]);
    }
    const unpin = one.locator("[data-quick-use-unpin]");
    assert.equal(await use.isDisabled(), true);
    assert.equal(await unpin.evaluate(node => node === document.activeElement), true, "Last use moves focus to the same entry's available action");
    assert.equal(saved.state.inputs.play.inventory[0].notes, "Keep one");
    assert.deepEqual(saved.state.inputs.play.currency, initial.state.inputs.play.currency);
    assert.equal(saved.state.inputs.play.inspiration, true);
    await sheet.locator("#dnd-tab-sheet").click();
    const quantity = sheet.locator('[data-focus-key="inventory/one/quantity"]');
    assert.equal(await quantity.inputValue(), "0");
    await quantity.fill("2"); await status.filter({ hasText: text.saved }).waitFor();
    assert.equal((await read()).state.inputs.play.inventory[0].quantity, 2);
    assert.equal(await use.isEnabled(), true);
    await unpin.click(); await status.filter({ hasText: text.saved }).waitFor();
    assert.equal((await read()).state.inputs.play.inventory[0].quantity, 2, "Unpinning keeps the exact inventory entry");
    assert.equal(await sheet.locator('[data-focus-key="quick-use/copy/unpin"]').evaluate(node => node === document.activeElement), true);
    const pin = sheet.locator('[data-focus-key="inventory/one/quick-use"]'); await pin.click(); await status.filter({ hasText: text.saved }).waitFor();
    const remove = sheet.locator('[data-focus-key="inventory/copy/remove"]'); await remove.click(); await status.filter({ hasText: text.saved }).waitFor();
    saved = await read();
    assert.deepEqual(saved.state.inputs.play.quickUse, ["stored", "empty", "one"]);
    assert.deepEqual(saved.state.inputs.play.inventory.map((item: { id: string }) => item.id), ["one", "stored", "empty"]);
    await page.reload(); await page.locator("#character-view-addons").click(); await sheet.locator("#dnd-tab-combat").click();
    assert.equal(await sheet.locator("[data-quick-use-item]").count(), 3);
    await sheet.locator("#dnd-tab-tools").click();
    const transfer = await exported(page, sheet, locale);
    assert.deepEqual(transfer.inputs.play.quickUse, saved.state.inputs.play.quickUse);
    transfer.inputs.play.quickUse = ["empty", "one", "stored"];
    await review(sheet, locale, transfer, false); await sheet.getByRole("button", { name: text.replace, exact: true }).click();
    await status.filter({ hasText: text.saved }).waitFor();
    assert.deepEqual((await read()).state.inputs.play.quickUse, ["empty", "one", "stored"]);
    const popup = await printOutput(page, sheet, locale);
    await popup.getByRole("heading", { name: text.quick, exact: true }).waitFor();
    assert.equal(await popup.locator('[data-quick-use-item="empty"]').count(), 1, "Print includes depleted pinned entries");
    assert.match(await popup.locator('[data-quick-use-item="empty"]').innerText(), /Keep empty/);
    await popup.close(); await sheet.getByRole("button", { name: text.close, exact: true }).click();
    frozen.set(key, await read());
  });

  for (const outcome of ["lost-reply", "disjoint", "conflict", "removed-item"]) test("Quick-use autosave retains " + outcome, { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = "quick-use-save-" + outcome;
    const { page, sheet, status, initial, read } = await openCharacter(t, f, key);
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
    const pin = sheet.locator('[data-focus-key="inventory/keepsake/quick-use"]'); await pin.click();
    if (outcome === "lost-reply") {
      await status.getByRole("button", { name: "Retry", exact: true }).click(); await status.filter({ hasText: /^Saved$/ }).waitFor();
      assert.deepEqual(writes[1], writes[0]); assert.equal(writes.length, 2);
      assert.equal((await read()).revision, initial.revision + 1);
    } else {
      await arriving;
      const remote = await read();
      if (outcome === "conflict") {
        remote.state.inputs.play.inventory.push({ ...remote.state.inputs.play.inventory[0], id: "other" }); remote.state.inputs.play.quickUse = ["other"];
      } else if (outcome === "removed-item") remote.state.inputs.play.inventory = [];
      else remote.state.inputs.play.currency.gp = 12;
      await save(f, key, remote.state.inputs, remote.revision, "other"); release();
      await status.filter({ hasText: outcome === "conflict" ? /edited elsewhere/ : outcome === "removed-item" ? /Quick-use pins must refer/ : /^Saved$/ }).waitFor();
      if (outcome === "disjoint") assert.equal((await read()).state.inputs.play.currency.gp, 12);
    }
    if (outcome === "removed-item") {
      assert.equal((await read()).state.inputs.play.inventory.length, 0);
      assert.equal((await read()).state.inputs.play.quickUse, undefined, "A merge must not persist a dangling pin or recreate an item");
      await sheet.locator('[data-focus-key="quick-use/keepsake/unpin"]').click(); await status.filter({ hasText: /^Saved$/ }).waitFor();
      assert.equal((await read()).state.inputs.play.inventory.length, 0);
    } else {
      assert.equal(await pin.getAttribute("aria-pressed"), "true");
      assert.deepEqual((await read()).state.inputs.play.quickUse, [outcome === "conflict" ? "other" : "keepsake"]);
    }
  });

  for (const delivered of [false, true]) test("Quick-use command retries exactly once after " + (delivered ? "lost acknowledgment" : "failed delivery"), { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = "quick-use-command-" + delivered, initial = await seed(f, key, true);
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    await sheet.locator("#dnd-tab-combat").click();
    const writes: Record<string, any>[] = [];
    await page.route("**/services/call", async route => {
      const body = route.request().postDataJSON();
      if (body?.method !== "save" || body.params.operation !== "play") { await route.continue(); return; }
      writes.push(body.params);
      if (writes.length === 1) { if (delivered) assert.equal((await route.fetch()).ok(), true); await route.abort("failed"); }
      else await route.continue();
    });
    const use = sheet.locator('[data-focus-key="quick-use/one/use"]'); await use.click();
    await status.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await use.isDisabled(), true);
    assert.equal((await read()).state.inputs.play.inventory[0].quantity, delivered ? 1 : 2);
    await status.getByRole("button", { name: "Retry", exact: true }).click(); await status.filter({ hasText: /^Saved$/ }).waitFor();
    assert.deepEqual(writes[1], writes[0]); assert.equal(writes.length, 2);
    const saved = await read(); assert.equal(saved.revision, initial.revision + 1);
    assert.equal(saved.state.inputs.play.inventory[0].quantity, 1);
    assert.deepEqual(saved.state.inputs.play.quickUse, initial.state.inputs.play.quickUse);
  });

  test("Quick-use pending command does not steal focus moved outside the sheet", { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = "quick-use-focus"; await seed(f, key, true);
    const { page, sheet, status } = await openBuilder(t, f, key); await sheet.locator("#dnd-tab-combat").click();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), arriving = new Promise<void>(resolve => { entered = resolve; });
    t.after(() => release());
    await page.route("**/services/call", async route => {
      const body = route.request().postDataJSON();
      if (body?.method === "save" && body.params.operation === "play") { entered(); await held; }
      await route.continue();
    });
    await sheet.locator('[data-focus-key="quick-use/one/use"]').click(); await arriving;
    await page.evaluate(() => { const outside = document.createElement("button"); outside.id = "outside-character-focus"; outside.textContent = "Outside character"; document.body.append(outside); outside.focus(); });
    release(); await status.filter({ hasText: /^Saved$/ }).waitFor();
    assert.equal(await page.locator("#outside-character-focus").evaluate(node => node === document.activeElement), true);
  });

  test("Quick-use replacement import rejects missing and duplicated instance references", { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = "quick-use-invalid-import", initial = await seed(f, key, true);
    for (const quickUse of [["missing"], ["one", "one"]]) {
      const inputs = structuredClone(initial.state.inputs); inputs.play.quickUse = quickUse;
      const preview = await f.call("preview", { key, operation: "import", operationId: key + "-" + quickUse.length, expectedRevision: initial.revision, inputs, summary: "Import pins" });
      assert.equal(preview.status, "invalid"); assert.equal(preview.token, undefined);
      const saved = await f.call("load", { key }); assert.equal(saved.revision, initial.revision); assert.deepEqual(saved.state, initial.state);
    }
  });

  test("Quick-use stale command cannot consume a different editor's inventory", { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = "quick-use-stale", initial = await seed(f, key, true);
    const changed = structuredClone(initial.state.inputs); changed.play.inventory[0].quantity = 1;
    const remote = await save(f, key, changed, initial.revision, "other");
    const result = await f.call("save", { key, operation: "play", operationId: key + "-use", expectedRevision: initial.revision, summary: "Use one", change: { operation: "consume-item", itemId: "one" } });
    assert.equal(result.status, "conflict");
    const saved = await f.call("load", { key }); assert.equal(saved.revision, remote.revision); assert.deepEqual(saved.state, remote.state);
    const rest = await f.call("save", { key, operation: "play", operationId: key + "-rest", expectedRevision: saved.revision, summary: "Rest", change: { operation: "rest", rest: "long" } });
    assert.deepEqual(rest.state.inputs.play.inventory, saved.state.inputs.play.inventory);
    assert.deepEqual(rest.state.inputs.play.quickUse, saved.state.inputs.play.quickUse);
  });
}

export async function verifyFrozenQuickUse(t: TestContext, f: Fixture): Promise<void> {
  for (const [key, saved] of frozen) {
    const locale = key.endsWith("-cs") ? "cs" : "en", text = messages(locale);
    const { page, sheet, read } = await openBuilder(t, f, key, locale);
    try {
      const loaded = await read(); assert.equal(loaded.status, "unavailable"); assert.deepEqual(loaded.state, saved.state);
      for (const tab of ["sheet", "combat"]) {
        await sheet.locator("#dnd-tab-" + tab).click();
        assert.equal(await sheet.locator("[data-quick-use-item]").count(), 3);
        for (const control of await sheet.locator('.dse-quick-use button[data-focus-key$="/use"]').all()) assert.equal(await control.isDisabled(), true);
        assert.equal(await sheet.locator("[data-quick-use-unpin]").count(), 0);
        await sheet.locator('[data-quick-use-item="empty"]').getByText(text.notes, { exact: true }).click();
        await sheet.getByText("Keep empty", { exact: true }).first().waitFor();
      }
      await sheet.locator("#dnd-tab-tools").click();
      assert.deepEqual((await exported(page, sheet, locale)).inputs.play.quickUse, saved.state.inputs.play.quickUse);
      const popup = await printOutput(page, sheet, locale);
      await popup.getByRole("heading", { name: text.quick, exact: true }).waitFor(); assert.equal(await popup.locator("[data-quick-use-item]").count(), 3); await popup.close();
    } finally { await page.context().close(); }
  }
}
