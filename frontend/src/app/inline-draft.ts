import type { ReactiveController, ReactiveControllerHost } from "lit";
import { sameCampaignValue } from "./campaign-record-editor.js";
import type { CampaignWriteResult } from "./campaign-writes.js";
import { uiText } from "./ui-localization.js";

/**
 * When an inline draft saves besides Enter or ✓: `explicit` only then, `blur`
 * also when focus leaves the field, and `pause` also after a quiet moment
 * while typing.
 */
export type InlineCommit = "explicit" | "blur" | "pause";

export type InlineSaved = Extract<CampaignWriteResult, { ok: true }>;

export interface InlineDraftOptions {
  /** Saves `value` over `base`, the saved source the draft started from. */
  save(value: unknown, base: unknown): Promise<CampaignWriteResult>;
  /** The source the next save starts from after a confirmed one. */
  rebase(saved: InlineSaved): unknown;
  /** The saved source and value now, which Keep my draft continues from. */
  current(): { readonly base: unknown; readonly value: unknown };
  /** The draft changed and should render again. */
  changed(): void;
  /** Editing ended, either confirmed or discarded. */
  closed(): void;
  /** Whether two values save the same; exact comparison by default. */
  readonly same?: (left: unknown, right: unknown) => boolean;
  readonly required?: boolean;
  /** Quiet milliseconds before a pause-mode draft saves. */
  readonly pause?: number;
  readonly timers?: {
    set(save: () => void, milliseconds: number): unknown;
    clear(timer: unknown): void;
  };
}

