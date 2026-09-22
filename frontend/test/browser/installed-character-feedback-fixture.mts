import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import type { Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";
import { jsonResponse } from "./installed-graph-fixture.mts";
import { unloadBlocked } from "./installed-planner-navigation-fixture.mts";

export function registerCharacterFeedbackTests(enabled: boolean, fixture: () => Fixture) {
  for (const scenario of [
    { role: "dm", layout: "compact", locale: "cs" },
    { role: "player", layout: "classic", locale: "cs" },
    { role: "player", layout: "compact", locale: "en" },
  ] as const) test("save feedback retains engine limits and pending input (" + scenario.role + ", " + scenario.layout + ", " + scenario.locale + ")",
    { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(), key = "feedback-" + scenario.role + "-" + scenario.locale;
      const initial = await readyCharacter(f, key), maximum = initial.state.projection.sheet.derived.maxHp;
      const context = await f.browser.newContext({ baseURL: f.origin, viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
      t.after(() => context.close());
      await jsonResponse(await context.request.post("/api/login", { data: { password: "local-character-" + scenario.role } }));
      await context.addInitScript(locale => localStorage.setItem("codex_lang", locale), scenario.locale);
      const page = await context.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
      await page.goto(f.origin + "/#/characters/" + key); await page.locator("#character-view-addons").click();
      const sheet = page.locator(".addon-dnd-character"), status = sheet.locator("[data-character-status]"), cs = scenario.locale === "cs";
      await sheet.locator("#dnd-tab-tools").click();
      await page.waitForFunction(() => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"));
      await sheet.getByLabel(cs ? "Rozložení deníku" : "Sheet layout", { exact: true }).selectOption(scenario.layout);
      await sheet.locator("#dnd-tab-sheet").click();
      const hp = sheet.getByLabel(cs ? "Aktuální životy" : "Current HP", { exact: true });
      await hp.waitFor(); assert.equal(await sheet.getAttribute("data-layout"), scenario.layout);
      assert.equal(await hp.getAttribute("max"), String(maximum));
      // Simulate stale client bounds; the real worker must reject the edit.
      await hp.evaluate((node, value) => {
        const field = node as HTMLInputElement; field.min = String(value); field.value = String(value);
        field.dispatchEvent(new Event("input", { bubbles: true })); field.focus();
      }, -1);
      const reason = cs ? "Současné životy musí být v rozmezí 0 až " + maximum + ". Zkontrolujte nutnou opravu."
        : "Current HP must be between 0 and " + maximum + "; review the required correction.";
      await status.getByText(reason, { exact: true }).waitFor();
      assert.equal(await status.getAttribute("data-ui-state"), "error");
      assert.equal(await hp.inputValue(), "-1");
      assert.equal(await hp.isEnabled(), true, "The rejected field must remain correctable");
      assert.equal(await sheet.getByRole("button", { name: cs ? "Léčení" : "Heal", exact: true }).isDisabled(), true);
      assert.equal(await hp.evaluate(node => node === document.activeElement), true);
      assert.equal((await f.call("load", { key })).revision, initial.revision);
      assert.equal(await unloadBlocked(page), true);
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await page.waitForFunction(() => (document.querySelector(".campaign-sidebar")?.getBoundingClientRect().right ?? 0) <= 1);
      await status.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve(f.output, key + "-" + scenario.layout + ".png") });
      const retry = status.getByRole("button", { name: cs ? "Zkusit znovu" : "Retry", exact: true });
      await retry.focus(); await retry.press("Enter");
      await status.getByText(reason, { exact: true }).waitFor();
      assert.equal((await f.call("load", { key })).revision, initial.revision);
      await hp.fill(String(maximum));
      await status.filter({ hasText: cs ? /^Uloženo$/ : /^Saved$/ }).waitFor();
      const saved = await f.call("load", { key });
      assert.equal(saved.revision, initial.revision + 1); assert.equal(saved.state.inputs.play.hp, maximum);
      assert.equal(await hp.evaluate(node => node === document.activeElement), true);
      assert.equal(await sheet.getByRole("button", { name: cs ? "Léčení" : "Heal", exact: true }).isEnabled(), true);
      assert.equal(await unloadBlocked(page), false);
    });
}
