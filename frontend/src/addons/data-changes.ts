import type { EventRefresh } from "../core/event-stream.js";

export type AddonDataChange =
  | { readonly reason: "changed"; readonly kind: "collection" | "record-extension"; readonly dataId: string }
  | { readonly reason: "reset" };
export type AddonDataSubscribe = (listener: (change: AddonDataChange) => void, options?: { readonly signal?: AbortSignal }) => () => void;

/** Invalidations carry no records or revisions; reads still resolve current authority. */
export class BrowserAddonDataChanges {
  readonly #listeners = new Set<{ addonId: string; signal: AbortSignal; notify: (change: AddonDataChange) => void }>();
  constructor(readonly onDiagnostic: (cause: unknown) => void = () => undefined) {}

  scoped(addonId: string, generation: AbortSignal): AddonDataSubscribe {
    return (notify, options = {}) => {
      if (typeof notify !== "function") throw new TypeError("A data change listener must be a function.");
      const signal = options.signal ? AbortSignal.any([generation, options.signal]) : generation;
      signal.throwIfAborted();
      if (this.#listeners.size >= 1024) throw new Error("Too many add-on data subscriptions.");
      const entry = { addonId, signal, notify };
      const dispose = (): void => { this.#listeners.delete(entry); signal.removeEventListener("abort", dispose); };
      this.#listeners.add(entry); signal.addEventListener("abort", dispose, { once: true });
      return dispose;
    };
  }

  handleEvent(event: EventRefresh): void {
    let change: AddonDataChange;
    if (event.cause === "addon-data-changed") change = Object.freeze({ reason: "changed", kind: event.kind, dataId: event.dataId });
    else if (event.cause === "hello" || event.cause === "reset" || event.cause === "campaign-restored") change = Object.freeze({ reason: "reset" });
    else return;
    for (const entry of [...this.#listeners]) {
      if (!this.#listeners.has(entry) || entry.signal.aborted || (event.cause === "addon-data-changed" && event.addonId !== entry.addonId)) continue;
      try { entry.notify(change); } catch (cause) { this.onDiagnostic(cause); }
    }
  }
}
