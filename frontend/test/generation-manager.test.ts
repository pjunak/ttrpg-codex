import { describe, expect, it, vi } from "vitest";
import {
  BrowserContributionRegistry,
  type BrowserAddonContext,
} from "../src/addons/browser-sdk.js";
import {
  BrowserGenerationManager,
  BrowserGenerationPlanError,
  createModuleActivator,
  type BrowserGenerationDescriptor,
} from "../src/addons/generation-manager.js";

const providerV1 = generation("rules-engine", "generation-1");
const providerV2 = generation("rules-engine", "generation-2");
const consumer = generation("character-sheets", "generation-sheets", ["rules-engine"]);

describe("BrowserGenerationManager", () => {
  it("cold-switches consumer-first and activates provider-first", async () => {
    const events: string[] = [];
    const manager = new BrowserGenerationManager((descriptor, context) => {
      events.push(`start:${descriptor.addonId}:${descriptor.generationId}`);
      context.scope.add("listener", () => {
        events.push(`listener:${descriptor.addonId}:${String(context.signal.reason)}`);
      });
      return () => {
        events.push(`stop:${descriptor.addonId}:${String(context.signal.reason)}`);
      };
    });

    await manager.reconcile({ contractVersion: 2, graphRevision: "graph-1", addons: [consumer, providerV1] });
    const result = await manager.reconcile({ contractVersion: 2, graphRevision: "graph-2", addons: [consumer, providerV2] });

    expect(result.activationFailures).toEqual([]);
    expect(result.disposalFailures).toEqual([]);
    expect(result.active.map((descriptor) => `${descriptor.addonId}:${descriptor.generationId}`)).toEqual([
      "character-sheets:generation-sheets",
      "rules-engine:generation-2",
    ]);
    expect(events).toEqual([
      "start:rules-engine:generation-1",
      "start:character-sheets:generation-sheets",
      "stop:character-sheets:reload",
      "listener:character-sheets:reload",
      "stop:rules-engine:updated",
      "listener:rules-engine:updated",
      "start:rules-engine:generation-2",
      "start:character-sheets:generation-sheets",
    ]);
  });

  it("isolates activation failures and skips required dependents", async () => {
    const independent = generation("dm-tools", "generation-dm");
    const manager = new BrowserGenerationManager((descriptor) => {
      if (descriptor.addonId === "rules-engine") {
        throw new Error("provider failed");
      }
      return undefined;
    });

    const result = await manager.reconcile({
      contractVersion: 2,
      graphRevision: "graph-1",
      addons: [consumer, independent, providerV1],
    });

    expect(result.active.map((descriptor) => descriptor.addonId)).toEqual(["dm-tools"]);
    expect(result.activationFailures.map((failure) => [failure.addonId, failure.kind])).toEqual([
      ["rules-engine", "activation"],
      ["character-sheets", "dependency"],
    ]);
  });

  it("validates the complete graph before disposing the current one", async () => {
    const stop = vi.fn();
    const manager = new BrowserGenerationManager(() => stop);
    await manager.reconcile({ contractVersion: 2, graphRevision: "graph-1", addons: [providerV1] });

    const left = generation("left-addon", "left", ["right-addon"]);
    const right = generation("right-addon", "right", ["left-addon"]);
    expect(() => manager.reconcile({ contractVersion: 2, graphRevision: "graph-2", addons: [left, right] })).toThrow(
      BrowserGenerationPlanError,
    );

    expect(stop).not.toHaveBeenCalled();
    expect(manager.activeGenerations()).toEqual([providerV1]);

    expect(() => manager.reconcile({
      contractVersion: 2,
      graphRevision: "graph-2",
      addons: [{ ...providerV2, entryUrl: "https://example.invalid/addon.js" }],
    })).toThrow(BrowserGenerationPlanError);
    expect(() => manager.reconcile({
      contractVersion: 2,
      graphRevision: "graph-2",
      addons: [generation("orphan-addon", "orphan", ["missing-addon"])],
    })).toThrow(BrowserGenerationPlanError);
    expect(() => manager.reconcile({
      contractVersion: 2,
      graphRevision: "graph-2",
      addons: [{
        ...providerV2,
        contributions: [{
          id: "planner.route",
          surface: "route",
          label: "Planner",
          roles: ["dm"],
          order: 0,
          requires: ["ui.contributions"],
          config: {},
        }],
      }],
    })).toThrow(BrowserGenerationPlanError);
    expect(stop).not.toHaveBeenCalled();
  });

  it("serializes rapid reconciliations and leaves only the latest graph active", async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const manager = new BrowserGenerationManager(async (descriptor) => {
      events.push(`start:${descriptor.generationId}`);
      if (descriptor.generationId === "generation-1") {
        await firstStarted;
      }
      return () => {
        events.push(`stop:${descriptor.generationId}`);
      };
    });

    const first = manager.reconcile({ contractVersion: 2, graphRevision: "graph-1", addons: [providerV1] });
    const second = manager.reconcile({ contractVersion: 2, graphRevision: "graph-2", addons: [providerV2] });
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(events).toEqual(["start:generation-1", "stop:generation-1", "start:generation-2"]);
    expect(manager.activeGenerations()).toEqual([providerV2]);
  });

  it("loads a module through the injected immutable-entry importer", async () => {
    const dispose = vi.fn();
    let stopReason: unknown;
    const activate = vi.fn((context: BrowserAddonContext) => {
      context.signal.addEventListener("abort", () => {
        stopReason = context.signal.reason;
      });
      return { dispose };
    });
    const importer = vi.fn(async () => ({ activate }));
    const registry = new BrowserContributionRegistry();
    const manager = new BrowserGenerationManager(
      createModuleActivator(importer, (descriptor, scope) => registry.open(descriptor, scope)),
    );

    await manager.reconcile({ contractVersion: 2, graphRevision: "graph-1", addons: [providerV1] });
    await manager.dispose("uninstalled");

    expect(importer).toHaveBeenCalledWith(providerV1.entryUrl);
    expect(activate).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(stopReason).toBe("uninstalled");
  });

  it("isolates a module that returns an invalid disposable", async () => {
    const importer = vi.fn(async () => ({ activate: () => null }));
    const registry = new BrowserContributionRegistry();
    const manager = new BrowserGenerationManager(
      createModuleActivator(importer, (descriptor, scope) => registry.open(descriptor, scope)),
    );

    const result = await manager.reconcile({ contractVersion: 2, graphRevision: "graph-1", addons: [providerV1] });

    expect(result.active).toEqual([]);
    expect(result.activationFailures).toHaveLength(1);
    expect(result.activationFailures[0]?.cause).toBeInstanceOf(TypeError);
  });
});

function generation(
  addonId: string,
  generationId: string,
  dependencies: readonly string[] = [],
): BrowserGenerationDescriptor {
  return {
    addonId,
    addonVersion: "1.0.0",
    generationId,
    mode: "integrated",
    entryUrl: `/api/addons/${addonId}/generations/${generationId}/entry.js`,
    styleUrls: [],
    sandbox: [],
    dependencies,
    capabilities: [],
    permissions: [],
    contributions: [],
  };
}
