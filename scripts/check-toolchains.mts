import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tools = ["typescript", "@types/node", "oxlint", "oxlint-tsgolint", "prettier"] as const;
type Versions = Readonly<Partial<Record<(typeof tools)[number], string>>>;

function dependencies(directory: string): Versions {
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as {
    devDependencies?: Versions;
  };
  return manifest.devDependencies ?? {};
}

export function assertToolchainVersions(expected: Versions, actual: Versions, label: string): void {
  for (const tool of tools) {
    const version = expected[tool];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`Host must pin an exact stable ${tool} version`);
    }
    if (actual[tool] !== version) {
      throw new Error(
        `${label}: ${tool} must match host ${version}; found ${actual[tool] ?? "missing"}`,
      );
    }
  }
}

/** The installed suite must not silently mix compiler or analysis versions. */
export function verifyToolchains(repositories: readonly string[]): void {
  const expected = { ...dependencies(root), ...dependencies(resolve(root, "frontend")) };
  for (const repository of repositories) {
    // A headless Go companion has no npm toolchain to align.
    if (!existsSync(resolve(repository, "package.json"))) continue;
    assertToolchainVersions(expected, dependencies(repository), repository);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repositories = process.argv.slice(2);
  if (!repositories.length) throw new Error("Provide the TypeScript companion repository paths");
  verifyToolchains(repositories);
  console.log("Companion TypeScript, lint and formatting toolchains match the host.");
}
