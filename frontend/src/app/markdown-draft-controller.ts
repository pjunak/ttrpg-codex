import type { ReactiveController, ReactiveControllerHost } from "lit";
import { IndexedDBMarkdownDraftStore, markdownDraftTarget, type MarkdownDraft, type MarkdownDraftContext, type MarkdownDraftStore } from "../core/markdown-drafts.js";

export class MarkdownDraftController implements ReactiveController {
  candidates: readonly MarkdownDraft[] = [];
  status: "idle" | "saving" | "saved" | "unavailable" = "idle";
  selected: MarkdownDraft | undefined;
  #context: MarkdownDraftContext | undefined;
  #id = "";
  #value = "";
  #entry: MarkdownDraft | undefined;
  #accepted: MarkdownDraft[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #active = false;

  constructor(readonly host: ReactiveControllerHost, readonly store: MarkdownDraftStore = new IndexedDBMarkdownDraftStore()) { host.addController(this); }

  configure(context: MarkdownDraftContext | undefined): void {
    const target = context ? markdownDraftTarget(context) : undefined;
    if (target === (this.#context ? markdownDraftTarget(this.#context) : undefined)) {
      if (context && context.baseValue === this.#context?.baseValue) this.#context = context;
      return;
    }
    this.flush();
    this.#context = context; this.#id = crypto.randomUUID(); this.#value = context?.baseValue ?? "";
    this.#entry = undefined; this.#accepted = []; this.candidates = []; this.selected = undefined; this.status = "idle"; this.#active = !!context;
    if (target) void this.refresh();
  }

  hostConnected(): void {
    globalThis.addEventListener("pagehide", this.flush);
    globalThis.addEventListener("focus", this.#refresh);
    document.addEventListener("visibilitychange", this.#visibility);
  }
  hostDisconnected(): void {
    this.flush();
    globalThis.removeEventListener("pagehide", this.flush);
    globalThis.removeEventListener("focus", this.#refresh);
    document.removeEventListener("visibilitychange", this.#visibility);
  }
  readonly #visibility = (): void => { if (document.visibilityState === "hidden") this.flush(); };
  readonly #refresh = (): void => { void this.refresh(); };

  async refresh(): Promise<void> {
    const context = this.#context; const id = this.#id;
    if (!context) return;
    try {
      const drafts = await this.store.list(markdownDraftTarget(context));
      if (id !== this.#id) return;
      this.candidates = drafts.filter(draft => draft.id !== id && !this.#accepted.some(accepted => accepted.id === draft.id));
      if (!this.selected || !this.candidates.some(draft => draft.id === this.selected?.id)) this.selected = this.candidates[0];
    } catch { if (id === this.#id) this.status = "unavailable"; }
    this.host.requestUpdate();
  }

  changed(value: string): void {
    this.#value = value;
    if (!this.#active || !this.#context) return;
    clearTimeout(this.#timer);
    this.status = "saving";
    this.#timer = setTimeout(this.flush, 250);
    this.#deadline ??= setTimeout(this.flush, 1_000);
    this.host.requestUpdate();
  }

  readonly flush = (): void => {
    this.#clearTimers();
    const context = this.#context; const id = this.#id;
    if (!context || !this.#active || this.#value === context.baseValue && !this.#entry && this.status === "idle" || this.#entry?.value === this.#value && this.status === "saved") return;
    const draft: MarkdownDraft = { id, target: markdownDraftTarget(context), baseRevision: context.revision,
      baseValue: context.baseValue, value: this.#value, savedAt: Date.now() };
    this.#enqueue(async () => {
      if (draft.value === context.baseValue) { if (this.#entry?.id === id) await this.store.remove([this.#entry]); }
      else await this.store.put(draft);
      if (this.#id === id) {
        this.#entry = draft.value === context.baseValue ? undefined : draft;
        if (this.#value === draft.value) this.status = draft.value === context.baseValue ? "idle" : "saved";
      }
    }, id);
  };

  async recover(draft: MarkdownDraft): Promise<string | undefined> {
    const id = this.#id;
    const openingValue = this.#value;
    if (!this.#context) return undefined;
    if (this.#value !== this.#context.baseValue && this.#value !== draft.value) {
      try {
        await this.store.put({ id: crypto.randomUUID(), target: markdownDraftTarget(this.#context), baseRevision: this.#context.revision,
          baseValue: this.#context.baseValue, value: this.#value, savedAt: Date.now() });
      } catch { this.status = "unavailable"; this.host.requestUpdate(); return undefined; }
    }
    if (id !== this.#id || this.#value !== openingValue) return undefined;
    this.#accepted.push(draft); this.selected = undefined;
    this.candidates = this.candidates.filter(item => item.id !== draft.id);
    this.changed(draft.value);
    return draft.value;
  }

  async discard(draft: MarkdownDraft): Promise<void> {
    try { await this.store.remove([draft]); this.selected = undefined; await this.refresh(); }
    catch { this.status = "unavailable"; this.host.requestUpdate(); }
  }

  saved(value: string): void {
    if (!this.#context) return;
    const id = this.#id; const accepted = [...this.#accepted];
    this.#clearTimers();
    this.#context = { ...this.#context, baseValue: value };
    this.#enqueue(async () => {
      const own = this.#entry?.id === id && (this.#entry.value === value || this.#value === value) ? [this.#entry] : [];
      await this.store.remove([...own, ...accepted]);
      if (id === this.#id) { this.#entry = undefined; this.#accepted = []; this.status = "idle"; }
    }, id);
    if (this.#value !== value) this.changed(this.#value);
  }

  discardCurrent(): void {
    const id = this.#id; const accepted = [...this.#accepted];
    this.#clearTimers(); this.#active = false;
    this.#enqueue(async () => { await this.store.remove([...(this.#entry?.id === id ? [this.#entry] : []), ...accepted]); }, id);
  }

  #enqueue(operation: () => Promise<void>, id: string): void {
    this.#tail = this.#tail.then(operation).catch(() => { if (id === this.#id) this.status = "unavailable"; })
      .then(() => { this.host.requestUpdate(); });
  }

  #clearTimers(): void {
    clearTimeout(this.#timer); clearTimeout(this.#deadline);
    this.#timer = undefined; this.#deadline = undefined;
  }
}
