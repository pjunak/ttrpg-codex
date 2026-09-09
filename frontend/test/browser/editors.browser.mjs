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
    cacheDir: fileURLToPath(new URL("../../node_modules/.vite-editor-tests", import.meta.url)),
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

const language = (page, locale) => page.evaluate(async locale => {
  const { setUiLocale } = await import('/src/app/ui-localization.ts'); setUiLocale(locale);
}, locale);

test("Czech record and relationship editors retain drafts and stable values across language changes", async t => {
  const page = await fixture(t, dataset({ characters: [character(), { key: 'peer', revision: 1, value: { id: 'peer', name: 'Title {0} $&' } }] }), '#/characters/ryn');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('[name="name"]').fill('Name {0} $&');
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'Add question', exact: true }).click();
  await page.locator('[data-part="text"]').fill('Untranslated authored question');
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add relationship', exact: true }).click();
  await page.locator('[data-part="target"]').selectOption('peer');
  await language(page, 'cs');
  await page.getByRole('button', { name: 'Uložit záznam', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Název', { exact: true }).inputValue(), 'Name {0} $&');
  assert.equal(await page.locator('[data-part="text"]').inputValue(), 'Untranslated authored question');
  assert.equal(await page.locator('[data-part="target"]').inputValue(), 'peer');
  await page.getByRole('button', { name: 'Uložit záznam', exact: true }).click();
  const result = await submission(page);
  assert.equal(result.error, undefined); assert.equal(result.detail.fields.name, 'Name {0} $&');
  assert.equal(result.detail.relationships[0].target, 'peer');
  await language(page, 'en');
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Name {0} $&');
});

test("Czech campaign settings translate closed choices and retain authored definitions", async t => {
  const page = await fixture(t, dataset({ settings: [gender()] }));
  await page.locator('[data-category="genders"]').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('[name="label"]').fill('Display name {0} $&');
  await language(page, 'cs');
  await page.getByRole('button', { name: 'Uložit definici', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Zobrazovaný název', { exact: true }).inputValue(), 'Display name {0} $&');
  await page.getByRole('button', { name: 'Uložit definici', exact: true }).click();
  const result = await submission(page);
  assert.equal(result.error, undefined); assert.equal(result.detail.originalId, 'unspecified');
  assert.equal(result.detail.fields.label, 'Display name {0} $&');
});

test("character tabs reveal invalid fields and keep all groups in the saved draft", async t => {
  const page = await fixture(t, dataset({ characters: [character()] }), '#/characters/ryn');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const details = page.getByRole('tab', { name: 'Details', exact: true });
  await page.getByLabel('Name', { exact: true }).fill('');
  await details.focus(); await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: 'Knowledge', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'name');
  assert.equal(await submission(page), undefined, 'invalid hidden required fields must not submit');
  await page.getByLabel('Name', { exact: true }).fill('New name');
  await details.focus(); await page.keyboard.press('ArrowRight');
  await page.locator('[name="faction"]').selectOption('party');
  await page.getByRole('tab', { name: 'Connections', exact: true }).press('ArrowRight');
  await page.getByRole('spinbutton', { name: 'Knowledge', exact: true }).fill('3');
  await page.getByRole('button', { name: 'Add question', exact: true }).click();
  await page.locator('[data-part="text"]').fill('Who sent the letter?');
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).press('Home');
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'New name');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  const result = await submission(page);
  assert.equal(result.error, undefined);
  assert.equal(result.detail.fields.faction, 'party');
  assert.equal(result.detail.fields.knowledge, '3');
  assert.equal(result.detail.fields.unknown[0].text, 'Who sent the letter?');
});

for (const mobile of [false, true]) test(`character editor keeps description and preview usable on ${mobile ? 'phone' : 'desktop'}`, async t => {
  const page = await fixture(t, dataset({ characters: [character()] }), '#/characters/ryn');
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const details = await page.locator('.character-editor-details').boundingBox();
  const description = await page.locator('.character-editor-description').boundingBox();
  assert.ok(mobile ? description.y >= details.y + details.height : description.x >= details.x + details.width);
  await page.getByRole('button', { name: 'Side by side', exact: true }).click();
  const textarea = page.locator('textarea[name="description"]');
  await textarea.fill('## The lighthouse\n\nAn **unfinished** promise.');
  await page.locator('.markdown-editor-preview').getByRole('heading', { name: 'The lighthouse' }).waitFor();
  await textarea.press('End'); await textarea.pressSequentially(' More.');
  assert.equal(await textarea.evaluate(element => element === document.activeElement), true, 'live preview keeps typing focus');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  assert.equal(await textarea.isVisible(), false);
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  assert.match(await textarea.inputValue(), /More\.$/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: fileURLToPath(new URL(`../../test-results/character-editor-${mobile ? 'phone' : 'desktop'}.png`, import.meta.url)), fullPage: true });
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  assert.match((await submission(page)).detail.fields.description, /More\.$/);
});

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
