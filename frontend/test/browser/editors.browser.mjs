import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

let server;
let browser;
let origin;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

function dataset(changes = {}) {
  const keyed = new Set(["factions", "deletedDefaults", "settings", "campaign"]);
  return {
    contractVersion: "campaign-data.v1",
    collections: ["characters", "relationships", "locations", "events", "mysteries", "factions",
      "deletedDefaults", "pantheon", "artifacts", "settings", "historicalEvents", "campaign", "pets"]
      .map(name => ({ name, shape: keyed.has(name) ? "keyed" : "list", materialized: true,
        revision: 1, records: changes[name] ?? [] })),
  };
}

const character = (revision = 1, name = "Ryn") => ({ key: "ryn", revision,
  value: { id: "ryn", name, title: "Scout", description: "Old notes", visibility: "public" } });
const gender = (revision = 1, label = "Unspecified") => ({ key: "genders", revision,
  value: [{ id: "unspecified", label }] });
const appearance = (revision = 1, theme = "classic") => ({ key: "appearance", revision, value: { theme } });

async function fixture(t, data, route) {
  const context = await browser.newContext({ locale: "en-US" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "browser errors"));
  await page.goto(`${origin}/test/browser/editor-fixture.html`);
  await page.waitForFunction(() => window.editorFixture !== undefined);
  await page.evaluate(({ data, route }) => window.editorFixture.mount(data, route), { data, route });
  return page;
}
const refresh = (page, data) => page.evaluate(data => window.editorFixture.refresh(data), data);
const submission = page => page.evaluate(() => window.editorFixture.submissions.at(-1));

test("record drafts retain their opening revision and fields across live refresh", async t => {
  const page = await fixture(t, dataset({ characters: [character()] }), "#/characters/ryn");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator('[name="name"]').fill("My draft");
  await page.locator('[name="description"]').fill("My draft notes");
  await refresh(page, dataset({ characters: [character(2, "Remote rename")] }));
  assert.equal(await page.locator('[name="name"]').inputValue(), "My draft");
  assert.equal(await page.locator('[name="description"]').inputValue(), "My draft notes");
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  const result = await submission(page);
  assert.equal(result.detail.expectedRevision, 1);
  assert.match(result.error, /stale/);
  assert.equal(result.mutation, undefined);
});

test("deleting an edited record uses its opening revision", async t => {
  const page = await fixture(t, dataset({ characters: [character()] }), "#/characters/ryn");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.evaluate(() => document.addEventListener("campaign-record-delete", event => {
    window.editorFixture.submissions.push(event.detail);
  }));
  await refresh(page, dataset({ characters: [character(2)] }));
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  assert.equal((await submission(page)).expectedRevision, 1);
});

test("a remotely deleted record keeps its draft available until explicitly cancelled", async t => {
  const page = await fixture(t, dataset({ characters: [character()] }), "#/characters/ryn");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator('[name="name"]').fill("Keep these notes");
  await refresh(page, dataset());
  assert.equal(await page.locator('[name="name"]').inputValue(), "Keep these notes");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "Entry not found" }).count(), 1);
});

test("repeated Add entry cannot clear a new dirty draft or its unload guard", async t => {
  const page = await fixture(t, dataset(), "#/characters");
  await page.getByRole("button", { name: "Add character", exact: true }).click();
  await page.locator('[name="name"]').fill("New hero");
  assert.equal(await page.getByRole("button", { name: "Add character", exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.editorFixture.dirty.at(-1)), true);
});

test("enum drafts retain values and revisions, including remote removal", async t => {
  const page = await fixture(t, dataset({ settings: [gender()] }));
  await page.locator('[data-category="genders"]').click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator('[name="label"]').fill("My label");
  await refresh(page, dataset({ settings: [gender(2, "Remote label")] }));
  assert.equal(await page.locator('[name="label"]').inputValue(), "My label");
  await page.getByRole("button", { name: "Save definition", exact: true }).click();
  assert.equal((await submission(page)).detail.expectedRevision, 1);
  assert.match((await submission(page)).error, /revision is stale/);
  assert.equal((await submission(page)).mutation, undefined);
  await refresh(page, dataset({ settings: [{ key: "genders", revision: 3, value: [] }] }));
  assert.equal(await page.locator('[name="label"]').inputValue(), "My label");
});

test("appearance drafts keep the reviewed revision and reset after save completion", async t => {
  const page = await fixture(t, dataset({ settings: [appearance()] }));
  await page.locator('[data-category="appearance"]').click();
  await page.locator('[name="theme"][value="moonlit"]').check();
  await refresh(page, dataset({ settings: [appearance(2, "moonlit")] }));
  assert.equal(await page.locator('[name="theme"][value="moonlit"]').isChecked(), true);
  await page.locator('button[type="submit"]').click();
  assert.equal((await submission(page)).detail.expectedRevision, 1);
  assert.match((await submission(page)).error, /revision is stale/);
  assert.equal((await submission(page)).mutation, undefined);
  await page.evaluate(() => window.editorFixture.complete());
  await page.locator('button[type="submit"]').click();
  assert.equal((await submission(page)).detail.expectedRevision, 2);
});

test("saving an older character draft cannot delete a newly added relationship", async t => {
  const characters = [character(), { key: "bob", revision: 1, value: { id: "bob", name: "Bob" } }];
  const page = await fixture(t, dataset({ characters }), "#/characters/ryn");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator('[name="title"]').fill("My title");
  await refresh(page, dataset({ characters, relationships: [{ key: "new-link", revision: 1,
    value: { source: "ryn", target: "bob", type: "ally" } }] }));
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  const result = await submission(page);
  assert.deepEqual(result.detail.relationshipBase, []);
  assert.match(result.error, /relationship revisions are stale/);
  assert.equal(result.mutation, undefined);
});

test("unrelated live changes allow saving and reopening loads the latest record", async t => {
  const original = character();
  original.value.customNotes = { keep: true };
  const page = await fixture(t, dataset({ characters: [original] }), "#/characters/ryn");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator('[name="title"]').fill("My title");
  await refresh(page, dataset({ characters: [original], locations: [{ key: "new", revision: 1, value: { id: "new", name: "New town" } }] }));
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  const result = await submission(page);
  assert.equal(result.error, undefined);
  assert.equal(result.mutation.mutations[0].value.title, "My title");
  assert.deepEqual(result.mutation.mutations[0].value.customNotes, { keep: true });
  await refresh(page, dataset({ characters: [character(2, "Latest name")] }));
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await page.locator('[name="name"]').inputValue(), "Latest name");
});
