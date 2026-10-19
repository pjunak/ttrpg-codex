import { required, stringValue } from "./fixture-types.mts";
import type { Browser, BrowserContext, Page } from "playwright";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { jsonResponse } from "./installed-graph-fixture.mts";
import { trackBrowserContext } from "./browser-diagnostics.mts";
import {
  buildRealHost,
  relationshipKey,
  removeRecord,
  startRealHost,
  storeRecord,
  storeRecords,
  storedRecord,
  type RealHost,
  type RealHostBuild,
} from "./real-host.mts";

// Every test runs the real app against its own real host and campaign, so a
// save goes through the app's write path and the stored record is read back.
let build: RealHostBuild;
let browser: Browser;
before(async () => {
  build = await buildRealHost("editors");
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await build?.remove();
});

type Seed = Readonly<Record<string, readonly { key: string; value: unknown }[]>>;
interface Campaign extends RealHost {
  readonly closers: (() => Promise<void>)[];
}

async function campaign(t: TestContext, seed: Seed = {}): Promise<Campaign> {
  const host = { ...(await startRealHost(build)), closers: [] as (() => Promise<void>)[] };
  t.after(async () => {
    // Pages leave before their host stops; their own hooks report page errors.
    for (const close of host.closers) await close().catch(() => undefined);
    await host.stop();
  });
  await storeRecords(
    host,
    Object.entries(seed).flatMap(([collection, records]) =>
      records.map((record) => ({ collection, ...record })),
    ),
  );
  return host;
}

interface CampaignWrite {
  mutations: { key: string; expectedRevision: number; value: Record<string, unknown> }[];
}

interface Editor {
  page: Page;
  context: BrowserContext;
  /** Transactions this page sent, in order. */
  writes: CampaignWrite[];
  /** Switches this session's view and reloads the page. */
  viewAs(role: "dm" | "player"): Promise<void>;
}

async function open(
  t: TestContext,
  host: Campaign,
  route: string,
  options: { mobile?: boolean; locale?: string } = {},
): Promise<Editor> {
  const context = await browser.newContext({
    baseURL: host.origin,
    locale: "en-US",
    reducedMotion: "reduce",
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  host.closers.push(await trackBrowserContext(t, context, () => assert.deepEqual(errors, [])));
  const auth = await jsonResponse(
    await context.request.post("/api/login", { data: { password: host.password("dm") } }),
  );
  if (options.locale)
    await context.addInitScript(
      (locale) => localStorage.setItem("codex_lang", locale),
      options.locale,
    );
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  const writes = transactions(page);
  await page.goto(`/${route}`);
  await ready(page);
  let csrf = auth.csrfToken as string;
  return {
    page,
    context,
    writes,
    async viewAs(role) {
      const next = await jsonResponse(
        await context.request.post("/api/view-as", {
          headers: { "X-Codex-CSRF": csrf },
          data: { role },
        }),
      );
      csrf = next.csrfToken;
      await reload(page);
    },
  };
}

/** Polls a condition the page cannot be asked about, such as the requests it sent. */
async function until(check: () => boolean, message: string) {
  for (let elapsed = 0; !check(); elapsed += 50) {
    assert.ok(elapsed < 10_000, message);
    await sleep(50);
  }
}

function transactions(page: Page): CampaignWrite[] {
  const writes: CampaignWrite[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/campaign/transactions"
    )
      writes.push(request.postDataJSON() as CampaignWrite);
  });
  return writes;
}

/** The campaign is shown and live updates arrive. */
async function ready(page: Page) {
  await page.waitForFunction(() => {
    const app = document.querySelector("codex-app") as unknown as {
      campaignState?: { state: string };
      liveState?: string;
    } | null;
    return app?.campaignState?.state === "ready" && app.liveState === "connected";
  });
}

/** Reloads even with open edits; the leave prompt is accepted. */
async function reload(page: Page) {
  const leave = (dialog: import("playwright").Dialog) => {
    if (dialog.type() === "beforeunload") void dialog.accept();
  };
  page.on("dialog", leave);
  try {
    await page.reload();
  } finally {
    page.off("dialog", leave);
  }
  await ready(page);
}

async function go(page: Page, hash: string) {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, hash);
}

/** Waits until the page shows the record at `revision`, or shows it gone. */
async function shown(page: Page, collection: string, key: string, revision?: number) {
  await page.waitForFunction(
    ({ collection, key, revision }) => {
      const app = document.querySelector("codex-app") as unknown as {
        campaignState: {
          campaign?: {
            collections: { name: string; records: { key: string; revision: number }[] }[];
          };
        };
      };
      const record = app.campaignState.campaign?.collections
        .find((item) => item.name === collection)
        ?.records.find((item) => item.key === key);
      return revision === undefined ? record === undefined : (record?.revision ?? 0) >= revision;
    },
    { collection, key, revision },
  );
}

/** Another author changes a record; resolves once this page shows it. */
async function remote(host: Campaign, page: Page, collection: string, key: string, value: unknown) {
  const stored = await storeRecord(host, collection, key, value);
  await shown(page, collection, key, stored.revision);
  return stored;
}

async function removedElsewhere(host: Campaign, page: Page, collection: string, key: string) {
  await removeRecord(host, collection, key);
  await shown(page, collection, key);
}

/** The stored value, without the change notes the host keeps for the activity list. */
async function saved(host: Campaign, collection: string, key: string) {
  const value: unknown = required(await storedRecord(host, collection, key)).value;
  if (Array.isArray(value)) return value as unknown as Record<string, unknown>;
  const { lastChange: _change, updatedAt: _updated, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** Switches the interface language the way Settings stores it, then reloads. */
async function language(page: Page, locale: "en" | "cs") {
  await page.evaluate((locale) => localStorage.setItem("codex_lang", locale), locale);
  await reload(page);
}

/** Fails the next campaign write the way an unavailable server does. */
async function failNextWrite(page: Page) {
  await page.route(
    "**/api/campaign/transactions",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { kind: "CAMPAIGN_UNAVAILABLE", message: "campaign data is unavailable" },
        }),
      }),
    { times: 1 },
  );
}

