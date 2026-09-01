import { describe, expect, it, vi } from "vitest";
import { BrowserContributionOutlet } from "../src/addons/contribution-outlet.js";
import { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import type {
  BrowserContributionDescriptor,
  BrowserGenerationDescriptor,
} from "../src/addons/generation-manager.js";
import { GenerationScope } from "../src/addons/generation-scope.js";

const generationId = "a".repeat(64);

describe("BrowserContributionOutlet", () => {
  it("mounts ordered role-visible elements and preserves stable instances", () => {
    const registry = new BrowserContributionRegistry();
    const first = registry.open(
      descriptor("z-tools", contribution("later.panel", 20)),
      new GenerationScope("z-tools@generation"),
    );
    const second = registry.open(
      descriptor("a-tools", contribution("first.panel", 10)),
      new GenerationScope("a-tools@generation"),
    );
    const document = new FakeDocument();
    const root = new FakeElement("div");
    const counts: number[] = [];
    const outlet = new BrowserContributionOutlet({
      document: document as unknown as Document,
      root: root as unknown as HTMLElement,
      registry,
      surface: "slot",
      role: "dm",
      onCountChange: (count) => counts.push(count),
    });

    first.context.ui.bind("later.panel", { kind: "element", tag: "z-tools-panel" });
    second.context.ui.bind("first.panel", { kind: "element", tag: "a-tools-panel" });

    expect(root.hidden).toBe(false);
    expect(root.children.map((child) => child.dataset["addonId"])).toEqual([
      "a-tools",
      "z-tools",
    ]);
    const firstWrapper = root.children[0] as FakeElement;
    const element = firstWrapper.children[1] as FakeElement & {
      codexContribution: { addon: { id: string }; signal: AbortSignal };
    };
    expect(element.tagName).toBe("a-tools-panel");
    expect(element.codexContribution.addon.id).toBe("a-tools");
    expect(Object.isFrozen(element.codexContribution)).toBe(true);

    outlet.refresh();
    expect(root.children[0]).toBe(firstWrapper);
    outlet.dispose();
    expect(root.hidden).toBe(true);
    expect(root.children).toEqual([]);
    expect(counts.at(-1)).toBe(0);
  });

  it("keeps DM-only contributions out of a player outlet", () => {
    const registry = new BrowserContributionRegistry();
    const session = registry.open(
      descriptor("dm-tools", contribution("private.panel", 10, ["dm"])),
      new GenerationScope("dm-tools@generation"),
    );
    session.context.ui.bind("private.panel", { kind: "element", tag: "dm-tools-private" });
    const root = new FakeElement("div");

    new BrowserContributionOutlet({
      document: new FakeDocument() as unknown as Document,
      root: root as unknown as HTMLElement,
      registry,
      surface: "slot",
      role: "player",
    });

    expect(root.hidden).toBe(true);
    expect(root.children).toEqual([]);
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
  textContent: string | null = null;

  constructor(readonly tagName: string) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [...nodes];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function descriptor(
  addonId: string,
  entry: BrowserContributionDescriptor,
): BrowserGenerationDescriptor {
  return {
    addonId,
    addonVersion: "1.0.0",
    generationId,
    mode: "integrated",
    entryUrl: `/api/addons/${addonId}/generations/${generationId}/assets/web/index.js`,
    styleUrls: [],
    sandbox: [],
    dependencies: [],
    capabilities: ["ui.contributions"],
    permissions: [],
    contributions: [entry],
  };
}

function contribution(
  id: string,
  order: number,
  roles: BrowserContributionDescriptor["roles"] = [],
): BrowserContributionDescriptor {
  return {
    id,
    surface: "slot",
    label: id,
    roles,
    order,
    requires: ["ui.contributions"],
    config: {},
  };
}
