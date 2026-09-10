import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";
import { sessionFetch } from "./player-preview.js";
import { HostRequestError } from "./api.js";
import { parseInstalledGeneration, type InstalledGeneration } from "./addon-admin.js";

export interface GitHubSource { repo: string; channel: "release" | "actions"; branch: string; artifact: string }
export interface GitHubLink { addonId: string; source: GitHubSource; revision: number }
export interface GitHubStatus {
  contractVersion: "addon-github.v1"; sources: GitHubLink[];
  credentials: { defaultSource: "none" | "stored" | "environment"; environmentConfigured: boolean; repositories: string[] };
}
export interface GitHubCandidate { id: string; name: string; version: string; digest: string; active: boolean }
export interface GitHubDiscovery { source: GitHubSource; candidates: GitHubCandidate[] }
const fail = (): never => { throw new BoundaryValidationError("GitHub add-ons", "invalid server response"); };
const record = (value: unknown, keys: string[]): Record<string, unknown> => isRecord(value) && hasOnlyKeys(value, new Set(keys)) ? value : fail();
const text = (value: unknown, max = 300): string => typeof value === "string" && value.length <= max ? value : fail();
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : fail();
const boolean = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const repo = (value: unknown): string => { const result = text(value); return /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/u.test(result) ? result : fail(); };
const hash = (value: unknown): string => { const result = text(value); return /^[a-f0-9]{64}$/u.test(result) ? result : fail(); };
function parseSource(value: unknown): GitHubSource {
  const r = record(value, ["repo", "channel", "branch", "artifact"]);
  if (r["channel"] !== "release" && r["channel"] !== "actions") return fail();
  return { repo: repo(r["repo"]), channel: r["channel"], branch: text(r["branch"], 200), artifact: text(r["artifact"], 200) };
}
export function parseGitHubStatus(value: unknown): GitHubStatus {
  const r = record(value, ["contractVersion", "sources", "credentials"]), c = record(r["credentials"], ["defaultSource", "environmentConfigured", "repositories"]);
  if (r["contractVersion"] !== "addon-github.v1" || !["none", "stored", "environment"].includes(text(c["defaultSource"]))) return fail();
  return { contractVersion: "addon-github.v1", sources: list(r["sources"]).map(value => {
    const link = record(value, ["addonId", "source", "revision"]), addonId = text(link["addonId"], 80), revision = link["revision"];
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(addonId) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return fail();
    return { addonId, source: parseSource(link["source"]), revision };
  }), credentials: { defaultSource: c["defaultSource"] as GitHubStatus["credentials"]["defaultSource"], environmentConfigured: boolean(c["environmentConfigured"]), repositories: list(c["repositories"]).map(repo) } };
}
export function parseGitHubDiscovery(value: unknown): GitHubDiscovery {
  const r = record(value, ["source", "candidates"]);
  return { source: parseSource(r["source"]), candidates: list(r["candidates"]).map(value => {
    const c = record(value, ["id", "name", "version", "digest", "active"]), digest = text(c["digest"]);
    if (digest !== "" && !/^sha256:[a-f0-9]{64}$/u.test(digest)) return fail();
    return { id: hash(c["id"]), name: text(c["name"]), version: text(c["version"]), digest, active: boolean(c["active"]) };
  }) };
}
export class GitHubRequestError extends HostRequestError {
  constructor(status: number, readonly code: string) { super(status, "GitHub add-ons"); }
}
export class AddonGitHubClient {
  constructor(readonly csrfToken: string, readonly signal: AbortSignal) {}
  async #request(path = "", body?: unknown): Promise<unknown> {
    const response = await sessionFetch(`/api/admin/addon-github${path}`, { method: body === undefined ? "GET" : "POST", signal: this.signal,
      headers: { Accept: "application/json", "X-Codex-CSRF": this.csrfToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: unknown = await response.json();
    if (!response.ok) { const error = isRecord(value) && isRecord(value["error"]) ? value["error"] : undefined; throw new GitHubRequestError(response.status, typeof error?.["kind"] === "string" ? error["kind"] : ""); }
    return value;
  }
  async status(): Promise<GitHubStatus> { return parseGitHubStatus(await this.#request()); }
  async token(repo: string, token: string): Promise<GitHubStatus> { return parseGitHubStatus(await this.#request("/token", { repo, token })); }
  async source(link: GitHubLink, remove = false): Promise<GitHubStatus> { return parseGitHubStatus(await this.#request("/source", { ...link, remove })); }
  async discover(source: GitHubSource, addonId = ""): Promise<GitHubDiscovery> { return parseGitHubDiscovery(await this.#request("/discover", { source, addonId })); }
  async stage(source: GitHubSource, candidateId: string, addonId = ""): Promise<InstalledGeneration> { return parseInstalledGeneration(await this.#request("/stage", { source, addonId, candidateId })); }
}
