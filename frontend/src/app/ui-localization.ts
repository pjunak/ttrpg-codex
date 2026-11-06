import type { ReactiveController, ReactiveControllerHost } from "lit";
import { isRecord } from "../core/boundary.js";
import { interpolate, isLocaleTag, selectPluralForm } from "../core/message-catalog.js";
import {
  hostLocales,
  hostMessage,
  isHostMessageKey,
  languageEndonym,
  type HostMessage,
  type HostMessageKey,
} from "../locales/index.js";

/** A canonical BCP 47 tag; the host ships English and Czech, add-ons may add more. */
export type UiLocale = string;
export type Message = HostMessage;
export type MessageKey = HostMessageKey;

/** The DM's site-wide choice, kept in the campaign's `settings/language` record. */
export interface SiteLanguages {
  readonly defaultLocale: string;
  /** Languages a browser may choose; always includes English and the default. */
  readonly enabledLocales: readonly string[];
}

/** Until the DM chooses, English is the default and every built-in language is offered. */
export const defaultSiteLanguages: SiteLanguages = Object.freeze({
  defaultLocale: "en",
  enabledLocales: hostLocales,
});

export const maximumSiteLanguages = 32;

/** The host's built-in languages with their own names. */
export const availableUiLocales = Object.freeze(
  hostLocales.map((id) => Object.freeze({ id, endonym: languageEndonym(id) })),
);

const personalStorageKey = "codex_lang";
const siteStorageKey = "codex_site_lang";
const localeChangeTarget = new EventTarget();
let personalLocale = readPersonalLocale();
let siteLanguagesValue = readCachedSiteLanguages();
let activeLocale = resolveActiveLocale();

