import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";
import type { ActiveBrowserContribution } from "./browser-sdk.js";
import { cloneEditHandoff } from "./edit-handoff.js";
import type { BrowserContributionEditState, BrowserContributionEditHandle } from "../../../contracts/addons/v3/contribution-edits.js";
export type { BrowserContributionEditState, BrowserContributionEditHandle } from "../../../contracts/addons/v3/contribution-edits.js";

export interface BrowserContributionEditRegistration {
  readonly handle: BrowserContributionEditHandle;
  dispose(reason?: "mount-failed"): void;
}

const editStateKeys = new Set(["dirty", "saving", "retainOnQueryChange"]);

export function parseContributionEditState(value: unknown): BrowserContributionEditState {
  if (!isRecord(value) || !hasOnlyKeys(value, editStateKeys) ||
    typeof value["dirty"] !== "boolean" || typeof value["saving"] !== "boolean" ||
    (value["retainOnQueryChange"] !== undefined && typeof value["retainOnQueryChange"] !== "boolean")) {
    throw new BoundaryValidationError("add-on edit state", "expected only dirty, saving and optional retainOnQueryChange booleans");
  }
  return Object.freeze({ dirty: value["dirty"], saving: value["saving"], retainOnQueryChange: value["retainOnQueryChange"] === true });
}

/** Edit guards also cover a bounded handoff while an opted-in outlet restarts. */
export class BrowserContributionEdits {
  readonly #views = new Map<symbol, { active: ActiveBrowserContribution; state: BrowserContributionEditState; slot: symbol | undefined; unclaimed(): boolean }>();

  readonly #pending = new Map<symbol, { owner: string; value: unknown }>();

  pending(slot: symbol): boolean {
    return this.#pending.has(slot) || [...this.#views.values()].some(view => view.slot === slot && view.unclaimed());
  }
  forget(slot: symbol): void { this.#pending.delete(slot); }
  retain(owners: ReadonlySet<string>): void {
    for (const [slot, pending] of this.#pending) if (!owners.has(pending.owner)) this.#pending.delete(slot);
  }

  open(active: ActiveBrowserContribution, slot?: symbol, onHandoffConsumed: () => void = () => undefined): BrowserContributionEditRegistration {
    const id = Symbol(), inherited = slot === undefined || active.signal.aborted ? undefined : this.#pending.get(slot);
    if (slot !== undefined && !active.signal.aborted) this.#pending.delete(slot);
    let checkpoint = inherited?.value, recovered = inherited?.value;
    const view = { active, slot, unclaimed: () => recovered !== undefined,
      state: { dirty: inherited !== undefined, saving: false } as BrowserContributionEditState };
    let closed = false;
    const onAbort = (): void => dispose();
    const dispose = (reason?: "mount-failed"): void => {
      if (closed) return;
      closed = true;
      if (reason === "mount-failed" && inherited !== undefined && slot !== undefined) {
        this.#pending.set(slot, inherited);
      } else if (slot !== undefined && checkpoint !== undefined && (view.state.dirty || view.state.saving || view.unclaimed()) &&
        active.signal.aborted && (active.signal.reason === "reload" || active.signal.reason === "updated")) {
        this.#pending.set(slot, { owner: `${active.addonId}:${active.descriptor.id}`, value: checkpoint });
      }
      checkpoint = undefined; recovered = undefined;
      this.#views.delete(id);
      active.signal.removeEventListener("abort", onAbort);
    };
    if (!active.signal.aborted) {
      this.#views.set(id, view);
      active.signal.addEventListener("abort", onAbort, { once: true });
    } else closed = true;
    return Object.freeze({
      handle: Object.freeze({ set: (state: BrowserContributionEditState): void => {
        if (!closed) view.state = parseContributionEditState(state);
      }, ...(slot === undefined ? {} : { handoff: Object.freeze({
        checkpoint: (value: unknown): void => {
          if (closed) return;
          const next = value === undefined ? undefined : cloneEditHandoff(value), consumed = view.unclaimed();
          checkpoint = next; recovered = undefined;
          if (consumed) onHandoffConsumed();
        },
        take: (): unknown => {
          if (closed || recovered === undefined) return undefined;
          const value = cloneEditHandoff(recovered); recovered = undefined;
          view.state = { ...view.state, dirty: true }; onHandoffConsumed(); return value;
        },
      }) }) }),
      dispose,
    });
  }

  state(retainedRoute?: (active: ActiveBrowserContribution) => boolean): BrowserContributionEditState {
    let dirty = this.#pending.size > 0, saving = false;
    for (const { active, state, unclaimed } of this.#views.values()) {
      dirty ||= unclaimed() || state.dirty && !(state.retainOnQueryChange && retainedRoute?.(active));
      saving ||= state.saving;
    }
    return { dirty, saving };
  }
}
