import { describe, expect, it, vi } from "vitest";
import {
  BrowserContributionBindingError,
  BrowserContributionRegistry,
  BrowserSDKAuthorityError,
} from "../src/addons/browser-sdk.js";
import {
  BrowserGenerationManager,
  createModuleActivator,
  type BrowserContributionDescriptor,
  type BrowserGenerationDescriptor,
} from "../src/addons/generation-manager.js";
import { GenerationScope } from "../src/addons/generation-scope.js";
import type { AddonDataHandle, BrowserDataAPI } from "../src/addons/data-client.js";
import type { AddonContentSet, BrowserContentAPI } from "../src/addons/content-client.js";

const generationId = "a".repeat(64);
const route = contribution("planner.route", "route", 200, ["dm"]);
const action = contribution("planner.create", "article-action", 100);
const sidebar = contribution("planner.sidebar", "sidebar", 200);
const graphView = contribution("planner.graph", "graph-view", 300);

describe("BrowserContributionRegistry", () => {
  it("creates one generation-scoped data API for add-on code", () => {
    const handle: AddonDataHandle<unknown> = {
      get: vi.fn(), query: vi.fn(), put: vi.fn(), delete: vi.fn(),
    };
    const dataAPI: BrowserDataAPI = {
      collection: <T>() => handle as AddonDataHandle<T>,
      recordExtension: <T>() => handle as AddonDataHandle<T>,
      transact: vi.fn(),
    };
    const createDataAPI = vi.fn(() => dataAPI);
    const source = descriptor("dm-tools", [route]);
    const scope = new GenerationScope("dm-tools@generation");
    const session = new BrowserContributionRegistry(undefined, createDataAPI).open(source, scope);

    expect(createDataAPI).toHaveBeenCalledWith(source, scope.signal);
    expect(session.context.data.collection("dm_notes")).toBe(handle);
  });

  it("creates one generation-scoped content API for add-on code", () => {
    const set: AddonContentSet<unknown> = { get: vi.fn(), query: vi.fn() };
    const contentAPI: BrowserContentAPI = {
      catalog: vi.fn(),
      set: <T>() => set as AddonContentSet<T>,
    };
    const createContentAPI = vi.fn(() => contentAPI);
    const source = descriptor("compendium", [route]);
    const scope = new GenerationScope("compendium@generation");
    const session = new BrowserContributionRegistry(
      undefined,
      undefined,
      createContentAPI,
    ).open(source, scope);

    expect(createContentAPI).toHaveBeenCalledWith(source, scope.signal);
    expect(session.context.content.set("rules")).toBe(set);
  });

  it("exposes immutable generation identity and effective authority", () => {
    const source = descriptor("dm-tools", [route]);
    const registry = new BrowserContributionRegistry();
    const session = registry.open(source, new GenerationScope("dm-tools@generation"));

    expect(session.context.addon).toEqual({
      id: "dm-tools",
      version: "1.0.0",
      generation: generationId,
    });
    expect("scope" in session.context).toBe(false);
    expect(session.context.capabilities.has("ui.contributions")).toBe(true);
    expect(session.context.permissions.has("core.data.read", "characters")).toBe(true);
    expect(session.context.permissions.has("core.data.read", "locations")).toBe(false);
    expect(session.context.permissions.resources("core.data.read")).toEqual(["characters"]);
    expect(() => session.context.capabilities.require("ui.missing")).toThrow(
      BrowserSDKAuthorityError,
    );
    expect(() => session.context.permissions.require("core.data.read", "locations")).toThrow(
      BrowserSDKAuthorityError,
    );

    const declarations = session.context.ui.declarations();
    expect(declarations).toEqual([route]);
    expect(declarations).not.toBe(source.contributions);
    expect(Object.isFrozen(declarations[0]?.config)).toBe(true);
  });

  it("binds only declared implementations with the surface's stable shape", () => {
    const registry = new BrowserContributionRegistry();
    const session = registry.open(
      descriptor("dm-tools", [route, action, sidebar, graphView]),
      new GenerationScope("dm-tools@generation"),
    );
    const run = vi.fn();
    const provide = vi.fn();

    expect(() => session.context.ui.bind("planner.route", {
      kind: "action",
      run,
    })).toThrow("requires an element binding");
    expect(() => session.context.ui.bind("planner.route", {
      kind: "element",
      tag: "main",
    })).toThrow("invalid custom element tag");
    session.context.ui.bind("planner.route", { kind: "element", tag: "dm-tools-planner" });
    session.context.ui.bind("planner.create", { kind: "action", run });
    session.context.ui.bind("planner.graph", { kind: "model-provider", provide });
    session.publishDeclarative("planner.sidebar");

    expect(registry.list("route", "dm").map((active) => active.descriptor.id)).toEqual([
      "planner.route",
    ]);
    expect(registry.list("route", "player")).toEqual([]);
    expect(registry.list("sidebar", "player")[0]?.binding.kind).toBe("declarative");
    const activeAction = registry.list("article-action", "player")[0]?.binding;
    const activeModel = registry.list("graph-view", "player")[0]?.binding;
    const invocation = new AbortController();
    expect(activeAction?.kind).toBe("action");
    expect(activeModel?.kind).toBe("model-provider");
    if (activeAction?.kind === "action" && activeModel?.kind === "model-provider") {
      activeAction.run({ recordId: "character-1" }, { signal: invocation.signal });
      activeModel.provide({ graphId: "story" }, { signal: invocation.signal });
    }
    const actionSignal = run.mock.calls[0]?.[1]?.signal as AbortSignal;
    const modelSignal = provide.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(run.mock.calls[0]?.[0]).toEqual({ recordId: "character-1" });
    expect(provide.mock.calls[0]?.[0]).toEqual({ graphId: "story" });
    expect(actionSignal.aborted).toBe(false);
    expect(modelSignal.aborted).toBe(false);
    invocation.abort("host-cancelled");
    expect(actionSignal.reason).toBe("host-cancelled");
    expect(modelSignal.reason).toBe("host-cancelled");

    expect(() => session.context.ui.bind("missing.route", {
      kind: "element",
      tag: "dm-tools-missing",
    })).toThrow(BrowserContributionBindingError);
    expect(() => session.context.ui.bind("planner.route", {
      kind: "element",
      tag: "dm-tools-again",
    })).toThrow(BrowserContributionBindingError);
    expect(() => session.context.ui.bind("planner.sidebar", {
      kind: "element",
      tag: "dm-tools-sidebar",
    })).toThrow("declarative");
    expect(() => session.publishDeclarative("planner.route")).toThrow("executable binding");
  });

  it("orders contributions deterministically and namespaces local ids by add-on", () => {
    const registry = new BrowserContributionRegistry();
    const later = registry.open(
      descriptor("z-addon", [contribution("shared.route", "route", 20)]),
      new GenerationScope("z-addon@generation"),
    );
    const earlier = registry.open(
      descriptor("a-addon", [contribution("shared.route", "route", 10)]),
      new GenerationScope("a-addon@generation"),
    );
    later.context.ui.bind("shared.route", { kind: "element", tag: "z-addon-route" });
    earlier.context.ui.bind("shared.route", { kind: "element", tag: "a-addon-route" });

    expect(registry.list("route", "player").map((active) => active.addonId)).toEqual([
      "a-addon",
      "z-addon",
    ]);
  });

  it("notifies host observers without letting their failures break bindings", () => {
    const observerError = vi.fn();
    const registry = new BrowserContributionRegistry(observerError);
    const session = registry.open(
      descriptor("dm-tools", [route]),
      new GenerationScope("dm-tools@generation"),
    );
    const changes = vi.fn();
    const unsubscribe = registry.subscribe(changes);
    registry.subscribe(() => {
      throw new Error("broken host observer");
    });

    const handle = session.context.ui.bind("planner.route", {
      kind: "element",
      tag: "dm-tools-planner",
    });
    handle.dispose();
    unsubscribe();
    session.context.ui.bind("planner.route", {
      kind: "element",
      tag: "dm-tools-planner",
    });

    expect(changes).toHaveBeenCalledTimes(2);
    expect(observerError).toHaveBeenCalledTimes(3);
  });

  it("removes exact bindings on explicit disposal and generation shutdown", async () => {
    const registry = new BrowserContributionRegistry();
    const scope = new GenerationScope("dm-tools@generation");
    const session = registry.open(descriptor("dm-tools", [route, action]), scope);
    const handle = session.context.ui.bind("planner.route", {
      kind: "element",
      tag: "dm-tools-planner",
    });
    session.context.ui.bind("planner.create", { kind: "action", run: () => undefined });
    const staleAction = registry.list("article-action", "dm")[0]?.binding;

    handle.dispose();
    handle.dispose();
    expect(registry.list("route", "dm")).toEqual([]);
    expect(registry.list("article-action", "dm")).toHaveLength(1);

    await scope.dispose("authority-changed");
    expect(session.context.signal.reason).toBe("authority-changed");
    expect(session.context.capabilities.has("ui.contributions")).toBe(false);
    expect(session.context.permissions.resources("core.data.read")).toEqual([]);
    expect(registry.list("article-action", "dm")).toEqual([]);
    let staleCause: unknown;
    try {
      if (staleAction?.kind === "action") {
        staleAction.run({}, { signal: new AbortController().signal });
      }
    } catch (cause: unknown) {
      staleCause = cause;
    }
    expect(staleCause).toBe("authority-changed");
    expect(() => session.context.ui.declarations()).toThrow("closed");
    expect(() => session.context.ui.bind("planner.route", {
      kind: "element",
      tag: "dm-tools-closed",
    })).toThrow("closed");
  });

  it("does not let a replacement generation steal a live contribution", () => {
    const registry = new BrowserContributionRegistry();
    const previous = registry.open(descriptor("dm-tools", [route]), new GenerationScope("old"));
    const replacement = registry.open(
      { ...descriptor("dm-tools", [route]), generationId: "b".repeat(64) },
      new GenerationScope("new"),
    );
    previous.context.ui.bind("planner.route", { kind: "element", tag: "dm-tools-old" });

    expect(() => replacement.context.ui.bind("planner.route", {
      kind: "element",
      tag: "dm-tools-new",
    })).toThrow("owned by another generation");

    previous.dispose();
    expect(() => replacement.context.ui.bind("planner.route", {
      kind: "element",
      tag: "dm-tools-new",
    })).not.toThrow();
  });
});

