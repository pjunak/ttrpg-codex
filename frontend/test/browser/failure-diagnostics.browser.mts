import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { reportBrowserFailure } from "./failure-diagnostics.mts";

void test("a closed startup page retains its original timeout and independent JSON", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-closed-startup-"));
  assert.equal(dirname(directory), tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<main>Controlled character startup</main>");
  let original: unknown;
  try {
    await page.getByLabel("STR", { exact: true }).waitFor({ timeout: 50 });
  } catch (cause) {
    original = cause;
  }
  assert.ok(original instanceof Error);
  assert.equal(original.name, "TimeoutError");
  await page.close();
  const artifact = join(directory, "startup");
  const diagnostics: string[] = [];
  await assert.rejects(
    reportBrowserFailure(
      { diagnostic: (message) => diagnostics.push(message) },
      page,
      artifact,
      { errors: [] },
      original,
    ),
    (cause) => cause === original,
  );
  const record = JSON.parse(await readFile(artifact + ".json", "utf8")) as {
    body: string;
    captureFailures: string[];
  };
  assert.equal(record.body, "unavailable");
  assert.deepEqual(record.captureFailures, ["body", "screenshot"]);
  assert.ok(diagnostics.includes(`Browser failure evidence: ${artifact}.json`));
});
