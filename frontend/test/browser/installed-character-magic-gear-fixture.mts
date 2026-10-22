import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { openSheet, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";

interface Attack {
  itemId?: string;
  ref?: string;
  attackBonus: number;
  damage: string;
}

/** "1d8 +2" with its modifier raised by `bonus`. */
const raised = (damage: string, bonus: number): string => {
  const match = /^(\S+) ([+-]\d+)$/u.exec(damage);
  assert.ok(match, damage);
  const modifier = Number(match[2]) + bonus;
  return `${match[1]} ${modifier < 0 ? "" : "+"}${modifier}`;
};

export function registerMagicGearTest(enabled: boolean, fixture: () => Fixture): void {
  void test(
    "a Compendium +1 weapon and +2 shield add their bonus on the sheet",
    { skip: !enabled, timeout: 120000 },
    async (t) => {
      const f = fixture(),
        key = "magic-gear",
        initial = await readyCharacter(f, key),
        input = initial.state.inputs;
      const item = (id: string, kind: string, ref: string, extra: object = {}) => ({
        id,
        name: "Personal " + id,
        reference: { kind, id: ref },
        quantity: 1,
        location: "equipped",
        attuned: false,
        acquisition: "",
        notes: "",
        ...extra,
      });
      input.play.inventory = [
        item("plain", "weapon", "longsword"),
        item("shield", "armor", "shield"),
      ];
      const plain = await save(f, key, input, initial.revision, "plain");
      // The DMG records cover every base and +1 to +3; each item picks its own.
      input.play.inventory = [
        item("plain", "weapon", "longsword"),
        item("magic", "magic-item", "weapon-1-2-or-3", {
          name: "Weapon, +1, +2, or +3",
          baseItemId: "longsword",
          bonus: 1,
        }),
        item("shield", "magic-item", "shield-1-2-or-3", {
          name: "Shield, +1, +2, or +3",
          bonus: 2,
        }),
      ];
      const magic = await save(f, key, input, plain.revision, "magic");
      const before = plain.state.projection.sheet,
        after = magic.state.projection.sheet;
      const row = (sheet: { weapons: Attack[] }, id: string): Attack => {
        const found = sheet.weapons.find((weapon) => weapon.itemId === id);
        assert.ok(found, JSON.stringify(sheet.weapons));
        return found;
      };
      const longsword = row(before, "plain"),
        enchanted = row(after, "magic");
      assert.equal(enchanted.ref, "longsword");
      assert.equal(enchanted.attackBonus, longsword.attackBonus + 1);
      assert.equal(enchanted.damage, raised(longsword.damage, 1));
      assert.equal(after.derived.armorClass, before.derived.armorClass + 2);
      assert.deepEqual(
        magic.evaluation.issues.filter((issue: { id: string }) => issue.id.startsWith("item-")),
        [],
      );

      const { page, sheet } = await openSheet(t, f, key, "en", "combat");
      // The row names the magic weapon and notes what it is.
      const attack = sheet.locator(".dsc-attack-table tbody tr").filter({
        has: page.locator(".dsc-gear", { hasText: "Longsword, +1" }),
      });
      await attack.waitFor();
      assert.match((await attack.locator("th").textContent()) ?? "", /^Weapon, \+1, \+2, or \+3/u);
      assert.match(
        (await attack.locator(".dsc-hit").textContent()) ?? "",
        new RegExp(`^\\+${enchanted.attackBonus}\\b`, "u"),
      );
      if (process.env["CODEX_UI_SCREENSHOTS"] === "1")
        await page.screenshot({ path: resolve(f.output, "magic-gear.png") });
    },
  );
}
