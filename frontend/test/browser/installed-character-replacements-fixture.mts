import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { resolve } from "node:path";
import {
  createCharacter,
  openBuilder,
  save,
  type Fixture,
} from "./installed-character-builder-fixture.mts";
import { exported, printOutput, review } from "./installed-character-output-fixture.mts";

type Row = Record<string, any>;
const frozen = new Map<string, Row>();
const levels = (classId: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: classId + "-" + i, classId }));
const alternative = (classId: string) =>
  classId === "paladin" ? "blessed-warrior" : "druidic-warrior";
const keyFor = (classId: string) =>
  classId === "fighter"
    ? "fighter-fighting-style-feat"
    : "feature:" + classId + "-fighting-style:" + alternative(classId) + "-cantrips";
const changeFor = (classId: string) => ({
  operation: "replace-class-choice",
  kind: classId === "fighter" ? "feat" : "spell",
  key: keyFor(classId),
  out: classId === "fighter" ? "archery" : "guidance",
  ref: classId === "fighter" ? "defense" : classId === "paladin" ? "light" : "thorn-whip",
});
const allowance = (evaluation: Row, classId: string): Row =>
  evaluation.guidance.classReplacements.find((row: Row) => row.key === keyFor(classId));

async function seed(f: Fixture, key: string, classId: string) {
  const inputs = await createCharacter(f, key);
  inputs.build.species = "dwarf";
  inputs.build.background = "soldier";
  inputs.build.levels = levels(classId, classId === "fighter" ? 2 : 3);
  inputs.build.choices =
    classId === "fighter"
      ? [{ id: keyFor(classId), slot: 0, value: "archery" }]
      : [{ id: classId + "-fighting-style-option", slot: 0, value: alternative(classId) }];
  if (classId !== "fighter")
    inputs.build.spells.grantChoices[keyFor(classId)] = [
      "guidance",
      classId === "paladin" ? "sacred-flame" : "starry-wisp",
    ];
  inputs.notes = "Keep replacement session notes";
  inputs.play.hp = 1;
  inputs.play.temporaryHp = 2;
  inputs.play.currency.gp = 23;
  return save(f, key, inputs, 0, "seed");
}
function unchangedPlay(actual: Row, expected: Row) {
  assert.equal(actual.notes, expected.notes);
  const { asOf: _a, ...a } = actual.play,
    { asOf: _b, ...b } = expected.play;
  assert.deepEqual(a, b);
}

