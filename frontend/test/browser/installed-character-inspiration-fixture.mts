import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createCharacter, openBuilder, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";
import { backupEntry } from "./installed-character-compatibility-fixture.mts";
import { exported, printOutput, review } from "./installed-character-output-fixture.mts";
import { jsonResponse, installReviewedPackage } from "./installed-graph-fixture.mts";
import { replacementImportPackage } from "./installed-import-fixture.mts";
import { openCharacter } from "./installed-character-save-fixture.mts";

const frozen = new Map<string, Awaited<ReturnType<Fixture["call"]>>>();
const text = (locale: string) => locale === "cs"
  ? { inspiration: "Inspirace", available: "K dispozici", saved: /^Uloženo$/, layout: "Rozložení deníku", replace: "Nahradit postavu", close: "Zavřít" }
  : { inspiration: "Inspiration", available: "Available", saved: /^Saved$/, layout: "Sheet layout", replace: "Replace character", close: "Close" };

export function registerInspirationSchemaTest(enabled: boolean, fixture: () => Fixture): void {
  test("Optional play-field schema reviews preserve both prior schema-4 generations", { skip: !enabled, timeout: 90000 }, async t => {
    const f = fixture(), archive = await readFile(resolve(process.env.CODEX_SHEETS_ZIP!));
    // Prior data schemas are reconstructed byte-for-byte. Workers/UI remain
    // current; this is stored-data preservation, not an old-native-binary claim.
    const prior = (inspiration: boolean) => replacementImportPackage(archive, "4.0.0", (files, manifest) => {
      const path = manifest.recordExtensions[0].schema, schema = JSON.parse(files[path]!.toString());
      delete schema.properties.inputs.properties.play.properties.quickUse;
      if (!inspiration) delete schema.properties.inputs.properties.play.properties.inspiration;
      const body = JSON.stringify(schema, null, 2) + "\n";
      assert.equal(createHash("sha256").update(body).digest("hex"), inspiration
        ? "cf799a12adb9aac840e5349732d79d34226f72bc9b866e438e61400071efb373"
        : "d50dd66156a2a9e9aa1c25f20f069d6b86eeacb2d8d206b0aee461c3351ae317");
      files[path] = body;
    });
    const saved = new Map<string, Awaited<ReturnType<Fixture["call"]>>>();
    const seed = async (key: string, inspiration?: boolean) => {
      const inputs = await createCharacter(f, key);
      inputs.notes = "Retain authored notes without adding defaults";
      inputs.play.currency = { cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 };
      if (inspiration !== undefined) inputs.play.inspiration = inspiration;
      const result = await save(f, key, inputs, 0, "old-schema"); saved.set(key, result);
      assert.equal(result.state.inputs.play.inspiration, inspiration);
      assert.equal(Object.hasOwn(result.state.inputs.play, "quickUse"), false);
    };
    const upgrade = async (target: Buffer, suffix: string) => {
      const headers = { "X-Codex-CSRF": f.csrf };
      const staged = await jsonResponse(await f.admin.post("/api/admin/addons/generations", { headers: { ...headers, "Content-Type": "application/zip" }, data: target }));
      const activation = await jsonResponse(await f.admin.post("/api/admin/addons/dnd-sheets/activation-reviews", { headers, data: { generationId: staged.generationId } }));
      assert.ok(activation.proposal.blockers.some((row: { code: string }) => row.code === "DATA_MIGRATION_REQUIRED"));
      const current = await jsonResponse(await f.admin.get("/api/admin/addons/dnd-sheets"));
      await jsonResponse(await f.admin.post("/api/admin/addons/dnd-sheets/disable", { headers, data: { expectedStateRevision: current.state.revision } }));
      const plan = await jsonResponse(await f.admin.post("/api/admin/addons/dnd-sheets/schema-reviews", { headers, data: { generationId: staged.generationId } }));
      assert.deepEqual(plan.blockers, []); assert.equal(plan.changes.length, 1);
      const recovery = await jsonResponse(await f.admin.get("/api/admin/addon-schema-reviews/" + plan.reviewId + "/recovery"));
      assert.equal(recovery.bodiesBase64.length, saved.size);
      const original = new Map<string, string>(recovery.bodiesBase64.map((body: string) => {
        const text = Buffer.from(body, "base64").toString(); return [JSON.parse(text).operationId, text];
      }));
      const applied = await jsonResponse(await f.admin.post("/api/admin/addon-schema-reviews/" + plan.reviewId + "/apply", { headers, data: { reviewSha256: plan.reviewSha256 } }));
      assert.equal(applied.status, "applied");
      await installReviewedPackage(f.admin, f.csrf, "dnd-sheets", target, []);
      const directory = await mkdtemp(resolve(f.output, "play-schema-" + suffix + "-"));
      t.after(async () => { const child = relative(f.output, directory); assert.ok(child && !child.startsWith("..") && !isAbsolute(child)); await rm(directory, { recursive: true, force: true }); });
      const backup = await f.admin.get("/api/backup"); assert.equal(backup.status(), 200);
      const path = resolve(directory, "codex.db"); await writeFile(path, backupEntry(await backup.body(), "codex.db"));
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        for (const [key, expected] of saved) {
          const loaded = await f.call("load", { key });
          assert.equal(loaded.revision, expected.revision); assert.deepEqual(loaded.state, expected.state);
          const row = db.prepare("SELECT body_json, revision FROM addon_documents WHERE addon_id=? AND data_kind='record-extension' AND data_id=? AND document_key=?").get("dnd-sheets", "dnd-sheets", key);
          assert.ok(row); assert.equal(row.body_json, original.get(expected.state.operationId)); assert.equal(row.revision, expected.revision);
          assert.deepEqual(JSON.parse(String(row.body_json)), expected.state);
        }
      } finally { db.close(); }
    };
    await installReviewedPackage(f.admin, f.csrf, "dnd-sheets", prior(false), []);
    await seed("inspiration-preserved");
    await upgrade(prior(true), "inspiration");
    await seed("quick-use-preserved-available", true);
    await seed("quick-use-preserved-spent", false);
    await upgrade(archive, "quick-use");
  });
}

