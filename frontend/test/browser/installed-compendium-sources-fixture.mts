import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { APIRequestContext, Page } from "playwright";
import { jsonResponse } from "./installed-graph-fixture.mts";

interface Source { addonId: string; setId: string; id: string; enabled: boolean }
interface Fixture {
  admin: APIRequestContext;
  csrf: string;
  output: string;
  open(t: TestContext, role: string, mobile: boolean, locale: string): Promise<Page>;
  go(page: Page, query: string): Promise<void>;
  fits(page: Page): Promise<void>;
}
const reprints = [
  { kind: "species", id: "dhampir", name: "Dhampir", canonical: "rhw", reprint: "aboh" },
  { kind: "monster", id: "domestic-wonder", name: "Domestic Wonder", canonical: "hof", reprint: "aif" },
  { kind: "magic-item", id: "windskiff", name: "Windskiff", canonical: "hof", reprint: "aif" },
] as const;

async function setSources(f: Fixture, ids: readonly string[]) {
  const policy = await jsonResponse(await f.admin.get("/api/admin/rules-policy"));
  const sources = policy.sources as Source[];
  assert.ok(ids.every(id => sources.some(source => source.id === id)), "Use known source IDs");
  await jsonResponse(await f.admin.post("/api/admin/rules-policy", {
    headers: { "X-Codex-CSRF": f.csrf }, data: {
      expectedRevision: policy.revision, expectedGraphRevision: policy.graphRevision,
      enabled: sources.filter(source => ids.includes(source.id)).map(({ addonId, setId, id }) => ({ addonId, setId, id })),
    },
  }));
}
async function restoreSources(t: TestContext, f: Fixture) {
  const initial = await jsonResponse(await f.admin.get("/api/admin/rules-policy"));
  const ids = (initial.sources as Source[]).filter(source => source.enabled).map(source => source.id);
  t.after(() => setSources(f, ids));
}
function routeQuery(kind: string, id = "", book = "", q = "") {
  const query = new URLSearchParams({ kind });
  if (id) query.set("id", id);
  if (book) query.set("book", book);
  if (q) query.set("q", q);
  return "?" + query;
}