const unavailable = "The entry could not be saved: The server is unavailable. Try again shortly.";
const fieldConflict =
  "This field changed elsewhere. Your draft is kept. Review the current value before retrying.";

const character = (name = "Ryn") => ({
  key: "ryn",
  value: { id: "ryn", name, title: "Scout", description: "Old notes", visibility: "public" },
});
const gender = (label = "Unspecified") => ({
  key: "genders",
  value: [{ id: "unspecified", label }],
});

async function localCopySaved(page: Page) {
  await page
    .locator(".writer-recovery-status")
    .filter({ hasText: "Recovery copy saved on this device." })
    .waitFor();
}
async function reviewLocalDraft(page: Page) {
  await page.locator(".writer-recovery-review > summary").click();
  await page.getByRole("button", { name: "Use this draft", exact: true }).waitFor();
}
async function editRecordOrDefinition(page: Page) {
  if (await page.locator("codex-character-profile").count()) {
    await page.getByLabel("More actions", { exact: true }).click();
    await page.getByRole("button", { name: "Edit all fields", exact: true }).click();
  } else await page.getByRole("button", { name: "Edit", exact: true }).click();
}
async function sourceView(page: Page) {
  await page.getByLabel("Editor view", { exact: true }).selectOption("markdown");
}
async function screenshotForReview(page: Page, name: string) {
  if (process.env["CODEX_UI_SCREENSHOTS"] === "1")
    await page.screenshot({
      path: fileURLToPath(
        new URL(`../../../docs/plans/drafts-collections-${name}.png`, import.meta.url),
      ),
      fullPage: true,
    });
}

void test("Markdown survives reload, requires review, and is removed after confirmed campaign save", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await page.locator(".writer-source").fill("## Durable prose\n\nA **deliberate** edit.");
  await localCopySaved(page);
  await reload(page);
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  assert.equal(await page.locator(".writer-source").inputValue(), "Old notes");
  await reviewLocalDraft(page);
  await page.getByRole("button", { name: "Use this draft", exact: true }).click();
  assert.equal(
    await page.locator(".writer-source").inputValue(),
    "## Durable prose\n\nA **deliberate** edit.",
  );
  assert.equal(writes.length, 0);
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.locator(".character-save-status").filter({ hasText: "Wiki saved" }).waitFor();
  await page
    .locator(".writer-recovery-status")
    .filter({ hasText: "Local recovery is on" })
    .waitFor();
  assert.equal(
    (await saved(host, "characters", "ryn")).description,
    "## Durable prose\n\nA **deliberate** edit.",
  );
  await reload(page);
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await page.locator(".writer-recovery-status").waitFor();
  assert.equal(await page.locator(".writer-recovery-review").count(), 0);
});

void test("separate tabs retain independent Markdown drafts when one is recovered and saved", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, context } = await open(t, host, "#/characters/ryn");
  const second = await context.newPage();
  second.setDefaultTimeout(10_000);
  await second.goto("/#/characters/ryn");
  await ready(second);
  for (const [tab, value] of [
    [page, "First tab work"],
    [second, "Second tab work"],
  ] as const) {
    await tab.getByRole("button", { name: "Edit wiki", exact: true }).click();
    await sourceView(tab);
    await tab.locator(".writer-source").fill(value);
    await localCopySaved(tab);
  }
  await reload(page);
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await page.getByText("Local drafts available (2)", { exact: true }).waitFor();
  await reviewLocalDraft(page);
  assert.equal(
    await page.locator(".writer-recovery-comparison section").last().locator("pre").textContent(),
    "Second tab work",
  );
  await page.getByRole("button", { name: "Use this draft", exact: true }).click();
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page
    .locator(".writer-recovery-status")
    .filter({ hasText: "Local recovery is on" })
    .waitFor();
  assert.equal((await saved(host, "characters", "ryn")).description, "Second tab work");
  await reload(page);
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await page.getByText("Local drafts available (1)", { exact: true }).waitFor();
  await reviewLocalDraft(page);
  assert.equal(
    await page.locator(".writer-recovery-comparison section").last().locator("pre").textContent(),
    "First tab work",
  );
});

void test("recovery compares changed saved text and a subsequent remote change still rejects stale saves", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await page.locator(".writer-source").fill("My recovered text");
  await localCopySaved(page);
  await storeRecord(host, "characters", "ryn", {
    ...character().value,
    description: "Remote text",
  });
  await reload(page);
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await reviewLocalDraft(page);
  await page
    .getByText(
      "The saved entry has changed since this draft began. Compare the text before using it.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.locator(".writer-recovery-comparison section").nth(1).locator("pre").textContent(),
    "Remote text",
  );
  await screenshotForReview(page, "recovery");
  await page.getByRole("button", { name: "Use this draft", exact: true }).click();
  await remote(host, page, "characters", "ryn", {
    ...character().value,
    description: "Another remote edit",
  });
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: fieldConflict }).waitFor();
  assert.equal(await page.locator(".writer-source").inputValue(), "My recovered text");
  assert.equal(writes.length, 0);
  assert.equal((await saved(host, "characters", "ryn")).description, "Another remote edit");
});

void test("current editor text is retained as another draft before recovering a different copy", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await page.locator(".writer-source").fill("Original recovered draft");
  await localCopySaved(page);
  await reload(page);
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await page.locator(".writer-source").fill("New writing before review");
  await reviewLocalDraft(page);
  await page.getByRole("button", { name: "Use this draft", exact: true }).click();
  await localCopySaved(page);
  assert.equal(await page.locator(".writer-source").inputValue(), "Original recovered draft");
  await reload(page);
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await reviewLocalDraft(page);
  const options = await page
    .getByRole("combobox", { name: "Draft to review", exact: true })
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
    );
  const texts: string[] = [];
  for (const option of options) {
    await page.getByRole("combobox", { name: "Draft to review", exact: true }).selectOption(option);
    texts.push(
      await page.locator(".writer-recovery-comparison section").last().locator("pre").innerText(),
    );
  }
  assert.ok(texts.includes("New writing before review"));
  assert.ok(texts.includes("Original recovered draft"));
});

