# ADR-0007: One language system for the host and add-ons

**Status:** Accepted

**Date:** 2026-11-06

**Decider:** Project maintainer

## Context

The host interface speaks English and Czech. Its texts live in TypeScript
catalogs compiled into the frontend, and each browser picks its language in
`localStorage` with English as the default; the server stores no language.

Add-ons learn the language only from `codexContribution.host.locale`
(`"en" | "cs"`), so each first-party add-on runs its own translation system:
the Compendium ships flat `locales/*.json` files that nothing in the host
reads, Character Sheets compiles JSON into its bundle, DM Tools and Homebrew
keep TypeScript maps, and Character Sheets turns Engine English back into
Czech with regular expressions. The manifest `locales` map exists, but the
inspector only checks that its files are present and the asset route never
serves them. The only translatable manifest strings are contribution labels in
a closed `{en, cs}` object. Workers write English messages, and the
`-locale`/`CODEX_LOCALE` setting they receive is read by no add-on.

The owner wants one system: a site-wide language with a personal choice per
browser, add-on translations that follow it and fall back to English, a
settings page that shows what is translated across the host and every
installed add-on, and later language packs that are downloaded only for the
languages a site enables. Backend text stays English; every text a person
reads can be translated.

## Decision

- **One catalog format, `message-catalog.v1`**
  ([schema](../../contracts/addons/v3/message-catalog.schema.json)), for the
  host and add-ons: `{contractVersion, locale, sections}`, where each section
  maps keys to a message. A message is a string or a plural object
  (`zero`, `one`, `two`, `few`, `many`, `other`) with `{name}` placeholders.
  Sections give the Languages page its tree whatever key style a catalog uses.
  Keys are unique across sections. English is required, complete and defines
  the key set; another language may leave keys out, and each key it has must
  sit in the same section and use only English's placeholders.
- **Manifest strings are translated through the catalog.** A reserved
  `manifest` section holds `manifest.*` keys whose English text the host
  builds from `addon.json`: the name, description, contribution labels,
  permission and dependency reasons, the ruleset name and content group labels.
  `config.labels` stays accepted but is deprecated; its `cs` text counts as the
  Czech translation when the catalog has none.
- **The host tolerates bad catalogs; the inspector command does not.** Every
  host start re-inspects active packages, so a catalog problem becomes a
  report issue that drops that message or language instead of blocking
  activation. `codex-addon-inspect` exits non-zero on the same issues, so
  add-on CI catches them.
- **The server serves effective catalogs.** Inspection produces each
  language's validated catalog, with the built manifest section, and its
  SHA-256. The browser graph lists every active add-on's catalogs, headless
  add-ons included, and `GET /api/addons/{id}/generations/{gen}/locales/{locale}/{sha256}`
  serves one with immutable caching. One server function builds that index;
  language packs will add their catalogs there without browser changes.
- **The site language is a campaign setting.** `settings/language` holds
  `defaultLocale` and `enabledLocales` (English always enabled). Like the
  site theme, only the DM can change it, writes use revisions, and open browsers
  update live; the browser caches it to avoid a flash and to choose the
  sign-in page's language. A language the DM can enable is one the host ships
  or one any active add-on ships.
- **Resolution:** the browser's personal choice (absent means follow the
  site), then the site default, then the base language (`pt-BR` → `pt`), then
  English. Missing texts fall back the same way, key by key.
- **Host catalogs are JSON**, one bundled file per language. TypeScript still
  derives the message keys from the English file, and tests require every
  built-in language to be complete.
- **Add-ons get a translator.** The browser SDK's `i18n` facet (capability
  `ui.i18n`) gives the language, `t`, `plural`, `message` and change
  notifications, with catalogs loaded before an add-on mounts. `message`
  translates a `LocalizedText` (`{text, key?, args?, addon?}`) through any
  active add-on's catalog, so a consumer can show its provider's messages.
  `host.locale` becomes a BCP 47 string.
- **Workers stay English and may attach a key.** A worker issue can carry
  `issueKey` and `issueArgs` next to its English `issue`; the browser
  translates it through the provider's catalog. Workers always receive the
  locale `en`; `-locale` still parses but is ignored.
- **Languages page.** Everyone picks a personal language or follows the site.
  The DM also sets the site languages and sees a read-only coverage map of the
  host and every add-on, compares English with a translation side by side,
  and exports the missing texts as a `message-catalog.v1` file to translate.

## Consequences

- One format and one translator replace four add-on systems; every
  first-party add-on now ships `message-catalog.v1` catalogs.
- The site language travels with campaign backups and recovery points, as the
  theme does.
- Published add-ons keep comparing `host.locale` with `"cs"`; current sites
  produce only `en` and `cs`, so nothing changes for them until a third
  language is enabled.
- The host bundle carries every built-in language; Czech adds about 30 KB
  compressed.
- Follow-up work is in the [backlog](../BACKLOG.md): moving each add-on to the
  catalog format and keyed worker messages, language-pack ZIPs that the host
  downloads from an add-on's GitHub source when a language is enabled,
  Compendium record translations as pack content, and translated activation
  reviews.

## Alternatives considered

- **A dedicated settings table and public endpoint** for the site language:
  about the same behaviour for several hundred more lines, a new event and a
  new client, when the campaign settings collection already gives DM-only
  writes, revisions and live updates.
- **Separate language packs only**, with English alone in each ZIP: saves the
  most disk, but sites that upload ZIPs by hand would need to upload every
  pack too. Interface catalogs are 5–136 KB per language, so packs pay off
  mainly for large content such as Compendium record translations.
- **Lazy-loading host languages:** saves about 30 KB but makes every language
  switch and several synchronous helpers asynchronous.
- **A flat catalog without sections:** simpler, but catalogs keyed by English
  sentences would have no structure to show.
- **Rejecting bad catalogs at host inspection:** would stop the published
  Compendium from starting after the deploy.
- **Translating in workers:** would need a per-request language on every
  worker call; English text with an optional key keeps workers simple and puts
  every translation in one place.
