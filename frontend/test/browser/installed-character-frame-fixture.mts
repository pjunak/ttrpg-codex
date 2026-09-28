import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { openSheet, save, type Fixture } from "./installed-character-builder-fixture.mts";
import { readyCharacter } from "./installed-character-command-fixture.mts";

export function registerCompactFrameTests(enabled: boolean, fixture: () => Fixture): void {
  for (const locale of ["en", "cs"])
    void test(
      "Compact frame sizes unvisited tabs without duplicate controls (" + locale + ")",
      { skip: !enabled, timeout: 120000 },
      async (t) => {
        const f = fixture(),
          key = "compact-frame-" + locale,
          initial = await readyCharacter(f, key),
          input = initial.state.inputs;
        input.play.containers = Array.from({ length: 18 }, (_, index) => ({
          id: "container-" + index,
          name: "Expedition supplies " + (index + 1),
        }));
        const stored = await save(f, key, input, initial.revision, "containers");
        const { page, sheet, read } = await openSheet(t, f, key, locale);
        assert.equal(await sheet.getAttribute("lang"), locale);
        await sheet
          .getByLabel(locale === "cs" ? "Aktuální životy" : "Current HP", { exact: true })
          .waitFor();
        await page.evaluate(() => {
          const probe = {
            stages: 0,
            unsafe: 0,
            resolutions: 0,
            duplicates: 0,
            milliseconds: 0,
            contexts: [] as unknown[],
          };
          Object.assign(window, { frameProbe: probe });
          const root = document.querySelector(".addon-dnd-character")!;
          root.addEventListener(
            "click",
            (event) => {
              if (event.target instanceof Element && event.target.closest(".dnd-sheet-tabs"))
                (root as HTMLElement).dataset.tabScroll = String(scrollY);
            },
            { capture: true },
          );
          let started = 0;
          new MutationObserver((records) => {
            for (const record of records) {
              for (const node of record.addedNodes)
                if (node instanceof HTMLElement && node.matches(".dnd-frame-measure")) {
                  probe.stages++;
                  const shell = node.closest<HTMLElement>(".dnd-sheet-shell")!;
                  probe.contexts.push({
                    tab: shell.querySelector(".dnd-sheet-tabs [aria-selected=true]")?.id,
                    width: node.parentElement!.getBoundingClientRect().width,
                    font: getComputedStyle(shell).font,
                  });
                  started = performance.now();
                  if (!node.inert || node.getAttribute("aria-hidden") !== "true") probe.unsafe++;
                }
              for (const node of record.removedNodes)
                if (node instanceof HTMLElement && node.matches(".dnd-frame-measure"))
                  probe.milliseconds += performance.now() - started;
            }
            const ids = [...root.querySelectorAll("[id]")].map((node) => node.id);
            if (new Set(ids).size !== ids.length) probe.duplicates++;
          }).observe(root, { subtree: true, childList: true });
          root.addEventListener("codex-rule-details-resolve", (event) => {
            if (event.target instanceof Element && event.target.closest(".dnd-frame-measure"))
              probe.resolutions++;
          });
        });
        const probe = () =>
          page.evaluate(
            () =>
              (
                window as typeof window & {
                  frameProbe: {
                    stages: number;
                    unsafe: number;
                    resolutions: number;
                    duplicates: number;
                    milliseconds: number;
                  };
                }
              ).frameProbe,
          );
        const settle = () =>
          page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            );
          });
        const dimensions = () =>
          sheet.locator(".dnd-sheet-shell").evaluate((node) => ({
            height: node.getBoundingClientRect().height,
            width: node.getBoundingClientRect().width,
            content: node.querySelector(".dnd-sheet-panel")!.getBoundingClientRect().height,
            panels: node.querySelectorAll(".dnd-sheet-panel").length,
            natural:
              getComputedStyle(node.querySelector(".dnd-sheet-workspace")!).minHeight === "0px",
          }));
        await page.setViewportSize({ width: 1360, height: 1000 });
        await settle();
        const first = await dimensions();
        const initialProbe = await probe();
        assert.ok(initialProbe.stages > 0, "Width change measures the unvisited views");
        await page.screenshot({
          path: resolve(f.output, "compact-frame-first-" + locale + ".png"),
          fullPage: true,
        });
        const navigationProbe = await probe();
        const visits = [first];
        for (const tab of ["equipment", "combat", "spells", "builder", "tools", "sheet"]) {
          await sheet.locator("#dnd-tab-" + tab).click();
          await settle();
          const current = await dimensions();
          assert.ok(
            await sheet.evaluate(
              (node) => Math.abs(scrollY - Number((node as HTMLElement).dataset.tabScroll)) <= 1,
            ),
            "Changing tabs preserves the scroll position established by the click",
          );
          visits.push(current);
          assert.equal(current.panels, 1, "Only the current editable panel stays mounted");
          assert.ok(current.content <= current.height, "Content is not clipped by frame sizing");
          if (tab === "builder") {
            const destinations = await sheet
              .locator(".dnd-builder-tabs [role=tab]")
              .evaluateAll((nodes) => nodes.map((node) => node.id));
            for (const id of destinations) {
              await sheet.locator("#" + id).click();
              await settle();
              visits.push(await dimensions());
            }
          }
        }
        assert.equal(
          (await probe()).stages,
          navigationProbe.stages,
          "Tab navigation reuses measured geometry",
        );
        await page.screenshot({
          path: resolve(f.output, "compact-frame-return-" + locale + ".png"),
          fullPage: true,
        });
        t.diagnostic("First-visit frames: " + JSON.stringify(visits));
        assert.ok(
          Math.max(...visits.map((frame) => frame.height)) -
            Math.min(...visits.map((frame) => frame.height)) <=
            1,
          "First visits preserve the initial frame: " + JSON.stringify(visits),
        );
        t.diagnostic("Initial sizing lifecycle: " + JSON.stringify(await probe()));
        const interim = await read();
        assert.deepEqual(interim.state.inputs, stored.state.inputs);
        assert.equal(interim.revision, stored.revision);
        const hp = sheet.getByLabel(locale === "cs" ? "Aktuální životy" : "Current HP", {
          exact: true,
        });
        await hp.focus();
        await page.setViewportSize({ width: 1232, height: 1000 });
        await settle();
        assert.equal(
          await hp.evaluate((node) => node === document.activeElement),
          true,
          "Resizing does not replace the focused input",
        );
        for (const [width, fontSize, theme] of [
          [1232, "", "moonlit"],
          [1224, "", "moonlit"],
          [1360, "125%", "classic"],
          [1024, "", "moonlit"],
          [390, "200%", "classic"],
          [320, "200%", "moonlit"],
          [1360, "", "classic"],
        ] as const) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(
            ({ fontSize, theme }) => {
              document.documentElement.style.fontSize = fontSize;
              document.documentElement.dataset.theme = theme;
            },
            { fontSize, theme },
          );
          await settle();
          const frames = [await dimensions()];
          for (const tab of ["combat", "equipment", "builder", "tools", "sheet"]) {
            await sheet.locator("#dnd-tab-" + tab).click();
            await settle();
            frames.push(await dimensions());
          }
          if (!frames[0]!.natural)
            assert.ok(
              Math.max(...frames.map((frame) => frame.height)) -
                Math.min(...frames.map((frame) => frame.height)) <=
                1,
              JSON.stringify({ width, fontSize, theme, frames }),
            );
          else
            assert.ok(
              new Set(frames.map((frame) => frame.height)).size > 1,
              "Phone panels keep natural document height",
            );
          assert.ok(frames.every((frame) => frame.panels === 1 && frame.content <= frame.height));
          await page.screenshot({
            path: resolve(f.output, `compact-frame-${locale}-${width}-${fontSize || "100"}.png`),
            fullPage: true,
          });
        }
        const finalProbe = await probe();
        assert.equal(
          finalProbe.unsafe + finalProbe.resolutions + finalProbe.duplicates,
          0,
          JSON.stringify(finalProbe),
        );
        assert.equal(await sheet.locator(".dnd-frame-measure,[id^=measure-]").count(), 0);
        assert.equal(
          await sheet.locator("[data-codex-ui]").count(),
          0,
          "Temporary control handles are disposed",
        );
        t.diagnostic("Sizing lifecycle: " + JSON.stringify(finalProbe));
        await sheet.locator("#dnd-tab-tools").click();
        await sheet.locator("select").selectOption("classic");
        await sheet.locator("#dnd-tab-sheet").click();
        await settle();
        const classic = await dimensions();
        assert.equal(await sheet.getAttribute("data-layout"), "classic");
        assert.equal(await sheet.locator(".dnd-frame-measure").count(), 0);
        assert.equal(
          (await probe()).stages,
          finalProbe.stages,
          "Classic does not measure Compact panels",
        );
        await sheet.locator("#dnd-tab-combat").click();
        await settle();
        assert.notEqual(
          (await dimensions()).height,
          classic.height,
          "Classic retains its own layout",
        );
        await sheet.locator("#dnd-tab-tools").click();
        await sheet.locator("select").selectOption("compact");
        await sheet.locator("#dnd-tab-sheet").click();
        await settle();
        const collapsed = await dimensions();
        await sheet.locator("details[data-details-key]").evaluateAll((nodes) => {
          for (const node of nodes) (node as HTMLDetailsElement).open = true;
        });
        await settle();
        const expanded = await dimensions();
        assert.ok(
          expanded.height >= collapsed.height && expanded.content <= expanded.height,
          "Expanded content remains unclipped",
        );
        await sheet.locator("#dnd-tab-combat").click();
        await sheet.locator("#dnd-tab-sheet").click();
        assert.equal(
          await sheet.locator("details[data-details-key]:not([open])").count(),
          0,
          "Sizing preserves disclosure state",
        );
        const current = await read();
        assert.deepEqual(current.state.inputs, stored.state.inputs);
        assert.equal(current.revision, stored.revision, "Sizing and navigation do not save data");
      },
    );
}
