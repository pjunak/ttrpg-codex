import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const companionRepositories = {
  "dm-tools": "pjunak/addon-dm-tools",
  "dnd-engine": "pjunak/addon-dnd-engine",
  "dnd-sheets": "pjunak/addon-dnd-character-sheets",
  "dnd-2024-compendium": "pjunak/addon-dnd-2024-compendium",
} as const;
export type CompanionId = keyof typeof companionRepositories;
export type SuiteMode = "full" | "public";
export interface CompanionRevision { id: CompanionId; repository: string; revision: string }
export interface CompanionRevisions { contractVersion: "companion-revisions.v1"; companions: CompanionRevision[] }
interface SourceRevision { id: string; sourceCommit: string }
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (id: unknown): id is CompanionId => typeof id === "string" && Object.hasOwn(companionRepositories, id);
const included = (id: CompanionId, mode: SuiteMode): boolean => mode === "full" || id !== "dnd-2024-compendium";

export function parseRevisions(value: unknown): CompanionRevisions {
  if (!isObject(value) || value.contractVersion !== "companion-revisions.v1" || !Array.isArray(value.companions)) {
    throw new Error("Invalid companion revision file");
  }
  const seen = new Set<CompanionId>();
  const companions = value.companions.map((item: unknown): CompanionRevision => {
    if (!isObject(item) || !isId(item.id) || seen.has(item.id) || item.repository !== companionRepositories[item.id] ||
        typeof item.revision !== "string" || item.revision.length !== 40 || !/^[a-f0-9]{40}$/.test(item.revision)) {
      throw new Error("Companion revisions require unique known repositories and full commit SHAs");
    }
    seen.add(item.id);
    return { id: item.id, repository: companionRepositories[item.id], revision: item.revision };
  });
  if (seen.size !== Object.keys(companionRepositories).length) throw new Error("Pin all four companion repositories");
  return { contractVersion: "companion-revisions.v1", companions };
}

export function readRevisions(path = join(root, "companion-revisions.json")): CompanionRevisions {
  return parseRevisions(JSON.parse(readFileSync(path, "utf8")));
}

export function verifyRevisions(sources: readonly SourceRevision[], revisions: CompanionRevisions, mode: SuiteMode): void {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const source of sources) {
    const pin = revisions.companions.find(item => item.id === source.id);
    if (!pin || seen.has(source.id)) throw new Error("Unknown or duplicate companion source: " + source.id);
    seen.add(source.id);
    if (source.sourceCommit !== pin.revision) errors.push(pin.repository + ": expected " + pin.revision + ", found " + source.sourceCommit);
  }
  for (const pin of revisions.companions) {
    if (included(pin.id, mode) && !seen.has(pin.id)) errors.push("Missing source: " + pin.repository);
  }
  if (errors.length) throw new Error("Companion sources do not match companion-revisions.json:\n" + errors.join("\n") +
    "\nUse the pinned commits, or explicitly record and test a new coordinated source set.");
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true }).trim();
}

export function readSourceRevision(repository: string): SourceRevision {
  const manifest = JSON.parse(readFileSync(join(repository, "addon.json"), "utf8")) as { id?: unknown };
  if (!isId(manifest.id)) throw new Error("Unknown companion in " + repository);
  return { id: manifest.id, sourceCommit: git(repository, ["rev-parse", "HEAD"]) };
}

function readCheckouts(mode: SuiteMode): CompanionRevision[] {
  return Object.entries(companionRepositories).filter(([id]) => included(id as CompanionId, mode)).map(([id, repository]) => {
    const directory = join(dirname(root), repository.split("/")[1]!);
    const source = readSourceRevision(directory);
    if (source.id !== id) throw new Error("Unexpected add-on in " + directory);
    if (git(directory, ["status", "--porcelain", "--untracked-files=normal"])) {
      throw new Error("Commit companion source changes before recording/checking revisions: " + repository);
    }
    return { id: id as CompanionId, repository, revision: source.sourceCommit };
  });
}

type CommitResponse = Pick<Response, "ok" | "status" | "json">;
type CommitFetcher = (url: string, init: RequestInit) => Promise<CommitResponse>;

// Verify availability without fetching a mutable branch or printing API bodies:
// the private token and compendium contents must never become public evidence.
export async function resolvePublishedRevisions(revisions: CompanionRevisions, mode: SuiteMode,
  tokens: { public?: string; private?: string }, fetchCommit: CommitFetcher = fetch): Promise<string> {
  if (mode === "full" && !tokens.private) throw new Error("Full companion coverage requires ADDON_SUITE_TOKEN");
  const selected = revisions.companions.filter(pin => included(pin.id, mode));
  const failures = await Promise.all(selected.map(async pin => {
    const label = pin.repository + "@" + pin.revision;
    const token = pin.id === "dnd-2024-compendium" ? tokens.private : tokens.public;
    try {
      const response = await fetchCommit("https://api.github.com/repos/" + pin.repository + "/git/commits/" + pin.revision, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: "Bearer " + token } : {}) },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return label + ": unavailable (HTTP " + response.status + ")";
      const commit: unknown = await response.json();
      if (!isObject(commit) || commit.sha !== pin.revision) return label + ": returned a different commit";
      return undefined;
    } catch {
      return label + ": availability check failed";
    }
  }));
  const errors = failures.filter((error): error is string => !!error);
  if (errors.length) throw new Error("Pinned companion commits are not accessible:\n" + errors.join("\n") +
    "\nPublish the pinned companion commits before the host; check token access for private repositories. No default-branch fallback is allowed.");
  return selected.map(pin => pin.id.replaceAll("-", "_") + "=" + pin.revision).join("\n") + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "record" && args.length === 0) {
      const revisions = parseRevisions({ contractVersion: "companion-revisions.v1", companions: readCheckouts("full") });
      writeFileSync(join(root, "companion-revisions.json"), JSON.stringify(revisions, null, 2) + "\n");
      console.log("Recorded clean companion commits. Run their package gates and full installed acceptance before committing the source set.");
    } else if (["check", "github"].includes(command ?? "") && args.length === 1 && ["full", "public"].includes(args[0]!)) {
      const mode = args[0] as SuiteMode, revisions = readRevisions();
      if (command === "check") {
        verifyRevisions(readCheckouts(mode).map(pin => ({ id: pin.id, sourceCommit: pin.revision })), revisions, mode);
        console.log("Companion checkouts match the pinned " + mode + " source set.");
      } else {
        const outputs = await resolvePublishedRevisions(revisions, mode, { public: process.env.GITHUB_TOKEN, private: process.env.ADDON_SUITE_TOKEN });
        if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
        else process.stdout.write(outputs);
      }
    } else throw new Error("Usage: companion-revisions.mts record | check <full|public> | github <full|public>");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
