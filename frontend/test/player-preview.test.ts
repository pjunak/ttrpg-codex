import { afterEach, describe, expect, it, vi } from "vitest";
import { authorityRejectedEvent, initializePlayerPreview, isPlayerPreview, playerPreviewURL, previewResourceURL, sessionFetch } from "../src/core/player-preview.js";
import { createPlayerPreview } from "../src/core/api.js";

const credential = "preview_" + "a".repeat(32);
function scope(href: string, stored: string | null = null, blocked = false) {
  const storage = new Map<string, string>();
  if (stored !== null) storage.set("codex_player_preview", stored);
  return {
    location: new URL(href) as unknown as Location,
    history: { replaceState: vi.fn() } as unknown as History,
    sessionStorage: {
      getItem: (key: string) => { if (blocked) throw new Error("storage unavailable"); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw new Error("storage unavailable"); storage.set(key, value); },
    } as unknown as Storage,
  };
}
afterEach(() => { initializePlayerPreview(scope("https://codex.test/")); vi.unstubAllGlobals(); });

describe("tab-scoped player preview", () => {
  it("announces rejected same-origin authorized calls without replaying or escalating preview tabs", async () => {
    vi.stubGlobal("location", new URL("https://codex.test/"));
    const events = new EventTarget(), rejected = vi.fn();
    events.addEventListener(authorityRejectedEvent, rejected); vi.stubGlobal("window", events);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("forbidden", {status:403}));
    vi.stubGlobal("fetch", fetch);
    const init={method:"POST",headers:{"X-Codex-CSRF":"c".repeat(32)}};
    const response=await sessionFetch("/api/campaign/transactions",init);
    expect(response.status).toBe(403); expect(rejected).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    await sessionFetch("https://elsewhere.test/api/records",init);
    await sessionFetch("/api/login",{method:"POST"});
    initializePlayerPreview(scope(playerPreviewURL(credential,location.href)));
    await sessionFetch("/api/campaign/transactions",init);
    expect(rejected).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("removes bootstrap credentials and keeps the preview tab scoped across same-site navigation", () => {
    const opened = scope(playerPreviewURL(credential, "https://codex.test/#/dm"));
    initializePlayerPreview(opened);
    expect(isPlayerPreview()).toBe(true);
    expect(opened.history.replaceState).toHaveBeenCalledWith(null, "", "https://codex.test/?playerPreview=1#/");
    expect(opened.sessionStorage.getItem("codex_player_preview")).toBe(credential);
    initializePlayerPreview(scope("https://codex.test/?playerPreview=1#/characters", credential));
    expect(isPlayerPreview()).toBe(true);
    initializePlayerPreview(scope("https://codex.test/#/dm", credential));
    expect(isPlayerPreview()).toBe(true);
    initializePlayerPreview(scope("https://codex.test/#/dm"));
    expect(isPlayerPreview()).toBe(false);
  });

  it.each([null, "", "invalid"])("keeps explicit preview mode with missing or invalid credentials %s", async stored => {
    vi.stubGlobal("location", new URL("https://codex.test/?playerPreview=1#/"));
    const fetch = vi.fn(async () => new Response()); vi.stubGlobal("fetch", fetch);
    initializePlayerPreview(scope(location.href, stored));
    await sessionFetch("/api/campaign", { credentials: "include" });
    const init = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init[1].headers).has("X-Codex-Player-Preview")).toBe(true);
    expect(new Headers(init[1].headers).get("X-Codex-Player-Preview")).toBe("");
    expect(init[1].credentials).toBe("omit");
  });

  it("keeps storage failures scoped and never forwards preview credentials off-site", async () => {
    vi.stubGlobal("location", new URL("https://codex.test/"));
    initializePlayerPreview(scope(playerPreviewURL(credential, location.href), null, true));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response()); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await sessionFetch(new Request("https://codex.test/api/campaign", { headers: { Accept: "application/json" } }), { signal });
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
    expect(new Headers(init?.headers).get("X-Codex-Player-Preview")).toBe(credential);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", signal });
    await sessionFetch("https://elsewhere.test/api/records");
    expect(fetch.mock.calls[1]?.[1]).toBeUndefined();
    expect(previewResourceURL("https://elsewhere.test/api/media/image")).toBe("https://elsewhere.test/api/media/image");
    expect(previewResourceURL("/api/events")).toBe(`/api/events?playerPreviewToken=${credential}`);
    expect(previewResourceURL("/api/media/b_example/tiles/v1/{z}/{x}/{y}")).toContain("/{z}/{x}/{y}?playerPreviewToken=");
    initializePlayerPreview(scope("https://codex.test/?playerPreview=1", null, true));
    expect(previewResourceURL("/api/events")).toBe("/api/events?playerPreviewToken=");
  });

  it("validates the preview-creation response and supplies the DM CSRF token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      contractVersion: "player-preview.v1", token: credential, expiresAt: "2026-09-05T15:00:00Z",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await createPlayerPreview("c".repeat(32), new AbortController().signal)).toBe(credential);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/player-preview");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("X-Codex-CSRF")).toBe("c".repeat(32));
    fetch.mockImplementation(async () => new Response(JSON.stringify({ token: credential }), { headers: { "Content-Type": "application/json" } }));
    await expect(createPlayerPreview("c".repeat(32), new AbortController().signal)).rejects.toThrow("invalid preview session");
  });
});
