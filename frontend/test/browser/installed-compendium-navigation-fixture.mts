import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { Page } from "playwright";

interface Fixture {
  open(t: TestContext, role: string, mobile: boolean, locale: string): Promise<Page>;
  go(page: Page, query: string): Promise<void>;
  fits(page: Page): Promise<void>;
  output: string;
}

export function registerCompendiumNavigationTests(enabled: boolean, f: Fixture) {
  for (const locale of ["en", "cs"]) test("Compendium library stays reachable while reading long records (" + locale + ")",
    { skip: !enabled, timeout: 90000 }, async t => {
      const page = await f.open(t, "player", true, locale);
      for (const [kind, id] of [["class", "wizard"], ["monster", "aboleth"], ["spell", "wish"]]) {
        await f.go(page, "?kind=" + kind + "&id=" + id);
        if (locale === "cs") await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
        const pane = page.locator(".comp-reading-pane"), drawer = page.locator(".comp-tree-drawer"), summary = drawer.locator("summary");
        assert.equal(await drawer.evaluate((node: HTMLDetailsElement) => node.open), false);
        const visible = async () => {
          const rect = await summary.boundingBox();
          assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= 844, "Library control must be reachable without scrolling past the record: " + JSON.stringify(await summary.evaluate(node => { const chain = []; for (let current: Element | null = node; current; current = current.parentElement) { const style = getComputedStyle(current), rect = current.getBoundingClientRect(); chain.push({ tag: current.localName, cls: current.className, top: rect.top, height: rect.height, overflow: style.overflow, position: style.position, inset: style.top }); } return chain; })));
        };
        await visible();
        await pane.locator("article").evaluate(node => node.setAttribute("data-reading-retained", "yes"));
        await pane.locator("article").evaluate(node => {
          const top = node.getBoundingClientRect().top + scrollY;
          scrollTo(0, top + Math.min(650, node.clientHeight / 2));
        });
        await visible();
        const url = page.url(), before = await pane.locator("article").boundingBox();
        await summary.press("Enter");
        await drawer.locator('[data-tree-mode="sources"]').press("Enter");
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-tree-mode") === "sources");
        assert.equal(await pane.locator("article").getAttribute("data-reading-retained"), "yes", "Changing library organization must retain the reading DOM");
        const disclosure = drawer.locator('[data-tree-node][aria-expanded="true"]').first();
        const node = await disclosure.getAttribute("data-tree-node"); await disclosure.press("Enter");
        assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.treeNode), node);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-expanded")), "false", "The current record\u0027s automatically opened branch must still collapse");
        assert.equal(await pane.locator("article").getAttribute("data-reading-retained"), "yes");
        assert.equal(await drawer.locator(".comp-tree-panel").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, "The library panel must not hide horizontal overflow");
        assert.equal(await drawer.locator(".comp-tree-row").evaluateAll(rows => rows.every(row => {
          const label = row.querySelector<HTMLElement>(".comp-tree-label")!, count = row.querySelector<HTMLElement>(".comp-tree-count")!;
          const a = label.getBoundingClientRect(), b = count.getBoundingClientRect();
          return label.scrollWidth <= label.clientWidth + 1 && (!count.textContent || a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        })), true, "Long titles and counts must wrap without overlap");
        if (kind === "class") await page.screenshot({ path: resolve(f.output, "library-open-" + locale + ".png") });
        assert.equal(page.url(), url);
        const after = await pane.locator("article").boundingBox();
        assert.ok(before && after && Math.abs(before.y - after.y) < 2, "Opening and organizing the library must preserve reading position");
        await drawer.locator('[data-tree-mode="sources"]').press("Escape");
        assert.equal(await drawer.evaluate((node: HTMLDetailsElement) => node.open), false);
        assert.equal(await summary.evaluate(node => document.activeElement === node), true);
        await visible(); await f.fits(page);
        await page.screenshot({ path: resolve(f.output, "long-reading-" + kind + "-" + locale + ".png") });
      }
      const drawer = page.locator(".comp-tree-drawer"), summary = drawer.locator("summary");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await drawer.locator("nav").waitFor({ state: "visible" });
      assert.equal(await drawer.evaluate((node: HTMLDetailsElement) => node.open), true, "Desktop library must open after a phone resize");
      await drawer.locator('[data-tree-mode="domains"]').focus();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => !document.querySelector<HTMLDetailsElement>(".comp-tree-drawer")?.open);
      assert.equal(await summary.evaluate(node => document.activeElement === node), true, "Resize must not leave focus inside hidden navigation");
      await summary.press("Space");
      await summary.press("Tab");
      assert.equal(await drawer.locator("nav").evaluate(node => node.contains(document.activeElement)), true);
      // Leaving the disclosure returns the space to the reading content.
      await page.locator(".comp-reading-pane .comp-breadcrumb a").first().focus();
      await page.waitForFunction(() => !document.querySelector<HTMLDetailsElement>(".comp-tree-drawer")?.open);
      await f.fits(page);
    });
}
