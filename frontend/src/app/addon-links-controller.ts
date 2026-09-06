import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BrowserContributionRegistry } from "../addons/browser-sdk.js";
import type { BrowserRole } from "../addons/generation-manager.js";
import { acceptsWikiReference, requestWikiProvider, wikiProviders, type WikiReference, type WikiResult } from "../addons/wiki-links.js";

export type AddonLinkState = { readonly status: "loading" | "missing" | "failed" } | { readonly status: "resolved"; readonly href: string };
export interface AddonSearchState { readonly loading: boolean; readonly results: readonly WikiResult[] }

/** Cache belongs to the mounted host view and is invalidated on any binding/role change. */
export class AddonLinksController implements ReactiveController {
  #registry: BrowserContributionRegistry | undefined;
  #role: BrowserRole | undefined;
  #unsubscribe: (() => void) | undefined;
  #owner = new AbortController();
  #cache = new Map<string, AddonLinkState>();
  #pending = new Map<string, WikiReference>();
  #query = "";
  #search: AddonSearchState = { loading: false, results: [] };
  #searchRequest: AbortController | undefined;
  #searchTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly host: ReactiveControllerHost, private readonly source: () => {
    registry: BrowserContributionRegistry | undefined; role: BrowserRole | undefined;
  }) { host.addController(this); }
  hostUpdate(): void {
    const { registry, role } = this.source();
    if (registry === this.#registry && role === this.#role && !this.#owner.signal.aborted) return;
    this.#unsubscribe?.(); this.#registry = registry; this.#role = role;
    this.retry(); this.#unsubscribe = registry?.subscribe(() => this.retry());
  }
  hostDisconnected(): void {
    this.#unsubscribe?.(); this.#unsubscribe = undefined; this.#owner.abort(); this.#searchRequest?.abort(); clearTimeout(this.#searchTimer);
  }
  retry = (): void => {
    this.#owner.abort(); this.#owner = new AbortController(); this.#cache.clear(); this.#pending.clear();
    this.#searchRequest?.abort(); clearTimeout(this.#searchTimer); this.#query = ""; this.#search = { loading: false, results: [] };
    this.host.requestUpdate();
  };
  get failed(): boolean { return [...this.#cache.values()].some(state => state.status === "failed"); }
  wiki = (label: string, hint: string): AddonLinkState => this.resolve({ label, hint });
  resolve(reference: WikiReference): AddonLinkState {
    const key = JSON.stringify(reference), cached = this.#cache.get(key);
    if (cached) return cached;
    if (!wikiProviders(this.#registry, this.#role).some(active => acceptsWikiReference(active, reference))) return { status: "missing" };
    // Bound retained view state without evicting requests that are still in flight.
    if (this.#cache.size >= 1000) for (const [id, state] of this.#cache) if (state.status !== "loading") { this.#cache.delete(id); break; }
    if (this.#cache.size >= 1000) return { status: "missing" };
    const state = { status: "loading" } as const;
    this.#cache.set(key, state); this.#pending.set(key, reference);
    return state;
  }
  hostUpdated(): void {
    if (!this.#pending.size || this.#owner.signal.aborted) return;
    const entries = [...this.#pending]; this.#pending.clear();
    const signal = this.#owner.signal, providers = wikiProviders(this.#registry, this.#role);
    const routes = this.#role ? this.#registry?.list("route", this.#role) ?? [] : [];
    // Small batches stay inside the isolated bridge's serialized request limit.
    for (let offset = 0; offset < entries.length; offset += 20) {
      const batch = entries.slice(offset, offset + 20);
      void Promise.all(providers.map(async active => {
        const selected = batch.filter(([, reference]) => acceptsWikiReference(active, reference));
        if (!selected.length) return { selected, result: undefined };
        return { selected, result: await requestWikiProvider(active, { contractVersion: "wiki-links.v1", operation: "resolve",
          references: selected.map(([, reference]) => reference) }, routes, signal) };
      })).then(results => {
        if (signal.aborted) return;
        for (const [key] of batch) {
          const matches = results.flatMap(({ selected, result }) => result?.matches.filter(match => selected[match.index]?.[0] === key) ?? []);
          const failed = results.some(({ selected, result }) => result?.failed && selected.some(([id]) => id === key));
          this.#cache.set(key, matches.length === 1 && !failed ? { status: "resolved", href: matches[0]!.href } : { status: failed ? "failed" : "missing" });
        }
        this.host.requestUpdate();
      });
    }
  }
  search(query: string): AddonSearchState {
    query = query.trim().slice(0, 200);
    if (query === this.#query) return this.#search;
    this.#query = query; this.#searchRequest?.abort(); clearTimeout(this.#searchTimer);
    const providers = wikiProviders(this.#registry, this.#role).filter(active => active.descriptor.config["search"] === true);
    this.#search = { loading: !!query && providers.length > 0, results: [] };
    if (!this.#search.loading) return this.#search;
    const owner = this.#owner.signal, request = new AbortController(); this.#searchRequest = request;
    const signal = AbortSignal.any([owner, request.signal]), routes = this.#role ? this.#registry?.list("route", this.#role) ?? [] : [];
    this.#searchTimer = setTimeout(() => {
      void Promise.all(providers.map(active => requestWikiProvider(active, { contractVersion: "wiki-links.v1", operation: "search", query, limit: 20 }, routes, signal)))
        .then(results => { if (!signal.aborted) { this.#search = { loading: false, results }; this.host.requestUpdate(); } });
    }, 150);
    return this.#search;
  }
}
