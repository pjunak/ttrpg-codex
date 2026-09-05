import { describe, expect, it, vi } from "vitest";
import { BrowserContributionOutlet } from "../src/addons/contribution-outlet.js";
import { BrowserContributionRegistry } from "../src/addons/browser-sdk.js";
import type {
  BrowserContributionDescriptor,
  BrowserGenerationDescriptor,
} from "../src/addons/generation-manager.js";
import { GenerationScope } from "../src/addons/generation-scope.js";
import type { BrowserContributionEditHandle } from "../src/addons/edit-state.js";

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
      codexContribution: { addon: { id: string }; signal: AbortSignal; edits: BrowserContributionEditHandle };
    };
    expect(element.tagName).toBe("a-tools-panel");
    expect(element.codexContribution.addon.id).toBe("a-tools");
    expect(Object.isFrozen(element.codexContribution)).toBe(true);
    const edits = element.codexContribution.edits;
    edits.set({ dirty: true, saving: false });

    outlet.refresh();
    expect(root.children[0]).toBe(firstWrapper);
    expect(element.codexContribution.edits).toBe(edits);
    expect(registry.edits.state().dirty).toBe(true);
    outlet.dispose();
    edits.set({ dirty: true, saving: true });
    expect(registry.edits.state()).toEqual({ dirty: false, saving: false });
    expect(root.hidden).toBe(true);
    expect(root.children).toEqual([]);
    expect(counts.at(-1)).toBe(0);
  });

  it("refreshes a frozen host-owned context on a stable custom element", () => {
    const registry = new BrowserContributionRegistry();
    const session = registry.open(
      descriptor("dnd-sheets", {
        ...contribution("sheet.section", 10),
        surface: "article-section",
        config: { collection: "characters" },
      }),
      new GenerationScope("dnd-sheets@generation"),
    );
    session.context.ui.bind("sheet.section", { kind: "element", tag: "dnd-character-sheet" });
    const root = new FakeElement("div");
    let revision = 3;
    const outlet = new BrowserContributionOutlet({
      document: new FakeDocument() as unknown as Document,
      root: root as unknown as HTMLElement,
      registry,
      surface: "article-section",
      role: "player",
      hostContext: () => ({
        kind: "campaign-record", collection: "characters", key: "ryn",
        revision, value: { name: "Ryn" }, canEdit: false,
      }),
    });
    const element = (root.children[0] as FakeElement).children[1] as FakeElement & {
      codexContribution: { host: { revision: number; value: { name: string } } };
    };

    expect(element.codexContribution.host.revision).toBe(3);
    expect(Object.isFrozen(element.codexContribution.host)).toBe(true);
    expect(Object.isFrozen(element.codexContribution.host.value)).toBe(true);
    revision = 4;
    outlet.refresh();
    expect(element.codexContribution.host.revision).toBe(4);
    outlet.dispose();
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

  it("mounts and releases host-owned isolated frame bindings", () => {
    const registry = new BrowserContributionRegistry();
    const session = registry.open(
      { ...descriptor("isolated-tools", contribution("frame.panel", 10)), mode: "isolated" },
      new GenerationScope("isolated-tools@generation"),
    );
    const mount = vi.fn(() => dispose);
    const dispose = vi.fn();
    const root = new FakeElement("div");
    const outlet = new BrowserContributionOutlet({
      document: new FakeDocument() as unknown as Document,
      root: root as unknown as HTMLElement,
      registry,
      surface: "slot",
      role: "dm",
    });

    const handle = session.bindIsolated("frame.panel", { kind: "isolated-frame", mount });
    expect(mount).toHaveBeenCalledOnce();
    expect((root.children[0] as FakeElement).children[1]?.tagName).toBe("div");

    handle.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    outlet.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("mounts only contributions selected by a feature-owned outlet", () => {
    const registry = new BrowserContributionRegistry();
    const first = registry.open(
      descriptor("first-tools", contribution("first.panel", 10)),
      new GenerationScope("first-tools@generation"),
    );
    const second = registry.open(
      descriptor("second-tools", contribution("second.panel", 20)),
      new GenerationScope("second-tools@generation"),
    );
    first.context.ui.bind("first.panel", { kind: "element", tag: "first-tools-panel" });
    second.context.ui.bind("second.panel", { kind: "element", tag: "second-tools-panel" });
    let selected = "first-tools";
    const root = new FakeElement("div");
    const outlet = new BrowserContributionOutlet({
      document: new FakeDocument() as unknown as Document,
      root: root as unknown as HTMLElement,
      registry,
      surface: "slot",
      role: "dm",
      include: (active) => active.addonId === selected,
    });

    expect(root.children.map((child) => child.dataset["addonId"])).toEqual(["first-tools"]);
    selected = "second-tools";
    outlet.refresh();
    expect(root.children.map((child) => child.dataset["addonId"])).toEqual(["second-tools"]);
  });
});

class FakeDocument {
  createElement(tag: string): HTMLElement {
    return new FakeElement(tag) as unknown as HTMLElement;
  }
}

class FakeElement {
  parentNode: FakeElement | null = null;
  insertBefore(node: FakeElement, before: FakeElement | null): void {
    node.remove();
    const index = before === null ? this.children.length : this.children.indexOf(before);
    this.children.splice(index, 0, node); node.parentNode = this;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this);
    this.parentNode = null;
  }
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
