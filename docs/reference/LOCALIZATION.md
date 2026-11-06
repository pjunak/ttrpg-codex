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
to translate and merge back. The page reads catalogs only; translations change
through package releases. Downloadable language packs are planned
([backlog](../BACKLOG.md#next)).
