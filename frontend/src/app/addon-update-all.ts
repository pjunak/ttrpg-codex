import type { AddonReview, InstalledGeneration } from "../core/addon-admin.js";
import type { GitHubDiscovery } from "../core/addon-github.js";

export interface UpdateTarget {
  readonly addonId: string;
  readonly discovery: GitHubDiscovery;
  readonly candidateId: string;
}

export interface UpdateAllClients {
  stage(target: UpdateTarget): Promise<InstalledGeneration>;
  review(addonId: string, generationId: string): Promise<AddonReview>;
  activate(review: AddonReview, grants: string[]): Promise<void>;
}

export interface UpdateAllResult {
  readonly updated: readonly string[];
  /** Add-ons left for the ordinary review: new permissions, blockers or saved data. */
  readonly needsReview: readonly string[];
}

/** Linked add-ons whose last check found exactly one package that is not active. */
export function updateTargets(
  results: Readonly<Record<string, GitHubDiscovery | string>>,
): UpdateTarget[] {
  return Object.entries(results).flatMap(([addonId, discovery]) => {
    if (typeof discovery === "string" || discovery.candidates.length !== 1) return [];
    const candidate = discovery.candidates[0]!;
    return candidate.active ? [] : [{ addonId, discovery, candidateId: candidate.id }];
  });
}

/** An update that asks for nothing new can be approved with the existing grants. */
export function approvableWithoutReview(review: AddonReview): boolean {
  const permissions = review.changes.find((change) => change.category === "permissions");
  return (
    review.blockers.length === 0 &&
    review.permissions.every((permission) => review.suggested.includes(permission.id)) &&
    !permissions?.added.length &&
    !permissions?.changed.length
  );
}

/**
 * Updates each target that needs no decision. A consumer can be blocked until
 * its provider's update is active, so blocked targets are tried once more
 * after the others.
 */
export async function updateAll(
  targets: readonly UpdateTarget[],
  clients: UpdateAllClients,
): Promise<UpdateAllResult> {
  const updated: string[] = [];
  let remaining = [...targets];
  for (let pass = 0; pass < 2 && remaining.length; pass++) {
    const blocked: UpdateTarget[] = [];
    for (const target of remaining) {
      const staged = await clients.stage(target);
      const review = await clients.review(staged.addonId, staged.generationId);
      if (!approvableWithoutReview(review)) {
        blocked.push(target);
        continue;
      }
      await clients.activate(review, [...new Set([...review.required, ...review.suggested])]);
      updated.push(target.addonId);
    }
    if (blocked.length === remaining.length) {
      remaining = blocked;
      break;
    }
    remaining = blocked;
  }
  return { updated, needsReview: remaining.map((target) => target.addonId) };
}