void test("generic create forms recover Markdown by field and role without changing saved campaign records", async (t) => {
  const host = await campaign(t, { locations: [{ key: "keep", value: { name: "Keep" } }] });
  const editor = await open(t, host, "#/locations");
  const { page, writes } = editor;
  await page.getByRole("button", { name: "Add location", exact: true }).click();
  const writer = page.locator("codex-markdown-editor").first();
  await writer.getByRole("combobox", { name: "Editor view", exact: true }).selectOption("markdown");
  await writer.locator(".writer-source").fill("Unsaved location prose");
  await writer
    .locator(".writer-recovery-status")
    .filter({ hasText: "Recovery copy saved" })
    .waitFor();
  await editor.viewAs("player");
  await page.getByRole("button", { name: "Add location", exact: true }).click();
  assert.equal(await page.locator(".writer-recovery-review").count(), 0);
  await editor.viewAs("dm");
  await page.getByRole("button", { name: "Add location", exact: true }).click();
  await page.getByText("Local drafts available (1)", { exact: true }).waitFor();
  await page.locator(".writer-recovery-review > summary").click();
  await page.getByRole("button", { name: "Use this draft", exact: true }).click();
  assert.equal(
    await page.locator("codex-markdown-editor").first().locator(".writer-source").inputValue(),
    "Unsaved location prose",
  );
  assert.equal(writes.length, 0);
  page.once("dialog", (dialog) => dialog.accept());
  await go(page, "#/locations/keep");
  await page.getByRole("heading", { name: "Keep", exact: true }).waitFor();
  await editRecordOrDefinition(page);
  assert.equal(await page.locator(".writer-recovery-review").count(), 0);
  assert.equal(writes.length, 0);
  assert.equal(required(await storedRecord(host, "locations", "keep")).revision, 1);
});

void test("collection views apply compound filters and persist sorting/grouping without clearing an open create form", async (t) => {
  const host = await campaign(t, {
    characters: [
      character(),
      {
        key: "zar",
        value: {
          name: "Žár",
          faction: "watch",
          description: `${"Intro ".repeat(100)}Strážce severu`,
          tags: ["scout"],
        },
      },
    ],
    factions: [{ key: "watch", value: { name: "Noční hlídka" } }],
  });
  const { page } = await open(t, host, "#/characters");
  await page.getByRole("button", { name: "Add character", exact: true }).click();
  await page.locator('.record-editor [name="name"]').fill("Unsubmitted character");
  const search = page.getByRole("searchbox", { name: "Search this collection", exact: true });
  await search.fill("zar strazce");
  // Searching applies while typing and keeps focus in the field.
  await page.getByText("1 of 2 entries", { exact: true }).waitFor();
  assert.equal(await search.evaluate((node) => node === document.activeElement), true);
  await search.fill("");
  await page.getByText("2 of 2 entries", { exact: true }).waitFor();
  await search.fill("zar strazce");
  await page.locator(".collection-filter-picker > summary").click();
  await page.getByRole("combobox", { name: "Filter by", exact: true }).selectOption("faction");
  // Filter values are a chip picker: type to narrow, choose with the keyboard.
  const value = page.getByRole("combobox", { name: "Value", exact: true });
  await value.fill("hlídka");
  await value.press("ArrowDown");
  await value.press("Enter");
  await page.locator(".collection-filter-chips").getByText("Noční hlídka").waitFor();
  await page.getByRole("combobox", { name: "Group by", exact: true }).selectOption("faction");
  await page.getByRole("combobox", { name: "Sort direction", exact: true }).selectOption("desc");
  await page.getByText("1 of 2 entries", { exact: true }).waitFor();
  assert.equal(
    await page.locator('.record-editor [name="name"]').inputValue(),
    "Unsubmitted character",
  );
  assert.match(page.url(), /q=zar\+strazce/);
  await reload(page);
  await page.getByText("1 of 2 entries", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Group by", exact: true }).inputValue(),
    "faction",
  );
  assert.equal(
    await page.getByRole("combobox", { name: "Sort direction", exact: true }).inputValue(),
    "desc",
  );
  await screenshotForReview(page, "desktop");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByText("2 of 2 entries", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("searchbox", { name: "Search this collection", exact: true }).inputValue(),
    "",
  );
});

void test("Czech phone collection controls remain usable and announce zero results with a clear recovery action", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters", { mobile: true, locale: "cs" });
  await page
    .getByRole("searchbox", { name: "Prohledat tuto sbírku", exact: true })
    .fill("nenalezeno");
  await page.getByText("0 z 1 záznamu", { exact: true }).waitFor();
  assert.ok(await page.getByRole("button", { name: "Vymazat filtry", exact: true }).isEnabled());
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.getByRole("button", { name: "Vymazat filtry", exact: true }).click();
  await page.getByText("1 z 1 záznamu", { exact: true }).waitFor();
  await screenshotForReview(page, "phone");
});

void test("blocked browser draft storage reports the limitation and still allows campaign Save", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters/ryn");
  await page.evaluate(() => {
    Object.defineProperty(IDBFactory.prototype, "open", {
      configurable: true,
      value() {
        throw new DOMException("Unavailable", "QuotaExceededError");
      },
    });
  });
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await page.locator(".writer-source").fill("Keep this text");
  await page.getByRole("alert").filter({ hasText: "Local recovery is unavailable" }).waitFor();
  assert.equal(await page.locator(".writer-source").inputValue(), "Keep this text");
  await page.getByRole("link", { name: "Download Markdown", exact: true }).waitFor();
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.locator(".character-save-status").filter({ hasText: "Wiki saved" }).waitFor();
  assert.equal((await saved(host, "characters", "ryn")).description, "Keep this text");
});

