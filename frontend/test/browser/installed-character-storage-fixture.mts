import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { openBuilder, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";
import { exported, printOutput, review } from "./installed-character-output-fixture.mts";

const frozen = new Map<string, Awaited<ReturnType<Fixture["call"]>>>();
const messages = (locale: string) => locale === "cs" ? {
  saved: /^Uloženo$/, heading: "Úložné prostory", add: "Přidat úložný prostor", layout: "Rozložení deníku",
  addItem: "Přidat předmět", destination: "Cílový úložný prostor", find: "Najít předmět v katalogu", selected: "Přidat vybrané předměty",
  replace: "Nahradit postavu", close: "Zavřít",
} : {
  saved: /^Saved$/, heading: "Storage containers", add: "Add container", layout: "Sheet layout",
  addItem: "Add item", destination: "Destination container", find: "Find catalog item", selected: "Add selected items",
  replace: "Replace character", close: "Close",
};

async function seed(f: Fixture, key: string, groups = false) {
  const initial = await readyCharacter(f, key), input = initial.state.inputs;
  const item = (id: string, quantity: number, location = "carried") => ({
    id, name: "Trail supplies", quantity, location, attuned: false, acquisition: "Quest reward", notes: "Keep " + id,
  });
  input.play.inventory = [item("one", 2), item("copy", 3, "stored"), item("empty", 0),
    { ...item("dagger", 1), name: "Personal dagger", reference: { kind: "weapon", id: "dagger" } }];
  input.play.quickUse = ["one", "empty"]; input.play.inspiration = true; input.play.currency = { cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 };
  if (groups) {
    input.play.containers = [{ id: "pack", name: "Travel pack" }, { id: "pouch", name: "Pouch" }];
    input.play.inventory[0].containerId = "pack"; input.play.inventory[2].containerId = "pack";
  }
  return save(f, key, input, initial.revision, "inventory");
}

export function registerStorageTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en", "cs"]) test("Storage organizes instances across edits, equipment, transfer and print (" + locale + ")", { skip: !enabled, timeout: 120000 }, async t => {
    const f = fixture(), key = "storage-" + locale, text = messages(locale), initial = await seed(f, key);
    const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    await sheet.locator("#dnd-tab-sheet").click();
    const ids: string[] = [];
    for (const label of ["Travel pack", "Pouch"]) {
      await sheet.getByRole("button", { name: text.add, exact: true }).click();
      const group = sheet.locator(".dse-storage [data-container]").last(), name = group.locator("input");
      assert.equal(await name.evaluate(node => node === document.activeElement), true, "New group focuses its name");
      await name.fill(label); await status.filter({ hasText: text.saved }).waitFor();
      ids.push((await group.getAttribute("data-container"))!);
    }
    const [pack, pouch] = ids as [string, string];
    for (const [id, destination] of [["one", pack], ["empty", pack], ["copy", pouch], ["dagger", pack]]) {
      const select = sheet.locator('[data-focus-key="inventory/' + id + '/container"]');
      await select.selectOption(destination!); await status.filter({ hasText: text.saved }).waitFor();
      assert.equal(await select.inputValue(), destination);
    }
    let saved = await read();
    assert.deepEqual(saved.state.inputs.play.quickUse, initial.state.inputs.play.quickUse);
    assert.deepEqual(saved.state.inputs.play.inventory.map(({ containerId: _, ...item }: Record<string, any>) => item), initial.state.inputs.play.inventory);
    const move = sheet.locator('[data-focus-key="inventory/dagger/move"]');
    await move.selectOption("equipped"); await status.filter({ hasText: text.saved }).waitFor();
    assert.equal((await read()).state.inputs.play.inventory[3].containerId, undefined);
    assert.equal(await sheet.locator('[data-focus-key="inventory/dagger/container"] option[value="' + pack + '"]').isDisabled(), true);
    await sheet.getByRole("button", { name: text.addItem, exact: true }).click();
    const picker = sheet.getByRole("dialog");
    await picker.getByLabel(text.destination, { exact: true }).selectOption(pouch);
    await picker.getByLabel(text.find, { exact: true }).fill("dagger");
    await picker.getByRole("button", { name: locale === "cs" ? "Přidat: Dagger" : "Add Dagger", exact: true }).click();
    await picker.getByRole("button", { name: text.selected, exact: true }).click();
    await status.filter({ hasText: text.saved }).waitFor();
    saved = await read();
    assert.equal(saved.state.inputs.play.inventory.length, 5);
    assert.equal(saved.state.inputs.play.inventory[4].containerId, pouch);
    assert.equal(saved.state.inputs.play.inventory[3].name, "Personal dagger");
    assert.equal(saved.state.inputs.play.inventory[3].location, "equipped");
    for (const layout of ["compact", "classic"]) {
      await sheet.locator("#dnd-tab-tools").click(); await sheet.getByRole("combobox", { name: text.layout, exact: true }).selectOption(layout);
      await sheet.locator("#dnd-tab-sheet").click();
      for (const width of [1360, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ width, layout }) => { document.documentElement.style.fontSize = width < 500 ? "200%" : ""; document.documentElement.dataset.theme = layout === "compact" ? "classic" : "moonlit"; }, { width, layout });
        const field = sheet.locator('[data-focus-key="storage/' + pack + '/name"]'); await field.scrollIntoViewIfNeeded();
        assert.ok((await field.boundingBox())!.height >= 40);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (width === 1360 || width === 320) await page.screenshot({ path: resolve(f.output, "storage-" + locale + "-" + layout + "-" + width + ".png") });
      }
    }
    await page.setViewportSize({ width: 1360, height: 1000 }); await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await sheet.locator('[data-focus-key="storage/' + pack + '/name"]').fill("Renamed pack"); await status.filter({ hasText: text.saved }).waitFor();
    await sheet.locator('[data-focus-key="storage/' + pouch + '/remove"]').click(); await status.filter({ hasText: text.saved }).waitFor();
    assert.equal(await sheet.locator('[data-focus-key="storage/' + pack + '/name"]').evaluate(node => node === document.activeElement), true);
    saved = await read();
    assert.equal(saved.state.inputs.play.inventory.length, 5);
    for (const index of [1, 4]) assert.equal(saved.state.inputs.play.inventory[index].containerId, undefined);
    assert.equal(saved.state.inputs.play.inventory[0].containerId, pack); assert.equal(saved.state.inputs.play.inventory[2].containerId, pack);
    await page.reload(); await page.locator("#character-view-addons").click(); await sheet.locator("#dnd-tab-sheet").click();
    assert.equal(await sheet.locator('[data-focus-key="storage/' + pack + '/name"]').inputValue(), "Renamed pack");
    await sheet.locator("#dnd-tab-tools").click();
    const transfer = await exported(page, sheet, locale); assert.deepEqual(transfer.inputs.play, saved.state.inputs.play);
    transfer.inputs.play.containers[0].name = "Imported pack";
    await review(sheet, locale, transfer, false); await sheet.getByRole("button", { name: text.replace, exact: true }).click();
    await status.filter({ hasText: text.saved }).waitFor(); saved = await read();
    assert.equal(saved.state.inputs.play.containers[0].name, "Imported pack");
    assert.equal(saved.state.inputs.play.inventory[2].containerId, pack);
    const popup = await printOutput(page, sheet, locale);
    await popup.getByRole("heading", { name: text.heading, exact: true }).waitFor();
    assert.match(await popup.locator('[data-container="' + pack + '"]').innerText(), /Imported pack/);
    assert.match(await popup.locator('[data-container="' + pack + '"]').innerText(), /Trail supplies × 0/);
    await popup.close(); await sheet.getByRole("button", { name: text.close, exact: true }).click();
    frozen.set(key, saved);
  });

  for (const outcome of ["lost-reply", "disjoint", "conflict", "removed-container"]) test("Storage autosave retains " + outcome, { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = "storage-save-" + outcome, initial = await seed(f, key, true);
    const { page, sheet, status, read } = await openBuilder(t, f, key);
    await sheet.locator("#dnd-tab-sheet").click();
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
    const destination = sheet.locator('[data-focus-key="inventory/one/container"]');
    await destination.selectOption("pouch");
    if (outcome === "lost-reply") {
      await status.getByRole("button", { name: "Retry", exact: true }).click(); await status.filter({ hasText: /^Saved$/ }).waitFor();
      assert.deepEqual(writes[1], writes[0]); assert.equal(writes.length, 2);
      assert.equal((await read()).revision, initial.revision + 1);
    } else {
      await arriving;
      const remote = await read();
      if (outcome === "conflict") delete remote.state.inputs.play.inventory[0].containerId;
      else if (outcome === "removed-container") remote.state.inputs.play.containers.pop();
      else remote.state.inputs.play.currency.gp = 12;
      await save(f, key, remote.state.inputs, remote.revision, "other"); release();
      await status.filter({ hasText: outcome === "conflict" ? /edited elsewhere/ : outcome === "removed-container" ? /Choose an existing container/ : /^Saved$/ }).waitFor();
      if (outcome === "disjoint") assert.equal((await read()).state.inputs.play.currency.gp, 12);
    }
    if (outcome === "removed-container") {
      assert.equal((await read()).state.inputs.play.inventory[0].containerId, "pack", "Invalid merged membership is not persisted");
      assert.equal(await destination.inputValue(), "pouch", "Pending assignment remains available for repair");
      await destination.selectOption(""); await status.filter({ hasText: /^Saved$/ }).waitFor();
      assert.equal((await read()).state.inputs.play.inventory[0].containerId, undefined);
      assert.equal((await read()).state.inputs.play.containers.length, 1);
    } else {
      assert.equal(await destination.inputValue(), "pouch");
      assert.equal((await read()).state.inputs.play.inventory[0].containerId, outcome === "conflict" ? undefined : "pouch");
    }
    const saved = await read();
    assert.deepEqual(saved.state.inputs.play.quickUse, initial.state.inputs.play.quickUse);
    assert.equal(saved.state.inputs.play.inventory[0].quantity, 2);
  });

  test("Storage item picker puts narrative quantities in the chosen container", { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = "storage-narrative", initial = await seed(f, key, true);
    const { sheet, status, read } = await openBuilder(t, f, key);
    await sheet.locator("#dnd-tab-sheet").click();
    await sheet.getByRole("button", { name: "Add item", exact: true }).click();
    const picker = sheet.getByRole("dialog");
    await picker.getByLabel("Destination container", { exact: true }).selectOption("pouch");
    await picker.locator("summary").filter({ hasText: /^Add narrative item$/ }).click();
    await picker.getByLabel("Name", { exact: true }).fill("Keepsake");
    await picker.getByLabel("Quantity", { exact: true }).fill("3");
    await picker.getByRole("button", { name: "Add narrative item", exact: true }).click();
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    const saved = await read();
    assert.deepEqual(saved.state.inputs.play.inventory.slice(0, 4), initial.state.inputs.play.inventory);
    const added = saved.state.inputs.play.inventory[4];
    assert.equal(added.name, "Keepsake"); assert.equal(added.quantity, 3);
    assert.equal(added.containerId, "pouch"); assert.equal(added.location, "carried");
  });

  test("Storage rejects invalid saves and replacement imports without changing saved inventory", { skip: !enabled, timeout: 60000 }, async () => {
    const f = fixture(), key = "storage-invalid", initial = await seed(f, key, true);
    const cases = [
      (input: Record<string, any>) => { input.play.inventory[0].containerId = "missing"; },
      (input: Record<string, any>) => { input.play.containers = []; },
      (input: Record<string, any>) => { input.play.containers.push({ id: "pack", name: "Duplicate" }); },
      (input: Record<string, any>) => { input.play.containers[0].name = " "; },
      (input: Record<string, any>) => { input.play.containers[0].name = "x".repeat(121); },
      (input: Record<string, any>) => { input.play.inventory[3].containerId = "pack"; input.play.inventory[3].location = "equipped"; },
    ];
    for (const [index, mutate] of cases.entries()) for (const method of ["save", "preview"]) {
      const inputs = structuredClone(initial.state.inputs); mutate(inputs);
      const result = await f.call(method, { key, operation: method === "preview" ? "import" : "build", operationId: key + "-" + index + "-" + method, expectedRevision: initial.revision, inputs, summary: "Invalid storage" });
      assert.equal(result.status, "invalid"); assert.equal(result.token, undefined);
      const saved = await f.call("load", { key }); assert.equal(saved.revision, initial.revision); assert.deepEqual(saved.state, initial.state);
    }
  });
}

