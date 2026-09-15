import { afterEach, describe, expect, it, vi } from "vitest";
import { AddonGitHubClient, GitHubRequestError, parseGitHubDiscovery, parseGitHubStatus } from "../src/core/addon-github.js";

const source = { repo: "owner/repo", channel: "actions", branch: "main", artifact: "reviewed-package" };
const status = { contractVersion: "addon-github.v1", sources: [{ addonId: "example", revision: 1, source }], credentials: { defaultSource: "stored", environmentConfigured: true, repositories: ["owner/repo"] } };
const discovery = { source, candidates: [{ id: "a".repeat(64), name: "reviewed-package", version: "abc", digest: `sha256:${"b".repeat(64)}`, active: false }] };
afterEach(() => vi.unstubAllGlobals());
describe("GitHub add-on boundary", () => {
  it("validates repository links and rejects credentials in status responses", () => {
    expect(parseGitHubStatus(status)).toEqual(status);
    for (const value of [{ ...status, token: "secret" }, { ...status, credentials: { ...status.credentials, token: "secret" } }, { ...status, sources: [{ ...status.sources[0], revision: -1 }] }, { ...status, sources: [{ ...status.sources[0], source: { ...source, repo: "https://evil.test/repo" } }] }, { ...status, credentials: { ...status.credentials, repositories: ["../repo"] } }]) expect(() => parseGitHubStatus(value)).toThrow();
  });
  it("rejects arbitrary URLs, malformed identity, and non-boolean update status", () => {
    expect(parseGitHubDiscovery(discovery)).toEqual(discovery);
    for (const field of [{ id: "arbitrary" }, { digest: "bad" }, { active: "false" }, { downloadUrl: "http://localhost/" }]) expect(() => parseGitHubDiscovery({ ...discovery, candidates: [{ ...discovery.candidates[0], ...field }] })).toThrow();
  });
  it("validates bounded display provenance without accepting upstream URLs or credentials", () => {
    const provenance = { commit: "c".repeat(40), runId: "1234", runAttempt: 2, publishedAt: "2026-09-15T10:00:00Z", notes: "<script>plain text</script>", notesTruncated: false };
    const candidate = { ...discovery.candidates[0], provenance };
    expect(parseGitHubDiscovery({ ...discovery, candidates: [candidate] }).candidates[0]?.provenance).toEqual(provenance);
    for (const field of [{ commit: "main" }, { runId: "../1234" }, { runAttempt: -1 }, { runAttempt: 1.5 }, { publishedAt: "tomorrow" }, { notes: "x".repeat(8001) }, { notesTruncated: "false" }, { url: "javascript:alert(1)" }, { token: "secret" }]) {
      expect(() => parseGitHubDiscovery({ ...discovery, candidates: [{ ...candidate, provenance: { ...provenance, ...field } }] })).toThrow();
    }
  });
  it("uses the protected host transport and carries safe error categories", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(status), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal, client = new AddonGitHubClient("csrf", signal);
    await client.token("owner/repo", "replacement");
    expect(fetch).toHaveBeenCalledWith("/api/admin/addon-github/token", expect.objectContaining({ signal, method: "POST", headers: expect.objectContaining({ "X-Codex-CSRF": "csrf" }), body: JSON.stringify({ repo: "owner/repo", token: "replacement" }) }));
    fetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { kind: "GITHUB_PACKAGE", message: "untrusted detail" } }), { status: 422 })));
    await expect(client.discover({ ...source, channel: "actions" })).rejects.toMatchObject({ code: "GITHUB_PACKAGE", status: 422 });
    try { await client.status(); } catch (error) { expect(error).toBeInstanceOf(GitHubRequestError); expect((error as Error).message).not.toContain("untrusted detail"); }
  });
});
