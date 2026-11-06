import { BoundaryValidationError, hasOnlyKeys, isRecord } from "./boundary.js";

/**
 * message-catalog.v1: the interface texts of the host or one add-on in one
 * language. This module mirrors contracts/addons/v3/message-catalog.schema.json
 * and the Go inspector's catalog rules; both run the fixtures in
 * contracts/addons/v3/examples/catalogs/.
 */
export const messageCatalogContract = "message-catalog.v1";
/** Reserved section for add-on manifest strings; the host builds its English text. */
export const manifestSection = "manifest";
export const maximumCatalogBytes = 2 * 1024 * 1024;
export const maximumCatalogMessages = 20_000;

const pluralForms = ["zero", "one", "two", "few", "many", "other"] as const;
export type PluralForm = (typeof pluralForms)[number];
export type PluralMessage = Readonly<Partial<Record<PluralForm, string>>> & {
  readonly other: string;
};
export type CatalogMessage = string | PluralMessage;
export type CatalogSection = Readonly<Record<string, CatalogMessage>>;

export interface MessageCatalog {
  readonly contractVersion: typeof messageCatalogContract;
  readonly locale: string;
  readonly sections: Readonly<Record<string, CatalogSection>>;
}

export interface CatalogCheck {
  /** The catalog without dropped messages, or undefined when the whole file was rejected. */
  readonly catalog: MessageCatalog | undefined;
  readonly issues: readonly string[];
  /** Keys whose message was dropped, in file order. */
  readonly dropped: readonly string[];
}

const localeTagPattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/u;
const sectionIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const placeholderPattern = /\{([A-Za-z0-9_]+)\}/gu;
const catalogKeys = new Set(["contractVersion", "locale", "sections"]);
const pluralKeys = new Set<string>(pluralForms);

/** Whether `value` is a canonical language tag: language, optional script, optional region. */
export function isLocaleTag(value: unknown): value is string {
  return typeof value === "string" && localeTagPattern.test(value);
}

/** The languages to try for `locale`, most specific first, always ending in English. */
export function localeFallbacks(locale: string): readonly string[] {
  const result: string[] = [];
  const parts = isLocaleTag(locale) ? locale.split("-") : [];
  for (let length = parts.length; length > 0; length -= 1) {
    const tag = parts.slice(0, length).join("-");
    if (!result.includes(tag)) result.push(tag);
  }
  if (!result.includes("en")) result.push("en");
  return result;
}

/** Validates the catalog's shape exactly as the public schema does. */
export function parseMessageCatalog(value: unknown, boundary: string): MessageCatalog {
  const problem = shapeProblem(value);
  if (problem !== undefined) throw new BoundaryValidationError(boundary, problem);
  return value as MessageCatalog;
}

/**
 * Applies the catalog rules. A file with the wrong shape or language is
 * rejected whole; a message that breaks a translation rule is dropped.
 * Without `english` the catalog is a source catalog, which must not write the
 * reserved manifest section.
 */
export function checkMessageCatalog(
  value: unknown,
  options: { readonly locale: string; readonly english?: MessageCatalog },
): CatalogCheck {
  const shape = shapeProblem(value);
  if (shape !== undefined) return { catalog: undefined, issues: [shape], dropped: [] };
  const catalog = value as MessageCatalog;
  if (catalog.locale !== options.locale)
    return {
      catalog: undefined,
      issues: [`the file is for ${catalog.locale}, not ${options.locale}`],
      dropped: [],
    };
  if (catalogMessageCount(catalog) > maximumCatalogMessages)
    return {
      catalog: undefined,
      issues: [`more than ${maximumCatalogMessages} messages`],
      dropped: [],
    };
  const englishSections = options.english === undefined ? undefined : keySections(options.english);
  const englishMessages =
    options.english === undefined ? undefined : flattenCatalog(options.english);
  const issues: string[] = [],
    dropped: string[] = [],
    seen = new Set<string>(),
    sections: Record<string, CatalogSection> = {};
  for (const [sectionId, section] of Object.entries(catalog.sections)) {
    const kept: Record<string, CatalogMessage> = {};
    for (const [key, message] of Object.entries(section)) {
      const issue = messageIssue(sectionId, key, message, seen, englishSections, englishMessages);
      if (issue === undefined) {
        kept[key] = message;
        seen.add(key);
      } else {
        issues.push(`${key}: ${issue}`);
        dropped.push(key);
      }
    }
    sections[sectionId] = kept;
  }
  return {
    catalog: { contractVersion: messageCatalogContract, locale: catalog.locale, sections },
    issues,
    dropped,
  };
}