void test("explicit wiki cancellation removes its local copy while failed campaign saves retain it", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await page.locator(".writer-source").fill("Retain after failure");
  await localCopySaved(page);
  await failNextWrite(page);
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: unavailable }).waitFor();
  await reload(page);
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await reviewLocalDraft(page);
  await page.getByRole("button", { name: "Use this draft", exact: true }).click();
  await localCopySaved(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await page.locator(".writer-recovery-status").waitFor();
  assert.equal(await page.locator(".writer-recovery-review").count(), 0);
  assert.equal((await saved(host, "characters", "ryn")).description, "Old notes");
});

void test("a linked collection view survives article navigation and role changes keep separate browser preferences", async (t) => {
  const host = await campaign(t, {
    characters: [character(), { key: "other", value: { name: "Other" } }],
  });
  const editor = await open(t, host, "#/characters?view=1&q=Ryn&direction=desc");
  const { page } = editor;
  await page.getByText("1 of 2 entries", { exact: true }).waitFor();
  await go(page, "#/characters/ryn");
  await page.getByRole("heading", { name: "Ryn", exact: true }).waitFor();
  await go(page, "#/characters");
  await page.getByText("1 of 2 entries", { exact: true }).waitFor();
  await editor.viewAs("player");
  await page.getByText("2 of 2 entries", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("searchbox", { name: "Search this collection", exact: true }).inputValue(),
    "",
  );
  assert.doesNotMatch(page.url(), /q=Ryn/);
  await editor.viewAs("dm");
  await page.getByText("1 of 2 entries", { exact: true }).waitFor();
});

void test("a deleted record's draft remains downloadable from its collection without recreating data", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const editor = await open(t, host, "#/characters/ryn");
  const { page, writes } = editor;
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await page.locator(".writer-source").fill("Text for an entry removed elsewhere");
  await localCopySaved(page);
  await removedElsewhere(host, page, "characters", "ryn");
  page.once("dialog", (dialog) => dialog.accept());
  await go(page, "#/characters");
  await page.getByText("There are no entries in this collection yet.", { exact: true }).waitFor();
  // An empty collection has nothing to search, sort or group.
  assert.equal(await page.locator(".collection-controls").count(), 0);
  await page.locator(".collection-local-drafts > summary").click();
  await page
    .locator(".collection-local-draft > summary")
    .filter({ hasText: "Entry no longer available" })
    .click();
  assert.equal(
    await page.locator(".collection-local-draft pre").innerText(),
    "Text for an entry removed elsewhere",
  );
  assert.equal(await page.getByRole("link", { name: "Open entry", exact: true }).count(), 0);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download Markdown", exact: true }).click();
  const download = await downloaded;
  const stream = await download.createReadStream();
  assert.ok(stream);
  let content = "";
  for await (const chunk of stream) content += String(chunk);
  assert.equal(content, "Text for an entry removed elsewhere");
  assert.equal(writes.length, 0);
  assert.equal(await storedRecord(host, "characters", "ryn"), undefined);
  await editor.viewAs("player");
  // Another role's drafts stay separate, so the player sees no draft library at all.
  await page.getByText("There are no entries in this collection yet.", { exact: true }).waitFor();
  assert.equal(await page.locator(".collection-local-drafts").count(), 0);
});

void test("an empty mysteries page shows its empty states without search tools", async (t) => {
  const host = await campaign(t);
  const { page } = await open(t, host, "#/mysteries");
  await page.getByText("No unanswered questions.", { exact: true }).waitFor();
  await page.getByText("There are no entries in this collection yet.", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".collection-controls, .investigation-jump, .investigation-toolbar").count(),
    0,
  );
});

