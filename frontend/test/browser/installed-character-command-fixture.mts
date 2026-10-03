import assert from "node:assert/strict";
import { createCharacter, save, type Fixture } from "./installed-character-builder-fixture.mts";

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
