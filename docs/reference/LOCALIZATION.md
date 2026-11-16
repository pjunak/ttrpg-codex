# Interface languages

One language system serves the host and every add-on
([ADR-0007](../decisions/0007-interface-languages.md)). Backend text stays
English; every text a person reads comes from a message catalog and falls back
to English. Authored campaign content and reference content keep their own
language.

## Choosing the language

| Setting | Stored in | Who changes it |
| --- | --- | --- |
| Site default and enabled languages | Campaign record `settings/language` (`defaultLocale`, `enabledLocales`) | The DM, in Settings → Language |
| This browser's language, or "follow the site" | `localStorage["codex_lang"]` | Anyone, in Settings → Language |

Resolution: the browser's choice while the site enables it, otherwise the site
default. A message missing in that language falls back through its base
language (`pt-BR` → `pt`) to English. Until the DM saves the setting, English is
the default and every built-in language is enabled; English is always enabled.
The browser caches the last site languages in `codex_site_lang`, so the sign-in
page and startup show the right language before the campaign loads. Saving the
site setting updates every open browser through the usual campaign events.
`ui-localization.ts` owns this resolution and notifies Lit components through
`UiLocalizationController`.

The DM can enable any language the host ships or any active add-on ships. A
language only add-ons ship shows the host interface in English.

## Catalogs

Every catalog is a
[`message-catalog.v1`](../../contracts/addons/v3/message-catalog.schema.json)
file: sections of keys, each message a string or CLDR plural forms with
`{name}` placeholders. English defines the keys; other languages may omit keys
and must keep each key's section and placeholders. The Go inspector
(`internal/addons/packageinspect/catalog.go`) and
`frontend/src/core/message-catalog.ts` apply the same rules and share the
fixtures in `contracts/addons/v3/examples/catalogs/`.

**Host.** `frontend/src/locales/en.json` and `cs.json` hold about 1,400 keys
in sections named after the interface areas, plus `controls` for the shared
controls lent to add-ons. TypeScript derives `MessageKey` from the English
file and the Czech file must be complete at compile time;
`test/host-catalogs.test.ts` and the Go catalog tests also check the rules and
duplicate keys. Add a text by adding its key to both files in the same
section. Components translate with `UiLocalizationController.t`/`plural` or
`uiText`/`uiPlural`.

**Add-ons.** A package declares `locales` (English required) in its manifest.
Inspection builds each language's effective catalog: the file with
rule-breaking messages dropped, the English `manifest` section built from
`addon.json`, and the deprecated `config.labels` folded into Czech. Problems
become issues on the catalog and never block installation, because every host
start re-inspects active packages; `codex-addon-inspect` fails on them for
package builds. See [browser add-ons](BROWSER_ADDONS.md) for how catalogs are
served and the [API reference](../../examples/addons/API_V3.md#message-catalogs)
for the author's view.

## Language packs

A language pack translates one add-on into one language without a new package
([`language-pack.v1`](../../contracts/addons/v3/language-pack.schema.json)).
It is a ZIP with `pack.json`, an optional `message-catalog.v1` catalog and
optional `content/**.json` translation overlays, which the host checks and
stores but does not apply yet. `pack.json` names the add-on, the language
(never `en`), the add-on versions it fits (`addonVersions`, a semantic version
range) and `builtFrom`, the version whose English it was checked against.
`internal/addons/packageinspect/languagepack.go` inspects packs with bounded,
containment-checked entries and refuses any file `pack.json` does not declare.

**Publishing.** Authors keep pack sources in `packs/<locale>/messages.json`
(and `content/`), build them with `codex-addon-inspect -build-packs`, and the
publish action uploads `<package file name>.<locale>.langpack.zip` beside the
package ([authoring](../../examples/addons/AUTHORING.md#language-packs)).

**Fetching.** `githubsource.PackSync` checks every active add-on linked to a
GitHub repository: at host start, when `settings/language` changes or a
campaign is restored, when an add-on's active generation changes (the
`browser-addons-changed` event), and when the DM presses **Check for language
packs**. Checks run one at a time in the background. For each enabled
language other than English it lists the repository's 30 newest published
releases, tries packs built from the active add-on version first and then the
newest, and downloads at most four. A pack whose digest is already stored is
not downloaded again; one whose `addonVersions` exclude the active version is
skipped. Failed add-ons are checked again on the next pass. Until the DM saves
the site languages, the host languages (English and Czech) count as enabled.

**Storing.** `packagemanager` stores each pack as
`<data>/addons/.language-packs/<sha256>.zip` with a row in
`addon_language_packs` (add-on, language, digest, versions, `builtFrom`), and
re-inspects stored packs at start. Disabling a language deletes its packs;
uninstalling an add-on deletes its packs in the same transaction; files no row
uses are deleted. Check results (published languages, failures) are kept in
memory only. Stored packs travel with the full server archive, as packages do,
and not with Settings backups.

**Merging.** `catalogIndexLocked` merges an applicable pack into the add-on's
catalogs: the package's own messages win key by key and the pack fills the
keys they lack, after the pack is checked against the active package's English
(unknown keys and changed placeholders are dropped as `language pack:`
issues). The catalog's `source` is `package`, `pack` or `package+pack`, and
its URL names the merged catalog's digest. Each add-on's catalog entry also
lists `packs`: per language `available` (published, language not enabled),
`installed` (with `version`, the pack's `builtFrom`), `outdated` (stored but
excluded by its versions), `none` (nothing published fits) or `failed`, with
an `error` of `unavailable`, `rate-limited`, `tls`, `invalid` or `storage`.

## In the browser

`frontend/src/addons/catalog-store.ts` holds one add-on session's catalogs. It
loads an add-on's catalogs for the active language and its fallbacks before the
add-on activates, loads every add-on's catalogs again when the language
changes, and notifies the contribution registry, so host-drawn labels and the
`ui.i18n` facet (`frontend/src/addons/i18n.ts`) re-render. A failed catalog is
recorded as a `catalog` diagnostic and its language falls back to English.

Workers always receive the locale `en`. A worker attaches a catalog key to a
user-facing issue (`workerrpc.IssueDetails`); the host forwards the key and
bounded arguments, and `ServiceError.issueText` lets a consumer translate it
through the provider's catalog.

## Languages page

Settings → Language shows everyone the personal choice. The DM also sees the
site form and, for each enabled language other than English, a coverage map:
the Codex interface and every active add-on, the share of their keys the
language translates, by section, where each catalog comes from and any catalog
issues. A section can be compared side by side with English, optionally only
the missing keys, and the missing texts export as a `message-catalog.v1` file
to translate and merge back. Each linked add-on also shows its language pack
for the language: in use, published for other versions, none published, or
why it failed. **Check for language packs** asks the host to look again. A
language that only add-on language packs supply can be enabled, which
downloads them. The page reads catalogs only; translations change through
package and language pack releases.
