import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { APIRequestContext, Browser, Page } from "playwright";
import { jsonResponse, installReviewedPackage } from "./installed-graph-fixture.mts";
import { replacementImportPackage } from "./installed-import-fixture.mts";
import { changeUnusedSource } from "./installed-character-rules-recovery-fixture.mts";
import { openCharacter, editInspiredName } from "./installed-character-save-fixture.mts";
import { unloadBlocked } from "./installed-planner-navigation-fixture.mts";

interface Fixture {
  admin: APIRequestContext; browser: Browser; csrf: string; origin: string; output: string;
  call(method: string, params: Record<string, unknown>): ReturnType<typeof jsonResponse>;
}

async function reloadProvider(f: Fixture, id = "dnd-engine") {
  const snapshot = await jsonResponse(await f.admin.get("/api/admin/addons/" + id));
  await jsonResponse(await f.admin.post("/api/admin/addons/" + id + "/reload", {
    headers: { "X-Codex-CSRF": f.csrf }, data: { expectedStateRevision: snapshot.state.revision },
  }));
}
async function markInstance(page: Page) {
  return page.locator(".addon-dnd-character").evaluate(node => { node.setAttribute("data-before-restart", ""); return node.localName; });
}
async function reconnected(page: Page, cs = false) {
  const sheet = page.locator(".addon-dnd-character:not([data-before-restart])");
  await sheet.locator("[data-character-status]").filter({ hasText: cs ? "Deník postavy se znovu připojil" : "The character reconnected" }).waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"));
  assert.equal(await unloadBlocked(page), true);
  assert.equal(await sheet.locator("[data-character-status]").evaluate(node => node === document.activeElement), true,
    JSON.stringify(await page.evaluate(() => ({ focused: document.activeElement?.outerHTML.slice(0, 600), busy: document.querySelector(".addon-dnd-character")?.getAttribute("aria-busy"), status: document.querySelector("[data-character-status]")?.outerHTML.slice(0, 800) }))));
}

