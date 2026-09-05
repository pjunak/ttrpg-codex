import { BoundaryValidationError, hasOnlyKeys, isRecord } from "../core/boundary.js";
import type { ActiveBrowserContribution } from "./browser-sdk.js";

export interface BrowserContributionEditState {
  readonly dirty: boolean;
  readonly saving: boolean;
  /** The contribution retains its drafts when only its route query changes. */
  readonly retainOnQueryChange?: boolean;
}

export interface BrowserContributionEditHandle {
  set(state: BrowserContributionEditState): void;
}

export interface BrowserContributionEditRegistration {
  readonly handle: BrowserContributionEditHandle;
  dispose(): void;
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

/** The host tracks only flags. Draft values remain inside the mounted view. */
export class BrowserContributionEdits {
  readonly #views = new Map<symbol, { active: ActiveBrowserContribution; state: BrowserContributionEditState }>();

  open(active: ActiveBrowserContribution): BrowserContributionEditRegistration {
    const id = Symbol();
    const view = { active, state: { dirty: false, saving: false } as BrowserContributionEditState };
    let closed = false;
    const dispose = (): void => {
      if (closed) return;
      closed = true;
      this.#views.delete(id);
      active.signal.removeEventListener("abort", dispose);
    };
    if (!active.signal.aborted) {
      this.#views.set(id, view);
      active.signal.addEventListener("abort", dispose, { once: true });
    } else closed = true;
    return Object.freeze({
      handle: Object.freeze({ set: (state: BrowserContributionEditState): void => {
        if (!closed) view.state = parseContributionEditState(state);
      } }),
      dispose,
    });
  }

  state(retainedRoute?: (active: ActiveBrowserContribution) => boolean): BrowserContributionEditState {
    let dirty = false, saving = false;
    for (const { active, state } of this.#views.values()) {
      dirty ||= state.dirty && !(state.retainOnQueryChange && retainedRoute?.(active));
      saving ||= state.saving;
    }
    return { dirty, saving };
  }
}
