import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { resolve } from "node:path";
import type { APIRequestContext, Browser, Page } from "playwright";
import { jsonResponse } from "./installed-graph-fixture.mts";
import { unloadBlocked } from "./installed-planner-navigation-fixture.mts";
import { openCharacter, editInspiredName } from "./installed-character-save-fixture.mts";

interface Fixture {
  admin: APIRequestContext; browser: Browser; csrf: string; origin: string; output: string;
  call(method: string, params: Record<string, unknown>): ReturnType<typeof jsonResponse>;
}
type Source = { addonId: string; setId: string; id: string; enabled: boolean };

export async function changeUnusedSource(t: TestContext, f: Fixture, initial: Awaited<ReturnType<Fixture["call"]>>) {
  const policy = await jsonResponse(await f.admin.get("/api/admin/rules-policy"));
  const sources = policy.sources as Source[];
  const unused = sources.find(source => source.enabled && !initial.state.projection.evidence.some((entry: { book: string }) => entry.book === source.id));
  assert.ok(unused, "The fixture needs an enabled book outside the saved character's evidence");
  const set = async (enabled: Source[]) => {
    const current = await jsonResponse(await f.admin.get("/api/admin/rules-policy"));
    await jsonResponse(await f.admin.post("/api/admin/rules-policy", { headers: { "X-Codex-CSRF": f.csrf }, data: {
      expectedRevision: current.revision, expectedGraphRevision: current.graphRevision,
      enabled: enabled.map(({ addonId, setId, id }) => ({ addonId, setId, id })),
    } }));
  };
  t.after(() => set(sources.filter(source => source.enabled)));
  await set(sources.filter(source => source.enabled && source !== unused));
}