void test("direct character edits confirm with Enter, cancel with Escape and preserve the article", async (t) => {
  const host = await campaign(t, { characters: [character()], settings: [gender()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit Name", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Ryn of the Watch");
  await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter");
  await page
    .getByRole("button", { name: "Edit Name", exact: true })
    .filter({ hasText: "Ryn of the Watch" })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Save entry", exact: true }).count(), 0);
  assert.equal((await saved(host, "characters", "ryn")).description, "Old notes");
  await page.getByRole("button", { name: "Edit Title", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Unconfirmed");
  await page.getByRole("textbox", { name: "Title", exact: true }).press("Escape");
  assert.equal(
    await page.getByRole("button", { name: "Edit Title", exact: true }).textContent(),
    "Scout",
  );
  await page.locator(".character-empty-details > summary").click();
  await page.getByRole("button", { name: "Edit Gender", exact: true }).click();
  await page.getByRole("combobox", { name: "Gender", exact: true }).selectOption("unspecified");
  await page
    .getByRole("button", { name: "Edit Gender", exact: true })
    .filter({ hasText: "Unspecified" })
    .waitFor();
  // The second edit builds on the revision the first one saved.
  assert.equal(required(writes.at(-1)).mutations[0]?.expectedRevision, 2);
  assert.deepEqual(await saved(host, "characters", "ryn"), {
    ...character().value,
    name: "Ryn of the Watch",
    gender: "unspecified",
  });
});

void test("location facts edit in place: Enter saves the location, Escape keeps the saved value", async (t) => {
  const host = await campaign(t, {
    locations: [{ key: "gate", value: { name: "Gate", type: "Town" } }],
  });
  const { page, writes } = await open(t, host, "#/locations/gate");
  await page.getByRole("button", { name: "Edit Kind", exact: true }).click();
  const kind = page.getByRole("textbox", { name: "Kind", exact: true });
  await kind.fill("City");
  await kind.press("Enter");
  await page
    .getByRole("button", { name: "Edit Kind", exact: true })
    .filter({ hasText: "City" })
    .waitFor();
  assert.equal((await saved(host, "locations", "gate")).type, "City");
  await page.getByRole("button", { name: "Edit Kind", exact: true }).click();
  await kind.fill("Not kept");
  await kind.press("Escape");
  assert.equal(
    (await page.getByRole("button", { name: "Edit Kind", exact: true }).textContent())?.trim(),
    "City",
  );
  assert.equal(writes.length, 1);
});

void test("multi-value location fields edit in place with the chip picker", async (t) => {
  const host = await campaign(t, {
    locations: [
      { key: "gate", value: { name: "Gate" } },
      { key: "vale", value: { name: "Vale" } },
    ],
  });
  const { page } = await open(t, host, "#/locations/gate");
  await page.locator(".record-more-details > summary").click();
  await page.getByRole("button", { name: "Edit Connected locations", exact: true }).click();
  const picker = page.getByRole("combobox", { name: "Connected locations", exact: true });
  await picker.fill("val");
  await picker.press("ArrowDown");
  await picker.press("Enter");
  await picker.press("Enter");
  await page.getByRole("button", { name: "Edit Connected locations", exact: true }).waitFor();
  assert.deepEqual((await saved(host, "locations", "gate")).connections, ["vale"]);
});

void test("an inline save shows the value read back from the campaign", async (t) => {
  const host = await campaign(t, { locations: [{ key: "gate", value: { name: "Gate" } }] });
  const { page } = await open(t, host, "#/locations/gate");
  await page.locator(".record-more-details > summary").click();
  await page.getByRole("button", { name: "Edit Region", exact: true }).click();
  const region = page.getByRole("textbox", { name: "Region", exact: true });
  await region.fill("  Northern reach  ");
  await region.press("Enter");
  await page
    .getByRole("button", { name: "Edit Region", exact: true })
    .filter({ hasText: /^Northern reach$/ })
    .waitFor();
  assert.equal((await saved(host, "locations", "gate")).region, "Northern reach");
  await reload(page);
  await page
    .getByRole("button", { name: "Edit Region", exact: true })
    .filter({ hasText: /^Northern reach$/ })
    .waitFor();
});

void test("circumstances autosave while wiki text remains an explicit draft, and Undo affects only the quick edit", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  const source = page.getByRole("textbox", { name: "Overview Markdown", exact: true });
  await source.fill("## An unsaved wiki draft");
  await page.locator(".character-empty-details > summary").click();
  await page.getByRole("button", { name: "Edit Current circumstances", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Current circumstances", exact: true })
    .fill("Travelling north");
  await until(() => writes.length === 1, "circumstances save after a pause");
  const undo = page
    .locator(".character-save-status")
    .getByRole("button", { name: "Undo", exact: true });
  await undo.waitFor();
  assert.equal(await source.inputValue(), "## An unsaved wiki draft");
  assert.deepEqual(await saved(host, "characters", "ryn"), {
    ...character().value,
    circumstances: "Travelling north",
  });
  await undo.click();
  await until(() => writes.length === 2, "undo writes the previous value");
  await undo.waitFor({ state: "detached" });
  assert.equal((await saved(host, "characters", "ryn")).circumstances, "");
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.locator(".character-save-status").getByText("Wiki saved").waitFor();
  assert.equal(writes.length, 3);
  assert.equal(required(writes.at(-1)).mutations[0]?.expectedRevision, 3);
  assert.equal((await saved(host, "characters", "ryn")).description, "## An unsaved wiki draft");
});

void test("failed saves retain values for retry, and edits typed during a pending save are retained", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await failNextWrite(page);
  await page.getByRole("button", { name: "Edit Name", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Retained draft");
  await name.press("Enter");
  await page.getByRole("alert").filter({ hasText: unavailable }).waitFor();
  assert.equal(await name.inputValue(), "Retained draft");
  const delayed = Promise.withResolvers<void>();
  t.after(() => delayed.resolve());
  await page.route(
    "**/api/campaign/transactions",
    async (route) => {
      await delayed.promise;
      await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.locator(".inline-edit-hint").getByText("Saving…", { exact: true }).waitFor();
  await name.fill("Changed while saving");
  await name.press("Enter");
  delayed.resolve();
  await page
    .getByRole("button", { name: "Edit Name", exact: true })
    .filter({ hasText: "Changed while saving" })
    .waitFor();
  assert.equal(writes.length, 3);
  assert.equal((await saved(host, "characters", "ryn")).name, "Changed while saving");
});

void test("wiki conflicts retain the draft until the user reviews and explicitly retries", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  const source = page.getByRole("textbox", { name: "Overview Markdown", exact: true });
  await source.fill("My wiki draft");
  await remote(host, page, "characters", "ryn", {
    ...character().value,
    description: "Another author’s wiki",
  });
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: fieldConflict }).waitFor();
  assert.equal(await source.inputValue(), "My wiki draft");
  assert.equal(writes.length, 0);
  await page.getByRole("button", { name: "Keep my draft", exact: true }).click();
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.locator(".character-save-status").getByText("Wiki saved").waitFor();
  assert.equal((await saved(host, "characters", "ryn")).description, "My wiki draft");
});

void test("a remotely removed character retains open inline and wiki drafts", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await page
    .getByRole("textbox", { name: "Overview Markdown", exact: true })
    .fill("Copyable draft");
  await removedElsewhere(host, page, "characters", "ryn");
  assert.equal(
    await page.getByRole("textbox", { name: "Overview Markdown", exact: true }).inputValue(),
    "Copyable draft",
  );
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: fieldConflict }).waitFor();
  assert.equal(writes.length, 0);
  assert.equal(await storedRecord(host, "characters", "ryn"), undefined);
});

void test("the compact writer applies formatting, preserves source, and retains one draft through expansion", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters/ryn");
  // Wide enough for the whole toolbar beside the shell's sidebar.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  const rich = page.locator(".ProseMirror");
  await rich.click();
  await rich.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Underline", exact: true }).click();
  assert.equal(await rich.locator(".md-effect-underline").textContent(), "Old notes");
  await page.getByRole("button", { name: "Underline", exact: true }).click();
  assert.equal(await rich.locator(".md-effect-underline").count(), 0);
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.getByRole("button", { name: "Text color", exact: true }).click();
  await page.getByRole("button", { name: "Red", exact: true }).click();
  await page.getByRole("button", { name: "Text color", exact: true }).click();
  await page.getByRole("button", { name: "Blue", exact: true }).click();
  await page.getByRole("combobox", { name: "Text size", exact: true }).selectOption("24");
  assert.equal(await rich.locator(".md-color-info").textContent(), "Old notes");
  assert.equal(
    await rich.locator(".md-color-info").evaluate((element) => getComputedStyle(element).color),
    "rgb(144, 202, 249)",
  );
  assert.equal(
    await rich.locator(".md-size-24").evaluate((element) => getComputedStyle(element).fontSize),
    "24px",
  );
  assert.equal(await rich.locator(".md-color-danger").count(), 0);
  await sourceView(page);
  const source = page.getByRole("textbox", { name: "Overview Markdown", exact: true });
  const formatted = await source.inputValue();
  assert.match(formatted, /\*\*/);
  assert.match(formatted, /data-md-size="24"/);
  await source.fill(formatted + "\n\n- [x] An existing task");
  await page.getByRole("button", { name: "Expand writer", exact: true }).click();
  assert.equal(await page.locator("dialog").evaluate((dialog) => dialog.matches(":modal")), true);
  await source.press("End");
  await source.pressSequentially(" remains");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog").evaluate((dialog) => dialog.matches(":modal")), false);
  assert.match(await source.inputValue(), /existing task remains$/);
  await page.getByRole("combobox", { name: "Editor view", exact: true }).selectOption("formatted");
  await rich.locator(".writer-raw-block").filter({ hasText: "existing task remains" }).waitFor();
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.locator(".character-save-status").getByText("Wiki saved").waitFor();
  assert.match(
    stringValue((await saved(host, "characters", "ryn")).description),
    /existing task remains$/,
  );
});

void test("phone writer keeps one toolbar row and reachable formatting menus", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters/ryn", { mobile: true });
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  const toolbar = page.locator(".writer-toolbar");
  assert.ok(required(await toolbar.boundingBox()).height < 60);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "More formatting", exact: true }).click();
  await page
    .locator(".writer-menu")
    .getByRole("combobox", { name: "Text size", exact: true })
    .selectOption("24");
  await page.getByRole("button", { name: "Expand writer", exact: true }).click();
  await page.getByRole("combobox", { name: "Editor view", exact: true }).selectOption("markdown");
  await page.getByRole("textbox", { name: "Overview Markdown", exact: true }).fill("Phone draft");
  await page.keyboard.press("Escape");
  assert.equal(
    await page.getByRole("textbox", { name: "Overview Markdown", exact: true }).inputValue(),
    "Phone draft",
  );
});

