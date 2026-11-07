import { currentUiLocale } from "../app/ui-localization.js";
import { isRecord } from "../core/boundary.js";
import { interpolate, selectPluralForm, type CatalogMessage } from "../core/message-catalog.js";
import { addonIdPattern } from "../core/validators.js";
import { hostMessage } from "../locales/index.js";
import type { BrowserCatalogStore } from "./catalog-store.js";

/** English text with an optional catalog key; workers send these for user-facing messages. */
export interface LocalizedText {
  readonly text: string;
  readonly key?: string;
  readonly args?: Readonly<Record<string, string | number>>;
  /** The add-on whose catalog holds `key`; the calling add-on by default. */
  readonly addon?: string;
}

export type MessageArguments = Readonly<Record<string, string | number>>;

/**
 * The provider ID of the host's own services, such as its campaign-bundle
 * import adapter. A LocalizedText naming it is keyed in the host's catalog.
 */
export const hostCatalogAddon = "codex-core";

/** ui.i18n: the reader's language and the add-on's own message catalogs. */
export interface BrowserI18nAPI {
  /** The reader's interface language, a canonical BCP 47 tag. */
  readonly locale: string;
  /** The add-on's message `key` in the reader's language; the key itself when missing. */
  t(key: string, args?: MessageArguments): string;
  /** A plural message for `count`, which also fills `{n}`. */
  plural(key: string, count: number, args?: MessageArguments): string;
  /** Translates `text` through its add-on's catalog, or shows its English text. */
  message(text: LocalizedText): string;
  /** Calls `listener` after the language changes or catalogs load; stops with the generation. */
  onChange(listener: () => void, options?: { readonly signal?: AbortSignal }): () => void;
}

export function createI18nAPI(
  store: BrowserCatalogStore,
  addonId: string,
  signal: AbortSignal,
  assertAvailable: () => void,
): BrowserI18nAPI {
  const lookup = (owner: string, key: string): CatalogMessage | undefined =>
    owner === hostCatalogAddon
      ? hostMessage(currentUiLocale(), key)
      : store.message(owner, key, currentUiLocale());
  return Object.freeze({
    get locale(): string {
      return currentUiLocale();
    },
    t(key: string, args: MessageArguments = {}): string {
      assertAvailable();
      assertKey(key);
      assertArguments(args);
      const message = lookup(addonId, key);
      return message === undefined ? key : interpolate(singular(message), args);
    },
    plural(key: string, count: number, args: MessageArguments = {}): string {
      assertAvailable();
      assertKey(key);
      assertArguments(args);
      if (!Number.isFinite(count)) throw new TypeError("count must be a finite number");
      const message = lookup(addonId, key);
      return message === undefined
        ? key
        : interpolate(selectPluralForm(message, currentUiLocale(), count), { n: count, ...args });
    },
    message(text: LocalizedText): string {
      assertAvailable();
      assertLocalizedText(text);
      if (text.key === undefined) return text.text;
      const message = lookup(text.addon ?? addonId, text.key);
      if (message === undefined) return text.text;
      const args = text.args ?? {};
      const count = args["n"];
      return interpolate(
        typeof count === "number"
          ? selectPluralForm(message, currentUiLocale(), count)
          : singular(message),
        args,
      );
    },
    onChange(listener: () => void, options: { readonly signal?: AbortSignal } = {}): () => void {
      assertAvailable();
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      const stops = [signal, options.signal].filter(
        (item): item is AbortSignal => item !== undefined,
      );
      const unsubscribe = store.subscribe(() => {
        if (stops.every((item) => !item.aborted)) listener();
      });
      const stop = (): void => {
        unsubscribe();
        for (const item of stops) item.removeEventListener("abort", stop);
      };
      for (const item of stops) item.addEventListener("abort", stop, { once: true });
      if (stops.some((item) => item.aborted)) stop();
      return stop;
    },
  });
}

function singular(message: CatalogMessage): string {
  return typeof message === "string" ? message : message.other;
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 500)
    throw new TypeError("message key must be a non-empty string of at most 500 characters");
}

function assertArguments(args: unknown): asserts args is MessageArguments {
  if (
    !isRecord(args) ||
    !Object.values(args).every((value) => typeof value === "string" || Number.isFinite(value))
  )
    throw new TypeError("message arguments must map names to strings or finite numbers");
}

function assertLocalizedText(text: unknown): asserts text is LocalizedText {
  if (!isRecord(text) || typeof text["text"] !== "string")
    throw new TypeError("localized text needs its English text");
  if (text["key"] !== undefined) assertKey(text["key"]);
  if (text["args"] !== undefined) assertArguments(text["args"]);
  const addon = text["addon"];
  if (addon !== undefined && (typeof addon !== "string" || !addonIdPattern.test(addon)))
    throw new TypeError("localized text names an invalid add-on");
}