const defaultTimers = {
  set: (save: () => void, milliseconds: number): unknown => setTimeout(save, milliseconds),
  clear: (timer: unknown): void => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * One field's unsaved edit. It keeps the source it started from, saves one
 * value at a time (an edit made while a save runs saves after it), and after a
 * conflict waits until the user keeps the draft or uses the current value.
 */
export class InlineDraft {
  value: unknown;
  /** The saved value the draft is compared with. */
  original: unknown;
  base: unknown;
  /** Which part of the value is open, when one draft is edited in several places. */
  active: string | undefined;
  pending = false;
  error = "";
  conflict = false;
  closed = false;
  readonly #options: InlineDraftOptions;
  readonly #timers: NonNullable<InlineDraftOptions["timers"]>;
  #timer: unknown;
  #again = false;
  #closeAfter = false;

  constructor(value: unknown, base: unknown, options: InlineDraftOptions) {
    this.value = value;
    this.original = value;
    this.base = base;
    this.#options = options;
    this.#timers = options.timers ?? defaultTimers;
  }

  get dirty(): boolean {
    return !(this.#options.same ?? sameCampaignValue)(this.value, this.original);
  }

  /** Replaces the draft value; `autosave` saves it after a quiet moment. */
  input(value: unknown, autosave = false): void {
    this.value = value;
    this.error = "";
    this.stopTimer();
    if (autosave && !this.conflict)
      this.#timer = this.#timers.set(() => void this.commit(false), this.#options.pause ?? 700);
    this.#options.changed();
  }

  /**
   * Saves the draft. `close` ends editing once the save is confirmed, unless
   * another part of the draft was opened meanwhile or it changed again.
   */
  async commit(close: boolean): Promise<void> {
    this.stopTimer();
    if (this.closed || this.conflict) return;
    this.#closeAfter = close;
    if (this.pending) {
      this.#again = true;
      return;
    }
    if (!this.dirty) {
      if (close) this.#close();
      return;
    }
    if (this.#options.required && String(this.value).trim() === "") {
      this.error = uiText("A name is required.");
      this.#options.changed();
      return;
    }
    const submitted = this.value,
      active = this.active;
    this.pending = true;
    this.error = "";
    this.#options.changed();
    const result = await this.#options.save(submitted, this.base);
    this.pending = false;
    if (this.closed) return;
    if (!result.ok) {
      this.#again = false;
      this.error = result.message;
      this.conflict = result.conflict === true;
      this.#options.changed();
      return;
    }
    this.base = this.#options.rebase(result);
    this.original = submitted;
    if (!this.dirty && this.#closeAfter && this.active === active) {
      this.#close();
      return;
    }
    this.#options.changed();
    if (this.#again) {
      this.#again = false;
      await this.commit(this.#closeAfter);
    }
  }

  /** After a conflict, keeps the draft over the current saved source. */
  keep(): void {
    const current = this.#options.current();
    this.base = current.base;
    this.original = current.value;
    this.conflict = false;
    this.error = "";
    this.#options.changed();
  }

  /** Ends editing without saving. A save already sent still finishes. */
  discard(): void {
    this.#close();
  }

  /** Cancels a waiting pause-mode save; the draft stays. */
  stopTimer(): void {
    if (this.#timer === undefined) return;
    this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }

  #close(): void {
    this.stopTimer();
    this.closed = true;
    this.#again = false;
    this.#options.closed();
  }
}

/** How an owner's field starts a draft. */
export interface InlineDraftSetup {
  /** The saved value in the draft's shape. */
  readonly value: unknown;
  /** The saved source the draft starts from, passed back to `save`. */
  readonly base: unknown;
  save(value: unknown, base: unknown): Promise<CampaignWriteResult>;
  /** The base after a confirmed save; the saved record by default. */
  rebase?(saved: InlineSaved): unknown;
  current(): { readonly base: unknown; readonly value: unknown };
  readonly same?: (left: unknown, right: unknown) => boolean;
  readonly required?: boolean;
}

/**
 * An owner's open inline drafts, one per field key, so a draft survives its
 * field moving on the page. Closing a draft returns focus to that field's
 * read-mode button when focus was in its editor.
 */
export class InlineDraftController implements ReactiveController {
  readonly #host: ReactiveControllerHost & HTMLElement;
  readonly #drafts = new Map<string, InlineDraft>();

  constructor(host: ReactiveControllerHost & HTMLElement) {
    this.#host = host;
    host.addController(this);
  }

  get(key: string): InlineDraft | undefined {
    return this.#drafts.get(key);
  }

  /**
   * Opens `key`'s draft, or reuses the open one. `part` marks where it is
   * edited when several fields share one draft; such a field is named
   * `key:part`, so focus can return to it.
   */
  open(key: string, setup: () => InlineDraftSetup, part?: string): InlineDraft {
    let draft = this.#drafts.get(key);
    if (draft === undefined) {
      const options = setup();
      const created: InlineDraft = new InlineDraft(options.value, options.base, {
        save: (value, base) => options.save(value, base),
        rebase: (saved) => (options.rebase ? options.rebase(saved) : saved.record),
        current: () => options.current(),
        changed: () => this.#host.requestUpdate(),
        closed: () => this.#closed(key, created),
        ...(options.same ? { same: options.same } : {}),
        ...(options.required ? { required: true } : {}),
      });
      draft = created;
      this.#drafts.set(key, draft);
    }
    draft.active = part;
    this.#host.requestUpdate();
    return draft;
  }

  get drafts(): readonly InlineDraft[] {
    return [...this.#drafts.values()];
  }

  get dirty(): boolean {
    return this.drafts.some((draft) => draft.dirty);
  }

  get saving(): boolean {
    return this.drafts.some((draft) => draft.pending);
  }

  get failed(): boolean {
    return this.drafts.some((draft) => draft.error !== "");
  }

  /** Ends every draft without saving, such as when the edited record changes. */
  discardAll(): void {
    for (const draft of this.drafts) draft.discard();
  }

  hostDisconnected(): void {
    for (const draft of this.drafts) draft.stopTimer();
  }

  #closed(key: string, draft: InlineDraft): void {
    if (this.#drafts.get(key) !== draft) return;
    const name = draft.active === undefined ? key : `${key}:${draft.active}`;
    const editor = this.#host.querySelector(`[data-field="${CSS.escape(name)}"]`);
    const focused = editor?.contains(document.activeElement) === true;
    this.#drafts.delete(key);
    this.#host.requestUpdate();
    if (!focused) return;
    void this.#host.updateComplete.then(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected)
        this.#host
          .querySelector<HTMLButtonElement>(`[data-edit-field="${CSS.escape(name)}"]`)
          ?.focus({ preventScroll: true });
    });
  }
}