export class UiLocalizationController implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #onChange = (): void => {
    this.#host.requestUpdate();
  };

  constructor(host: ReactiveControllerHost) {
    this.#host = host;
    host.addController(this);
  }

  hostConnected(): void {
    localeChangeTarget.addEventListener("change", this.#onChange);
  }
  hostDisconnected(): void {
    localeChangeTarget.removeEventListener("change", this.#onChange);
  }
  get locale(): UiLocale {
    return activeLocale;
  }
  t(key: MessageKey, parameters: Readonly<Record<string, string | number>> = {}): string {
    return uiText(key, parameters);
  }
  plural(
    key: MessageKey,
    count: number,
    parameters: Readonly<Record<string, string | number>> = {},
  ): string {
    return uiPlural(key, count, parameters);
  }
  relativeDate(value: string | undefined): string {
    return uiRelativeDate(value);
  }
  setLocale(locale: UiLocale): void {
    setUiLocale(locale);
  }
}

export function initializeUiLocalization(): void {
  applyLocale();
}

/** A stored personal choice the host can show by itself, or English. */
export function resolveUiLocale(stored: string | null | undefined): UiLocale {
  return typeof stored === "string" && hostLocales.includes(stored) ? stored : "en";
}

export function currentUiLocale(): UiLocale {
  return activeLocale;
}

/** This browser's own choice, or undefined when it follows the site default. */
export function personalUiLocale(): UiLocale | undefined {
  return personalLocale;
}

export function siteLanguages(): SiteLanguages {
  return siteLanguagesValue ?? defaultSiteLanguages;
}

/** Chooses this browser's language and keeps it across visits. */
export function setUiLocale(locale: UiLocale): void {
  setPersonalUiLocale(locale);
}

/** Chooses this browser's language, or follows the site default when undefined. */
export function setPersonalUiLocale(locale: UiLocale | undefined): void {
  if (locale !== undefined && !isLocaleTag(locale)) return;
  const changed = locale !== personalLocale;
  personalLocale = locale;
  if (locale === undefined) removeStorage(personalStorageKey);
  else writeStorage(personalStorageKey, locale);
  update(changed);
}

/** Applies the campaign's site languages; undefined restores the defaults. */
export function applySiteLanguages(languages: SiteLanguages | undefined): void {
  const next = languages === undefined ? undefined : normalizeSiteLanguages(languages);
  if (JSON.stringify(next) === JSON.stringify(siteLanguagesValue)) return;
  siteLanguagesValue = next;
  if (next === undefined) removeStorage(siteStorageKey);
  else writeStorage(siteStorageKey, JSON.stringify(next));
  update(true);
}

/** Reads site languages from untrusted data, repairing what it can; undefined when unusable. */
export function parseSiteLanguages(value: unknown): SiteLanguages | undefined {
  if (!isRecord(value) || !isLocaleTag(value["defaultLocale"])) return undefined;
  const enabled = value["enabledLocales"];
  if (!Array.isArray(enabled) || enabled.length > maximumSiteLanguages) return undefined;
  if (!enabled.every(isLocaleTag)) return undefined;
  return normalizeSiteLanguages({ defaultLocale: value["defaultLocale"], enabledLocales: enabled });
}

/**
 * Notifies `listener` after the active language, the personal choice or the
 * site languages change; returns an unsubscribe function.
 */
export function onUiLocaleChange(listener: () => void, signal?: AbortSignal): () => void {
  const handler = (): void => listener();
  localeChangeTarget.addEventListener("change", handler, signal ? { signal } : undefined);
  return () => localeChangeTarget.removeEventListener("change", handler);
}

/** Only for code-owned descriptor labels; never for authored record or provider text. */
export function uiSourceLabel(source: string): string {
  return isHostMessageKey(source) ? uiText(source) : source;
}

export function uiText(
  key: MessageKey,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  return uiTextIn(activeLocale, key, parameters);
}

/** The message `key` in `locale` rather than the active language, for surfaces with their own. */
export function uiTextIn(
  locale: string,
  key: MessageKey,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const message = hostMessage(locale, key) ?? key;
  return interpolate(typeof message === "string" ? message : message.other, parameters);
}

/** Whether `text` is the message `key` in any interface language. */
export function uiTextInAnyLocale(key: MessageKey, text: string): boolean {
  return hostLocales.some((locale) => {
    const message = hostMessage(locale, key);
    return (typeof message === "string" ? message : message?.other) === text;
  });
}

export function uiPlural(
  key: MessageKey,
  count: number,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const message = hostMessage(activeLocale, key) ?? key;
  return interpolate(selectPluralForm(message, activeLocale, count), { n: count, ...parameters });
}

export function uiCollectionLabel(pageID: string, form: "one" | "other"): string {
  const key = collectionKeys[pageID]?.[form];
  return key === undefined ? pageID : uiText(key);
}

export function uiRelativeDate(value: string | undefined, now = Date.now()): string {
  if (value === undefined) return "";
  const instant = Date.parse(value);
  const elapsed = now - instant;
  if (!Number.isFinite(elapsed) || elapsed < 0) return formatDate(instant);
  const days = Math.floor(elapsed / 86_400_000);
  if (days === 0) return uiText("dashboard.today");
  if (days === 1) return uiText("dashboard.yesterday");
  if (days < 14) return uiText("dashboard.daysAgo", { n: days });
  return formatDate(instant);
}

const collectionKeys: Readonly<Record<string, Readonly<Record<"one" | "other", MessageKey>>>> =
  Object.freeze({
    characters: Object.freeze({
      one: "collection.characters.one",
      other: "collection.characters.other",
    }),
    locations: Object.freeze({
      one: "collection.locations.one",
      other: "collection.locations.other",
    }),
    events: Object.freeze({ one: "collection.events.one", other: "collection.events.other" }),
    mysteries: Object.freeze({
      one: "collection.mysteries.one",
      other: "collection.mysteries.other",
    }),
    factions: Object.freeze({ one: "collection.factions.one", other: "collection.factions.other" }),
    pantheon: Object.freeze({ one: "collection.pantheon.one", other: "collection.pantheon.other" }),
    artifacts: Object.freeze({
      one: "collection.artifacts.one",
      other: "collection.artifacts.other",
    }),
    history: Object.freeze({ one: "collection.history.one", other: "collection.history.other" }),
    companions: Object.freeze({
      one: "collection.companions.one",
      other: "collection.companions.other",
    }),
  });

function normalizeSiteLanguages(languages: SiteLanguages): SiteLanguages {
  const enabled = ["en", ...languages.enabledLocales.filter(isLocaleTag)].filter(
    (locale, index, all) => all.indexOf(locale) === index,
  );
  const kept = enabled.slice(0, maximumSiteLanguages);
  return Object.freeze({
    defaultLocale: kept.includes(languages.defaultLocale) ? languages.defaultLocale : "en",
    enabledLocales: Object.freeze(kept),
  });
}

/** The personal choice while the site offers it, otherwise the site default. */
function resolveActiveLocale(): UiLocale {
  const site = siteLanguages();
  return personalLocale !== undefined && site.enabledLocales.includes(personalLocale)
    ? personalLocale
    : site.defaultLocale;
}

function update(notify: boolean): void {
  const next = resolveActiveLocale();
  if (next === activeLocale && !notify) return;
  activeLocale = next;
  applyLocale();
  localeChangeTarget.dispatchEvent(new Event("change"));
}

function formatDate(instant: number): string {
  try {
    return new Intl.DateTimeFormat(activeLocale).format(new Date(instant));
  } catch {
    return new Date(instant).toLocaleDateString();
  }
}

function applyLocale(): void {
  if (typeof document !== "undefined") document.documentElement.lang = activeLocale;
}

function readPersonalLocale(): UiLocale | undefined {
  const stored = readStorage(personalStorageKey);
  return isLocaleTag(stored) ? stored : undefined;
}

function readCachedSiteLanguages(): SiteLanguages | undefined {
  const stored = readStorage(siteStorageKey);
  if (stored === null) return undefined;
  try {
    return parseSiteLanguages(JSON.parse(stored));
  } catch {
    return undefined;
  }
}

function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch {
    /* A blocked preference store must not break the campaign UI. */
  }
}

function removeStorage(key: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  } catch {
    /* A blocked preference store must not break the campaign UI. */
  }
}
