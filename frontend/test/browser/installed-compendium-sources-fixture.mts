import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { APIRequestContext, Page } from "playwright";
import { jsonResponse } from "./installed-graph-fixture.mts";

interface Source {
  addonId: string;
  setId: string;
  id: string;
  enabled: boolean;
}
interface Fixture {
  admin: APIRequestContext;
  csrf: string;
  output: string;
  open(t: TestContext, role: string, mobile: boolean, locale: string): Promise<Page>;
  go(page: Page, query: string): Promise<void>;
  fits(page: Page): Promise<void>;
}

async function setSources(f: Fixture, ids: readonly string[]) {
  const policy = await jsonResponse(await f.admin.get("/api/admin/rules-policy"));
  const sources = policy.sources as Source[];
  assert.ok(
    ids.every((id) => sources.some((source) => source.id === id)),
    "Use known source IDs",
  );
  await jsonResponse(
    await f.admin.post("/api/admin/rules-policy", {
      headers: { "X-Codex-CSRF": f.csrf },
      data: {
        expectedRevision: policy.revision,
        expectedGraphRevision: policy.graphRevision,
        enabled: sources
          .filter((source) => ids.includes(source.id))
          .map(({ addonId, setId, id }) => ({ addonId, setId, id })),
      },
    }),
  );
}
async function restoreSources(t: TestContext, f: Fixture) {
  const initial = await jsonResponse(await f.admin.get("/api/admin/rules-policy"));
  const ids = (initial.sources as Source[])
    .filter((source) => source.enabled)
    .map((source) => source.id);
  t.after(() => setSources(f, ids));
}
export function registerCompendiumSourceTests(enabled: boolean, fixture: () => Fixture) {
  void test(
    "Compendium class, level and spell browsing follows enabled sources",
    { skip: !enabled, timeout: 60000 },
    async (t) => {
      const f = fixture();
      await restoreSources(t, f);
      const page = await f.open(t, "player", false, "en"),
        pane = page.locator(".comp-reading-pane");
      for (const hof of [false, true, false]) {
        await setSources(f, hof ? ["phb", "hof"] : ["phb"]);
        await page.reload();
        await pane.getByRole("heading", { level: 1 }).waitFor();
        await f.go(page, "?kind=subclass&id=bladesinger");
        await pane
          .getByRole("heading", { level: 1, name: hof ? /Bladesinger/u : "Not found" })
          .waitFor();
        await f.go(page, "?kind=class&id=wizard");
        const tree = page.locator(".comp-tree");
        const wizard = tree.locator('[data-tree-node="domain:characters:class:class:wizard"]');
        if ((await wizard.getAttribute("aria-expanded")) === "true") await wizard.click();
        await wizard.click();
        await tree.locator('[data-tree-node="domain:characters:class:wizard:subclasses"]').click();
        assert.equal(
          await tree.locator('a[href*="kind=subclass&id=bladesinger"]').count(),
          hof ? 1 : 0,
        );
        await tree.locator('[data-tree-node="domain:characters:class:wizard:features"]').click();
        await tree.locator('[data-tree-node="domain:characters:class:wizard:level:1"]').click();
        await tree.locator('a[href*="kind=feature&id=wizard-arcane-recovery"]').click();
        await pane.getByRole("heading", { level: 1, name: /Arcane Recovery/u }).waitFor();
        await f.go(page, "?kind=spell&level=1&classes=wizard&school=Abjuration&q=shield&book=phb");
        const spell = pane
          .locator(".codex-list-copy")
          .filter({ has: page.getByText("Shield", { exact: true }) });
        assert.equal(await spell.count(), 1);
        await spell.click();
        await pane.locator("article h1").waitFor();
        await page.goBack();
        for (const [field, value] of [
          ["level", "1"],
          ["classes", "wizard"],
          ["school", "Abjuration"],
          ["book", "phb"],
        ]) {
          assert.equal(await pane.locator('[data-filter="' + field + '"]').inputValue(), value);
        }
      }
    },
  );
}
