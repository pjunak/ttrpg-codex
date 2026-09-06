import { describe, expect, it, vi } from "vitest";
import type { ActiveBrowserContribution, BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import { acceptsWikiReference, parseWikiMatches, requestWikiProvider, type WikiRequest } from "../src/addons/wiki-links.js";
import { AddonLinksController } from "../src/app/addon-links-controller.js";

const route = active("route", "detail", { path: "library" });
const provider = active("wiki-kind", "links", { contractVersion: 1, kinds: ["spell"], legacyRoots: ["old-library"], search: true });
const request: WikiRequest = { contractVersion: "wiki-links.v1", operation: "resolve", references: [{ label: "Shield", hint: "spell" }] };
function response() { return { contractVersion: "wiki-links.v1", matches: [{ index: 0, target: { route: "detail", query: [["kind", "spell"], ["id", "shield /&?"]] } }] }; }

function active(surface: ActiveBrowserContribution["descriptor"]["surface"], id: string, config: Record<string, unknown>): ActiveBrowserContribution {
  return { addonId: "reference-fixture", generationId: "a".repeat(64), signal: new AbortController().signal,
    descriptor: { id, surface, config, label: "References", roles: ["dm", "player"], order: 0, requires: [] },
    binding: surface === "route" ? { kind: "element", tag: "fixture-library" } : { kind: "model-provider", provide: response } };
}
function harness(providers: readonly ActiveBrowserContribution[] = [provider]) {
  let changed = () => {};
  const update = vi.fn();
  const registry = { list: (surface: string) => surface === "route" ? [route] : providers,
    subscribe: (callback: () => void) => { changed = callback; return () => { changed = () => {}; }; } } as unknown as BrowserContributionRegistry;
  const controller = new AddonLinksController({ addController: vi.fn(), removeController: vi.fn(), requestUpdate: update, updateComplete: Promise.resolve(true) }, () => ({ registry, role: "player" }));
  controller.hostUpdate();
  return { controller, changed: () => changed(), update };
}
describe("public wiki links", () => {
  it("claims only declared typed hints and whole legacy roots", () => {
    expect(acceptsWikiReference(provider, { label: "Shield", hint: "spell:shield" })).toBe(true);
    expect(acceptsWikiReference(provider, { label: "Shield", hint: "character" })).toBe(false);
    expect(acceptsWikiReference(provider, { path: "#/old-library/spell:shield" })).toBe(true);
    expect(acceptsWikiReference(provider, { path: "#/old-library-other/spell" })).toBe(false);
  });
  it("constructs encoded same-generation routes and rejects stale or arbitrary targets", () => {
    expect(parseWikiMatches(response(), provider, [route], request)[0]?.href).toBe("#/addons/reference-fixture/library?kind=spell&id=shield+%2F%26%3F");
    for (const routes of [[], [{ ...route, generationId: "b".repeat(64) }], [{ ...route, addonId: "another-addon" }]]) {
      expect(() => parseWikiMatches(response(), provider, routes, request)).toThrow();
    }
    const invalid = response(); invalid.matches[0]!.target.query = [["id", "\n"]];
    expect(() => parseWikiMatches(invalid, provider, [route], request)).toThrow();
    expect(() => parseWikiMatches({ ...response(), html: "<b>bad</b>" }, provider, [route], request)).toThrow();
    expect(() => parseWikiMatches({ ...response(), matches: [...response().matches, ...response().matches] }, provider, [route], request)).toThrow();
  });
  it("bounds search labels and indices", () => {
    const search: WikiRequest = { contractVersion: "wiki-links.v1", operation: "search", query: "shield", limit: 20 };
    expect(() => parseWikiMatches(response(), provider, [route], search)).toThrow();
    expect(parseWikiMatches({ ...response(), matches: response().matches.map(match => ({ ...match, label: "Shield" })) }, provider, [route], search)).toHaveLength(1);
  });
  it("ends a callback that ignores its deadline", async () => {
    const stuck = { ...provider, binding: { kind: "model-provider" as const, provide: () => new Promise(() => {}) } };
    expect((await requestWikiProvider(stuck, request, [route], new AbortController().signal, 5)).failed).toBe(true);
  });
  it("batches rendered references and does not guess between providers", async () => {
    const { controller } = harness([provider, { ...provider, descriptor: { ...provider.descriptor, id: "second" } }]);
    controller.wiki("Shield", "spell"); controller.hostUpdated();
    await vi.waitFor(() => expect(controller.wiki("Shield", "spell").status).toBe("missing"));
    controller.hostDisconnected();
  });
  it("invalidates pending results on binding changes and detach", async () => {
    let resolve!: (value: unknown) => void;
    const delayed = { ...provider, binding: { kind: "model-provider" as const, provide: () => new Promise(done => { resolve = done; }) } };
    const { controller, changed } = harness([delayed]);
    controller.wiki("Shield", "spell"); controller.hostUpdated(); changed(); resolve(response());
    await new Promise(done => setTimeout(done, 0));
    expect(controller.wiki("Shield", "spell").status).toBe("loading");
    controller.hostDisconnected();
  });
  it("returns a failed state until an explicit retry", async () => {
    const broken = { ...provider, binding: { kind: "model-provider" as const, provide: () => { throw Error("Unavailable"); } } };
    const { controller } = harness([broken]);
    controller.wiki("Shield", "spell"); controller.hostUpdated();
    await vi.waitFor(() => expect(controller.failed).toBe(true));
    expect(controller.wiki("Shield", "spell").status).toBe("failed");
    controller.retry(); expect(controller.wiki("Shield", "spell").status).toBe("loading"); controller.hostDisconnected();
  });
});