void test("pasted formatted content retains campaign references and keeps unsafe HTML inert", async (t) => {
  const value = character();
  value.value.description = "Meet [[Scout|character:scout]].";
  const host = await campaign(t, { characters: [value] });
  const { page } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  const rich = page.locator(".ProseMirror");
  const copied = await rich.locator(".writer-wiki-link").evaluate((element) => element.outerHTML);
  await rich.click();
  await rich.press("ControlOrMeta+End");
  await rich.press("Enter");
  await rich.evaluate((element, html) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      "<p>" +
        html +
        '<a href="javascript:alert(1)">unsafe</a></p><pre data-md-raw="block">- [x] A copied task</pre>',
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, copied);
  assert.equal(await rich.locator(".writer-wiki-link").count(), 2);
  assert.equal(await rich.locator('a[href^="javascript:"]').count(), 0);
  await sourceView(page);
  const source = await page
    .getByRole("textbox", { name: "Overview Markdown", exact: true })
    .inputValue();
  assert.equal(source.split("[[Scout|character:scout]]").length - 1, 2);
  assert.match(source, /- \[x\] A copied task/);
});

void test("authored record and relationship values stay intact in either interface language", async (t) => {
  const host = await campaign(t, {
    characters: [character(), { key: "peer", value: { id: "peer", name: "Title {0} $&" } }],
  });
  const { page } = await open(t, host, "#/characters/ryn/edit");
  await language(page, "cs");
  const form = page.locator("form.record-editor");
  await form.locator('[name="name"]').fill("Name {0} $&");
  await page.getByRole("tab", { name: "Znalost", exact: true }).click();
  await page.getByRole("button", { name: "Přidat otázku", exact: true }).click();
  await page.locator('[data-part="text"]').fill("Untranslated authored question");
  await page.getByRole("tab", { name: "Vazby", exact: true }).click();
  await page.getByRole("button", { name: "Přidat vztah", exact: true }).click();
  await page.locator('[data-part="target"]').selectOption("peer");
  assert.equal(await page.locator('[data-part="target"]').inputValue(), "peer");
  await page.getByRole("button", { name: "Uložit záznam", exact: true }).click();
  await page.locator(".record-save-confirmation").waitFor();
  const stored = await saved(host, "characters", "ryn");
  assert.equal(stored.name, "Name {0} $&");
  assert.deepEqual(
    (stored.unknown as { text: string }[]).map(({ text }) => text),
    ["Untranslated authored question"],
  );
  const relationships = await jsonResponse(await host.admin.get("/api/campaign"));
  assert.ok(
    JSON.stringify(relationships).includes('"target":"peer"'),
    "the relationship to peer is stored",
  );
  await go(page, "#/characters/ryn/edit");
  await language(page, "en");
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Name {0} $&");
});

void test("Czech campaign settings translate closed choices and retain authored definitions", async (t) => {
  const host = await campaign(t, { settings: [gender()] });
  const { page } = await open(t, host, "#/settings/genders", { locale: "cs" });
  await page.getByRole("button", { name: "Upravit", exact: true }).click();
  await page.locator('[name="label"]').fill("Display name {0} $&");
  assert.equal(
    await page.getByLabel("Zobrazovaný název", { exact: true }).inputValue(),
    "Display name {0} $&",
  );
  await page.getByRole("button", { name: "Uložit definici", exact: true }).click();
  await page.locator(".settings-edit-form").waitFor({ state: "detached" });
  assert.deepEqual(await saved(host, "settings", "genders"), [
    { id: "unspecified", label: "Display name {0} $&" },
  ]);
});