export function registerCompendiumSourceTests(enabled: boolean, fixture: () => Fixture) {
  test("Shared rule details wait for settled hover and cancel pending previews",
    { skip: !enabled, timeout: 45000 }, async t => {
      const f = fixture(), page = await f.open(t, "player", false, "en");
      await f.go(page, "?q=Domestic%20Wonder");
      const pane = page.locator(".comp-reading-pane");
      const item = pane.locator("codex-addon-rule-details").filter({ has: page.getByRole("button", { name: "Details for Domestic Mechanical Wonder", exact: true }) });
      const monster = pane.locator("codex-addon-rule-details").filter({ has: page.getByRole("button", { name: "Details for Domestic Wonder", exact: true }) });
      await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
      await item.getByRole("button").hover();
      await page.clock.runFor(250);
      assert.equal(await item.getByRole("dialog").isVisible(), false, "Crossing a trigger must not immediately obscure its neighbors");
      await page.mouse.move(0, 0); await page.clock.runFor(100);
      assert.equal(await item.getByRole("dialog").isVisible(), false, "Leaving cancels the pending preview");
      await item.getByRole("button").hover(); await page.clock.runFor(300);
      await item.getByRole("dialog").waitFor();
      await item.getByRole("dialog").hover(); await page.clock.runFor(300);
      assert.equal(await item.getByRole("dialog").isVisible(), true, "A settled preview remains hoverable");
      await page.keyboard.press("Escape"); await item.getByRole("dialog").waitFor({ state: "hidden" });
      await page.mouse.move(0, 0);
      await monster.getByRole("button").click();
      await monster.getByRole("heading", { name: "Domestic Wonder", exact: true }).waitFor();
      await page.clock.runFor(1000);
      assert.equal(await monster.getByRole("dialog").isVisible(), true, "Click pins without a hover delay");
      await page.keyboard.press("Escape"); await monster.getByRole("dialog").waitFor({ state: "hidden" });
      await pane.locator("[data-compendium-search]").focus();
      await item.getByRole("button").focus();
      assert.equal(await item.getByRole("dialog").isVisible(), true, "Keyboard focus remains immediate");
      await page.keyboard.press("Escape");
      await pane.locator("[data-compendium-search]").focus();
      await item.getByRole("button").hover();
      await f.go(page, "?kind=spell&id=shield");
      await page.clock.runFor(500);
      assert.equal(await page.getByRole("dialog").count(), 0, "Navigation disposes pending previews");
    });

  for (const locale of ["en", "cs"]) {
    test("Compendium source policy preserves canonical reprints and usable filters (" + locale + ")",
      { skip: !enabled, timeout: 120000 }, async t => {
        const f = fixture();
        await restoreSources(t, f);
        const page = await f.open(t, "player", locale === "cs", locale);
        const pane = page.locator(".comp-reading-pane");
        const notFound = locale === "cs" ? "Nenalezeno" : "Not found";
        for (const sources of [["rhw", "hof"], ["aboh", "aif"], ["rhw", "hof", "aboh", "aif"], []]) {
          await f.go(page, routeQuery("species", "dhampir"));
          const url = page.url();
          await page.locator(".dnd-compendium").evaluate(node => node.setAttribute("data-policy-probe", ""));
          await setSources(f, ["phb", ...sources]);
          await page.locator("[data-policy-probe]").waitFor({ state: "detached" });
          await pane.getByRole("heading", { level: 1 }).waitFor();
          assert.equal(page.url(), url, "A policy refresh preserves the requested typed route");
          await pane.getByRole("heading", { level: 1, name: sources.length ? /Dhampir/u : notFound }).waitFor();

          const drawer = page.locator(".comp-tree-drawer");
          if (!await drawer.evaluate((node: HTMLDetailsElement) => node.open)) await drawer.locator("summary").click();
          await drawer.locator('[data-tree-mode="sources"]').click();
          const books = await drawer.locator(".comp-tree > li > .comp-tree-row > a").evaluateAll(nodes =>
            nodes.map(node => new URLSearchParams((node as HTMLAnchorElement).hash.split("?")[1]).get("id")));
          assert.deepEqual(books.sort(), ["phb", ...sources].sort(), "The source library uses exactly the enabled book catalog");
          if (locale === "cs") await drawer.locator("summary").click();

          for (const record of reprints) {
            const eligible = sources.includes(record.canonical) || sources.includes(record.reprint);
            await f.go(page, routeQuery(record.kind, record.id));
            await pane.getByRole("heading", { level: 1, name: eligible ? new RegExp(record.name, "u") : notFound }).waitFor();
            if (eligible) {
              const links = await pane.locator(".codex-badge-row a").evaluateAll(nodes => nodes.map(node =>
                new URLSearchParams((node as HTMLAnchorElement).hash.split("?")[1]).get("id")));
              assert.deepEqual(links, [record.canonical, record.reprint].filter(id => sources.includes(id)),
                "Only enabled books should be linked; unavailable provenance stays plain text");
              for (const id of [record.canonical, record.reprint].filter(id => !sources.includes(id))) {
                assert.match(await pane.locator(".codex-badge-row").innerText(), new RegExp(id + ".*" + (locale === "cs" ? "nedostupná" : "unavailable"), "u"));
              }
            }
            await f.go(page, "?q=" + encodeURIComponent(record.name));
            // The row's direct label is unique even when its name also occurs in other records' prose.
            const exactLink = pane.locator(".codex-list-copy").filter({ has: page.getByText(record.name, { exact: true }) });
            assert.equal(await exactLink.count(), eligible ? 1 : 0, "Cross-kind search must not duplicate reprints");
            if (eligible) {
              assert.match((await exactLink.getAttribute("href"))!, new RegExp("kind=" + record.kind + "&id=" + record.id, "u"));
              const detail = exactLink.locator("..").locator("codex-addon-rule-details");
              try { await detail.getByRole("button").click(); }
              catch (error) {
                await page.screenshot({ path: resolve(f.output, "source-details-blocked-" + locale + ".png") });
                const bounds = await pane.locator(".codex-link-row").evaluateAll(rows => rows.map(row => ({ text: row.textContent?.slice(0, 65), row: row.getBoundingClientRect().toJSON(), details: row.querySelector("codex-addon-rule-details")?.getBoundingClientRect().toJSON() })));
                throw new Error(String(error) + "\n" + JSON.stringify(bounds));
              }
              const full = detail.getByRole("link", { name: locale === "cs" ? "Otevřít úplné pravidlo" : "Open full rule", exact: true });
              await full.waitFor();
              assert.match((await full.getAttribute("href"))!, new RegExp("kind=" + record.kind + "&id=" + record.id, "u"));
              await page.keyboard.press("Escape");
            }
            for (const book of [record.canonical, record.reprint]) {
              await f.go(page, routeQuery(record.kind, "", book, record.name));
              const result = pane.locator(".codex-list-copy").filter({ has: page.getByText(record.name, { exact: true }) });
              assert.equal(await result.count(), sources.includes(book) ? 1 : 0, "Book browsing requires an enabled book");
              const filter = pane.locator('[data-filter="book"]');
              assert.equal(await filter.inputValue(), book, "Retain the requested source so the user can repair it");
              const offered = await filter.locator("option").evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value).filter(Boolean));
              assert.ok(offered.every(id => id === book || id === "phb" || sources.includes(id)), "Do not offer disabled books through alternate membership");
              if (!sources.includes(book)) {
                assert.match(await filter.locator("option:checked").innerText(), / \(0\)$/u);
                await pane.locator('[data-ui-state="empty"]').filter({ hasText: locale === "cs" ? "Vyberte jinou" : "Choose another" }).waitFor();
                await filter.selectOption("");
                assert.equal(await pane.locator(".codex-list-copy").filter({ has: page.getByText(record.name, { exact: true }) }).count(), eligible ? 1 : 0);
              }
            }
          }
          await f.go(page, routeQuery("book", "hof"));
          await pane.getByRole("heading", { level: 1, name: sources.includes("hof") ? /Heroes of Faer/u : notFound }).waitFor();
          if (sources.includes("hof")) {
            await pane.locator('a.codex-link-tile[href*="kind=monster"]').click();
            assert.equal(await pane.locator('[data-filter="book"]').inputValue(), "hof", "Book to kind navigation retains its source");
          }
          await f.go(page, routeQuery("monster", "", "missing-source", "Domestic Wonder"));
          await pane.locator('[data-ui-state="empty"]').waitFor();
          assert.equal(await pane.locator(".codex-link-row").count(), 0);
          if (locale === "cs") await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
          await f.fits(page);
          if (!sources.length) {
            await pane.locator('[data-ui-state="empty"]').scrollIntoViewIfNeeded();
            await page.screenshot({ path: resolve(f.output, "source-unavailable-" + locale + ".png") });
          }
        }
      });

    test("Compendium Core Traits render as readable tables (" + locale + ")",
      { skip: !enabled, timeout: 60000 }, async t => {
        const f = fixture(), page = await f.open(t, "player", true, locale);
        if (locale === "cs") await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
        for (const [id, name, die] of [
          ["barbarian", "Barbarian", "D12"], ["cleric", "Cleric", "D8"], ["druid", "Druid", "D8"],
          ["monk", "Monk", "D8"], ["sorcerer", "Sorcerer", "D6"], ["warlock", "Warlock", "D8"], ["wizard", "Wizard", "D6"],
        ]) {
          await f.go(page, routeQuery("class", id));
          const pane = page.locator(".comp-reading-pane");
          await pane.getByRole("heading", { name: "Core " + name + " Traits", exact: true }).waitFor();
          const table = pane.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Trait", exact: true }) });
          assert.equal(await table.count(), 1);
          assert.equal(await table.getByRole("row").count(), ["druid", "monk"].includes(id!) ? 9 : 8);
          await table.getByRole("row").filter({ has: page.getByRole("cell", { name: "Hit Point Die", exact: true }) })
            .getByRole("cell", { name: die + " per " + name + " level", exact: true }).waitFor();
          assert.equal(await pane.locator(".md-view p").filter({ hasText: /^\s*\|\s*$/u }).count(), 0);
          const scroll = table.locator("..");
          assert.equal(await scroll.getAttribute("tabindex"), "0");
          await scroll.focus(); assert.equal(await scroll.evaluate(node => node === document.activeElement), true);
          assert.equal(await table.locator("tbody td:first-child strong").evaluateAll(labels => labels.some(label => {
            const text = label.firstChild, start = text?.textContent?.indexOf("Proficiencies") ?? -1;
            if (!text || start < 0) return false;
            const range = document.createRange(); range.setStart(text, start); range.setEnd(text, start + "Proficiencies".length);
            return range.getClientRects().length > 1;
          })), false, "Table labels must keep whole words readable instead of splitting them into fragments");
          if (locale === "cs") {
            assert.equal(await scroll.evaluate(node => node.scrollWidth > node.clientWidth), true, "Enlarged tables use their bounded horizontal scroll area");
            await scroll.press("ArrowRight");
            await page.waitForFunction(() => [...document.querySelectorAll(".comp-table-scroll")].some(node => node === document.activeElement && node.scrollLeft > 0));
            await scroll.evaluate(node => { node.scrollLeft = 0; });
          }
          await f.fits(page);
          if (id === "wizard") {
            await table.evaluate(node => {
              const inset = document.querySelector(".comp-tree-drawer")!.getBoundingClientRect().height + 32;
              scrollTo(0, scrollY + node.getBoundingClientRect().top - inset);
            });
            await page.screenshot({ path: resolve(f.output, "core-traits-" + locale + ".png") });
          }
        }
      });
  }

  test("Compendium class, level and spell browsing follows enabled sources",
    { skip: !enabled, timeout: 60000 }, async t => {
      const f = fixture(); await restoreSources(t, f);
      const page = await f.open(t, "player", false, "en"), pane = page.locator(".comp-reading-pane");
      for (const hof of [false, true, false]) {
        await setSources(f, hof ? ["phb", "hof"] : ["phb"]);
        await page.reload(); await pane.getByRole("heading", { level: 1 }).waitFor();
        await f.go(page, "?kind=subclass&id=bladesinger");
        await pane.getByRole("heading", { level: 1, name: hof ? /Bladesinger/u : "Not found" }).waitFor();
        await f.go(page, "?kind=class&id=wizard");
        const tree = page.locator(".comp-tree");
        const wizard = tree.locator('[data-tree-node="domain:characters:class:class:wizard"]');
        if (await wizard.getAttribute("aria-expanded") === "true") await wizard.click();
        await wizard.click();
        await tree.locator('[data-tree-node="domain:characters:class:wizard:subclasses"]').click();
        assert.equal(await tree.locator('a[href*="kind=subclass&id=bladesinger"]').count(), hof ? 1 : 0);
        await tree.locator('[data-tree-node="domain:characters:class:wizard:features"]').click();
        await tree.locator('[data-tree-node="domain:characters:class:wizard:level:1"]').click();
        await tree.locator('a[href*="kind=feature&id=wizard-arcane-recovery"]').click();
        await pane.getByRole("heading", { level: 1, name: /Arcane Recovery/u }).waitFor();
        await f.go(page, "?kind=spell&level=1&classes=wizard&school=Abjuration&q=shield&book=phb");
        const spell = pane.locator(".codex-list-copy").filter({ has: page.getByText("Shield", { exact: true }) });
        assert.equal(await spell.count(), 1);
        await spell.click(); await pane.locator("article h1").waitFor();
        await page.goBack();
        for (const [field, value] of [["level", "1"], ["classes", "wizard"], ["school", "Abjuration"], ["book", "phb"]]) {
          assert.equal(await pane.locator('[data-filter="' + field + '"]').inputValue(), value);
        }
      }
    });
}
