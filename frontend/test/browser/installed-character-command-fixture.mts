import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  createCharacter,
  openSheet,
  save,
  type Fixture,
} from "./installed-character-builder-fixture.mts";

export async function readyCharacter(f: Fixture, key: string) {
  const inputs = await createCharacter(f, key);
  inputs.build.species = "dwarf";
  inputs.build.background = "soldier";
  inputs.build.levels = [{ id: "one", classId: "fighter" }];
  inputs.build.choices = [];
  for (let round = 0; round < 6; round++) {
    const { evaluation } = await f.call("evaluate", {
      key,
      operation: "build",
      inputs,
      expectedRevision: 0,
    });
    if (evaluation.ready) break;
    for (const choice of [
      ...evaluation.plan.creationChoices,
      ...evaluation.plan.creationAbilityChoices,
      ...evaluation.plan.classChoices,
    ]) {
      if (inputs.build.choices.some((row: { id: string }) => row.id === choice.id)) continue;
      if (choice.kind === "abilityBudget") {
        let remaining = Number(choice.budget);
        const value: Record<string, number> = {};
        for (const ability of choice.eligible) {
          const amount = Math.min(remaining, Number(choice.perAbilityMax));
          if (amount) value[ability] = amount;
          remaining -= amount;
        }
        inputs.build.choices.push({ id: choice.id, slot: 0, value });
      } else {
        const options = evaluation.guidance.choices[choice.id]?.options ?? [];
        for (let slot = 0; slot < Number(choice.count ?? 1) && options[slot]; slot++)
          inputs.build.choices.push({ id: choice.id, slot, value: options[slot].id });
      }
    }
  }
  const built = await save(f, key, inputs, 0, "seed");
  assert.equal(built.evaluation.ready, true, JSON.stringify(built.evaluation.issues));
  const rested = await f.call("save", {
    key,
    operation: "play",
    operationId: key + "-rest",
    expectedRevision: built.revision,
    summary: "Start with full HP",
    change: { operation: "rest", rest: "long" },
  });
  assert.equal(rested.status, "ready");
  assert.ok(rested.state.inputs.play.hp > 2);
  return rested;
}

export function registerRefusalTest(enabled: boolean, fixture: () => Fixture): void {
  void test(
    "a play action the rules refuse is outlined with its reason and editing continues",
    { skip: !enabled, timeout: 120000 },
    async (t) => {
      const f = fixture(),
        key = "refused-action";
      await readyCharacter(f, key);
      const { page, sheet, status, saveChange } = await openSheet(t, f, key, "en", "combat");
      const reason = "No uses remain for this resource.";
      // The rules engine refuses a play action this way; fake one refusal by
      // answering the save with a read and the worker's "invalid" status.
      await page.route("**/services/call", async (route) => {
        const body = route.request().postDataJSON();
        if (body?.contract !== "dnd5e.character" || body.method !== "save") return route.fallback();
        const read = await route.fetch({
          postData: JSON.stringify({
            ...body,
            method: "load",
            params: { contractVersion: body.params.contractVersion, key: body.params.key },
          }),
        });
        const envelope = await read.json();
        envelope.result = { ...envelope.result, status: "invalid", message: reason };
        await route.fulfill({ response: read, json: envelope });
      });
      await sheet.locator("summary", { hasText: "Rest and recovery" }).click();
      const rest = sheet.getByRole("button", { name: "Long rest", exact: true });
      await rest.click();
      await status.filter({ hasText: reason }).waitFor();
      const refused = sheet.locator("[data-rule-issue]");
      assert.equal(await refused.count(), 1);
      assert.equal(await refused.textContent(), "Long rest");
      const note = sheet.locator(".dnd-rule-note");
      await note.getByText("Against the rules", { exact: true }).waitFor();
      const detail = note.locator(".dnd-rule-note-detail");
      await page.mouse.move(0, 0);
      await detail.waitFor({ state: "hidden" });
      await note.locator(".dnd-rule-note-label").hover();
      await detail.filter({ hasText: reason }).waitFor({ state: "visible" });
      assert.equal(
        await sheet.getByText("The action may already be saved", { exact: false }).count(),
        0,
      );
      if (process.env["CODEX_UI_SCREENSHOTS"] === "1")
        await page.screenshot({ path: resolve(f.output, "refused-action.png") });
      await page.unroute("**/services/call");
      await saveChange(() =>
        sheet.getByRole("button", { name: "Short rest", exact: true }).click(),
      );
      assert.equal(await sheet.locator("[data-rule-issue]").count(), 0);
    },
  );
}
