import {
  flattenCatalog,
  isLocaleTag,
  localeFallbacks,
  parseMessageCatalog,
  type CatalogMessage,
  type MessageCatalog,
} from "../core/message-catalog.js";
import czech from "./cs.json";
import english from "./en.json";

/**
 * The host's own interface languages, bundled with the app as
 * message-catalog.v1 files. English defines the keys; each built-in language
 * is complete, which the assignment below and test/host-catalogs.test.ts check.
 */
type EnglishCatalog = typeof english;
type EnglishSections = EnglishCatalog["sections"];
export type HostMessageKey = {
  [Section in keyof EnglishSections]: keyof EnglishSections[Section] & string;
}[keyof EnglishSections];
export type HostMessage = CatalogMessage;

const completeCzech: EnglishCatalog = czech;

export const hostCatalogs: readonly MessageCatalog[] = Object.freeze(
  [english, completeCzech].map((catalog) => parseMessageCatalog(catalog, "host message catalog")),
);

const hostMessages: ReadonlyMap<string, ReadonlyMap<string, HostMessage>> = new Map(
  hostCatalogs.map((catalog) => [catalog.locale, flattenCatalog(catalog)]),
);

/** The languages the host interface ships in. */
export const hostLocales: readonly string[] = Object.freeze(
  hostCatalogs.map(({ locale }) => locale),
);

/** A host message in `locale` or its nearest built-in fallback; undefined only for unknown keys. */
export function hostMessage(locale: string, key: string): HostMessage | undefined {
  for (const candidate of localeFallbacks(locale)) {
    const message = hostMessages.get(candidate)?.get(key);
    if (message !== undefined) return message;
  }
  return undefined;
}

export function isHostMessageKey(key: string): key is HostMessageKey {
  return hostMessages.get("en")!.has(key);
}

/** A language's own name, such as "Čeština", for language pickers. */
export function languageEndonym(locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(locale);
    if (name !== undefined && name !== locale)
      return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    /* An unsupported tag shows as written. */
  }
  return locale;
}

/** Canonicalizes a `lang` attribute such as "cs-cz"; undefined when it is not a language tag. */
export function canonicalLocale(value: string): string | undefined {
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return isLocaleTag(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

const controlNames = [
  "clear",
  "show",
  "empty",
  "loading",
  "narrow",
  "details",
  "required",
  "add",
  "remove",
  "filter",
  "menu",
] as const;
export type ControlMessages = Readonly<Record<(typeof controlNames)[number], string>>;
const controlMessageCache = new Map<string, ControlMessages>();

/** The shared controls' texts for an element's `lang`, from the host's `controls` section. */
export function controlMessages(lang: string): ControlMessages {
  const locale = canonicalLocale(lang) ?? "en";
  let messages = controlMessageCache.get(locale);
  if (messages === undefined) {
    const entries = controlNames.map((name) => {
      const message = hostMessage(locale, `controls.${name}`);
      return [name, typeof message === "string" ? message : (message?.other ?? name)] as const;
    });
    messages = Object.freeze(
      Object.fromEntries(entries) as Record<(typeof controlNames)[number], string>,
    );
    controlMessageCache.set(locale, messages);
  }
  return messages;
}
