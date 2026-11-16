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
  Czech translation when the catalog has none. Packages that are not active
  have no catalogs in the browser, so the server sends their translated
  manifest texts: an add-on snapshot gives each installed generation's
  (`manifestTexts`, read from the stored package's catalogs) and an activation
  review the target package's (`targetManifestTexts`). The add-on manager and
  its configuration panel show those, falling back to the manifest's English.
- **The host tolerates bad catalogs; the inspector command does not.** Every
  host start re-inspects active packages, so a catalog problem becomes a
  report issue that drops that message or language instead of blocking
  activation. `codex-addon-inspect` exits non-zero on the same issues, so
  add-on CI catches them.
- **The server serves effective catalogs.** Inspection produces each
  language's validated catalog, with the built manifest section, and its
  SHA-256. The browser graph lists every active add-on's catalogs, headless
  add-ons included, and `GET /api/addons/{id}/generations/{gen}/locales/{locale}/{sha256}`
  serves one with immutable caching. One server function
  (`catalogIndexLocked`) builds that index, language packs included.
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
  active add-on's catalog, so a consumer can show its provider's messages;
  `addon: "codex-core"` names the host's catalog, for the host's own services.
  `host.locale` becomes a BCP 47 string.
- **Workers stay English and may attach a key.** A worker issue can carry
  `issueKey` and `issueArgs` next to its English `issue`; the browser
  translates it through the provider's catalog. Workers always receive the
  locale `en`; `-locale` still parses but is ignored.
- **Languages page.** Everyone picks a personal language or follows the site.
  The DM also sets the site languages and sees a read-only coverage map of the
  host and every add-on, compares English with a translation side by side,
  and exports the missing texts as a `message-catalog.v1` file to translate.
- **Language packs add translations without a new package.** A pack is a
  data-only ZIP ([`language-pack.v1`](../../contracts/addons/v3/language-pack.schema.json)):
  `pack.json` names one add-on, one language other than English, the add-on
  versions it applies to (a semantic version range that includes
  `builtFrom`, the version it was checked against) and its files: one
  `message-catalog.v1` catalog and, reserved, `content/**.json` translation
  overlays that the host validates and stores but does not apply yet. A pack
  holds nothing else. Authors keep sources in `packs/<locale>/`;
  `codex-addon-inspect -build-packs` builds and checks
  `<package file name>.<locale>.langpack.zip` against the package's English,
  and the publish action uploads them beside the package in its release.
- **The package wins key by key.** For a language with an applicable pack,
  `catalogIndexLocked` keeps every message of the package's own catalog and
  fills only the keys it lacks from the pack, whose messages are checked
  against the active package's English like any translation. The catalog's
  source is `package`, `pack` (only the pack has the language) or
  `package+pack`. A stored pack whose versions exclude the active add-on is
  kept but unused.
- **The host fetches packs from linked add-ons' GitHub repositories**, in the
  background: at start, when the site's enabled languages change, when an
  add-on's active generation changes, and when the DM asks on the Languages
  page. It reads the repository's 30 newest releases with the stored token,
  prefers packs built from the active version, otherwise the newest, and
  downloads at most four per language and check. It stores each pack by its
  SHA-256 under the package directory with one SQLite row per add-on and
  language, deletes them when the language is disabled or the add-on
  uninstalled, and keeps check results in memory. A failed check never
  blocks enabling a language or activating an add-on: the browser graph
  reports each add-on's pack states (`available`, `installed`, `outdated`,
  `none`, `failed` with a short error code), and the Languages page shows
  them. Languages only packs supply can be enabled.

## Consequences

- One format and one translator replace four add-on systems; every
  first-party add-on now ships `message-catalog.v1` catalogs.
- The site language travels with campaign backups and recovery points, as the
  theme does. Stored language packs travel with the full server archive,
  like installed packages, and not with Settings backups; a restored server
  fetches what is missing at its next check.
- Each linked add-on costs one GitHub request per check, plus a download per
  new pack. Unlinked add-ons, such as uploaded ZIPs, get no packs.
- Hosts older than language packs list `.langpack.zip` release assets as
  installable packages, so the host must be deployed before add-ons publish
  packs.
- Published add-ons keep comparing `host.locale` with `"cs"`; current sites
  produce only `en` and `cs`, so nothing changes for them until a third
  language is enabled.
- The host bundle carries every built-in language; Czech adds about 30 KB
  compressed.
- The host's own languages stay built in; there are no host packs until a
  host language beyond English and Czech is wanted.
- Follow-up work is in the [backlog](../BACKLOG.md): moving each add-on to the
  catalog format and keyed worker messages, and applying Compendium record
  translations from pack content.

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
- **A pack winning over the package's catalog:** a pack covers a range of
  versions and may lag behind the code, while the package's catalog was
  checked with exactly that code; filling gaps only also means a pack can
  never make a shipped translation worse.
- **Building packs in the publish action from the catalogs a package ships:**
  would only duplicate the package. The action has no source checkout and
  publishes only bytes the add-on's tests inspected, so packs are built and
  checked in the test job and handed over as a second artifact.
- **Storing packs in the blob store:** blobs are campaign files with owners,
  visibility and recovery points; packs belong to add-ons like their
  packages and are downloaded again when lost.
