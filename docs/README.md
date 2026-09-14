# Documentation

Start with the guide for your task. References describe current behavior;
the backlog tracks future work. Paths to companion repositories assume they
are checked out alongside this repository.

## Use or operate a campaign

| Task | Read |
| --- | --- |
| Install, configure or update the server | [Self-hosting](SELF_HOSTING.md) |
| Install add-ons or configure private GitHub access | [Add-on installation](SELF_HOSTING.md#add-on-installation) |
| Choose a ruleset, books or service providers | [Rules and sources](rewrite/RULES_SOURCES.md) |
| Recover Markdown or customize collection views | [Editing and browsing](rewrite/EDITOR_BROWSING.md) |
| Use quick search, activity and map editing | [Search, activity and maps](rewrite/SEARCH_ACTIVITY_MAP.md) |
| Understand character changes, DM grants and history | [Character workflow](rewrite/CHARACTER_BUILD_HISTORY.md) |
| Restore a backup or recover access | [Backups](SELF_HOSTING.md#backups) and [password recovery](SELF_HOSTING.md#password-changes-and-access-recovery) |
| Convert an old campaign or retire an old sheet schema | [Offline conversion](rewrite/LEGACY_CONVERSION.md) and [sheet cutover](rewrite/CHARACTER_SHEET_CUTOVER.md) |

The conversion and cutover guides describe explicit maintenance operations.
They are unnecessary for a new installation.

## Develop the host or an add-on

Begin with [Contributing](../CONTRIBUTING.md) and [Architecture](ARCHITECTURE.md).
For add-ons, use the [authoring guide](../examples/addons/AUTHORING.md),
[API reference](../examples/addons/API_V3.md) and
[machine contracts](../contracts/addons/v3/).

Detailed references remain under `rewrite/` to preserve existing links. The
directory name records their origin; these documents describe the current
implementation unless explicitly labeled historical.

| Boundary | References |
| --- | --- |
| Records, access and mutations | [Core data](rewrite/CORE_DATA.md), [authentication](rewrite/AUTHENTICATION.md) |
| Media and durable storage | [Media](rewrite/MEDIA.md), [blobs](rewrite/BLOBS.md), [backups](rewrite/BACKUP_RESTORE.md) |
| Live invalidation and recovery | [Event stream](rewrite/EVENT_STREAM.md) |
| Packages and browser contributions | [Package lifecycle](rewrite/PACKAGE_LIFECYCLE.md), [browser add-ons](rewrite/BROWSER_ADDONS.md) |
| Content and service selection | [Content](rewrite/CONTENT.md), [service broker](rewrite/SERVICE_BROKER.md) |
| Native workers | [Supervision](rewrite/WORKER_SUPERVISION.md), [worker broker](rewrite/WORKER_BROKER.md) |
| Character persistence and explanations | [Retained history](rewrite/RETAINED_ADDON_HISTORY.md), [rule details](rewrite/RULE_DETAILS.md) |
| Campaign views | [Maps](rewrite/MAPS.md), [campaign browsing](rewrite/EDITOR_BROWSING.md) |

## Decisions, history and remaining work

[BACKLOG.md](BACKLOG.md) is the suite's only durable backlog. Its September 14
source audit separates T01–T19 concrete work from C01–C10 conditional extensions,
records source/deployment evidence, and retains the 33 accepted product gates.
Start there for the current completion list. The [feature audit](rewrite/FEATURE_PARITY_AUDIT.md)
preserves the original comparison and subsequent decisions; its missing-feature
descriptions are historical evidence, not a current bug list.
[Architecture decisions](decisions/) explain the choices behind the system.
