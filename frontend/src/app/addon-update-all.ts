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

/** Why one add-on was not updated automatically. */
export type UpdateIssue =
  /** The update asks for permissions that were never granted. */
  | { readonly kind: "permissions"; readonly permissions: readonly string[] }
  /** Saved data needs the upgrade review before this package can run. */
  | { readonly kind: "data" }
  /** Activation is blocked, for example by a missing provider or host version. */
  | { readonly kind: "blocked"; readonly codes: readonly string[] }
  /** The add-on is disabled; updating it would also turn it on. */
  | { readonly kind: "disabled" }
  /** Downloading, reviewing or activating the package failed. */
  | { readonly kind: "failed"; readonly error: unknown }
  /** The check found several packages, so the DM has to pick one. */
  | { readonly kind: "choose" }
  /** The update check itself failed. */
  | { readonly kind: "unchecked"; readonly message: string };

export interface UpdateAttention {
  readonly addonId: string;
  readonly issue: UpdateIssue;
  /** The downloaded package that waits for its review, when there is one. */
  readonly generationId?: string;
}

export interface UpdateAllResult {
  readonly updated: readonly string[];
  /** Every add-on that still has an update, with what it needs from the DM. */
  readonly attention: readonly UpdateAttention[];
}

export interface UpdatePlan {
  readonly targets: readonly UpdateTarget[];
  /** Add-ons that cannot join the batch at all; they are reported, never skipped silently. */
  readonly attention: readonly UpdateAttention[];
}

/** Splits the last check into updates the batch can try and add-ons it has to report. */
export function updatePlan(
  results: Readonly<Record<string, GitHubDiscovery | string>>,
): UpdatePlan {
  const targets: UpdateTarget[] = [],
    attention: UpdateAttention[] = [];
  for (const [addonId, discovery] of Object.entries(results)) {
    if (typeof discovery === "string") {
      attention.push({ addonId, issue: { kind: "unchecked", message: discovery } });
      continue;
    }
    const available = discovery.candidates.filter((candidate) => !candidate.active);
    if (!available.length) continue;
    if (discovery.candidates.length === 1)
      targets.push({ addonId, discovery, candidateId: available[0]!.id });
    else attention.push({ addonId, issue: { kind: "choose" } });
  }
  return { targets, attention };
}

/** Add-ons whose last check found a package that is not active. */
export function availableUpdates(
  results: Readonly<Record<string, GitHubDiscovery | string>>,
): string[] {
  return Object.entries(results).flatMap(([addonId, discovery]) =>
    typeof discovery !== "string" && discovery.candidates.some((candidate) => !candidate.active)
      ? [addonId]
      : [],
  );
}

const dataBlockers = new Set([
  "DATA_MIGRATION_REQUIRED",
  "INVALID_STORED_DOCUMENT",
  "DATA_DEFINITION_REMOVED",
  "UNIQUE_INDEX_CONFLICT",
]);

/** Blockers that the saved-data upgrade review resolves. */
export function isDataBlocker(code: string): boolean {
  return dataBlockers.has(code);
}

/**
 * What an update needs from the DM, or undefined when it asks for nothing new
 * and can be approved with the grants the active version already has.
 */
export function reviewIssue(review: AddonReview): UpdateIssue | undefined {
  const other = review.blockers.filter((blocker) => !isDataBlocker(blocker.code));
  if (other.length) return { kind: "blocked", codes: other.map((blocker) => blocker.code) };
  if (review.blockers.length) return { kind: "data" };
  if (!review.currentVersion) return { kind: "disabled" };
  const changes = review.changes.find((change) => change.category === "permissions");
  const permissions = [
    ...new Set([
      ...(changes?.added ?? []),
      ...(changes?.changed ?? []),
      ...review.required.filter((id) => !review.suggested.includes(id)),
    ]),
  ];
  return permissions.length ? { kind: "permissions", permissions } : undefined;
}

/**
 * Updates each target that needs no decision and reports the rest. A failure
 * stays with its add-on, so one broken download does not stop the others. A
 * consumer can be blocked until its provider's update is active, so blocked
 * packages are reviewed again while other updates keep succeeding. Only an
 * aborted signal stops the batch.
 */
export async function updateAll(
  targets: readonly UpdateTarget[],
  clients: UpdateAllClients,
  signal?: AbortSignal,
): Promise<UpdateAllResult> {
  const updated: string[] = [],
    attention: UpdateAttention[] = [];
  const attempt = async (addonId: string, generationId: string) => {
    try {
      const review = await clients.review(addonId, generationId);
      const issue = reviewIssue(review);
      if (!issue) await clients.activate(review, [...review.suggested]);
      return issue;
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: "failed", error } as const;
    }
  };
  let waiting: (UpdateAttention & { readonly generationId: string })[] = [];
  for (const target of targets) {
    let generationId: string;
    try {
      generationId = (await clients.stage(target)).generationId;
    } catch (error) {
      if (signal?.aborted) throw error;
      attention.push({ addonId: target.addonId, issue: { kind: "failed", error } });
      continue;
    }
    const issue = await attempt(target.addonId, generationId);
    if (issue) waiting.push({ addonId: target.addonId, issue, generationId });
    else updated.push(target.addonId);
  }
  for (let progress = updated.length > 0; progress;) {
    progress = false;
    const next: typeof waiting = [];
    for (const item of waiting) {
      const issue =
        item.issue.kind === "blocked" ? await attempt(item.addonId, item.generationId) : item.issue;
      if (issue) next.push({ ...item, issue });
      else {
        updated.push(item.addonId);
        progress = true;
      }
    }
    waiting = next;
  }
  return { updated, attention: [...waiting, ...attention] };
}