export async function verifyFrozenStorage(t: TestContext, f: Fixture): Promise<void> {
  for (const [key, saved] of frozen) {
    const locale = key.endsWith("-cs") ? "cs" : "en", text = messages(locale);
    const { page, sheet, read } = await openBuilder(t, f, key, locale);
    try {
      const loaded = await read(); assert.equal(loaded.status, "unavailable"); assert.deepEqual(loaded.state, saved.state);
      await sheet.locator("#dnd-tab-sheet").click();
      assert.equal(await sheet.locator('[data-focus-key="storage/add"]').count(), 0);
      assert.equal(await sheet.locator(".dse-storage [data-container]").count(), 1);
      assert.match(await sheet.locator(".dse-storage").innerText(), /Imported pack/);
      assert.match(await sheet.locator(".dse-storage").innerText(), /Trail supplies × 0/);
      await sheet.locator("#dnd-tab-tools").click();
      assert.deepEqual((await exported(page, sheet, locale)).inputs.play, saved.state.inputs.play);
      const popup = await printOutput(page, sheet, locale);
      await popup.getByRole("heading", { name: text.heading, exact: true }).waitFor();
      assert.equal(await popup.locator("[data-container]").count(), 1); await popup.close();
    } finally { await page.context().close(); }
  }
}