async function language(page: Page, locale: string) {
  await page.evaluate(value => localStorage.setItem("codex_lang", value), locale);
  await page.reload(); await page.locator("#character-view-addons").click();
  await page.locator(".addon-dnd-character .dse-item-notes summary").first().click();
  await page.waitForFunction(() => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"));
}

export function registerCharacterRulesRecoveryTests(enabled: boolean, fixture: () => Fixture) {
  for (const scenario of [
    { role: "dm", locale: "en", outcome: "saved" },
    { role: "player", locale: "cs", outcome: "saved" },
    { role: "dm", locale: "en", outcome: "lost-reply" },
    { role: "dm", locale: "en", outcome: "conflict" },
  ] as const) test("rules adoption keeps pending edits for " + scenario.role + " (" + scenario.locale + ", " + scenario.outcome + ")",
    { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), key = "rules-recovery-" + scenario.role + "-" + scenario.outcome;
      const { page, sheet, status, initial, read } = await openCharacter(t, f, key, false, scenario.role);
      const cs = scenario.locale === "cs";
      // Model a delayed event stream: the real worker rejection can arrive before
      // the graph replacement event. Generation replacement has separate acceptance.
      await page.route("**/api/events", route => route.abort("internetdisconnected"));
      if (cs) {
        await sheet.locator("#dnd-tab-tools").click(); await sheet.getByLabel("Sheet layout", { exact: true }).selectOption("classic");
        await language(page, "cs"); await page.setViewportSize({ width: 390, height: 1000 });
        await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      } else await language(page, "en");
      const input = sheet.getByLabel(cs ? "Název" : "Name", { exact: true }).first();
      const writes: Record<string, any>[] = [];
      await page.route("**/services/call", async route => {
        const body = route.request().postDataJSON();
        if (body?.method !== "save") { await route.continue(); return; }
        writes.push(body.params);
        if (writes.length === 1) await changeUnusedSource(t, f, initial);
        if (scenario.outcome === "lost-reply" && writes.length === 2) {
          const response = await route.fetch(); assert.equal(response.ok(), true);
          assert.equal((await response.json()).result.status, "ready");
          await route.abort("failed");
        } else await route.continue();
      });
      // The interception performs a real graph transition before forwarding the
      // save. Start the UI feedback deadline only after that rejected response.
      const firstSave = page.waitForResponse(response => {
        if (!response.url().endsWith("/services/call")) return false;
        const body = response.request().postDataJSON();
        return body?.method === "save" && body.params?.key === key;
      });
      await editInspiredName(sheet, "Keep pending rules edit");
      const rejectedSave = await firstSave;
      assert.equal(rejectedSave.ok(), true);
      assert.equal((await rejectedSave.json()).result.status, "rules-changed");
      await status.filter({ hasText: cs ? /Pravidla nebo povolené zdroje/ : /Rules or allowed sources changed/ }).waitFor({ timeout: 10000 }).catch(async error => {
        const current = await read();
        throw new Error(String(error) + "\n" + await status.allTextContents() + "\n" + JSON.stringify({ status: current.status, rulesChanged: current.rulesChanged, issues: current.evaluation?.issues, writes }));
      });
      assert.equal((await read()).revision, initial.revision); assert.equal(await unloadBlocked(page), true);
      await sheet.locator('[data-item="keepsake"] .dse-item-name').getByRole("button", { name: "Keep pending rules edit", exact: true }).waitFor();
      assert.equal(await status.getByRole("button", { name: cs ? "Zkusit znovu" : "Retry", exact: true }).count(), 0);
      const review = status.getByRole("button", { name: cs ? "Zkontrolovat změněná pravidla" : "Review changed rules", exact: true });
      await review.focus(); await review.press("Enter");
      const adopt = sheet.getByRole("button", { name: cs ? "Přijmout pravidla a uložit čekající změny" : "Adopt rules and save pending changes", exact: true });
      assert.equal(await adopt.count(), 1, "A rejected autosave must expose explicit adoption with the pending input");
      assert.equal(await adopt.evaluate(node => node === document.activeElement), true, "Review must focus the explicit adoption action");
      assert.equal(writes.length, 1, "Reviewing changed rules must not write");
      if (cs) {
        const readableActions = await sheet.locator(".character-toolbar").evaluate(toolbar => [...toolbar.querySelectorAll("button")].every(button => button.getBoundingClientRect().width >= toolbar.getBoundingClientRect().width * 0.9));
        assert.equal(readableActions, true, "Enlarged phone labels must not be squeezed into narrow columns");
        await adopt.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(f.output, "rules-adoption-cs-classic-phone.png") });
      }
      if (scenario.outcome === "conflict") {
        const remote = await read(); remote.state.inputs.play.inventory[0].name = "Another editor's accepted name";
        const saved = await f.call("save", { key, operation: "adopt-rules", operationId: key + "-remote", summary: "Remote adoption",
          expectedRevision: remote.revision, inputs: remote.state.inputs, adoptRules: true });
        assert.equal(saved.status, "ready");
      }
      await adopt.focus(); await adopt.press("Enter");
      if (scenario.outcome === "lost-reply") {
        const retry = status.getByRole("button", { name: "Retry", exact: true }); await retry.waitFor();
        assert.equal((await read()).revision, initial.revision + 1); assert.equal(await unloadBlocked(page), true);
        await retry.click();
      }
      await status.filter({ hasText: scenario.outcome === "conflict" ? /changed in another session/ : cs ? /^Uloženo$/ : /^Saved$/ }).waitFor();
      const saved = await read();
      assert.equal(saved.revision, initial.revision + 1);
      assert.equal(saved.state.inputs.play.inspiration, scenario.outcome === "conflict" ? undefined : true);
      assert.deepEqual(saved.state.inputs.play.quickUse, scenario.outcome === "conflict" ? undefined : ["keepsake"]);
      assert.equal(saved.state.inputs.play.containers?.[0].name, scenario.outcome === "conflict" ? undefined : "Pending pack");
      assert.equal(saved.state.inputs.play.inventory[0].containerId, saved.state.inputs.play.containers?.[0].id);
      assert.equal(writes[1]!.inputs.play.inspiration, true);
      assert.deepEqual(writes[1]!.inputs.play.quickUse, ["keepsake"]);
      assert.equal(writes[1]!.inputs.play.containers[0].name, "Pending pack");
      assert.equal(writes[1]!.inputs.play.inventory[0].containerId, writes[1]!.inputs.play.containers[0].id);
      assert.equal(saved.state.inputs.play.inventory[0].name, scenario.outcome === "conflict" ? "Another editor's accepted name" : "Keep pending rules edit");
      assert.equal(writes.length, scenario.outcome === "lost-reply" ? 3 : 2, "Adoption must not retry the rejected autosave first");
      assert.equal(writes[1]!.operation, "adopt-rules"); assert.equal(writes[1]!.adoptRules, true);
      assert.equal(writes[1]!.expectedRevision, initial.revision); assert.equal(writes[1]!.inputs.play.inventory[0].name, "Keep pending rules edit");
      if (scenario.outcome === "lost-reply") assert.deepEqual(writes[2], writes[1], "Retry keeps the exact adoption request");
      assert.equal(await unloadBlocked(page), scenario.outcome === "conflict");
      await sheet.locator("#dnd-tab-sheet").click();
      await sheet.locator('[data-item="keepsake"] .dse-item-name').getByRole("button", { name: "Keep pending rules edit", exact: true }).waitFor();
      if (scenario.outcome === "conflict") assert.equal(await input.count(), 0);
      else {
        await sheet.locator(".dse-item-notes summary").first().click();
        assert.equal(await input.inputValue(), "Keep pending rules edit"); assert.equal(await input.isEnabled(), true);
      }
      if (cs) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
}