void test("character tabs reveal invalid fields and keep all groups in the saved draft", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await editRecordOrDefinition(page);
  const details = page.getByRole("tab", { name: "Details", exact: true });
  await page.getByLabel("Name", { exact: true }).fill("");
  await details.focus();
  await page.keyboard.press("End");
  assert.equal(
    await page.getByRole("tab", { name: "Knowledge", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "name");
  assert.equal(writes.length, 0, "invalid hidden required fields must not submit");
  await page.getByLabel("Name", { exact: true }).fill("New name");
  await details.focus();
  await page.keyboard.press("ArrowRight");
  await page.locator('[name="faction"]').selectOption("party");
  await page.getByRole("tab", { name: "Connections", exact: true }).press("ArrowRight");
  await page.getByRole("spinbutton", { name: "Knowledge", exact: true }).fill("3");
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page.locator('[data-part="text"]').fill("Who sent the letter?");
  await page.getByRole("tab", { name: "Knowledge", exact: true }).press("Home");
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "New name");
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page.locator(".record-save-confirmation").waitFor();
  const stored = await saved(host, "characters", "ryn");
  assert.equal(stored.name, "New name");
  assert.equal(stored.faction, "party");
  assert.equal(stored.knowledge, 3);
  assert.equal((stored.unknown as { text: string }[])[0]?.text, "Who sent the letter?");
});

for (const mobile of [false, true])
  void test(`character editor keeps description and preview usable on ${mobile ? "phone" : "desktop"}`, async (t) => {
    const host = await campaign(t, { characters: [character()] });
    const { page } = await open(t, host, "#/characters/ryn", { mobile });
    await editRecordOrDefinition(page);
    await page.evaluate(() => document.fonts.ready);
    // Read both rectangles in one frame: smooth scrolling changes viewport coordinates.
    const { details, description } = await page.evaluate(() => {
      const details = document.querySelector(".character-editor-details")!.getBoundingClientRect();
      const description = document
        .querySelector(".character-editor-description")!
        .getBoundingClientRect();
      return { details: details.toJSON(), description: description.toJSON() };
    });
    assert.ok(
      mobile
        ? description.y >= details.y + details.height
        : description.x >= details.x + details.width,
      `Editor panes overlap: ${JSON.stringify({ mobile, details, description })}`,
    );
    await sourceView(page);
    await page.getByRole("button", { name: "Expand writer", exact: true }).click();
    const textarea = page.locator('textarea[name="description"]');
    await textarea.fill("## The lighthouse\n\nAn **unfinished** promise.");
    await page
      .locator(".writer-preview")
      .getByRole("heading", { name: "The lighthouse" })
      .waitFor();
    await textarea.press("End");
    await textarea.pressSequentially(" More.");
    assert.equal(
      await textarea.evaluate((element) => element === document.activeElement),
      true,
      "live preview keeps typing focus",
    );
    await page.getByLabel("Editor view", { exact: true }).selectOption("preview");
    assert.equal(await textarea.isVisible(), false);
    await sourceView(page);
    await page.locator(".writer-heading").getByRole("button", { name: "Exit full screen" }).click();
    assert.match(await textarea.inputValue(), /More\.$/);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({
      path: fileURLToPath(
        new URL(
          `../../test-results/character-editor-${mobile ? "phone" : "desktop"}.png`,
          import.meta.url,
        ),
      ),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Save entry", exact: true }).click();
    await page.locator(".record-save-confirmation").waitFor();
    assert.match(stringValue((await saved(host, "characters", "ryn")).description), /More\.$/);
  });

void test("a full-form save without changes keeps every stored value", async (t) => {
  const location = {
    name: "Round trip",
    type: "Port",
    region: "Coast",
    tags: ["harbour", "trade"],
    connections: ["vale"],
    description: "Some *notes*",
    visibility: "public",
    extension: { kept: true },
  };
  const host = await campaign(t, {
    locations: [
      { key: "trip", value: location },
      { key: "vale", value: { name: "Vale" } },
    ],
  });
  const before = await saved(host, "locations", "trip");
  const { page } = await open(t, host, "#/locations/trip/edit");
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page.locator(".record-save-confirmation").waitFor();
  assert.equal(required(await storedRecord(host, "locations", "trip")).revision, 2);
  assert.deepEqual(await saved(host, "locations", "trip"), before);
});

void test("record drafts retain their opening revision and fields across live refresh", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await editRecordOrDefinition(page);
  await page.locator('[name="name"]').fill("My draft");
  await sourceView(page);
  await page.locator('[name="description"]').fill("My draft notes");
  await remote(host, page, "characters", "ryn", character("Remote rename").value);
  assert.equal(await page.locator('[name="name"]').inputValue(), "My draft");
  assert.equal(await page.locator('[name="description"]').inputValue(), "My draft notes");
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page
    .locator("form.record-editor .save-failure")
    .getByText("The entry or its relationships changed.", { exact: false })
    .waitFor();
  assert.equal(writes.length, 0);
  assert.equal((await saved(host, "characters", "ryn")).name, "Remote rename");
});

void test("deleting an edited record uses its opening revision", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await editRecordOrDefinition(page);
  await remote(host, page, "characters", "ryn", character("Changed elsewhere").value);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .locator("form.record-editor .save-failure")
    .getByText("The entry changed before it could be deleted. Refresh and try again.")
    .waitFor();
  assert.equal(writes.length, 0);
  assert.equal((await saved(host, "characters", "ryn")).name, "Changed elsewhere");
});

void test("a remotely deleted record keeps its draft available until explicitly cancelled", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters/ryn");
  await editRecordOrDefinition(page);
  await page.locator('[name="name"]').fill("Keep these notes");
  await removedElsewhere(host, page, "characters", "ryn");
  assert.equal(await page.locator('[name="name"]').inputValue(), "Keep these notes");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "Entry not found" }).count(), 1);
});

