import assert from "node:assert/strict";
import { save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";

type Row = Record<string, any>;
const owner = (id: string) => "feat:magic-initiate@" + encodeURIComponent("grant:" + id);
export async function spellCharacter(f: Fixture, key: string, count = 3) {
  let stored = await readyCharacter(f, key);
  for (const [index, list] of ["wizard", "cleric", "druid"].slice(0, count).entries()) {
    const previous = new Set(stored.state.inputs.grants.map((grant: Row) => grant.id));
    stored = await f.call("save", {
      key,
      operation: "grant",
      operationId: key + "-grant-" + list,
      expectedRevision: stored.revision,
      summary: "Grant spell training",
      grant: {
        id: "",
        actorId: "",
        grantedAt: "",
        name: list + " training",
        reason: "Installed spell acceptance",
        active: true,
        effectiveLevel: 1,
        condition: "always",
        effects: [],
        waivers: [],
        feat: { kind: "feat", id: "magic-initiate" },
      },
    });
    assert.equal(stored.status, "ready", JSON.stringify(stored));
    const id = stored.state.inputs.grants.find((grant: Row) => !previous.has(grant.id)).id,
      prefix = owner(id);
    const inputs = structuredClone(stored.state.inputs);
    inputs.build.choices.push({ id: prefix + ":spell-list", slot: 0, value: list });
    stored = await save(f, key, inputs, stored.revision, "list-" + list);
    const selected = structuredClone(stored.state.inputs);
    for (const choice of stored.evaluation.spellOptions.pendingChoices.filter((row: Row) =>
      row.key.startsWith(prefix + ":"),
    )) {
      assert.deepEqual(choice.from.class, [list]);
      selected.build.spells.grantChoices[choice.key] =
        choice.spellLevel === 1 ? ["detect-magic"] : choice.eligibleSpellIds.slice(0, 2);
      assert.ok(choice.spellLevel !== 1 || choice.eligibleSpellIds.includes("detect-magic"));
    }
    selected.build.spells.castingAbilities[prefix + ":magic-initiate-casting"] = [
      "INT",
      "WIS",
      "CHA",
    ][index];
    selected.notes = "Preserve spell ownership";
    stored = await save(f, key, selected, stored.revision, "spells-" + list);
    assert.equal(stored.evaluation.ready, true, JSON.stringify(stored.evaluation.issues));
  }
  const inputs = structuredClone(stored.state.inputs);
  inputs.play.inventory = [
    {
      id: "spell-sword",
      reference: { kind: "weapon", id: "longsword" },
      name: "Spell Sword",
      quantity: 1,
      location: "equipped",
      attuned: false,
      acquisition: "Retain acquisition",
      notes: "Retain notes",
    },
  ];
  return save(f, key, inputs, stored.revision, "weapon");
}
