import { describe, expect, it } from "vitest";
import type { AddonReview } from "../src/core/addon-admin.js";
import type { GitHubDiscovery } from "../src/core/addon-github.js";
import {
  availableUpdates,
  reviewIssue,
  updateAll,
  updatePlan,
  type UpdateAllClients,
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
    description: "",
    version: "2.0.0",
    currentVersion: "1.0.0",
    permissions: [{ id: "core.data.read", reason: "", resources: ["characters"] }],
    manifestTexts: new Map(),
    required: ["core.data.read"],
    restarted: [],
    changes: [{ category: "permissions", added: [], changed: [], removed: [] }],
    runtimeChanged: false,
    blockers: [],
    ...overrides,
  };
}

const target = (addonId: string): UpdateTarget => ({
  addonId,
  discovery: discovery(candidate(`${addonId}-2`, false)),
  candidateId: `${addonId}-2`,
});

/** Clients over an in-memory site; `reviews` decides each add-on's review. */
function site(reviews: (addonId: string, active: ReadonlySet<string>) => AddonReview) {
  const active = new Set<string>();
  const activations: [string, string[]][] = [];
  const staged: string[] = [];
  const clients: UpdateAllClients = {
    stage: async ({ addonId }) => {
      staged.push(addonId);
      return {
        addonId,
        generationId: `${addonId}-generation`,
        version: "2.0.0",
        installedAt: "",
        lastError: "",
        name: addonId,
        description: "",
        manifestTexts: new Map(),
      };
    },
    review: async (addonId, generationId) => ({ ...reviews(addonId, active), generationId }),
    activate: async (approved, grants) => {
      active.add(approved.addonId);
      activations.push([approved.addonId, grants]);
    },
  };
  return { clients, activations, staged };
}

describe("update all", () => {
  it("plans single-package updates and reports add-ons it cannot batch", () => {
    const results = {
      engine: discovery(candidate("engine-2", false)),
      sheets: discovery(candidate("sheets-1", true)),
      tools: discovery(candidate("tools-a", false), candidate("tools-b", false)),
      broken: "GitHub is unavailable.",
    };
    const plan = updatePlan(results);
    expect(plan.targets.map((item) => [item.addonId, item.candidateId])).toEqual([
      ["engine", "engine-2"],
    ]);
    expect(plan.attention).toEqual([
      { addonId: "tools", issue: { kind: "choose" } },
      { addonId: "broken", issue: { kind: "unchecked", message: "GitHub is unavailable." } },
    ]);
    expect(availableUpdates(results)).toEqual(["engine", "tools"]);
  });

  it("says what each update needs from the DM", () => {
    expect(reviewIssue(review("engine"))).toBeUndefined();
    expect(
      reviewIssue(
        review("engine", {
          permissions: [
            { id: "core.data.read", reason: "", resources: [] },
            { id: "core.data.write", reason: "", resources: [] },
          ],
          required: ["core.data.read", "core.data.write"],
          changes: [
            { category: "permissions", added: ["core.data.write"], changed: [], removed: [] },
          ],
        }),
      ),
    ).toEqual({ kind: "permissions", permissions: ["core.data.write"] });
    expect(
      reviewIssue(
        review("engine", {
          changes: [
            { category: "permissions", added: [], changed: ["core.data.read"], removed: [] },
          ],
        }),
      ),
    ).toEqual({ kind: "permissions", permissions: ["core.data.read"] });
    expect(
      reviewIssue(
        review("engine", { blockers: [{ code: "DATA_MIGRATION_REQUIRED", message: "" }] }),
      ),
    ).toEqual({ kind: "data" });
    expect(
      reviewIssue(
        review("engine", {
          blockers: [
            { code: "DATA_MIGRATION_REQUIRED", message: "" },
            { code: "COMPATIBILITY", message: "" },
          ],
        }),
      ),
    ).toEqual({ kind: "blocked", codes: ["COMPATIBILITY"] });
    expect(reviewIssue(review("engine", { currentVersion: "" }))).toEqual({ kind: "disabled" });
  });

  it("keeps an optional permission the DM declined without asking again", () => {
    const declined = review("engine", {
      permissions: [
        { id: "core.data.read", reason: "", resources: [] },
        { id: "core.media.read", reason: "", resources: [] },
      ],
    });
    expect(reviewIssue(declined)).toBeUndefined();
  });

  it("retries consumers after their providers and reports the rest", async () => {
    const { clients, activations } = site((addonId, active) =>
      addonId === "sheets" && !active.has("engine")
        ? review(addonId, { blockers: [{ code: "SERVICE", message: "" }] })
        : addonId === "engine" && !active.has("compendium")
          ? review(addonId, { blockers: [{ code: "DEPENDENCY", message: "" }] })
          : addonId === "tools"
            ? review(addonId, { blockers: [{ code: "DATA_MIGRATION_REQUIRED", message: "" }] })
            : review(addonId),
    );
    const result = await updateAll(
      [target("sheets"), target("engine"), target("tools"), target("compendium")],
      clients,
    );
    expect(result).toEqual({
      updated: ["compendium", "engine", "sheets"],
      attention: [{ addonId: "tools", issue: { kind: "data" }, generationId: "tools-generation" }],
    });
    expect(activations).toEqual([
      ["compendium", ["core.data.read"]],
      ["engine", ["core.data.read"]],
      ["sheets", ["core.data.read"]],
    ]);
  });

  it("reports a failed update and continues with the others", async () => {
    const { clients, staged } = site((addonId) => review(addonId));
    const failure = new Error("GitHub is down");
    const result = await updateAll([target("engine"), target("sheets"), target("tools")], {
      ...clients,
      stage: (item) => (item.addonId === "engine" ? Promise.reject(failure) : clients.stage(item)),
      activate: (approved, grants) =>
        approved.addonId === "tools" ? Promise.reject(failure) : clients.activate(approved, grants),
    });
    expect(result).toEqual({
      updated: ["sheets"],
      attention: [
        {
          addonId: "tools",
          issue: { kind: "failed", error: failure },
          generationId: "tools-generation",
        },
        { addonId: "engine", issue: { kind: "failed", error: failure } },
      ],
    });
    expect(staged).toEqual(["sheets", "tools"]);
  });

  it("stops when the request is cancelled", async () => {
    const controller = new AbortController();
    const { clients, staged } = site((addonId) => review(addonId));
    const cancelled = new DOMException("cancelled", "AbortError");
    await expect(
      updateAll(
        [target("engine"), target("sheets")],
        {
          ...clients,
          stage: () => {
            controller.abort();
            return Promise.reject(cancelled);
          },
        },
        controller.signal,
      ),
    ).rejects.toBe(cancelled);
    expect(staged).toEqual([]);
  });
});
