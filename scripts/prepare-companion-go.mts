import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the candidate host's module graph without editing a pinned companion. */
export function prepareCompanionGo(repository: string, directory: string): string {
  repository = resolve(repository);
  directory = resolve(directory);
  const moduleFile = join(directory, "candidate.mod");
  const sumFile = join(directory, "candidate.sum");
  const flag = `-modfile=${moduleFile}`;
  // GOFLAGS uses Go's quoted-field syntax, not JSON or shell escaping.
  const quoted = !flag.includes('"') ? `"${flag}"` : !flag.includes("'") ? `'${flag}'` : undefined;
  if (!quoted) throw new Error("The companion module path cannot contain both quote characters");

  mkdirSync(directory, { recursive: true });
  copyFileSync(join(repository, "go.mod"), moduleFile);
  const sourceSum = join(repository, "go.sum");
  if (existsSync(sourceSum)) copyFileSync(sourceSum, sumFile);
  else rmSync(sumFile, { force: true });
  execFileSync("go", ["mod", "tidy", `-modfile=${moduleFile}`], {
    cwd: repository,
    env: { ...process.env, GOFLAGS: "", GOWORK: "off" },
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  // Explicit readonly mode also keeps Staticcheck's module-discovery subprocesses
  // compatible with an inherited -modfile. Tool selection retains its own modfile.
  return `${quoted} -mod=readonly`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length)
      throw new Error("Usage: prepare-companion-go.mts <scratch-directory> (run in the companion)");
    console.log(prepareCompanionGo(process.cwd(), directory));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