/** Every message by key; keys are unique across sections in a checked catalog. */
export function flattenCatalog(catalog: MessageCatalog): ReadonlyMap<string, CatalogMessage> {
  const result = new Map<string, CatalogMessage>();
  for (const section of Object.values(catalog.sections))
    for (const [key, message] of Object.entries(section))
      if (!result.has(key)) result.set(key, message);
  return result;
}

export function catalogMessageCount(catalog: MessageCatalog): number {
  let count = 0;
  for (const section of Object.values(catalog.sections)) count += Object.keys(section).length;
  return count;
}

/** The placeholder names a message uses, across all its plural forms. */
export function messagePlaceholders(message: CatalogMessage): ReadonlySet<string> {
  const names = new Set<string>();
  for (const text of typeof message === "string" ? [message] : Object.values(message))
    for (const match of text.matchAll(placeholderPattern)) names.add(match[1]!);
  return names;
}

/** Replaces `{name}` placeholders; unknown names stay as written. */
export function interpolate(
  template: string,
  parameters: Readonly<Record<string, string | number>>,
): string {
  return template.replace(placeholderPattern, (match, key: string) =>
    Object.hasOwn(parameters, key) ? String(parameters[key]) : match,
  );
}

/** The text of `message` for `count` in `locale`, falling back to `other`. */
export function selectPluralForm(message: CatalogMessage, locale: string, count: number): string {
  if (typeof message === "string") return message;
  let category: Intl.LDMLPluralRule = "other";
  try {
    category = new Intl.PluralRules(locale).select(Math.abs(count));
  } catch {
    /* An unsupported tag keeps the `other` form. */
  }
  return message[category] ?? message.other;
}

function messageIssue(
  sectionId: string,
  key: string,
  message: CatalogMessage,
  seen: ReadonlySet<string>,
  englishSections: ReadonlyMap<string, string> | undefined,
  englishMessages: ReadonlyMap<string, CatalogMessage> | undefined,
): string | undefined {
  if (seen.has(key)) return "the key already appears in another section";
  const manifestKey = key.startsWith(`${manifestSection}.`);
  if (sectionId === manifestSection && englishSections === undefined)
    return "the host writes the English manifest section";
  if (manifestKey !== (sectionId === manifestSection))
    return manifestKey
      ? "manifest keys belong in the manifest section"
      : "the manifest section holds only manifest keys";
  if (englishSections === undefined || englishMessages === undefined) return undefined;
  const englishSection = englishSections.get(key);
  if (englishSection === undefined) return "the key is not in the English catalog";
  if (englishSection !== sectionId) return `the English key is in section ${englishSection}`;
  const english = englishMessages.get(key)!;
  if (typeof english === "string" && typeof message !== "string")
    return "plural forms cannot translate a single English message";
  if (!sameNames(messagePlaceholders(message), messagePlaceholders(english)))
    return "placeholders differ from the English message";
  return undefined;
}

function keySections(catalog: MessageCatalog): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [sectionId, section] of Object.entries(catalog.sections))
    for (const key of Object.keys(section)) if (!result.has(key)) result.set(key, sectionId);
  return result;
}

function sameNames(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name));
}

function shapeProblem(value: unknown): string | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, catalogKeys))
    return "not a message-catalog.v1 object";
  if (value["contractVersion"] !== messageCatalogContract)
    return "contractVersion must be message-catalog.v1";
  if (!isLocaleTag(value["locale"])) return "locale must be a canonical language tag";
  const sections = value["sections"];
  if (!isRecord(sections)) return "sections must be an object";
  const ids = Object.keys(sections);
  if (ids.length > 200) return "more than 200 sections";
  for (const id of ids) {
    if (id.length > 64 || !sectionIdPattern.test(id)) return `section ${id} has an invalid id`;
    const section = sections[id];
    if (!isRecord(section)) return `section ${id} must be an object`;
    for (const [key, message] of Object.entries(section)) {
      if (!validKey(key)) return `section ${id} has an invalid key`;
      if (!validMessage(message)) return `${key} is not a valid message`;
    }
  }
  return undefined;
}

function validKey(key: string): boolean {
  if (key.length === 0 || codePointLength(key) > 500) return false;
  for (const character of key) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && codePointLength(value) <= 4000;
}

/** Length as JSON Schema counts it: in code points, not UTF-16 units. */
function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xdc00 || unit > 0xdfff) length += 1;
  }
  return length;
}

function validMessage(value: unknown): value is CatalogMessage {
  if (typeof value === "string") return validText(value);
  return (
    isRecord(value) &&
    hasOnlyKeys(value, pluralKeys) &&
    validText(value["other"]) &&
    Object.values(value).every(validText)
  );
}