export function registerCharacterGenerationTests(enabled: boolean, fixture: () => Fixture) {
  for (const role of ["dm", "player"] as const) test("graph handoff preserves pending input through a rules policy change (" + role + ")",
    { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), cs = role === "player", key = "generation-policy-" + role;
      const { page, sheet, status, initial, read } = await openCharacter(t, f, key, false, role);
      if (cs) {
        await sheet.locator("#dnd-tab-tools").click(); await sheet.getByLabel("Sheet layout", { exact: true }).selectOption("classic");
        await page.evaluate(() => localStorage.setItem("codex_lang", "cs")); await page.reload();
        await page.locator("#character-view-addons").click(); await sheet.locator(".dse-item-notes summary").first().click();
        await page.waitForFunction(() => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"));
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      }
      const writes: Record<string, any>[] = [];
      await page.route("**/services/call", async route => {
        const body = route.request().postDataJSON();
        if (body?.method !== "save") { await route.continue(); return; }
        writes.push(body.params);
        if (writes.length === 1) await route.abort("failed"); else await route.continue();
      });
      await editInspiredName(sheet, "Keep graph change input");
      await status.getByRole("button", { name: cs ? "Zkusit znovu" : "Retry", exact: true }).waitFor();
      const tag = await markInstance(page);
      await changeUnusedSource(t, f, initial); await reconnected(page, cs);
      assert.equal(await sheet.evaluate(node => node.localName), tag, "Policy changes restart the same immutable browser module");
      assert.equal(writes.length, 1, "Restart must not automatically replay an uncertain save");
      assert.equal((await read()).revision, initial.revision);
      await sheet.locator('[data-item="keepsake"] .dse-item-name').getByRole("button", { name: "Keep graph change input", exact: true }).waitFor();
      await status.getByRole("button", { name: cs ? "Zkusit znovu" : "Retry", exact: true }).click();
      const review = status.getByRole("button", { name: cs ? "Zkontrolovat změněná pravidla" : "Review changed rules", exact: true });
      await review.waitFor(); assert.deepEqual(writes[1], writes[0], "Uncertain autosave keeps its original request");
      await review.click();
      const adopt = sheet.getByRole("button", { name: cs ? "Přijmout pravidla a uložit čekající změny" : "Adopt rules and save pending changes", exact: true });
      if (cs) {
        await adopt.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(f.output, "generation-handoff-cs-classic-phone.png") });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await adopt.click(); await status.filter({ hasText: cs ? /^Uloženo$/ : /^Saved$/ }).waitFor();
      const saved = await read(); assert.equal(saved.revision, initial.revision + 1);
      assert.equal(saved.state.inputs.play.inventory[0].name, "Keep graph change input");
      assert.equal(saved.state.inputs.play.inspiration, true);
      assert.deepEqual(saved.state.inputs.play.quickUse, ["keepsake"]);
      assert.equal(saved.state.inputs.play.containers?.[0].name, "Pending pack");
      assert.equal(saved.state.inputs.play.inventory[0].containerId, saved.state.inputs.play.containers[0].id);
      assert.equal(writes[2]!.expectedRevision, initial.revision); assert.equal(writes.length, 3);
      assert.equal(await unloadBlocked(page), false);
    });

  for (const outcome of ["lost-reply", "conflict", "failed-read", "departure"] as const) test("graph handoff preserves autosave revision after provider reload (" + outcome + ")",
    { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), key = "generation-save-" + outcome;
      const { page, sheet, name, status, initial, read } = await openCharacter(t, f, key);
      const writes: Record<string, any>[] = []; let failRead = false, failedLoads = 0;
      await page.route("**/services/call", async route => {
        const body = route.request().postDataJSON();
        if (body?.method === "load" && failRead) { failedLoads++; await route.abort("failed"); return; }
        if (body?.method !== "save") { await route.continue(); return; }
        writes.push(body.params);
        if (writes.length === 1) {
          if (outcome === "lost-reply") assert.equal((await route.fetch()).ok(), true);
          await route.abort("failed");
        } else await route.continue();
      });
      await editInspiredName(sheet, "Pending across reload"); await status.getByRole("button", { name: "Retry", exact: true }).waitFor();
      if (outcome === "conflict") {
        const remote = await read(); remote.state.inputs.play.inventory[0].name = "Other editor";
        assert.equal((await f.call("save", { key, operation: "build", operationId: key + "-remote", summary: "Other edit",
          expectedRevision: remote.revision, inputs: remote.state.inputs })).status, "ready");
      }
      const tag = await markInstance(page); failRead = outcome === "failed-read";
      await reloadProvider(f);
      if (failRead) {
        // The old dirty sheet also has this button. Wait for the replacement's
        // failed initial load before releasing the transport failure.
        const replacement = page.locator(".addon-dnd-character:not([data-before-restart])");
        await replacement.getByRole("button", { name: "Reload saved character", exact: true }).waitFor();
        assert.ok(failedLoads > 0); assert.equal(await replacement.locator("[data-character-status]").count(), 0);
        assert.equal(await unloadBlocked(page), true, "A failed recovery read cannot clear the handoff guard");
        failRead = false; await replacement.getByRole("button", { name: "Reload saved character", exact: true }).click();
      }
      await reconnected(page);
      assert.equal(await sheet.evaluate(node => node.localName), tag); assert.equal(writes.length, 1);
      if (outcome === "departure") {
        page.once("dialog", dialog => dialog.accept());
        await page.evaluate(() => { location.hash = "#/timeline"; }); await page.locator(".tl-shell").waitFor();
        await page.evaluate(key => { location.hash = "#/characters/" + key; }, key);
        await page.locator("#character-view-addons").click(); await sheet.locator(".dse-item-notes summary").first().click();
        assert.equal(await name.inputValue(), "Travel dagger"); assert.equal(await unloadBlocked(page), false);
        return;
      }
      await status.getByRole("button", { name: "Retry", exact: true }).click();
      await status.filter({ hasText: outcome === "conflict" ? /edited elsewhere/ : /^Saved$/ }).waitFor();
      assert.deepEqual(writes[1], writes[0]); assert.equal(writes.length, 2);
      const saved = await read(); assert.equal(saved.revision, initial.revision + 1);
      assert.equal(saved.state.inputs.play.inventory[0].name, outcome === "conflict" ? "Other editor" : "Pending across reload");
      assert.equal(saved.state.inputs.play.inspiration, outcome === "conflict" ? undefined : true);
      assert.deepEqual(saved.state.inputs.play.quickUse, outcome === "conflict" ? undefined : ["keepsake"]);
      assert.equal(saved.state.inputs.play.containers?.[0].name, outcome === "conflict" ? undefined : "Pending pack");
      assert.equal(saved.state.inputs.play.inventory[0].containerId, saved.state.inputs.play.containers?.[0].id);
      assert.equal(await unloadBlocked(page), outcome === "conflict");
    });

  test("graph handoff retains the original merge base for rejected input", { skip: !enabled, timeout: 60000 }, async t => {
    const f = fixture(), key = "generation-rejected";
    const { page, sheet, status, initial, read } = await openCharacter(t, f, key);
    const writes: Record<string, any>[] = [];
    page.on("request", request => { if (request.url().endsWith("/services/call") && request.postDataJSON()?.method === "save") writes.push(request.postDataJSON().params); });
    await sheet.evaluate(root => {
      const coins = root.querySelector<HTMLInputElement>('input[aria-label="GP"]')!;
      coins.min = "-1"; coins.value = "-1"; coins.dispatchEvent(new Event("input", { bubbles: true }));
      const name = root.querySelector<HTMLInputElement>(".dse-item-notes input")!;
      name.value = "Rejected but retained"; name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await status.filter({ hasText: "Currency must use supported coins and non-negative amounts." }).waitFor();
    const remote = await read(); remote.state.inputs.notes = "Other editor's independent note";
    assert.equal((await f.call("save", { key, operation: "build", operationId: key + "-remote", summary: "Independent edit",
      expectedRevision: remote.revision, inputs: remote.state.inputs })).status, "ready");
    await markInstance(page); await reloadProvider(f); await reconnected(page);
    assert.equal(writes.length, 1, "Known rejected input is not automatically replayed");
    await sheet.getByLabel("GP", { exact: true }).fill("0");
    await status.filter({ hasText: /^Saved$/ }).waitFor();
    const saved = await read();
    assert.equal(saved.state.inputs.notes, "Other editor's independent note");
    assert.equal(saved.state.inputs.play.inventory[0].name, "Rejected but retained");
    assert.equal(saved.revision, initial.revision + 2);
    assert.equal(writes.length, 3); assert.equal(writes[1]!.expectedRevision, initial.revision);
    assert.equal(writes[2]!.expectedRevision, initial.revision + 1); assert.equal(await unloadBlocked(page), false);
  });

  for (const delivered of [false, true]) test("graph handoff retains the exact reviewed import after package replacement (delivered=" + delivered + ")",
    { skip: !enabled, timeout: 90000 }, async t => {
      const f = fixture(), key = "generation-import-" + delivered;
      const { page, sheet, status, initial, read } = await openCharacter(t, f, key);
      const archive = await readFile(resolve(process.env.CODEX_SHEETS_ZIP!));
      t.after(() => installReviewedPackage(f.admin, f.csrf, "dnd-sheets", archive, []));
      await sheet.locator("#dnd-tab-tools").click(); await sheet.getByRole("button", { name: "Import character", exact: true }).click();
      const inputs = structuredClone(initial.state.inputs); inputs.notes = "Approved before replacement";
      await sheet.getByLabel("Or paste the export").fill(JSON.stringify({ format: "dnd-character.v1", schemaVersion: "4.0.0", inputs }));
      const writes: Record<string, any>[] = []; let previews = 0;
      await page.route("**/services/call", async route => {
        const body = route.request().postDataJSON();
        if (body?.method === "preview") previews++;
        if (body?.method !== "commit") { await route.continue(); return; }
        writes.push(body.params);
        if (writes.length === 1) {
          if (delivered) assert.equal((await route.fetch()).ok(), true);
          await route.abort("failed");
        } else await route.continue();
      });
      await sheet.getByRole("button", { name: "Review import", exact: true }).click();
      await sheet.getByRole("button", { name: "Replace character", exact: true }).click();
      await status.getByRole("button", { name: "Retry", exact: true }).waitFor();
      const previous = await markInstance(page);
      await installReviewedPackage(f.admin, f.csrf, "dnd-sheets", replacementImportPackage(archive, "4.0.1"), []);
      await reconnected(page);
      assert.notEqual(await sheet.evaluate(node => node.localName), previous);
      assert.equal(writes.length, 1); assert.equal(previews, 1);
      await status.getByRole("button", { name: "Retry", exact: true }).click();
      if (delivered) await status.filter({ hasText: /^Saved$/ }).waitFor();
      else {
        await status.getByRole("button", { name: "Check saved character", exact: true }).waitFor();
        await page.waitForFunction(() => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"));
        assert.equal(await status.getByRole("button", { name: "Retry", exact: true }).count(), 0, "An expired review must not be automatically replaced or reapproved");
        assert.equal(await unloadBlocked(page), true);
        page.once("dialog", dialog => dialog.accept()); await status.getByRole("button", { name: "Check saved character", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"));
      }
      assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]); assert.equal(previews, 1);
      const saved = await read(); assert.equal(saved.revision, initial.revision + (delivered ? 1 : 0));
      assert.equal(saved.state.inputs.notes, delivered ? "Approved before replacement" : initial.state.inputs.notes);
      assert.equal(await unloadBlocked(page), false);
    });
}
