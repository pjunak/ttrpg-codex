import { waitForSignal } from "../core/abort-signal.js";
import { HostRequestError } from "../core/api.js";
import { BoundaryValidationError } from "../core/boundary.js";
import { readJSONResponse } from "../core/http.js";
import {
  flattenCatalog,
  localeFallbacks,
  maximumCatalogBytes,
  parseMessageCatalog,
  type CatalogMessage,
  type MessageCatalog,
} from "../core/message-catalog.js";
import { sessionFetch } from "../core/player-preview.js";
import { currentUiLocale, onUiLocaleChange } from "../app/ui-localization.js";
import type { BrowserCatalogIndexEntry, BrowserCatalogLocale } from "./generation-manager.js";

const boundary = "GET add-on locale catalog";

interface LoadedCatalog {
  readonly catalog: MessageCatalog;
  readonly messages: ReadonlyMap<string, CatalogMessage>;
}

export interface BrowserCatalogStoreOptions {
  readonly fetch?: typeof fetch;
  readonly onError?: (cause: unknown) => void;
}

/**
 * The active add-ons' message catalogs in this tab. A catalog URL names its
 * content, so a loaded catalog never changes. A language that fails to load
 * falls back to English and is tried again when the catalog index changes.
 */
export class BrowserCatalogStore {
  readonly #fetch: typeof fetch;
  readonly #onError: (cause: unknown) => void;
  readonly #listeners = new Set<() => void>();
  readonly #loaded = new Map<string, LoadedCatalog>();
  readonly #pending = new Map<string, Promise<LoadedCatalog | undefined>>();
  readonly #failed = new Set<string>();
  readonly #lifetime = new AbortController();
  #index: ReadonlyMap<string, BrowserCatalogIndexEntry> = new Map();

