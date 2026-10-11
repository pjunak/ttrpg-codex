import { describe, expect, it } from "vitest";
import type { AddonReview } from "../src/core/addon-admin.js";
import type { GitHubDiscovery } from "../src/core/addon-github.js";
import {
  approvableWithoutReview,
  updateAll,
  updateTargets,
  type UpdateTarget,
} from "../src/app/addon-update-all.js";

const source = { repo: "pjunak/addon", channel: "release", branch: "", artifact: "" } as const;
const candidate = (id: string, active: boolean) => ({
  id,
  name: `${id}.zip`,
  version: "1.0.0",
  digest: "a".repeat(64),
  active,
});
const discovery = (...candidates: ReturnType<typeof candidate>[]): GitHubDiscovery => ({
  source,
  candidates,
});

function review(addonId: string, overrides: Partial<AddonReview> = {}): AddonReview {
  return {
    suggested: ["core.data.read"],
    dependencies: [],
    services: [],
    rulesetName: "",
    supportedRulesets: [],
    disabledSources: [],
    reviewId: `review-${addonId}`,
    addonId,
    generationId: "b".repeat(64),
    proposalSha256: "c".repeat(64),
    status: "pending",
    name: addonId,
    version: "2.0.0",
    currentVersion: "1.0.0",
    permissions: [{ id: "core.data.read", reason: "", resources: ["characters"] }],
    required: ["core.data.read"],
    restarted: [],
    changes: [{ category: "permissions", added: [], changed: [], removed: [] }],
    runtimeChanged: false,
    blockers: [],
    ...overrides,
  };
}

describe("update all", () => {
  it("targets only checked add-ons with exactly one inactive package", () => {
    const targets = updateTargets({
      engine: discovery(candidate("engine-2", false)),
      sheets: discovery(candidate("sheets-1", true)),
      tools: discovery(candidate("tools-a", false), candidate("tools-b", false)),
      broken: "GitHub is unavailable.",
    });
    expect(targets.map((target) => [target.addonId, target.candidateId])).toEqual([
      ["engine", "engine-2"],
    ]);
  });

  it("needs a review for new permissions, changed grants and blockers", () => {
    expect(approvableWithoutReview(review("engine"))).toBe(true);
    expect(
      approvableWithoutReview(
        review("engine", {
          permissions: [
            { id: "core.data.read", reason: "", resources: [] },
            { id: "core.data.write", reason: "", resources: [] },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      approvableWithoutReview(
        review("engine", {
          changes: [
            { category: "permissions", added: [], changed: ["core.data.read"], removed: [] },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      approvableWithoutReview(
        review("engine", { blockers: [{ code: "DATA_MIGRATION_REQUIRED", message: "" }] }),
      ),
    ).toBe(false);
  });

  it("retries a consumer after its provider and leaves the rest for review", async () => {
    const target = (addonId: string): UpdateTarget => ({
      addonId,
      discovery: discovery(candidate(`${addonId}-2`, false)),
      candidateId: `${addonId}-2`,
    });
    const active = new Set<string>();
    const activations: [string, string[]][] = [];
    const result = await updateAll([target("sheets"), target("engine"), target("tools")], {
      stage: async ({ addonId }) => ({
        addonId,
        generationId: "b".repeat(64),
        version: "2.0.0",
        installedAt: "",
        lastError: "",
        name: addonId,
        description: "",
      }),
      review: async (addonId) =>
        addonId === "sheets" && !active.has("engine")
          ? review(addonId, { blockers: [{ code: "SERVICE_UNAVAILABLE", message: "" }] })
          : addonId === "tools"
            ? review(addonId, { blockers: [{ code: "DATA_MIGRATION_REQUIRED", message: "" }] })
            : review(addonId),
      activate: async (approved, grants) => {
        active.add(approved.addonId);
        activations.push([approved.addonId, grants]);
      },
    });
    expect(result).toEqual({ updated: ["engine", "sheets"], needsReview: ["tools"] });
    expect(activations).toEqual([
      ["engine", ["core.data.read"]],
      ["sheets", ["core.data.read"]],
    ]);
  });
});
