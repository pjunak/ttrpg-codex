import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { installedHostDiagnostics as createHostDiagnostics } from "../frontend/test/browser/installed-host-diagnostics.mts";
import type { PublicFailureRecord } from "../frontend/test/browser/public-failure-evidence.mts";

const installedHostDiagnostics = (
  output: string,
  host: Parameters<typeof createHostDiagnostics>[1],
) => createHostDiagnostics(output, host, async () => {});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "codex-host-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function records(directory: string) {
  const names = await readdir(directory);
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))),
  );
}

void test("overlapping failures and separate fixture runs retain their own HTTP and transport evidence", async (t) => {
  const output = await fixture(t);
  const process = { pid: 42, exitCode: null, signalCode: null };
  const diagnostics = installedHostDiagnostics(output, () => process);
  const transportFailure = new Error("private request body");
  const httpFailure = new Error("private response body");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = diagnostics.run(
    "read-generation",
    async () => {
      await held;
      throw transportFailure;
    },
    "load",
  );
  await assert.rejects(
    diagnostics.run(
      "call-service",
      async (evidence) => {
        evidence.status = 403;
        throw httpFailure;
      },
      "save",
    ),
    (cause) => cause === httpFailure,
  );
  release();
  await assert.rejects(pending, (cause) => cause === transportFailure);
  await assert.rejects(
    installedHostDiagnostics(output, () => process).run(
      "call-service",
      async (evidence) => {
        evidence.status = 409;
        throw httpFailure;
      },
      "save",
    ),
    (cause) => cause === httpFailure,
  );
  const saved = await records(output);
  assert.equal(saved.length, 3);
  assert.equal(new Set(saved.map((record) => record.runId)).size, 2);
  assert.deepEqual(
    saved
      .map((record) => [record.stage, record.method, record.status])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [
      ["call-service", "save", 403],
      ["call-service", "save", 409],
      ["read-generation", "load", undefined],
    ],
  );
  assert.ok(saved.every((record) => record.hostPID === 42));
  assert.ok(saved.every((record) => !JSON.stringify(record).includes("private")));
});

void test("failure evidence bounds the host tail and captures process exit at failure time", async (t) => {
  const output = await fixture(t);
  const process: { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  };
  const diagnostics = installedHostDiagnostics(output, () => process);
  diagnostics.append("old output that should expire");
  diagnostics.append(Buffer.from("x".repeat(32000)));
  diagnostics.append("latest output");
  process.exitCode = 17;
  await assert.rejects(
    diagnostics.run("enable-rule-sources", async () => {
      throw new Error("request failed");
    }),
  );
  const [record] = await records(output);
  assert.equal(record.hostOutput.length, 16000);
  assert.ok(record.hostOutput.endsWith("latest output"));
  assert.ok(!record.hostOutput.includes("old output"));
  assert.equal(record.hostExitCode, 17);
  assert.equal(record.hostSignal, null);
});

void test("artifact write failure preserves the original request error", async (t) => {
  const directory = await fixture(t);
  const output = join(directory, "not-a-directory");
  await writeFile(output, "occupied");
  const warnings = t.mock.method(console, "warn", () => {});
  const original = new Error("original transport error");
  await assert.rejects(
    installedHostDiagnostics(output, () => undefined).run("connect-service", async () => {
      throw original;
    }),
    (cause) => cause === original,
  );
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(await readFile(output, "utf8"), "occupied");
});

void test("successful fixture actions return unchanged without writing failure evidence", async (t) => {
  const output = await fixture(t);
  const result = { revision: 4 };
  assert.equal(
    await installedHostDiagnostics(output, () => undefined).run(
      "seed-character",
      async () => result,
    ),
    result,
  );
  assert.deepEqual(await readdir(output), []);
});

void test("public setup metadata survives failure of the private capture", async (t) => {
  const directory = await fixture(t);
  const output = join(directory, "occupied");
  await writeFile(output, "unchanged");
  const saved: PublicFailureRecord[] = [];
  t.mock.method(console, "warn", () => {});
  const original = new Error("Private setup failure");
  await assert.rejects(
    createHostDiagnostics(
      output,
      () => ({ pid: 42, exitCode: -1073741515, signalCode: null }),
      async (record) => {
        saved.push(record);
      },
    ).run("seed-character", async (evidence) => {
      evidence.status = 503;
      throw original;
    }),
    (cause) => cause === original,
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.status, 503);
  assert.equal(saved[0]!.host?.exitCode, -1073741515);
  assert.equal(saved[0]!.stage, "seed-character");
  assert.ok(!JSON.stringify(saved).includes(original.message));
});

void test("public reporting failure preserves the exact service error and private record", async (t) => {
  const output = await fixture(t);
  t.mock.method(console, "warn", () => {});
  const original = new Error("Original service transport failure");
  await assert.rejects(
    createHostDiagnostics(
      output,
      () => undefined,
      async () => {
        throw new Error("Public metadata unavailable");
      },
    ).run(
      "call-service",
      async () => {
        throw original;
      },
      "load",
    ),
    (cause) => cause === original,
  );
  const saved = await records(output);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].method, "load");
});