  constructor(options: BrowserCatalogStoreOptions = {}) {
    this.#fetch = options.fetch ?? sessionFetch;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Loads every add-on's catalogs for each new interface language, then notifies. */
  followUiLocale(): void {
    onUiLocaleChange(() => {
      void this.prepareAll().then(() => this.#notify());
    }, this.#lifetime.signal);
  }

  /** Stops loading and notifying; the store is unusable afterwards. */
  dispose(): void {
    this.#lifetime.abort();
    this.#listeners.clear();
  }

  /** Every active add-on's catalog entry, by add-on ID. */
  entries(): readonly BrowserCatalogIndexEntry[] {
    return [...this.#index.values()];
  }

  /** Every language at least one active add-on supplies. */
  locales(): readonly string[] {
    const locales = new Set<string>();
    for (const entry of this.#index.values())
      for (const { locale } of entry.locales) locales.add(locale);
    return [...locales];
  }

  /** Replaces the index from the latest browser graph. */
  settleIndex(entries: readonly BrowserCatalogIndexEntry[] | undefined): void {
    const next = new Map((entries ?? []).map((entry) => [entry.addonId, entry] as const));
    if (JSON.stringify([...next]) === JSON.stringify([...this.#index])) return;
    this.#index = next;
    const urls = new Set(
      [...next.values()].flatMap((entry) => entry.locales.map(({ url }) => url)),
    );
    for (const url of this.#loaded.keys()) if (!urls.has(url)) this.#loaded.delete(url);
    this.#failed.clear();
    this.#notify();
  }

  /** Loads `addonId`'s catalogs for `locale` and its fallbacks. */
  async prepare(addonId: string, locale = currentUiLocale(), signal?: AbortSignal): Promise<void> {
    const entry = this.#index.get(addonId);
    if (entry === undefined) return;
    await Promise.all(this.#chain(entry, locale).map((catalog) => this.#load(catalog, signal)));
  }

  /** Loads every active add-on's catalogs for `locale` and its fallbacks. */
  async prepareAll(locale = currentUiLocale()): Promise<void> {
    await Promise.all([...this.#index.keys()].map((addonId) => this.prepare(addonId, locale)));
  }

  /**
   * A message from `addonId`'s loaded catalogs for `locale`, trying its
   * fallbacks and, unless `english` is false, English last. A language not
   * loaded yet starts loading and notifies subscribers when it arrives.
   */
  message(
    addonId: string,
    key: string,
    locale = currentUiLocale(),
    english = true,
  ): CatalogMessage | undefined {
    const entry = this.#index.get(addonId);
    if (entry === undefined) return undefined;
    const ownBase = locale.split("-")[0] === "en";
    for (const catalog of this.#chain(entry, locale)) {
      if (!english && !ownBase && catalog.locale === "en") continue;
      const loaded = this.#loaded.get(catalog.url);
      if (loaded === undefined) {
        if (!this.#failed.has(catalog.url))
          void this.#load(catalog).then((found) => {
            if (found !== undefined) this.#notify();
          });
        continue;
      }
      const message = loaded.messages.get(key);
      if (message !== undefined) return message;
    }
    return undefined;
  }

  /** A translated manifest text, such as a contribution label, without the English fallback. */
  manifestText(addonId: string, key: string, locale = currentUiLocale()): string | undefined {
    const message = this.message(addonId, key, locale, false);
    return message === undefined
      ? undefined
      : typeof message === "string"
        ? message
        : message.other;
  }

  /** One language's whole catalog, for the coverage view; undefined when absent or failed. */
  async catalog(
    addonId: string,
    locale: string,
    signal?: AbortSignal,
  ): Promise<MessageCatalog | undefined> {
    const catalog = this.#index.get(addonId)?.locales.find((item) => item.locale === locale);
    return catalog === undefined ? undefined : (await this.#load(catalog, signal))?.catalog;
  }

  /** Notifies `listener` after catalogs load or the index or language changes. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #chain(entry: BrowserCatalogIndexEntry, locale: string): readonly BrowserCatalogLocale[] {
    return localeFallbacks(locale).flatMap((tag) => {
      const catalog = entry.locales.find((item) => item.locale === tag);
      return catalog === undefined ? [] : [catalog];
    });
  }

  #load(catalog: BrowserCatalogLocale, signal?: AbortSignal): Promise<LoadedCatalog | undefined> {
    const loaded = this.#loaded.get(catalog.url);
    if (loaded !== undefined) return Promise.resolve(loaded);
    let pending = this.#pending.get(catalog.url);
    if (pending === undefined) {
      pending = this.#request(catalog).then((result) => {
        this.#pending.delete(catalog.url);
        if (result === undefined) this.#failed.add(catalog.url);
        else if (this.#indexed(catalog.url)) this.#loaded.set(catalog.url, result);
        return result;
      });
      this.#pending.set(catalog.url, pending);
    }
    return signal === undefined ? pending : waitForSignal(pending, signal);
  }

  async #request(catalog: BrowserCatalogLocale): Promise<LoadedCatalog | undefined> {
    const signal = this.#lifetime.signal;
    try {
      const response = await this.#fetch(catalog.url, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal,
      });
      const value = await readJSONResponse(response, {
        boundary,
        maxBytes: maximumCatalogBytes,
        signal,
        httpError: (status) => new HostRequestError(status, boundary),
      });
      const parsed = parseMessageCatalog(value, boundary);
      if (parsed.locale !== catalog.locale)
        throw new BoundaryValidationError(boundary, "the catalog's language does not match");
      return { catalog: parsed, messages: flattenCatalog(parsed) };
    } catch (cause: unknown) {
      if (!signal.aborted) this.#onError(cause);
      return undefined;
    }
  }

  #indexed(url: string): boolean {
    for (const entry of this.#index.values())
      if (entry.locales.some((catalog) => catalog.url === url)) return true;
    return false;
  }

  #notify(): void {
    if (this.#lifetime.signal.aborted) return;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (cause: unknown) {
        this.#onError(cause);
      }
    }
  }
}
