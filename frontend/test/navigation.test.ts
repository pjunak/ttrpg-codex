import { describe, expect, it, vi } from "vitest";
import {
  BrowserNavigationOutlet,
  browserAddonRouteHash,
  isBrowserAddonRouteHash,
  listBrowserNavigation,
  parseBrowserAddonLocation,
} from "../src/addons/navigation.js";
import { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import type {
  BrowserContributionDescriptor,
  BrowserGenerationDescriptor,
} from "../src/addons/generation-manager.js";
import { GenerationScope } from "../src/addons/generation-scope.js";

const generationId = "a".repeat(64);

describe("browser add-on navigation", () => {
  it("decodes bounded ordered query pairs without changing route ownership", () => {
    const routeHash = "#/addons/dm-tools/planner";
    expect(parseBrowserAddonLocation(`${routeHash}?item=quest-a&item=quest-b&label=%C4%8Caj+%26+k%C3%A1va`)).toEqual({
      routeHash, query: [["item", "quest-a"], ["item", "quest-b"], ["label", "Čaj & káva"]],
    });
    expect(parseBrowserAddonLocation(`${routeHash}?route=%23%2Faddons%2Fother%2Fpage`)?.routeHash).toBe(routeHash);
    expect(parseBrowserAddonLocation(routeHash)).toEqual({ routeHash, query: [] });
  });

  it("rejects malformed paths, escapes, controls and oversized parameters", () => {
    const routeHash = "#/addons/dm-tools/planner";
    for (const hash of ["#/addons/", "#/addons/dm-tools/../settings", "#/addons/dm-tools/planner/", "#/addons/dm-tools/%70lanner",
      `${routeHash}?x=%`, `${routeHash}?x=%FF`, `${routeHash}?x=%00`, `${routeHash}?=empty`,
      `${routeHash}?${"k".repeat(65)}=x`, `${routeHash}?x=${"v".repeat(1025)}`,
      `${routeHash}?${Array(33).fill("x=y").join("&")}`, `${routeHash}?x=${"%E2%82%AC".repeat(500)}`]) {
      expect(parseBrowserAddonLocation(hash), hash).toBeUndefined();
    }
  });

  it("publishes host-owned links only after their exact route is active", () => {
    const registry = new BrowserContributionRegistry();
    const session = registry.open(descriptor(), new GenerationScope("dm-tools@generation"));
    const root = new FakeElement("nav");
    let hash = "#/addons/dm-tools/planner";
    const counts: number[] = [];
    const outlet = new BrowserNavigationOutlet({
      document: new FakeDocument() as unknown as Document,
      root: root as unknown as HTMLElement,
      registry,
      role: "dm",
      currentHash: () => hash,
      onCountChange: (count) => counts.push(count),
    });

    session.publishDeclarative("planner.sidebar");
    expect(root.hidden).toBe(true);
    const route = session.context.ui.bind("planner.route", {
      kind: "element",
      tag: "dm-tools-planner",
    });

    expect(root.hidden).toBe(false);
    expect(root.children).toHaveLength(1);
    const anchor = root.children[0] as FakeElement;
    expect(anchor.href).toBe("#/addons/dm-tools/planner");
    expect(anchor.textContent).toBe("Story Planner");
    expect(anchor.attributes.get("aria-current")).toBe("page");
    expect(anchor.dataset).toEqual({
      addonId: "dm-tools",
      contributionId: "planner.sidebar",
    });

    hash = "#/addons/dm-tools/planner?item=quest-a";
    outlet.refresh();
    expect(anchor.attributes.get("aria-current")).toBe("page");
    expect(root.children[0]).toBe(anchor);
    hash = "#/";
    outlet.refresh();
    expect(anchor.attributes.has("aria-current")).toBe(false);
    expect(root.children[0]).toBe(anchor);

    route.dispose();
    expect(root.hidden).toBe(true);
    expect(counts.at(-1)).toBe(0);
    outlet.dispose();
  });

  it("keeps role-hidden and cross-generation routes out of navigation", () => {
    const registry = new BrowserContributionRegistry();
    const dmSession = registry.open(descriptor(), new GenerationScope("dm-tools@generation"));
    dmSession.publishDeclarative("planner.sidebar");
    dmSession.context.ui.bind("planner.route", { kind: "element", tag: "dm-tools-planner" });

    expect(listBrowserNavigation(registry, "player")).toEqual([]);
    const entries = listBrowserNavigation(registry, "dm");
    expect(entries).toEqual([{
      addonId: "dm-tools",
      generationId,
      contributionId: "planner.sidebar",
      label: "Story Planner",
      routeContributionId: "planner.route",
      hash: "#/addons/dm-tools/planner",
    }]);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
  });

  it("contains outlet observer failures and recognizes only the add-on namespace", () => {
    const registry = new BrowserContributionRegistry();
    const session = registry.open(descriptor(), new GenerationScope("dm-tools@generation"));
    const onError = vi.fn();
    const outlet = new BrowserNavigationOutlet({
      document: new FakeDocument() as unknown as Document,
      root: new ThrowingRoot() as unknown as HTMLElement,
      registry,
      role: "dm",
      currentHash: () => "#/",
      onError,
    });

    session.publishDeclarative("planner.sidebar");
    session.context.ui.bind("planner.route", { kind: "element", tag: "dm-tools-planner" });

    expect(onError).toHaveBeenCalled();
    expect(isBrowserAddonRouteHash("#/addons/dm-tools/planner")).toBe(true);
    expect(isBrowserAddonRouteHash("#/dashboard")).toBe(false);
    outlet.dispose();
  });

  it("derives route hashes only from route declarations", () => {
    const registry = new BrowserContributionRegistry();
    const session = registry.open(descriptor(), new GenerationScope("dm-tools@generation"));
    session.publishDeclarative("planner.sidebar");
    session.context.ui.bind("planner.route", { kind: "element", tag: "dm-tools-planner" });
    const route = registry.list("route", "dm")[0];
    const sidebar = registry.list("sidebar", "dm")[0];

    expect(route === undefined ? undefined : browserAddonRouteHash(route)).toBe(
      "#/addons/dm-tools/planner",
    );
    expect(() => sidebar === undefined ? undefined : browserAddonRouteHash(sidebar)).toThrow(
      "only route contributions",
    );
  });
});

class FakeDocument {
  createElement(tag: string): HTMLElement {
    return new FakeElement(tag) as unknown as HTMLElement;
  }
}

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  className = "";
  hidden = false;
  href = "";
  textContent: string | null = null;

  constructor(readonly tagName: string) {}

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [...nodes];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class ThrowingRoot extends FakeElement {
  constructor() {
    super("nav");
  }

  override replaceChildren(): void {
    throw new Error("detached host navigation");
  }
}

function descriptor(): BrowserGenerationDescriptor {
  return {
    addonId: "dm-tools",
    addonVersion: "1.0.0",
    generationId,
    mode: "integrated",
    entryUrl: `/api/addons/dm-tools/generations/${generationId}/assets/web/index.js`,
    styleUrls: [],
    sandbox: [],
    dependencies: [],
    capabilities: ["ui.contributions"],
    permissions: [],
    contributions: [route(), sidebar()],
  };
}

function route(): BrowserContributionDescriptor {
  return {
    id: "planner.route",
    surface: "route",
    label: "Story Planner",
    roles: ["dm"],
    order: 100,
    requires: ["ui.contributions"],
    config: { path: "planner" },
  };
}

function sidebar(): BrowserContributionDescriptor {
  return {
    id: "planner.sidebar",
    surface: "sidebar",
    label: "Story Planner",
    roles: ["dm"],
    order: 100,
    requires: ["ui.contributions"],
    config: { route: "planner.route" },
  };
}
