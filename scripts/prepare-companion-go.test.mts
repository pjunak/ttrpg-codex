import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { prepareCompanionGo } from "./prepare-companion-go.mts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "companion go "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, source: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  write("dependency/go.mod", "module example.test/dependency\n\ngo 1.27.1\n");
  write("dependency/value.go", "package dependency\nconst Value = 42\n");
  write(
    "host/go.mod",
    "module example.test/host\n\ngo 1.27.1\n\nrequire example.test/dependency v1.1.0\n",
  );
  write(
    "host/value.go",
    'package host\nimport "example.test/dependency"\nconst Value = dependency.Value\n',
  );
  write(
    "companion/go.mod",
    "module example.test/companion\n\ngo 1.27.1\n\n" +
      "require example.test/host v0.0.0\nrequire example.test/dependency v1.0.0 // indirect\n" +
      "replace example.test/host => ../host\nreplace example.test/dependency => ../dependency\n",
  );
  write("companion/go.sum", "");
  write(
    "companion/value_test.go",
    'package companion\nimport ("testing"; "example.test/host")\n' +
      "func TestHost(t *testing.T) { if host.Value != 42 { t.Fatal(host.Value) } }\n",
  );
  const repository = join(root, "companion");
  const env = { ...process.env, GOFLAGS: "-mod=readonly", GOWORK: "off", GOPROXY: "off" };
  return { root, write, repository, env };
}

void test("candidate host dependency updates pass without changing pinned companion locks", (t) => {
  const { root, repository, env } = fixture(t);
  const source = readFileSync(join(repository, "go.mod"));
  const before = spawnSync("go", ["test", "./..."], {
    cwd: repository,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(before.status, 0);
  assert.match(before.stderr, /updates to go\.mod needed/);

  env.GOFLAGS = prepareCompanionGo(repository, join(root, "scratch module"));
  const output = execFileSync("go", ["test", "./..."], {
    cwd: repository,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.match(output, /ok\s+example\.test\/companion/);
  assert.match(readFileSync(join(root, "scratch module/candidate.mod"), "utf8"), /v1\.1\.0/);
  assert.deepEqual(readFileSync(join(repository, "go.mod")), source);
  assert.equal(readFileSync(join(repository, "go.sum"), "utf8"), "");

  const selected = execFileSync("go", ["list", "-m", "example.test/host"], {
    cwd: repository,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.match(selected, /=> \.\.\/host/);
});

void test("isolated analysis tools and their child commands use the candidate module graph", (t) => {
  const { root, write, repository, env } = fixture(t);
  write("analyzer/go.mod", "module example.test/analyzer\n\ngo 1.27.1\n");
  write(
    "analyzer/main.go",
    'package main\nimport ("os"; "os/exec")\n' +
      'func main() { cmd := exec.Command("go", "list", "-m", "example.test/dependency"); ' +
      "cmd.Stdout = os.Stdout; cmd.Stderr = os.Stderr; if cmd.Run() != nil { os.Exit(1) } }\n",
  );
  write(
    "companion/go.tools.mod",
    "module example.test/tools\n\ngo 1.27.1\n\n" +
      "tool example.test/analyzer\nrequire example.test/analyzer v1.0.0\n" +
      "replace example.test/analyzer => ../analyzer\n",
  );
  const tools = readFileSync(join(repository, "go.tools.mod"));
  env.GOFLAGS = prepareCompanionGo(repository, join(root, "scratch module"));
  const output = execFileSync("go", ["tool", "-modfile=go.tools.mod", "analyzer"], {
    cwd: repository,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.match(output, /example\.test\/dependency v1\.1\.0/);
  assert.deepEqual(readFileSync(join(repository, "go.tools.mod")), tools);
});
