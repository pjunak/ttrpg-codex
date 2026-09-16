import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtAddonArchive } from "./inspect-addon-builds.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const companionInputs = {
  "dm-tools": "CODEX_DM_TOOLS_ZIP",
  "dnd-engine": "CODEX_ENGINE_ZIP",
  "dnd-sheets": "CODEX_SHEETS_ZIP",
  "dnd-2024-compendium": "CODEX_COMPENDIUM_ZIP",
} as const;
type AddonId = keyof typeof companionInputs;
export interface PackageEvidence { id: AddonId; version: string; sourceCommit: string; sourceDirty: boolean; file: string; sha256: string; bytes: number }
export interface SuiteEvidence { contractVersion: "companion-suite.v1"; hostCommit: string; hostDirty: boolean; packages: PackageEvidence[] }
const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
function git(directory: string, args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", windowsHide: true }).trim();
}

export function verifyPackages(evidence: SuiteEvidence, directory: string, required: boolean): Record<string, string> {
  if (evidence.contractVersion !== "companion-suite.v1" || !/^[a-f0-9]{40,64}$/.test(evidence.hostCommit) ||
      typeof evidence.hostDirty !== "boolean" || !Array.isArray(evidence.packages)) throw new Error("Invalid companion provenance");
  const result: Record<string, string> = {};
  for (const item of evidence.packages) {
    if (!Object.hasOwn(companionInputs, item.id) || item.file !== item.id + ".zip" ||
        item.file !== basename(item.file) || !/^[a-f0-9]{40,64}$/.test(item.sourceCommit) ||
        typeof item.sourceDirty !== "boolean" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 || typeof item.version !== "string") throw new Error("Invalid companion package evidence");
    const variable = companionInputs[item.id];
    if (result[variable]) throw new Error("Duplicate companion package");
    const path = resolve(directory, item.file);
    if (!statSync(path).isFile() || statSync(path).size !== item.bytes || digest(path) !== item.sha256) throw new Error("Companion package changed after inspection: " + item.id);
    result[variable] = path;
  }
  const missing = Object.values(companionInputs).filter(variable => !result[variable]);
  if (required && missing.length) throw new Error("Publication requires every companion ZIP: " + missing.join(", "));
  for (const variable of ["CODEX_DM_TOOLS_ZIP", "CODEX_ENGINE_ZIP", "CODEX_SHEETS_ZIP"]) {
    if (!result[variable]) throw new Error("Missing public companion package: " + variable);
  }
  return result;
}

export function prepareSuite(repositories: string[], directory = join(root, "release", "companions")): SuiteEvidence {
  if (!repositories.length) throw new Error("Companion repositories are required");
  mkdirSync(directory, { recursive: true });
  const evidence: SuiteEvidence = { contractVersion: "companion-suite.v1", hostCommit: git(root, ["rev-parse", "HEAD"]),
    hostDirty: !!git(root, ["status", "--porcelain", "--untracked-files=no"]), packages: [] };
  for (const repository of repositories) {
    const archive = builtAddonArchive(repository);
    const report = JSON.parse(execFileSync("go", ["run", "./cmd/codex-addon-inspect", "-compact", archive],
      { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 << 20 })) as { ok?: boolean; archiveSha256?: string; manifest?: { id?: string; version?: string } };
    const id = report.manifest?.id;
    if (!report.ok || !id || !Object.hasOwn(companionInputs, id) || !report.manifest?.version || report.archiveSha256 !== digest(archive)) throw new Error("Unexpected inspected companion");
    const file = id + ".zip"; copyFileSync(archive, join(directory, file));
    evidence.packages.push({ id: id as AddonId, version: report.manifest.version, file, sha256: report.archiveSha256,
      bytes: statSync(archive).size, sourceCommit: git(repository, ["rev-parse", "HEAD"]),
      sourceDirty: !!git(repository, ["status", "--porcelain", "--untracked-files=no"]) });
  }
  verifyPackages(evidence, directory, false);
  writeFileSync(join(directory, "provenance.json"), JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

export function requireNoSkips(output: string): void {
  const counts = [...output.matchAll(/^# skipped (\d+)\s*$/gm)];
  const tests = /^# tests (\d+)\s*$/m.exec(output);
  if (counts.length !== 1 || counts[0]![1] !== "0" || !tests || Number(tests[1]) < 1) throw new Error("Installed publication acceptance must report zero skipped tests");
}

function runSuite(required: boolean): void {
  const directory = join(root, "release", "companions");
  const evidence = JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8")) as SuiteEvidence;
  if (evidence.hostCommit !== git(root, ["rev-parse", "HEAD"])) throw new Error("Companions were inspected against a different host commit");
  const inputs = verifyPackages(evidence, directory, required);
  if (process.env.CI && (evidence.hostDirty || evidence.packages.some(item => item.sourceDirty))) {
    // Generated files are still tracked in some companions (T14). Their build
    // dirtiness is evidence, never a reason to claim a different source commit.
    console.log("Builds changed tracked files; provenance records this explicitly.");
  }
  const files = readdirSync(join(root, "frontend", "test", "browser")).filter(file => /^installed-.*\.browser\.mts$/.test(file)).sort();
  const env = { ...process.env };
  for (const variable of Object.values(companionInputs)) delete env[variable];
  Object.assign(env, inputs);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=4", "--test-reporter=tap", ...files.map(file => "test/browser/" + file)],
    { cwd: join(root, "frontend"), env, encoding: "utf8", windowsHide: true, maxBuffer: 32 << 20 });
  if (result.error) throw result.error;
  writeFileSync(join(directory, "installed.tap"), result.stdout ?? "");
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) throw new Error("Installed companion acceptance failed");
  if (required) requireNoSkips(result.stdout);
  const summary = [
    "### Installed companion acceptance", "",
    required ? "Full publication suite passed with zero skipped tests." : "Public compatibility passed; missing private content does not establish publication coverage.",
    "", "| Add-on | Source commit | Inspected ZIP SHA-256 | Working-tree changes after build |", "| --- | --- | --- | --- |",
    ...evidence.packages.map(item => `| ${item.id} | ${item.sourceCommit} | ${item.sha256} | ${item.sourceDirty} |`),
    "", `Host: ${evidence.hostCommit}; working-tree changes: ${evidence.hostDirty}.`, "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else console.log(summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "prepare") prepareSuite(args);
    else if (command === "test" && args.length === 1 && ["full", "public"].includes(args[0]!)) runSuite(args[0] === "full");
    else throw new Error("Usage: companion-suite.mts prepare <repos...> | test <full|public>");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
