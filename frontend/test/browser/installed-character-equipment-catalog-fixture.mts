import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { openBuilder, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";
import { characterTab, inventoryView } from "./installed-character-navigation-fixture.mts";

export function registerEquipmentCatalogTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en", "cs"])
    void test(
      "Equipment catalog uses source folders and declared wearable placements (" + locale + ")",
      { skip: !enabled, timeout: 120000 },
      async (t) => {
        const f = fixture(),
          key = "equipment-catalog-" + locale;
        const initial = await readyCharacter(f, key);
        const { page, sheet, status, read } = await openBuilder(t, f, key, locale);
        const names =
          locale === "cs"
            ? {
                type: "Typ předmětu",
                find: "Najít předmět v katalogu",
                close: "Zavřít",
                move: "Přesunout: ",
                saved: /^Uloženo$/,
              }
            : {
                type: "Item type",
                find: "Find catalog item",
                close: "Close",
                move: "Move ",
                saved: /^Saved$/,
              };
        for (const layout of ["compact", "classic"]) {
          await characterTab(sheet, "tools");
          await sheet.getByLabel(/^(Sheet layout|Rozložení deníku)$/).selectOption(layout);
          await inventoryView(sheet);
          await sheet.locator('.dse-bp-head > button, [data-focus-key="pack/add"]').click();
          const picker = sheet.locator(".dnd-equipment-picker");
          await picker.getByLabel(names.type, { exact: true }).selectOption("armor");
          await page.screenshot({
            path: resolve(f.output, `catalog-folders-${locale}-${layout}-desktop.png`),
          });
          assert.deepEqual(
            await picker.locator(".dnd-equipment-folder").allTextContents(),
            locale === "cs"
              ? ["▸ Těžké zbroje", "▸ Lehké zbroje", "▸ Střední zbroje", "▸ Štíty"]
              : ["▸ Heavy armor", "▸ Light armor", "▸ Medium armor", "▸ Shields"],
          );
          const shield = picker.locator(".dnd-equipment-folder").last();
          await shield.focus();
          await shield.press("Enter");
          assert.equal(await picker.locator(".dnd-picker-results .dnd-picker-row").count(), 1);
          await picker.getByLabel(names.type, { exact: true }).selectOption("magic-item");
          const ring = picker.getByRole("button", { name: "▸ Ring", exact: true });
          await ring.focus();
          await ring.press("Enter");
          await picker.getByLabel(names.find, { exact: true }).fill("Ring of Protection");
          assert.equal(await picker.locator(".dnd-picker-results .dnd-picker-row").count(), 1);
          await picker.getByLabel(names.find, { exact: true }).fill("");
          await picker.locator(".dnd-equipment-path button").last().click();
          await picker.getByRole("button", { name: "▸ Armor (Shield)", exact: true }).click();
          assert.ok((await picker.locator(".dnd-picker-results .dnd-picker-row").count()) > 1);
          for (const width of [1360, 1024, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate((width) => {
              document.documentElement.style.fontSize = width < 500 ? "200%" : "";
              document.documentElement.dataset.theme =
                width === 1024 || width === 320 ? "moonlit" : "classic";
            }, width);
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
            );
            assert.ok(await picker.getByLabel(names.find, { exact: true }).isVisible());
          }
          await page.screenshot({
            path: resolve(f.output, `catalog-folders-${locale}-${layout}-phone.png`),
          });
          await sheet
            .getByRole("dialog")
            .getByRole("button", { name: names.close, exact: true })
            .click();
          assert.equal(
            (await read()).revision,
            initial.revision,
            "Browsing/cancel cannot write a character",
          );
          await page.setViewportSize({ width: 1360, height: 1000 });
          await page.evaluate(() => {
            document.documentElement.style.fontSize = "";
          });
        }
        const sources = [
          ["gear", "robe", "body"],
          ["magic-item", "wings-of-flying", "shoulders"],
          ["magic-item", "boots-of-the-winding-path", "feet"],
          ["gear", "devil-mask", "face"],
          ["magic-item", "crown-of-horns", "head"],
          ["magic-item", "harkons-bite", "neck"],
          ["magic-item", "reliquary-of-dawn", "other"],
        ];
        const input = initial.state.inputs;
        input.play.inventory = sources.map(([kind, id]) => ({
          id,
          name: "Owned " + id,
          reference: { kind, id },
          quantity: 1,
          location: "carried",
          attuned: false,
          acquisition: "Gift",
          notes: "Keep exact item",
        }));
        const carried = await save(f, key, input, initial.revision, "source-items");
        for (const [, id, placement] of sources) {
          assert.deepEqual(carried.evaluation.guidance.equipment[id!].bodyPlacements, [placement]);
          assert.deepEqual(carried.state.projection.sheet.equipment[id!].bodyPlacements, [
            placement,
          ]);
        }
        assert.equal(carried.evaluation.guidance.equipment["wings-of-flying"].canEquip, false);
        assert.equal(
          carried.evaluation.guidance.equipment["wings-of-flying"].equipReason,
          "mechanics",
        );
        assert.equal(carried.evaluation.guidance.equipment["robe"].canEquip, true);
        await page.reload();
        await page.locator("#character-view-addons").click();
        await inventoryView(sheet);
        await sheet
          .getByRole("combobox", { name: names.move + "Owned robe", exact: true })
          .selectOption("equipped");
        await status.filter({ hasText: names.saved }).waitFor();
        await sheet
          .locator('[data-focus-key="inventory/robe/body-placement"]')
          .selectOption("body");
        await status.filter({ hasText: names.saved }).waitFor();
        const worn = await read();
        assert.equal(worn.state.inputs.play.inventory[0].bodyPlacement, "body");
        assert.deepEqual(
          worn.state.projection.sheet.derived,
          carried.state.projection.sheet.derived,
        );
        await page.reload();
        await page.locator("#character-view-addons").click();
        await inventoryView(sheet);
        assert.equal(
          await sheet.locator('[data-focus-key="inventory/robe/body-placement"]').inputValue(),
          "body",
        );
        assert.deepEqual((await read()).state.inputs, worn.state.inputs);
      },
    );
}