export function registerInspirationTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en", "cs"]) test("Inspiration shares authored state across tabs, layouts and transfer (" + locale + ")", { skip: !enabled, timeout: 90000 }, async t => {
    const f = fixture(), key = "inspiration-" + locale, messages = text(locale);
    const initial = await readyCharacter(f, key), { page, sheet, status, read } = await openBuilder(t, f, key, locale);
    await sheet.locator("#dnd-tab-sheet").click();
    const control = sheet.getByRole("checkbox", { name: messages.inspiration, exact: true });
    assert.equal(await control.isChecked(), false); assert.equal(await control.isDisabled(), false);
    await control.focus(); await control.press("Space"); await status.filter({ hasText: messages.saved }).waitFor();
    assert.equal(await control.evaluate(node => node === document.activeElement), true);
    const saved = await read(); assert.equal(saved.revision, initial.revision + 1);
    assert.equal(saved.state.inputs.play.inspiration, true); assert.equal(saved.state.projection.sheet.inspiration, true);
    assert.equal(saved.state.projection.explanations.inspiration.value, true);
    for (const layout of ["compact", "classic"]) {
      await sheet.locator("#dnd-tab-tools").click(); await sheet.getByRole("combobox", { name: messages.layout, exact: true }).selectOption(layout);
      for (const width of [1360, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ width, layout }) => { document.documentElement.style.fontSize = width < 500 ? "200%" : ""; document.documentElement.dataset.theme = layout === "compact" ? "classic" : "moonlit"; }, { width, layout });
        for (const tab of ["sheet", "combat"]) {
          await sheet.locator("#dnd-tab-" + tab).click();
          assert.equal(await control.isChecked(), true);
          await control.scrollIntoViewIfNeeded();
          const label = control.locator("..");
          assert.ok((await label.boundingBox())!.height >= 40, "The shared checkbox label retains a usable target");
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        if (width === 1360 || width === 320) await page.screenshot({ path: resolve(f.output, "inspiration-" + locale + "-" + layout + "-" + width + ".png") });
      }
    }
    await page.setViewportSize({ width: 1360, height: 1000 }); await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await control.uncheck(); await status.filter({ hasText: messages.saved }).waitFor();
    assert.equal((await read()).state.inputs.play.inspiration, false, "Spending retains an explicit false value");
    await page.reload(); await page.locator("#character-view-addons").click(); await sheet.locator("#dnd-tab-sheet").click();
    assert.equal(await control.isChecked(), false);
    await sheet.locator("#dnd-tab-tools").click();
    const transfer = await exported(page, sheet, locale); assert.equal(transfer.inputs.play.inspiration, false);
    transfer.inputs.play.inspiration = true;
    await review(sheet, locale, transfer, false);
    await sheet.getByRole("button", { name: messages.replace, exact: true }).click(); await status.filter({ hasText: messages.saved }).waitFor();
    assert.equal((await read()).state.inputs.play.inspiration, true);
    const popup = await printOutput(page, sheet, locale);
    await popup.getByRole("heading", { name: messages.inspiration, exact: true }).waitFor();
    await popup.getByText(messages.available, { exact: true }).waitFor(); await popup.close();
    frozen.set(key, await read());
  });

  for (const outcome of ["lost-reply", "disjoint", "conflict"]) test("Inspiration autosave preserves " + outcome, { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = "inspiration-save-" + outcome;
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
    const control = sheet.getByRole("checkbox", { name: "Inspiration", exact: true }); await control.check();
    if (outcome === "lost-reply") {
      await status.getByRole("button", { name: "Retry", exact: true }).click();
      await status.filter({ hasText: /^Saved$/ }).waitFor();
      assert.deepEqual(writes[1], writes[0]); assert.equal(writes.length, 2);
      assert.equal((await read()).revision, initial.revision + 1);
    } else {
      await arriving;
      const remote = await read();
      if (outcome === "conflict") remote.state.inputs.play.inspiration = false;
      else remote.state.inputs.play.currency.gp = 12;
      await save(f, key, remote.state.inputs, remote.revision, "other");
      release();
      await status.filter({ hasText: outcome === "conflict" ? /edited elsewhere/ : /^Saved$/ }).waitFor();
      assert.equal((await read()).revision, initial.revision + (outcome === "conflict" ? 1 : 2));
      if (outcome === "disjoint") assert.equal((await read()).state.inputs.play.currency.gp, 12);
    }
    assert.equal(await control.isChecked(), true, "Pending input stays visible even if another editor conflicts");
    assert.equal((await read()).state.inputs.play.inspiration, outcome !== "conflict");
  });
}

export async function verifyFrozenInspiration(t: TestContext, f: Fixture): Promise<void> {
  for (const [key, saved] of frozen) {
    const locale = key.endsWith("-cs") ? "cs" : "en", messages = text(locale);
    const { page, sheet, read } = await openBuilder(t, f, key, locale);
    try {
      const loaded = await read(); assert.equal(loaded.status, "unavailable"); assert.deepEqual(loaded.state, saved.state);
      for (const tab of ["sheet", "combat"]) {
        await sheet.locator("#dnd-tab-" + tab).click();
        const control = sheet.getByRole("checkbox", { name: messages.inspiration, exact: true });
        assert.equal(await control.isChecked(), true); assert.equal(await control.isDisabled(), true);
      }
      await sheet.locator("#dnd-tab-tools").click(); assert.equal((await exported(page, sheet, locale)).inputs.play.inspiration, true);
      const popup = await printOutput(page, sheet, locale);
      await popup.getByRole("heading", { name: messages.inspiration, exact: true }).waitFor();
      await popup.getByText(messages.available, { exact: true }).waitFor(); await popup.close();
    } finally { await page.context().close(); }
  }
}
