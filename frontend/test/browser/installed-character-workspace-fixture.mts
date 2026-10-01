import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { characterTab } from "./installed-character-navigation-fixture.mts";

type Row = Record<string, any>;
type Session = {
  page: Page;
  sheet: Locator;
  saveChange: (change: () => Promise<unknown>) => Promise<Row>;
};
const choice = (sheet: Locator, id: string) =>
  sheet.locator("[id=" + JSON.stringify("character-choice-" + encodeURIComponent(id)) + "]");

export function addWorkspaceState(input: Row): void {
  const item = (id: string, name: string, kind: string, ref: string) => ({
    id,
    name,
    reference: { kind, id: ref },
    quantity: 1,
    location: "carried",
    attuned: false,
    acquisition: "Session reward",
    notes: "Keep " + name,
  });
  input.play.inventory.push(
    { ...item("session-shield", "Road shield", "armor", "shield"), location: "equipped" },
    {
      ...item("session-armor", "Road armor", "armor", "chain-mail"),
      location: "equipped",
      bodyPlacement: "body",
    },
    {
      ...item("session-dagger", "Road dagger", "weapon", "dagger"),
      quantity: 2,
      containerId: "session-pack",
    },
  );
  input.play.containers = [{ id: "session-pack", name: "Road supplies" }];
  input.play.quickUse = ["session-dagger"];
  input.play.inspiration = true;
  input.play.hands = { main: "spell-sword", off: "session-shield", grip: "one" };
}

function preserved(inputs: Row): Row {
  const { inventory, containers, hands, quickUse, inspiration, conditions, currency } = inputs.play;
  return {
    inventory,
    containers,
    hands,
    quickUse,
    inspiration,
    conditions,
    currency,
    replacements: inputs.build.replacements,
    notes: inputs.notes,
  };
}

export function assertWorkspacePreserved(actual: Row, previous: Row): void {
  assert.deepEqual(
    preserved(actual),
    preserved(previous),
    "Session actions preserve independent authored state",
  );
}

