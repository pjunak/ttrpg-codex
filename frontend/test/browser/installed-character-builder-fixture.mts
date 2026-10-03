import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import type { APIRequestContext, Browser, Locator, Request } from "playwright";
import { jsonResponse } from "./installed-graph-fixture.mts";
import { trackBrowserContext } from "./browser-diagnostics.mts";

export interface Fixture {
  admin: APIRequestContext;
  browser: Browser;
  csrf: string;
  origin: string;
  output: string;
  call(method: string, params: Record<string, unknown>): ReturnType<typeof jsonResponse>;
}
export async function createCharacterRecord(f: Fixture, key: string) {
  await jsonResponse(
    await f.admin.post("/api/campaign/transactions", {
      headers: { "X-Codex-CSRF": f.csrf },
      data: {
        contractVersion: "campaign-mutation.v1",
        mutations: [
          {
            operation: "put",
            collection: "characters",
            key,
            expectedRevision: 0,
            value: { id: key, name: key, knowledge: 4, visibility: "public" },
          },
        ],
      },
    }),
  );
  const loaded = await f.call("load", { key });
  if (loaded.status !== "ready" || !loaded.evaluation) {
    const providers = await Promise.all(
      ["dnd-sheets", "dnd-engine", "dnd-2024-compendium"].map(async (id) => {
        const snapshot = await jsonResponse(await f.admin.get("/api/admin/addons/" + id));
        return { id, state: snapshot.state, runtime: snapshot.runtime };
      }),
    );
    assert.fail(
      "Character creation requires connected rules: " + JSON.stringify({ key, loaded, providers }),
    );
  }
  return loaded;
}
export async function createCharacter(f: Fixture, key: string) {
  const loaded = await createCharacterRecord(f, key);
  const inputs = loaded.evaluation.inputs;
  inputs.build.method = "array";
  inputs.build.baseScores = { STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 };
  return inputs;
}
export async function save(
  f: Fixture,
  key: string,
  inputs: Record<string, unknown>,
  revision: number,
  suffix: string,
) {
  const result = await f.call("save", {
    key,
    operation: "build",
    operationId: key + "-" + suffix,
    summary: "Builder acceptance",
    expectedRevision: revision,
    inputs,
  });
  assert.equal(
    result.status,
    "ready",
    JSON.stringify({
      status: result.status,
      message: result.message,
      issues: result.evaluation?.guidance.saveIssues,
    }),
  );
  return result;
}
export async function openBuilder(t: TestContext, f: Fixture, key: string, locale = "en") {
  return openSheet(t, f, key, locale, "builder");
}
export async function openSheet(
  t: TestContext,
  f: Fixture,
  key: string,
  locale = "en",
  initialTab = "sheet",
) {
  const errors: string[] = [];
  const context = await f.browser.newContext({
    storageState: await f.admin.storageState(),
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const close = await trackBrowserContext(t, context, () => assert.deepEqual(errors, []));
  await context.addInitScript((locale) => localStorage.setItem("codex_lang", locale), locale);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.origin + "/#/characters/" + key);
  await page.locator("#character-view-addons").click();
  const sheet = page.locator(".addon-dnd-character");
  await sheet.locator("#dnd-tab-" + initialTab).click();
  await page.waitForFunction(
    () => !document.querySelector(".addon-dnd-character")?.hasAttribute("aria-busy"),
  );
  const status = sheet.locator("[data-character-status]");
  return {
    close,
    page,
    sheet,
    status,
    read: () => f.call("load", { key }),
    saveChange: async (change: () => Promise<unknown>) => {
      const requests = new Set<Request>();
      const started = (request: Request) => {
        if (!request.url().endsWith("/services/call") || request.method() !== "POST") return;
        const body = request.postDataJSON();
        if (
          body?.contract === "dnd5e.character" &&
          body.method === "save" &&
          body.params?.key === key
        )
          requests.add(request);
      };
      page.on("request", started);
      try {
        // Only a write started by this action can acknowledge it. Reuse its
        // persisted result instead of requesting another full rules evaluation.
        const [response] = await Promise.all([
          page.waitForResponse((response) => requests.has(response.request())),
          change(),
        ]);
        assert.equal(response.ok(), true, await response.text());
        const result = (await response.json()).result;
        assert.equal(result?.status, "ready", JSON.stringify(result));
        assert.equal(result.key, key, "The acknowledgement must belong to this character");
        assert.equal(
          result.revision,
          response.request().postDataJSON().params.expectedRevision + 1,
          "A new UI action must commit its next revision",
        );
        await status.filter({ hasText: locale === "cs" ? /^Uloženo$/ : /^Saved$/ }).waitFor();
        return result as Record<string, any>;
      } finally {
        page.off("request", started);
      }
    },
  };
}
export async function choose(sheet: Locator, name: string, value: string) {
  const combo = sheet.getByRole("combobox", { name, exact: true });
  await combo.fill(value);
  await sheet.getByRole("option", { name: value, exact: true }).click();
}
