import { afterEach, expect, it, vi } from "vitest";
import { AddonGitHubController } from "../src/app/addon-github-controller.js";
import { hasGitHubAccess } from "../src/app/github-access.js";
import type { GitHubStatus } from "../src/core/addon-github.js";

const source = { repo: "owner/repo", channel: "actions" as const, branch: "", artifact: "reviewed-package" };
const status: GitHubStatus = { contractVersion: "addon-github.v1", sources: [], credentials: { defaultSource: "none", environmentConfigured: false, repositories: ["owner/repo"] } };
const controller = () => new AddonGitHubController({ addController: vi.fn(), removeController: vi.fn(), requestUpdate: vi.fn(), updateComplete: Promise.resolve(true) }, () => "csrf", key => key);
afterEach(() => vi.unstubAllGlobals());

it("continues checking other add-ons when one repository fails, without staging packages", async () => {
  const sources = ["unavailable", "available"].map(addonId => ({ addonId, revision: 1, source }));
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (path === "/api/admin/addon-github") return Response.json({ ...status, sources });
    expect(path).toBe("/api/admin/addon-github/discover");
    if (JSON.parse(String(options.body)).addonId === "unavailable") return Response.json({ error: { kind: "GITHUB_UNAVAILABLE" } }, { status: 502 });
    return Response.json({ source, candidates: [{ id: "a".repeat(64), name: "Package", version: "1.0.0", digest: "", active: true }] });
  });
  vi.stubGlobal("fetch", fetch);
  const state = controller(); await state.checkAll();
  expect(state.results["unavailable"]).toBe("github.unavailable");
  expect(state.results["available"]).toMatchObject({ candidates: [{ active: true }] });
  expect(fetch).toHaveBeenCalledTimes(3); expect(state.pending).toBe(false);
});

it("ignores metadata delivered after management authority is reset", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const state = controller(), loading = state.refresh(); state.reset();
  finish(Response.json(status)); await loading;
  expect(state.status).toBeUndefined(); expect(state.results).toEqual({}); expect(state.pending).toBe(false);
});

it("reuses only the matching repository token or an explicitly configured default", () => {
  expect(hasGitHubAccess(status, "https://github.com/Owner/Repo.git/")).toBe(true);
  expect(hasGitHubAccess(status, "owner/another")).toBe(false);
  expect(hasGitHubAccess({ ...status, credentials: { ...status.credentials, defaultSource: "environment" } }, "owner/another")).toBe(true);
  expect(hasGitHubAccess(undefined, "owner/repo")).toBe(false);
});
