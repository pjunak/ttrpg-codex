import assert from "node:assert/strict";
import { test } from "node:test";
import type { APIRequestContext, Browser } from "playwright";
import { jsonResponse } from "./installed-graph-fixture.mts";
import { unloadBlocked } from "./installed-planner-navigation-fixture.mts";
import { openCharacter } from "./installed-character-save-fixture.mts";

interface Fixture {
  admin: APIRequestContext; browser: Browser; csrf: string; origin: string; output: string;
  call(method: string, params: Record<string, unknown>): ReturnType<typeof jsonResponse>;
}

export function registerCharacterSessionTests(enabled: boolean, fixture: () => Fixture) {
  for (const scenario of [
    { role: "dm", locale: "en", width: 1440, stale: false },
    { role: "player", locale: "cs", width: 390, stale: false },
    { role: "dm", locale: "en", width: 1440, stale: true },
  ] as const) test("character pending edits survive session renewal for " + scenario.role + " in " + scenario.locale + (scenario.stale ? " with concurrent edits" : ""),
    { skip: !enabled, timeout: 60000 }, async t => {
      const { context, page, sheet, status, name, read, initial } = await openCharacter(t, fixture(), "session-" + scenario.role + (scenario.stale ? "-stale" : ""), false, scenario.role);
      if (scenario.locale === "cs") {
        await page.evaluate(() => localStorage.setItem("codex_lang", "cs")); await page.reload();
        await page.locator("#character-view-addons").click();
        await sheet.locator(".dse-item-notes summary").first().click();
        await page.waitForFunction(() => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"));
      }
      await page.setViewportSize({ width: scenario.width, height: 1000 });
      const input = scenario.locale === "cs" ? sheet.getByLabel("Název", { exact: true }).first() : name;
      const original = await sheet.elementHandle(); assert.ok(original);
      const requests: unknown[] = [];
      page.on("request", request => {
        if (request.url().endsWith("/services/call") && request.postDataJSON()?.method === "save") requests.push(request.postDataJSON());
      });
      await jsonResponse(await context.request.post("/api/logout"));
      await input.fill("Keep this through sign-in");
      const recovery = page.locator(".session-recovery"); await recovery.waitFor();
      const retry = status.getByRole("button", { name: scenario.locale === "cs" ? "Zkusit znovu" : "Retry", exact: true });
      await retry.waitFor();
      assert.equal((await read()).revision, initial.revision);
      assert.equal(await input.inputValue(), "Keep this through sign-in");
      assert.equal(await unloadBlocked(page), true);
      const password = recovery.locator("input[type=password]"), resume = recovery.locator("button[type=submit]");
      await password.fill("incorrect-local-password"); await resume.click(); await recovery.getByRole("alert").waitFor();
      await password.fill("local-character-" + (scenario.role === "dm" ? "player" : "dm")); await resume.click();
      await recovery.getByRole("alert").filter({ hasText: scenario.locale === "cs" ? /stejn/ : /same role/ }).waitFor();
      assert.equal(await input.inputValue(), "Keep this through sign-in");
      if (scenario.stale) {
        const remote = await read();
        remote.state.inputs.play.inventory[0].name = "Saved in the other editor";
        const changed = await fixture().call("save", { key: remote.key, operation: "build", operationId: "session-concurrent",
          summary: "Concurrent edit during sign-in", expectedRevision: remote.revision, inputs: remote.state.inputs });
        assert.equal(changed.status, "ready");
      }
      await password.fill("local-character-" + scenario.role); await resume.click();
      await recovery.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.activeElement?.id === "campaign-content");
      assert.equal(await original.evaluate(node => node.isConnected), true, "Reauthentication must preserve the mounted character and its pending request");
      assert.equal(await input.inputValue(), "Keep this through sign-in");
      assert.equal(requests.length, 1, "Signing in must not replay a save");
      assert.equal(await unloadBlocked(page), true);
      await retry.click();
      await status.filter({ hasText: scenario.stale ? /edited elsewhere/ : scenario.locale === "cs" ? /^Uloženo$/ : /^Saved$/ }).waitFor();
      const saved = await read();
      assert.equal(saved.state.inputs.play.inventory[0].name, scenario.stale ? "Saved in the other editor" : "Keep this through sign-in");
      assert.equal(saved.revision, initial.revision + 1);
      assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0], "Retry keeps the exact operation and revision");
      assert.equal(await unloadBlocked(page), scenario.stale);
      if (scenario.stale) assert.equal(await input.inputValue(), "Keep this through sign-in");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });

  test("same-role cookie renewal refreshes existing add-on clients without replaying a failed save",
    { skip: !enabled, timeout: 60000 }, async t => {
      const { context, page, sheet, status, name, read } = await openCharacter(t, fixture(), "session-cookie", false, "dm");
      const original = await sheet.elementHandle(); assert.ok(original);
      let writes = 0;
      page.on("request", request => { if (request.url().endsWith("/services/call") && request.postDataJSON()?.method === "save") writes++; });
      await jsonResponse(await context.request.post("/api/login", { data: { password: "local-character-dm" } }));
      const authority = page.waitForResponse(response => response.url().endsWith("/api/auth") && response.ok());
      await name.fill("Keep a renewed-cookie edit");
      const retry = status.getByRole("button", { name: "Retry", exact: true }); await retry.waitFor();
      await authority;
      assert.equal(await original.evaluate(node => node.isConnected), true);
      assert.equal(writes, 1); assert.equal(await page.locator(".session-recovery").count(), 0);
      await retry.click(); await status.filter({ hasText: /^Saved$/ }).waitFor();
      assert.equal((await read()).state.inputs.play.inventory[0].name, "Keep a renewed-cookie edit");
      assert.equal(writes, 2);
    });
}
