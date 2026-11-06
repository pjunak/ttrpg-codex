import {
  flattenCatalog,
  messageCatalogContract,
  type CatalogMessage,
  type CatalogSection,
  type MessageCatalog,
} from "../core/message-catalog.js";

/** One section of a catalog: its English keys and how many each language translates. */
export interface CoverageSection {
  readonly id: string;
  readonly total: number;
  /** Translated keys by language. */
  readonly translated: Readonly<Record<string, number>>;
}

/** The host or one add-on: its sections and per-language totals. */
export interface CoverageSource {
  readonly id: string;
  readonly name: string;
  readonly sections: readonly CoverageSection[];
  readonly total: number;
  readonly translated: Readonly<Record<string, number>>;
}

/** One row of the side-by-side view. */
export interface CoverageRow {
  readonly key: string;
  readonly english: string;
  /** Undefined when the language has no translation. */
  readonly translation: string | undefined;
}

/**
 * How much of `english` each language translates, by section. A key counts as
 * translated when the language's own catalog has it; fallbacks do not count.
 */
export function catalogCoverage(
  id: string,
  name: string,
  english: MessageCatalog,
  translations: ReadonlyMap<string, MessageCatalog | undefined>,
): CoverageSource {
  const messages = new Map(
    [...translations].map(([locale, catalog]) => [
      locale,
      catalog === undefined ? new Map<string, CatalogMessage>() : flattenCatalog(catalog),
    ]),
  );
  const sections = Object.entries(english.sections)
    .filter(([, section]) => Object.keys(section).length > 0)
    .map(([sectionId, section]) => {
      const keys = Object.keys(section);
      return {
        id: sectionId,
        total: keys.length,
        translated: Object.fromEntries(
          [...messages].map(([locale, catalog]) => [
            locale,
            keys.filter((key) => catalog.has(key)).length,
          ]),
        ),
      };
    });
  const total = sections.reduce((sum, section) => sum + section.total, 0);
  const translated = Object.fromEntries(
    [...messages.keys()].map((locale) => [
      locale,
      sections.reduce((sum, section) => sum + (section.translated[locale] ?? 0), 0),
    ]),
  );
  return { id, name, sections, total, translated };
}

/** English beside a translation for one section, in English key order. */
export function coverageRows(
  english: MessageCatalog,
  translation: MessageCatalog | undefined,
  sectionId: string,
): readonly CoverageRow[] {
  const translated =
    translation === undefined ? new Map<string, CatalogMessage>() : flattenCatalog(translation);
  return Object.entries(english.sections[sectionId] ?? {}).map(([key, message]) => {
    const other = translated.get(key);
    return {
      key,
      english: displayMessage(message),
      translation: other === undefined ? undefined : displayMessage(other),
    };
  });
}

/**
 * A message-catalog.v1 file holding the English text of every key `translation`
 * lacks, ready to translate and merge back into the language's catalog.
 */
export function missingCatalog(
  english: MessageCatalog,
  translation: MessageCatalog | undefined,
  locale: string,
): MessageCatalog {
  const translated =
    translation === undefined ? new Set<string>() : new Set(flattenCatalog(translation).keys());
  const sections: Record<string, CatalogSection> = {};
  for (const [sectionId, section] of Object.entries(english.sections)) {
    const missing = Object.entries(section).filter(([key]) => !translated.has(key));
    if (missing.length > 0) sections[sectionId] = Object.fromEntries(missing);
  }
  return { contractVersion: messageCatalogContract, locale, sections };
}

/** A share as a whole percentage, rounded down so incomplete never reads as 100%. */
export function coveragePercent(translated: number, total: number): number {
  return total === 0 ? 100 : Math.floor((translated / total) * 100);
}

function displayMessage(message: CatalogMessage): string {
  return typeof message === "string"
    ? message
    : Object.entries(message)
        .map(([form, text]) => `${form}: ${text}`)
        .join(" · ");
}
