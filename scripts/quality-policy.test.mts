import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("./", import.meta.url));
const root = resolve(scripts, "..");

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(scripts, "quality-probe-"));
  t.after(() => {
    assert.equal(dirname(directory), resolve(scripts));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

void test("typed lint rejects forgotten work inside and outside test callbacks", (t) => {
  const filename = join(fixture(t), "promises.mts");
  writeFileSync(
    filename,
    'import { test } from "node:test";\n' +
      'void test("registered", async () => {\n' +
      '  Promise.resolve("forgotten work");\n' +
      '  await Promise.resolve("handled");\n' +
      "});\n" +
      "const fake = { test: async () => {} };\n" +
      "fake.test();\n",
  );
  const manifest = JSON.parse(
    readFileSync(join(root, "node_modules/oxlint/package.json"), "utf8"),
  ) as { bin: { oxlint: string } };
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/oxlint", manifest.bin.oxlint),
      "--type-aware",
      "--tsconfig",
      "tsconfig.node.json",
      "--format",
      "json",
      filename,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout) as {
    diagnostics: { code: string; labels: { span: { line: number } }[] }[];
  };
  assert.deepEqual(
    output.diagnostics
      .filter((diagnostic) => diagnostic.code === "typescript(no-floating-promises)")
      .map((diagnostic) => diagnostic.labels[0]!.span.line)
      .sort((a, b) => a - b),
    [3, 7],
    "Ordinary promises are checked even inside Node test callbacks",
  );
});

void test("source guard rejects new JavaScript before it is staged", (t) => {
  const filename = join(fixture(t), "accidental.mjs");
  writeFileSync(filename, "export const accidental = true;\n");
  const result = spawnSync(process.execPath, [join(scripts, "check-source.mts")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accidental\.mjs/);
});