export async function exerciseWorkspace(session: Session, locale: string): Promise<Row> {
  const { sheet, saveChange } = session,
    cs = locale === "cs";
  assert.equal(await sheet.getAttribute("data-layout"), "compact");
  await characterTab(sheet, "combat");
  assert.equal(
    await sheet
      .getByRole("checkbox", { name: cs ? "Inspirace" : "Inspiration", exact: true })
      .isChecked(),
    true,
  );
  const condition = sheet.getByRole("combobox", {
    name: cs ? "Přidat stav" : "Add condition",
    exact: true,
  });
  await condition.fill(cs ? "Vyčerpání" : "Exhaustion");
  await condition.press("ArrowDown");
  let stored = await saveChange(() => condition.press("Enter"));

  await characterTab(sheet, "builder");
  await sheet.locator("#dnd-builder-tab-fighter").click();
  const allowance = stored.evaluation.guidance.classReplacements.find(
    (row: Row) => row.classId === "fighter",
  );
  assert.equal(allowance.remaining, 1);
  const previous = allowance.picked[0],
    next = allowance.options.find((row: Row) => row.id !== previous.id);
  assert.ok(next);
  const panel = sheet.locator(
    "[id=" +
      JSON.stringify(
        "character-replacement-" + encodeURIComponent(allowance.kind + "/" + allowance.key),
      ) +
      "]",
  );
  for (const [name, value] of [
    [cs ? "Současná volba" : "Current choice", previous.label],
    [cs ? "Nová volba" : "New choice", next.label],
  ]) {
    const picker = panel.getByRole("combobox", { name, exact: true });
    await picker.fill(value);
    await panel.getByRole("option", { name: value, exact: true }).waitFor();
    await picker.press("ArrowDown");
    await picker.press("Enter");
  }
  stored = await saveChange(() =>
    panel
      .getByRole("button", {
        name: cs ? "Vyměnit volbu povolání" : "Replace class choice",
        exact: true,
      })
      .press("Enter"),
  );
  assert.equal(stored.state.inputs.build.replacements.length, 1);
  assert.equal(
    stored.evaluation.guidance.classReplacements.find((row: Row) => row.classId === "fighter")
      .remaining,
    0,
  );
  assert.equal(
    await panel
      .locator('[data-focus-key$="/spent"]')
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(stored.state.inputs.play.inspiration, true);
  assert.deepEqual(stored.state.inputs.play.conditions, [{ id: "exhaustion", level: 1 }]);
  assert.equal(
    stored.state.inputs.play.inventory.find((item: Row) => item.id === "session-dagger").quantity,
    2,
  );
  await characterTab(sheet, "spells");
  return stored;
}

export async function advanceWorkspace(
  session: Session,
  locale: string,
  checkpoint: (phase: string) => void,
  before: Row,
): Promise<Row> {
  const { sheet, saveChange } = session,
    cs = locale === "cs";
  await characterTab(sheet, "builder");
  await sheet.locator("#dnd-builder-tab-wizard").click();
  let stored = await saveChange(() =>
    sheet.getByRole("button", { name: cs ? "Přidat úroveň" : "Add level", exact: true }).click(),
  );
  checkpoint(
    "Incomplete Wizard level saved: " +
      JSON.stringify(stored.evaluation.issues.map((issue: Row) => issue.id)),
  );
  assert.equal(stored.state.inputs.build.levels.length, 12);
  assert.equal(
    stored.evaluation.ready,
    false,
    "An unfinished advancement is saved before its choices are completed",
  );
  for (let step = 0; !stored.evaluation.ready && step < 12; step++) {
    await sheet.locator(".dse-builder-next").press("Enter");
    const issues = stored.evaluation.guidance.sections.flatMap(
      (section: Row) => section.issues,
    ) as Row[];
    const issue = issues.find((row) => row.repair) ?? issues[0];
    checkpoint("Builder repair " + step + ": " + issue.id);
    const descriptors = stored.evaluation.plan.classChoices as Row[];
    const advancement = descriptors.find(
      (row) =>
        row.kind === "asiMode" &&
        !stored.state.inputs.build.choices.some((value: Row) => value.id === row.id),
    );
    if (advancement) {
      stored = await saveChange(() =>
        choice(sheet, advancement.id)
          .getByLabel(cs ? "Postup" : "Advancement", { exact: true })
          .selectOption("asi"),
      );
      checkpoint("Advancement mode selected");
      for (const ability of ["INT", "CON"]) {
        stored = await saveChange(() =>
          choice(sheet, advancement.ability.id)
            .getByLabel(ability, { exact: true })
            .press("ArrowUp"),
        );
        checkpoint("Advancement ability " + ability + " selected");
      }
    } else {
      assert.ok(["spellbook:wizard", "cantrips:wizard"].includes(issue.id), JSON.stringify(issue));
      const group = sheet.locator("[data-builder-target=" + JSON.stringify(issue.id) + "]");
      await group.waitFor();
      for (const name of issue.id === "cantrips:wizard"
        ? ["Ray of Frost"]
        : ["See Invisibility", "Web"]) {
        await group.getByRole("searchbox").fill(name);
        const spell = group.getByRole("checkbox", { name, exact: true });
        stored = await saveChange(() => spell.check());
        checkpoint("Wizard spell " + name + " selected");
        assert.equal(await spell.evaluate((node) => node === document.activeElement), true);
      }
      await group.getByRole("searchbox").fill("");
    }
  }
  assert.equal(stored.evaluation.ready, true, JSON.stringify(stored.evaluation.issues));
  assertWorkspacePreserved(stored.state.inputs, before.state.inputs);
  assert.deepEqual(stored.state.inputs.play.resourceUses, before.state.inputs.play.resourceUses);
  assert.equal(stored.state.inputs.play.hp, before.state.inputs.play.hp);
  assert.equal(
    stored.evaluation.guidance.classReplacements.find((row: Row) => row.classId === "fighter")
      .remaining,
    0,
    "A Wizard level does not refresh the Fighter allowance",
  );
  return stored;
}