export function registerClassReplacementTests(enabled: boolean, fixture: () => Fixture) {
  void test(
    "installed class replacements use their own level and source allowance",
    { skip: !enabled, timeout: 60000 },
    async () => {
      const f = fixture();
      for (const classId of ["fighter", "paladin", "ranger"]) {
        const key = "class-replace-" + classId,
          initial = await seed(f, key, classId),
          change = changeFor(classId);
        assert.equal(allowance(initial.evaluation, classId).remaining, 1);
        const early = structuredClone(initial.state.inputs);
        early.build.levels.pop();
        const evaluated = await f.call("evaluate", {
          key,
          operation: "build",
          expectedRevision: initial.revision,
          inputs: early,
        });
        assert.equal(
          evaluated.evaluation.guidance.classReplacements.length,
          0,
          "Initial feature acquisition does not grant a replacement",
        );
        await assert.rejects(
          f.call("save", {
            key,
            operation: "play",
            operationId: key + "-wrong-list",
            summary: "Reject unrelated choice",
            expectedRevision: initial.revision,
            change: { ...change, ref: classId === "fighter" ? "tough" : "magic-missile" },
          }),
        );
        const request = {
          key,
          operation: "play",
          operationId: key + "-replace",
          summary: "Replace class training",
          expectedRevision: initial.revision,
          change,
        };
        const changed = await f.call("save", request);
        assert.equal(changed.status, "ready");
        assert.equal(changed.revision, initial.revision + 1);
        assert.equal(allowance(changed.evaluation, classId).remaining, 0);
        assert.equal(changed.state.inputs.build.replacements.length, 1);
        unchangedPlay(changed.state.inputs, initial.state.inputs);
        if (classId !== "fighter")
          assert.equal(
            changed.state.inputs.build.spells.grantChoices[change.key][1],
            initial.state.inputs.build.spells.grantChoices[change.key][1],
          );
        const retry = await f.call("save", request);
        assert.equal(retry.revision, changed.revision);
        assert.deepEqual(retry.state, changed.state);
        const stale = await f.call("save", { ...request, operationId: key + "-stale" });
        assert.equal(stale.status, "conflict");
        assert.deepEqual(stale.state, changed.state);
        await assert.rejects(
          f.call("save", {
            ...request,
            operationId: key + "-twice",
            expectedRevision: changed.revision,
            change: { ...change, out: change.ref, ref: change.out },
          }),
        );
        const forged = structuredClone(changed.state.inputs);
        delete forged.build.replacements;
        await assert.rejects(save(f, key, forged, changed.revision, "erase-history"));
        const next = structuredClone(changed.state.inputs);
        next.build.levels.push({ id: "next-" + classId, classId });
        const advanced = await save(f, key, next, changed.revision, "advance");
        assert.equal(allowance(advanced.evaluation, classId).remaining, 1);
        const returned = await f.call("save", {
          ...request,
          operationId: key + "-return",
          expectedRevision: advanced.revision,
          change: { ...change, out: change.ref, ref: change.out },
        });
        assert.equal(returned.state.inputs.build.replacements.length, 2);
        unchangedPlay(returned.state.inputs, initial.state.inputs);
      }
      const key = "class-replace-champion",
        initial = await seed(f, key, "fighter"),
        inputs = structuredClone(initial.state.inputs);
      inputs.build.levels = levels("fighter", 7);
      inputs.build.subclasses = { fighter: "champion" };
      inputs.build.choices.push({
        id: "champion-additional-fighting-style-feat",
        slot: 0,
        value: "defense",
      });
      const champion = await save(f, key, inputs, initial.revision, "champion");
      assert.deepEqual(
        champion.evaluation.guidance.classReplacements.map((row: Row) => row.key),
        ["fighter-fighting-style-feat"],
      );
      assert.equal(
        allowance(champion.evaluation, "fighter").options.some((row: Row) => row.id === "defense"),
        false,
        "Replacement cannot duplicate the Champion style",
      );
    },
  );

  for (const locale of ["en", "cs"])
    void test(
      "class replacements share keyboard controls, imports and reloads (" + locale + ")",
      { skip: !enabled, timeout: 90000 },
      async (t) => {
        const f = fixture(),
          cs = locale === "cs",
          classId = cs ? "ranger" : "fighter",
          key = "class-replace-ui-" + locale;
        const initial = await seed(f, key, classId),
          command = changeFor(classId);
        const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
        const labels = cs
          ? {
              current: "Současná volba",
              next: "Nová volba",
              apply: "Vyměnit volbu povolání",
              saved: /^Uloženo$/,
              replace: "Nahradit postavu",
            }
          : {
              current: "Current choice",
              next: "New choice",
              apply: "Replace class choice",
              saved: /^Saved$/,
              replace: "Replace character",
            };
        if (cs) {
          await sheet.locator("#dnd-tab-tools").click();
          await sheet.getByLabel("Rozložení deníku", { exact: true }).selectOption("classic");
          await sheet.locator("#dnd-tab-builder").click();
          await page.setViewportSize({ width: 390, height: 1000 });
          await page.addStyleTag({ content: "html { font-size:200% !important; }" });
        }
        await sheet.locator("#dnd-builder-tab-" + classId).click();
        const panel = sheet.locator(
          '[id="character-replacement-' +
            encodeURIComponent(command.kind + "/" + command.key) +
            '"]',
        );
        const pick = async (name: string, label: string) => {
          const control = panel.getByRole("combobox", { name, exact: true });
          await control.fill(label);
          await panel.getByRole("option", { name: label, exact: true }).waitFor();
          await control.press("ArrowDown");
          await control.press("Enter");
        };
        await pick(labels.current, cs ? "Guidance" : "Archery");
        await pick(labels.next, cs ? "Thorn Whip" : "Defense");
        const saved = page.waitForResponse(
          (response) =>
            response.url().endsWith("/services/call") &&
            response.request().postDataJSON()?.params?.change?.operation === "replace-class-choice",
        );
        await panel.getByRole("button", { name: labels.apply, exact: true }).press("Enter");
        assert.equal((await saved).ok(), true);
        await status.filter({ hasText: labels.saved }).waitFor();
        const spent = panel.locator('[data-focus-key$="/spent"]');
        await spent.waitFor();
        assert.equal(
          await spent.evaluate((node) => node === document.activeElement),
          true,
          "Completed replacement keeps keyboard focus on its result",
        );
        assert.equal(
          await panel.getByRole("button", { name: labels.apply, exact: true }).isDisabled(),
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        const replaced = await read();
        unchangedPlay(replaced.state.inputs, initial.state.inputs);
        assert.equal(allowance(replaced.evaluation, classId).remaining, 0);
        await page.screenshot({ path: resolve(f.output, key + ".png") });
        await sheet.locator("#dnd-tab-tools").click();
        const envelope = await exported(page, sheet, locale);
        assert.deepEqual(envelope.inputs, replaced.state.inputs);
        await review(sheet, locale, envelope, false);
        await sheet.getByRole("button", { name: labels.replace, exact: true }).click();
        await status.filter({ hasText: labels.saved }).waitFor();
        const imported = await read();
        assert.equal(imported.state.inputs.build.replacements[0].origin, "import");
        assert.equal(allowance(imported.evaluation, classId).remaining, 0);
        await page.reload();
        await page.locator("#character-view-addons").click();
        await sheet.locator("#dnd-tab-builder").click();
        await sheet.locator("#dnd-builder-tab-" + classId).click();
        await spent.waitFor();
        assert.equal(
          await panel.getByRole("button", { name: labels.apply, exact: true }).isDisabled(),
          true,
        );
        assert.deepEqual((await read()).state, imported.state);
        frozen.set(key, structuredClone(imported));
      },
    );
}

export async function verifyFrozenClassReplacements(t: TestContext, f: Fixture) {
  for (const [key, expected] of frozen) {
    const locale = key.endsWith("-cs") ? "cs" : "en",
      { close: closeSession, page, sheet, read } = await openBuilder(t, f, key, locale);
    const loaded = await read();
    assert.equal(loaded.status, "unavailable");
    assert.deepEqual(loaded.state, expected.state);
    await sheet.locator("#dnd-tab-tools").click();
    const envelope = await exported(page, sheet, locale);
    assert.deepEqual(envelope.inputs, expected.state.inputs);
    const popup = await printOutput(page, sheet, locale);
    assert.match(
      await popup.locator("body").innerText(),
      locale === "cs" ? /Thorn Whip/ : /Defense/,
    );
    await popup.close();
    assert.deepEqual((await read()).state, expected.state);
    await closeSession();
  }
}
