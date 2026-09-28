import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { openBuilder, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";
import { exported, printOutput, review } from "./installed-character-output-fixture.mts";

const frozen = new Map<string, Awaited<ReturnType<Fixture["call"]>>>();
const control = (hand: string) => '[data-focus-key="hands/' + hand + '"]';
const savedText = (locale: string) => (locale === "cs" ? /^Uloženo$/ : /^Saved$/);
async function seed(f: Fixture, key: string) {
  const ready = await readyCharacter(f, key),
    inputs = ready.state.inputs;
  const item = (id: string, kind: string, ref: string, location = "equipped") => ({
    id,
    name: "Personal " + id,
    reference: { kind, id: ref },
    quantity: 1,
    location,
    attuned: false,
    acquisition: "Reward",
    notes: "Keep " + id,
  });
  inputs.play.inventory = [
    item("blade", "weapon", "longsword"),
    item("shield", "armor", "shield"),
    item("spare", "weapon", "longsword", "stored"),
    { ...item("ring", "magic-item", "ring-of-protection"), attuned: true },
  ];
  inputs.play.inspiration = true;
  inputs.play.currency = { cp: 1, sp: 2, ep: 3, gp: 4, pp: 5 };
  inputs.play.quickUse = ["spare"];
  return save(f, key, inputs, ready.revision, "items");
}
async function configure(f: Fixture, key: string) {
  let current = await seed(f, key);
  for (const [hand, itemId] of [
    ["main", "blade"],
    ["off", "shield"],
  ])
    current = await f.call("save", {
      key,
      operation: "play",
      operationId: key + "-" + hand,
      summary: "Choose hand item",
      expectedRevision: current.revision,
      change: { operation: "set-hand", hand, itemId },
    });
  assert.equal(current.status, "ready");
  return current;
}
export function registerHandsTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en", "cs"])
    void test(
      "Hand controls preserve suspension, saved effects and output (" + locale + ")",
      { skip: !enabled, timeout: 120000 },
      async (t) => {
        const f = fixture(),
          key = "hands-" + locale,
          initial = await seed(f, key);
        assert.equal(initial.state.inputs.play.hands, undefined);
        const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
        await sheet.locator("#dnd-tab-sheet").click();
        for (const [hand, id] of [
          ["main", "blade"],
          ["off", "shield"],
        ]) {
          const select = sheet.locator(control(hand!));
          await select.focus();
          await select.selectOption(id!);
          await status.filter({ hasText: savedText(locale) }).waitFor();
          assert.equal(await select.inputValue(), id);
          assert.equal(await select.evaluate((node) => node === document.activeElement), true);
        }
        const one = await read();
        const grip = sheet.locator(control("grip"));
        const gripName = await grip.innerText();
        assert.equal(await grip.getAttribute("aria-pressed"), "false");
        await grip.focus();
        await grip.press("Enter");
        await status.filter({ hasText: savedText(locale) }).waitFor();
        assert.equal(await grip.getAttribute("aria-pressed"), "true");
        assert.equal(await grip.innerText(), gripName);
        assert.equal(await grip.evaluate((node) => node === document.activeElement), true);
        let current = await read();
        assert.equal(current.state.inputs.play.hands.suspendedOff.itemId, "shield");
        assert.equal(current.state.inputs.play.inventory[1].location, "carried");
        assert.equal(current.state.inputs.play.inventory[3].attuned, true);
        assert.equal(
          current.state.projection.sheet.derived.armorClass,
          one.state.projection.sheet.derived.armorClass - 2,
        );
        const weapon = current.state.projection.sheet.weapons.find(
          (row: Record<string, unknown>) => row.itemId === "blade",
        );
        assert.match(weapon.damage, /^1d10/);
        assert.equal(
          current.state.projection.explanations["weapons.0.damage"].value,
          weapon.damage,
        );
        assert.equal(await sheet.locator(control("off")).isDisabled(), true);
        assert.match(await sheet.locator(".dse-hand-suspended").innerText(), /Personal shield/);
        assert.equal(
          await sheet.locator(".dse-hand-attack").count(),
          0,
          "Sheet omits attack numbers",
        );
        await sheet.locator("#dnd-tab-combat").click();
        await sheet
          .locator(".dse-hand-attack")
          .getByRole("button", { name: weapon.damage, exact: true })
          .waitFor();
        for (const layout of ["compact", "classic"]) {
          await sheet.locator("#dnd-tab-tools").click();
          await sheet
            .getByRole("combobox", {
              name: locale === "cs" ? "Rozložení deníku" : "Sheet layout",
              exact: true,
            })
            .selectOption(layout);
          await sheet.locator("#dnd-tab-sheet").click();
          for (const width of [1360, 1024, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(
              ({ width, layout }) => {
                document.documentElement.style.fontSize = width < 500 ? "200%" : "";
                document.documentElement.dataset.theme =
                  layout === "compact" ? "classic" : "moonlit";
              },
              { width, layout },
            );
            await grip.scrollIntoViewIfNeeded();
            assert.ok((await grip.boundingBox())!.height >= 40);
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
            );
            if (width === 1360 || width === 320)
              await page.screenshot({
                path: resolve(f.output, `hands-${locale}-${layout}-${width}.png`),
              });
          }
        }
        await page.setViewportSize({ width: 1360, height: 1000 });
        await page.evaluate(() => (document.documentElement.style.fontSize = ""));
        await page.reload();
        await page.locator("#character-view-addons").click();
        await sheet.locator("#dnd-tab-sheet").click();
        assert.equal((await read()).state.inputs.play.hands.suspendedOff.itemId, "shield");
        await grip.click();
        await status.filter({ hasText: savedText(locale) }).waitFor();
        current = await read();
        assert.deepEqual(current.state.inputs.play.inventory, one.state.inputs.play.inventory);
        assert.deepEqual(current.state.inputs.play.hands, one.state.inputs.play.hands);
        await grip.click();
        await status.filter({ hasText: savedText(locale) }).waitFor();
        current = await read();
        await sheet.locator("#dnd-tab-tools").click();
        const transfer = await exported(page, sheet, locale);
        assert.deepEqual(transfer.inputs.play, current.state.inputs.play);
        transfer.inputs.notes = "Transfer retains suspended identity";
        await review(sheet, locale, transfer, false);
        await sheet
          .getByRole("button", {
            name: locale === "cs" ? "Nahradit postavu" : "Replace character",
            exact: true,
          })
          .click();
        await status.filter({ hasText: savedText(locale) }).waitFor();
        current = await read();
        assert.deepEqual(current.state.inputs.play.hands, transfer.inputs.play.hands);
        const popup = await printOutput(page, sheet, locale);
        assert.match(
          await popup.locator("body").innerText(),
          locale === "cs"
            ? /Odložená vedlejší ruka: Personal shield/
            : /Suspended off hand: Personal shield/,
        );
        await popup.close();
        frozen.set(key, current);
      },
    );
  void test(
    "Hand commands retain exact lost replies and refuse stale restoration",
    { skip: !enabled, timeout: 90000 },
    async (t) => {
      const f = fixture(),
        key = "hands-retry",
        initial = await configure(f, key),
        { page, sheet, status, read } = await openBuilder(t, f, key);
      await sheet.locator("#dnd-tab-sheet").click();
      const writes: Record<string, any>[] = [];
      await page.route("**/services/call", async (route) => {
        const body = route.request().postDataJSON();
        if (body?.method !== "save") {
          await route.continue();
          return;
        }
        writes.push(body.params);
        if (writes.length === 1) {
          assert.equal((await route.fetch()).ok(), true);
          await route.abort("failed");
        } else await route.continue();
      });
      await sheet.locator(control("grip")).click();
      await status.getByRole("button", { name: "Retry", exact: true }).click();
      await status.filter({ hasText: /^Saved$/ }).waitFor();
      assert.deepEqual(writes[1], writes[0]);
      assert.equal((await read()).revision, initial.revision + 1);
      await page.unroute("**/services/call");
      let current = await read();
      current.state.inputs.play.inventory[1].location = "stored";
      current.state.inputs.play.inventory[1].notes = "Moved by another editor";
      current = await save(f, key, current.state.inputs, current.revision, "moved");
      await page.reload();
      await page.locator("#character-view-addons").click();
      await sheet.locator("#dnd-tab-sheet").click();
      await sheet.locator(control("grip")).click();
      await status.filter({ hasText: /^Saved$/ }).waitFor();
      let after = await read();
      assert.equal(after.state.inputs.play.hands.off, "");
      assert.equal(after.state.inputs.play.inventory[1].location, "stored");
      assert.equal(after.state.inputs.play.inventory[1].notes, "Moved by another editor");
      assert.match(await sheet.locator("[data-hands]").innerText(), /moved or edited/);
      after = await f.call("save", {
        key,
        operation: "play",
        operationId: key + "-off-again",
        summary: "Select shield",
        expectedRevision: after.revision,
        change: { operation: "set-hand", hand: "off", itemId: "shield" },
      });
      assert.equal(after.status, "ready");
      after = await f.call("save", {
        key,
        operation: "play",
        operationId: key + "-two-again",
        summary: "Use two hands",
        expectedRevision: after.revision,
        change: { operation: "set-grip", grip: "two" },
      });
      after.state.inputs.play.inventory = after.state.inputs.play.inventory.filter(
        (item: Record<string, unknown>) => item.id !== "shield",
      );
      after = await save(f, key, after.state.inputs, after.revision, "remove");
      const result = await f.call("save", {
        key,
        operation: "play",
        operationId: key + "-release-missing",
        summary: "Release grip",
        expectedRevision: after.revision,
        change: { operation: "set-grip", grip: "one" },
      });
      assert.equal(result.status, "ready");
      assert.equal(result.state.inputs.play.hands.off, "");
      assert.equal(
        result.state.inputs.play.inventory.some(
          (item: Record<string, unknown>) => item.id === "shield",
        ),
        false,
      );
      assert.equal(result.state.projection.sheet.hands.restoreReason, "missing");
    },
  );
}
export async function verifyFrozenHands(t: TestContext, f: Fixture): Promise<void> {
  for (const [key, saved] of frozen) {
    const locale = key.endsWith("-cs") ? "cs" : "en",
      { close: closeSession, page, sheet, read } = await openBuilder(t, f, key, locale);
    try {
      const current = await read();
      assert.equal(current.status, "unavailable");
      assert.deepEqual(current.state, saved.state);
      await sheet.locator("#dnd-tab-sheet").click();
      assert.equal(await sheet.locator(control("grip")).count(), 0);
      assert.match(await sheet.locator(".dse-hand-suspended").innerText(), /Personal shield/);
      await sheet.locator("#dnd-tab-tools").click();
      assert.deepEqual((await exported(page, sheet, locale)).inputs.play, saved.state.inputs.play);
      const popup = await printOutput(page, sheet, locale);
      assert.match(await popup.locator("body").innerText(), /Personal shield/);
      await popup.close();
    } finally {
      await closeSession();
    }
  }
}
