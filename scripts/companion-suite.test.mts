import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  companionInputs,
  requireNoSkips,
  runInstalledProcess,
  suiteSummary,
  verifyPackages,
  type SuiteEvidence,
} from "./companion-suite.mts";

function sample(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "companion-proof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidence: SuiteEvidence = {
    contractVersion: "companion-suite.v1",
    hostCommit: "a".repeat(40),
    hostDirty: false,
    packages: [],
  };
  for (const id of Object.keys(companionInputs) as (keyof typeof companionInputs)[]) {
    const bytes = Buffer.from("synthetic ZIP " + id),
      file = id + ".zip";
    writeFileSync(join(directory, file), bytes);
    evidence.packages.push({
      id,
      version: "1.0.0",
      file,
      sourceCommit: "b".repeat(40),
      sourceDirty: false,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { directory, evidence };
}
void test("publication supplies every exact inspected ZIP and refuses partial coverage", (t) => {
  const { directory, evidence } = sample(t),
    environment = verifyPackages(evidence, directory, true);
  assert.deepEqual(Object.keys(environment).sort(), Object.values(companionInputs).sort());
  evidence.packages.pop();
  assert.throws(() => verifyPackages(evidence, directory, true), /every companion ZIP/);
  assert.equal(Object.keys(verifyPackages(evidence, directory, false)).length, 3);
});
void test("changed, duplicate and escaped artifact paths cannot replace an inspected package", (t) => {
  const { directory, evidence } = sample(t),
    first = evidence.packages[0]!;
  writeFileSync(join(directory, first.file), "replacement");
  assert.throws(() => verifyPackages(evidence, directory, true), /changed after inspection/);
  first.file = "../outside.zip";
  assert.throws(() => verifyPackages(evidence, directory, true), /Invalid companion/);
  const second = sample(t);
  second.evidence.packages.push(second.evidence.packages[0]!);
  assert.throws(() => verifyPackages(second.evidence, second.directory, true), /Duplicate/);
});
void test("missing or skipped installed acceptance cannot pass publication", () => {
  requireNoSkips("TAP version 13\n# tests 23\n# skipped 0\n");
  for (const text of ["", "# skipped 1\n", "# skipped 0\n# skipped 2\n"]) {
    assert.throws(() => requireNoSkips(text), /zero skipped/);
  }
});

void test("failed acceptance still identifies exact sources without claiming publication success", (t) => {
  const { evidence } = sample(t),
    failed = suiteSummary(evidence, true, false);
  assert.match(failed, /acceptance failed; publication is blocked/);
  assert.doesNotMatch(failed, /passed/);
  for (const item of evidence.packages) {
    assert.ok(failed.includes(item.id));
    assert.ok(failed.includes(item.sourceCommit));
    assert.ok(failed.includes(item.sha256));
  }
  assert.match(suiteSummary(evidence, true, true), /zero skipped tests/);
  assert.match(suiteSummary(evidence, false, true), /does not establish publication coverage/);
});

void test("installed progress is reported and saved before the child can finish", async (t) => {
  const { directory } = sample(t),
    signal = join(directory, "continue"),
    outputFile = join(directory, "installed.tap");
  writeFileSync(signal, "waiting");
  let reported = "";
  const result = await runInstalledProcess(
    process.execPath,
    [
      "-e",
      `const fs = require('node:fs');
       const signal = process.argv[1];
       const guard = setTimeout(() => process.exit(6), 2000);
       const watcher = fs.watch(signal, () => {
         if (fs.readFileSync(signal, 'utf8') !== 'continue') return;
         watcher.close(); clearTimeout(guard);
         process.stdout.write('# tests 1\\n# skipped 0\\n');
       });
       process.stdout.write('phase-start\\n');`,
      signal,
    ],
    {
      cwd: directory,
      env: process.env,
      outputFile,
      report: (chunk) => {
        reported += chunk;
        if (reported === "phase-start\n") {
          assert.equal(readFileSync(outputFile, "utf8"), reported);
          writeFileSync(signal, "continue");
        }
      },
      reportError: () => {},
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, reported);
  assert.equal(readFileSync(outputFile, "utf8"), result.stdout);
  requireNoSkips(result.stdout);
});

void test("failed installed processes preserve partial output and their exit status", async (t) => {
  const { directory } = sample(t),
    outputFile = join(directory, "installed.tap");
  let errors = "";
  const result = await runInstalledProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write('started\\n'); process.stderr.write('failed\\n'); process.exitCode = 7",
    ],
    {
      cwd: directory,
      env: process.env,
      outputFile,
      report: () => {},
      reportError: (chunk) => {
        errors += chunk;
      },
    },
  );
  assert.equal(result.status, 7);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "started\n");
  assert.equal(readFileSync(outputFile, "utf8"), result.stdout);
  assert.equal(errors, "failed\n");
  assert.throws(() => requireNoSkips(result.stdout), /zero skipped/);
});

void test("installed output bounds stop excessive stdout and stderr", async (t) => {
  const { directory } = sample(t);
  for (const stream of ["stdout", "stderr"]) {
    const outputFile = join(directory, stream + ".tap"),
      result = await runInstalledProcess(
        process.execPath,
        ["-e", `process.${stream}.write(Buffer.alloc((32 << 20) + 65536, 'x'))`],
        { cwd: directory, env: process.env, outputFile, report: () => {}, reportError: () => {} },
      );
    assert.match(result.error?.message ?? "", new RegExp(stream + " exceeds 32 MiB"));
    assert.ok(statSync(outputFile).size <= 32 << 20);
  }
});

void test("installed startup errors still settle with an empty diagnostic file", async (t) => {
  const { directory } = sample(t),
    outputFile = join(directory, "installed.tap"),
    result = await runInstalledProcess(join(directory, "missing-program"), [], {
      cwd: directory,
      env: process.env,
      outputFile,
      report: () => {},
      reportError: () => {},
    });
  assert.ok(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(outputFile, "utf8"), "");
});
