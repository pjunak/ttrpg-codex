import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { reportBrowserFailure } from "../frontend/test/browser/failure-diagnostics.mts";

async function fixture(t: TestContext, failing: readonly string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "codex-startup-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = join(directory, "startup"),
    attempts: string[] = [],
    diagnostics: string[] = [];
  const original = new Error("Original startup timeout");
  const page: Parameters<typeof reportBrowserFailure>[1] = {
    url() {
      attempts.push("url");
      if (failing.includes("url")) throw new Error("Closed page");
      return "http://fixture/#/view";
    },
    locator() {
      return {
        async innerText() {
          attempts.push("body");
          if (failing.includes("body")) throw new Error("Unreadable page body");
          return "x".repeat(5000);
        },
      };
    },
    async screenshot(options) {
      attempts.push("screenshot");
      if (failing.includes("screenshot")) throw new Error("Screenshot unavailable");
      assert.ok(options?.path);
      const image = Buffer.from("synthetic image");
      await writeFile(options.path, image);
      return image;
    },
  };
  return {
    artifact,
    attempts,
    diagnostics,
    original,
    async run(
      errors: readonly string[] = [],
      requests: ReadonlyMap<string, string> = new Map(),
      state?: () => Promise<unknown>,
    ) {
      await assert.rejects(
        reportBrowserFailure(
          {
            diagnostic(message) {
              if (failing.includes("diagnostic")) throw new Error("Reporting unavailable");
              diagnostics.push(message);
            },
          },
          page,
          artifact,
          { errors, requests, state },
          original,
        ),
        (error) => error === original,
      );
    },
    async record() {
      return JSON.parse(await readFile(artifact + ".json", "utf8"));
    },
  };
}

void test("unreadable startup body still saves request evidence and a screenshot", async (t) => {
  const probe = await fixture(t, ["body"]);
  await probe.run(["page error"], new Map([["/api/campaign", "pending"]]));
  const record = await probe.record();
  assert.equal(record.body, "unavailable");
  assert.deepEqual(record.errors, ["page error"]);
  assert.deepEqual(record.requests, { "/api/campaign": "pending" });
  assert.deepEqual(record.captureFailures, ["body"]);
  assert.equal(await readFile(probe.artifact + ".png", "utf8"), "synthetic image");
  assert.ok(probe.diagnostics.some((message) => message.includes("body")));
});

void test("startup JSON write failure still saves the screenshot and original error", async (t) => {
  const probe = await fixture(t);
  await mkdir(probe.artifact + ".json");
  await probe.run();
  assert.equal(await readFile(probe.artifact + ".png", "utf8"), "synthetic image");
  assert.ok(probe.diagnostics.some((message) => message.endsWith("unavailable: json")));
  assert.ok(
    !probe.diagnostics.some(
      (message) => message.startsWith("Browser failure evidence:") && message.includes(".json"),
    ),
  );
});

void test("startup screenshot failure retains JSON and the original error", async (t) => {
  const probe = await fixture(t, ["screenshot"]);
  await probe.run();
  assert.equal((await probe.record()).body.length, 4000);
  assert.deepEqual((await probe.record()).captureFailures, ["screenshot"]);
  assert.ok(probe.diagnostics.some((message) => message.includes(".json")));
});

void test("closed-page and reporting failures cannot mask the original startup error", async (t) => {
  const probe = await fixture(t, ["url", "body", "screenshot", "diagnostic"]);
  await probe.run();
  assert.deepEqual(probe.attempts, ["url", "body", "screenshot"]);
  assert.deepEqual((await probe.record()).captureFailures, ["url", "body", "screenshot"]);
  assert.equal((await probe.record()).url, "unavailable");
});

void test("startup evidence bounds page and request text without copying it to diagnostics", async (t) => {
  const probe = await fixture(t);
  await probe.run(
    Array.from({ length: 40 }, () => "e".repeat(2000)),
    new Map(
      Array.from({ length: 90 }, (_, index) => ["/" + index + "p".repeat(3000), "r".repeat(2000)]),
    ),
  );
  const record = await probe.record();
  assert.equal(record.errors.length, 32);
  assert.ok(record.errors.every((error: string) => error.length === 1000));
  assert.equal(Object.keys(record.requests).length, 80);
  assert.ok(Object.keys(record.requests).every((path) => path.length === 2000));
  assert.ok(
    Object.values(record.requests).every(
      (status) => typeof status === "string" && status.length === 1000,
    ),
  );
  assert.equal(record.body.length, 4000);
  assert.deepEqual(record.captureFailures, []);
  assert.ok(probe.diagnostics.every((message) => !message.includes("x".repeat(100))));
});

void test("custom fixture-state failure still saves independent page evidence", async (t) => {
  const probe = await fixture(t);
  await probe.run([], new Map(), async () => {
    throw new Error("Fixture state unavailable");
  });
  const record = await probe.record();
  assert.equal(record.body.length, 4000);
  assert.deepEqual(record.captureFailures, ["state"]);
  assert.equal(await readFile(probe.artifact + ".png", "utf8"), "synthetic image");
  const readable = await fixture(t);
  await readable.run([], new Map(), async () => ({ category: "addons", dirty: true }));
  assert.deepEqual((await readable.record()).state, { category: "addons", dirty: true });
});