void test("repeated Add entry cannot clear a new dirty draft or its unload guard", async (t) => {
  const host = await campaign(t);
  const { page } = await open(t, host, "#/characters");
  await page.getByRole("button", { name: "Add character", exact: true }).click();
  await page.locator('[name="name"]').fill("New hero");
  assert.equal(
    await page.getByRole("button", { name: "Add character", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.evaluate(() => {
      const leave = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(leave);
      return leave.defaultPrevented;
    }),
    true,
  );
});

void test("enum drafts retain values and revisions, including remote removal", async (t) => {
  const host = await campaign(t, { settings: [gender()] });
  const { page, writes } = await open(t, host, "#/settings/genders");
  await editRecordOrDefinition(page);
  await page.locator('[name="label"]').fill("My label");
  await remote(host, page, "settings", "genders", gender("Remote label").value);
  assert.equal(await page.locator('[name="label"]').inputValue(), "My label");
  await page.getByRole("button", { name: "Save definition", exact: true }).click();
  await page
    .locator(".settings-edit-form")
    .getByRole("alert")
    .filter({ hasText: "The definition changed. Your draft is kept" })
    .waitFor();
  assert.equal(writes.length, 0);
  await remote(host, page, "settings", "genders", []);
  assert.equal(await page.locator('[name="label"]').inputValue(), "My label");
});

void test("an empty vocabulary offers a starter set saved as one write", async (t) => {
  const host = await campaign(t);
  const { page, writes } = await open(t, host, "#/settings/genders");
  await page.getByRole("button", { name: "Add a starter set", exact: true }).click();
  await page.locator(".settings-definition").first().waitFor();
  assert.equal(writes.length, 1);
  assert.equal(required(writes[0]).mutations[0]?.expectedRevision, 0);
  assert.deepEqual(
    ((await saved(host, "settings", "genders")) as unknown as { id: string }[]).map(({ id }) => id),
    ["female", "male", "nonbinary", "unknown"],
  );
});

void test("theme choices save immediately against the current appearance revision", async (t) => {
  const host = await campaign(t, {
    settings: [{ key: "appearance", value: { theme: "classic" } }],
  });
  const { page, writes } = await open(t, host, "#/settings/appearance");
  await page.locator('[name="theme"][value="moonlit"]').check();
  await until(() => writes.length === 1, "the theme saves when picked");
  await page.waitForFunction(() => document.documentElement.dataset["theme"] === "moonlit");
  await page.getByText("A theme changes for everyone as soon as you pick it.").waitFor();
  assert.equal(required(writes[0]).mutations[0]?.expectedRevision, 1);
  assert.deepEqual(await saved(host, "settings", "appearance"), { theme: "moonlit" });
  assert.equal(await page.locator('[name="theme"][value="moonlit"]').isChecked(), true);
  await page.locator('[name="theme"][value="classic"]').check();
  await page.waitForFunction(() => document.documentElement.dataset["theme"] === "classic");
  assert.equal(required(writes[1]).mutations[0]?.expectedRevision, 2);
});

void test("saving an older character draft cannot delete a newly added relationship", async (t) => {
  const characters = [character(), { key: "bob", value: { id: "bob", name: "Bob" } }];
  const host = await campaign(t, { characters });
  const { page, writes } = await open(t, host, "#/characters/ryn");
  await editRecordOrDefinition(page);
  await page.locator('[name="title"]').fill("My title");
  const link = relationshipKey("ryn", "bob", "ally");
  await remote(host, page, "relationships", link, { source: "ryn", target: "bob", type: "ally" });
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page
    .locator("form.record-editor .save-failure")
    .getByText("The entry or its relationships changed.", { exact: false })
    .waitFor();
  assert.equal(writes.length, 0);
  assert.ok(await storedRecord(host, "relationships", link));
});

void test("unrelated live changes allow saving and reopening loads the latest record", async (t) => {
  const original = character();
  Object.assign(original.value, { customNotes: { keep: true } });
  const host = await campaign(t, { characters: [original] });
  const { page } = await open(t, host, "#/characters/ryn");
  await editRecordOrDefinition(page);
  await page.locator('[name="title"]').fill("My title");
  await remote(host, page, "locations", "new", { id: "new", name: "New town" });
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page.locator(".record-save-confirmation").waitFor();
  const stored = await saved(host, "characters", "ryn");
  assert.equal(stored.title, "My title");
  assert.deepEqual(stored.customNotes, { keep: true });
  await remote(host, page, "characters", "ryn", { ...stored, name: "Latest name" });
  await editRecordOrDefinition(page);
  assert.equal(await page.locator('[name="name"]').inputValue(), "Latest name");
});

void test("cancelling a conflicted wiki draft resets feedback and allows a fresh save", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  const source = page.getByRole("textbox", { name: "Overview Markdown", exact: true });
  await source.fill("Abandoned wiki draft");
  await page
    .locator(".character-save-status")
    .getByText("Unsaved changes", { exact: true })
    .waitFor();
  await remote(host, page, "characters", "ryn", {
    ...character().value,
    description: "Remote wiki",
  });
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: fieldConflict }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator(".character-save-status")
    .getByText("Saved to campaign", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  await source.fill("Fresh wiki draft");
  await page.getByRole("button", { name: "Save text", exact: true }).click();
  await page.locator(".character-save-status").getByText("Wiki saved", { exact: true }).waitFor();
  assert.equal((await saved(host, "characters", "ryn")).description, "Fresh wiki draft");
  await source.fill("Another unsaved change");
  await page
    .locator(".character-save-status")
    .getByText("Unsaved changes", { exact: true })
    .waitFor();
});

void test("a confirmed field save leaves another field's open draft unsaved", async (t) => {
  const host = await campaign(t, { characters: [character()] });
  const { page } = await open(t, host, "#/characters/ryn");
  await page.getByRole("button", { name: "Edit wiki", exact: true }).click();
  await sourceView(page);
  const source = page.getByRole("textbox", { name: "Overview Markdown", exact: true });
  await source.fill("A wiki draft kept open");
  await page.getByRole("button", { name: "Edit Title", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Captain");
  await title.press("Enter");
  await page
    .getByRole("button", { name: "Edit Title", exact: true })
    .filter({ hasText: "Captain" })
    .waitFor();
  assert.equal(await source.inputValue(), "A wiki draft kept open");
  assert.deepEqual(await saved(host, "characters", "ryn"), {
    ...character().value,
    title: "Captain",
  });
  await page
    .locator(".character-save-status")
    .getByText("Unsaved changes", { exact: true })
    .waitFor();
});