describe("module SDK composition", () => {
  it("cleans partial contribution bindings when activation fails", async () => {
    const registry = new BrowserContributionRegistry();
    const importer = async () => ({
      activate: (context: ReturnType<typeof registry.open>["context"]) => {
        context.ui.bind("planner.route", { kind: "element", tag: "dm-tools-planner" });
        throw new Error("activation failed after binding");
      },
    });
    const manager = new BrowserGenerationManager(
      createModuleActivator(importer, (value, scope) => registry.open(value, scope)),
    );

    const result = await manager.reconcile({
      contractVersion: 2,
      graphRevision: "c".repeat(64),
      addons: [descriptor("dm-tools", [route])],
    });

    expect(result.activationFailures).toHaveLength(1);
    expect(registry.list("route", "dm")).toEqual([]);
  });

  it("unpublishes contributions before running module cleanup", async () => {
    const registry = new BrowserContributionRegistry();
    const cleanupSaw: number[] = [];
    const importer = async () => ({
      activate: (context: ReturnType<typeof registry.open>["context"]) => {
        context.ui.bind("planner.route", { kind: "element", tag: "dm-tools-planner" });
        return {
          dispose: () => {
            cleanupSaw.push(registry.list("route", "dm").length);
          },
        };
      },
    });
    const manager = new BrowserGenerationManager(
      createModuleActivator(importer, (value, scope) => registry.open(value, scope)),
    );
    await manager.reconcile({
      contractVersion: 2,
      graphRevision: "d".repeat(64),
      addons: [descriptor("dm-tools", [route])],
    });

    await manager.dispose("disabled");

    expect(cleanupSaw).toEqual([0]);
  });

  it("publishes sidebar metadata without asking module code to bind it", async () => {
    const registry = new BrowserContributionRegistry();
    const importer = vi.fn(async () => ({ activate: vi.fn() }));
    const manager = new BrowserGenerationManager(
      createModuleActivator(importer, (value, scope) => registry.open(value, scope)),
    );

    const result = await manager.reconcile({
      contractVersion: 2,
      graphRevision: "e".repeat(64),
      addons: [descriptor("dm-tools", [sidebar])],
    });

    expect(result.activationFailures).toEqual([]);
    expect(registry.list("sidebar", "player")[0]?.binding.kind).toBe("declarative");
    await manager.dispose("disabled");
    expect(registry.list("sidebar", "player")).toEqual([]);
  });
});

function descriptor(
  addonId: string,
  contributions: readonly BrowserContributionDescriptor[],
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
    permissions: [{ id: "core.data.read", resources: ["characters"] }],
    contributions,
  };
}

function contribution(
  id: string,
  surface: BrowserContributionDescriptor["surface"],
  order: number,
  roles: BrowserContributionDescriptor["roles"] = [],
): BrowserContributionDescriptor {
  const config = surface === "route"
    ? { path: id === "planner.route" ? "planner" : "shared" }
    : surface === "sidebar"
      ? { route: "planner.route" }
      : { path: id };
  return {
    id,
    surface,
    label: id,
    roles,
    order,
    requires: ["ui.contributions"],
    config,
  };
}
