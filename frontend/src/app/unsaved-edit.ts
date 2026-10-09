export const unsavedEditMessage = "Discard the unsaved changes in this entry?";

export function confirmDiscardUnsavedEdit(
  dirty: boolean,
  confirm: (message: string) => boolean,
): boolean {
  return !dirty || confirm(unsavedEditMessage);
}

export function protectUnsavedEditBeforeUnload(dirty: boolean, event: BeforeUnloadEvent): void {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
}

export interface EditState {
  readonly dirty: boolean;
  readonly saving?: boolean;
}

/** Reports one component's unsaved and saving state to the app. */
export function reportEditState(source: EventTarget, state: EditState): void {
  source.dispatchEvent(
    new CustomEvent<EditState>("campaign-edit-dirty", {
      detail: Object.freeze({ dirty: state.dirty, saving: state.saving === true }),
      bubbles: true,
      composed: true,
    }),
  );
}

/**
 * Keeps each reporting element's state separately, so one editor finishing
 * cannot clear another editor's unsaved changes. Elements that have left the
 * page no longer count.
 */
export class EditStateTracker {
  readonly #states = new Map<EventTarget, { dirty: boolean; saving: boolean }>();

  record(event: CustomEvent<Partial<EditState> | undefined>): void {
    const source = event.composedPath()[0] ?? event.target;
    if (source === null) return;
    const previous = this.#states.get(source);
    const dirty =
      typeof event.detail?.dirty === "boolean" ? event.detail.dirty : (previous?.dirty ?? false);
    const saving = event.detail?.saving === true;
    if (dirty || saving) this.#states.set(source, { dirty, saving });
    else this.#states.delete(source);
  }

  /** Captures the event's source now; call the result after a confirmed save. */
  settler(event: Event): () => void {
    const source = event.composedPath()[0] ?? event.target;
    return () => {
      if (source !== null) this.#states.delete(source);
    };
  }

  get dirty(): boolean {
    return this.#current().some((state) => state.dirty);
  }

  get saving(): boolean {
    return this.#current().some((state) => state.saving);
  }

  clear(): void {
    this.#states.clear();
  }

  #current(): { dirty: boolean; saving: boolean }[] {
    for (const source of this.#states.keys())
      if ((source as Partial<Node>).isConnected === false) this.#states.delete(source);
    return [...this.#states.values()];
  }
}
