import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { InstalledFixture } from "./fixture-types.mts";
import { jsonResponse } from "./installed-graph-fixture.mts";

const queryPattern = "**/api/addons/dm-tools/generations/*/data/query";
const recoveryKey = JSON.stringify(["dm-tools-planner-drafts.v1", "dm-tools", "dm"]);

export async function exercisePlannerStartup({
  t,
  open,
  admin,
  csrf,
  output,
  mobile,
  failure,
}: Pick<InstalledFixture, "t" | "open" | "admin" | "csrf" | "output"> & {
  mobile: boolean;
  failure: "held" | "rejected";
}) {
  const prefix = `startup-${failure}-${mobile ? "phone" : "desktop"}`;
  const parent = prefix + "-scope",
    child = prefix + "-child";
  const generation = (await jsonResponse(await admin.get("/api/admin/addons/dm-tools"))).state
    .activeGenerationId;
  const base = `/api/addons/dm-tools/generations/${generation}/data`;
  const headers = { "X-Codex-CSRF": csrf };
  const item = (id: string, parentId: string | null) => ({
    id,
    schemaVersion: 3,
    kind: "quest",
    parentId,
    title: id,
    summary: "",
    objective: "",
    body: "Saved campaign text",
    setup: "",
    resolution: "",
    tags: [],
    updatedAt: 1,
  });
  await jsonResponse(
    await admin.post(`${base}/transactions`, {
      headers,
      data: {
        contractVersion: "addon-data-transaction.v1",
        mutations: [item(parent, null), item(child, parent)].map((value) => ({
          operation: "put",
          kind: "collection",
          dataId: "planning_items",
          key: value.id,
          expectedRevision: 0,
          value,
        })),
      },
    }),
  );
  const records = async () =>
    (
      await jsonResponse(
        await admin.post(`${base}/query`, {
          headers,
          data: {
            contractVersion: "addon-data-query.v1",
            kind: "collection",
            dataId: "planning_items",
            limit: 200,
            where: [],
          },
        }),
      )
    ).documents;
  const before = await records();
  const page = await open(t, "dm", mobile);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/data/transactions")) writes++;
  });
  const reload = page.getByRole("button", { name: "Reload planner", exact: true });
  const loading = page.getByText("Loading story planner…", { exact: true });
  const ready = page.locator('.dm-planner-shell[aria-busy="false"]');

  if (failure === "held") {
    const held = [0, 1].map(() => ({
      received: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
      finished: Promise.withResolvers<void>(),
    }));
    t.after(() => {
      for (const read of held) read.release.resolve();
    });
    let reads = 0;
    await page.route(queryPattern, async (route) => {
      if (route.request().postDataJSON().dataId !== "planning_items") return route.continue();
      const read = held[reads++];
      if (!read) return route.continue();
      const response = await route.fetch();
      read.received.resolve();
      await read.release.promise;
      try {
        await route.fulfill({ response });
      } finally {
        read.finished.resolve();
      }
    });
    await page.goto(`/#/addons/dm-tools/planner?item=${parent}`);
    await held[0]!.received.promise;
    await loading.waitFor();
    await page.screenshot({ path: resolve(output, `${prefix}-loading.png`), fullPage: true });
    assert.equal(await reload.count(), 1, "a stalled initial read must expose Reload planner");
    assert.equal(await reload.isEnabled(), true);
    await reload.focus();
    await page.keyboard.press("Enter");
    await held[1]!.received.promise;
    held[0]!.release.resolve();
    await held[0]!.finished.promise;
    await loading.waitFor();
    assert.equal(
      await ready.count(),
      0,
      "an obsolete response must not finish the replacement read",
    );
    assert.equal(await reload.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await ready.waitFor();
    held[1]!.release.resolve();
    await held[1]!.finished.promise;
    await page.locator(`[data-item-id="${child}"]`).waitFor();
    assert.equal(await reload.evaluate((node) => node === document.activeElement), true);
  } else {
    const copy = JSON.stringify({
      format: "dm-tools-planner-drafts.v1",
      drafts: [
        [
          `planning_items:${child}`,
          {
            revision: 1,
            baseline: { body: "Saved campaign text" },
            values: { body: "Retained startup draft" },
          },
        ],
      ],
      provisional: null,
      unconfirmed: [],
      editor: child,
      tab: "details",
    });
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), {
      key: recoveryKey,
      value: copy,
    });
    let reject = true;
    await page.route(queryPattern, (route) => {
      if (route.request().postDataJSON().dataId !== "planning_items" || !reject)
        return route.continue();
      reject = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await page.goto(`/#/addons/dm-tools/planner?item=${parent}`);
    await page.locator(".dm-tools-planner [role=alert]").waitFor();
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey), copy);
    await page.screenshot({ path: resolve(output, `${prefix}-error.png`), fullPage: true });
    await reload.focus();
    await page.keyboard.press("Enter");
    const resume = page.getByRole("button", { name: "Resume drafts", exact: true });
    await resume.waitFor();
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), recoveryKey), copy);
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download drafts", exact: true }).click();
    const draftFile = resolve(output, `${prefix}-drafts.txt`);
    await (await downloaded).saveAs(draftFile);
    assert.match(await readFile(draftFile, "utf8"), /Retained startup draft/);
    await resume.click();
    assert.equal(
      await page.getByLabel("Body", { exact: true }).inputValue(),
      "Retained startup draft",
    );
  }
  assert.equal(writes, 0, "startup recovery must never save or retry a write");
  assert.deepEqual(await records(), before);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, `${prefix}-recovered.png`), fullPage: true });
}
