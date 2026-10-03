# Documentation

Start with the guide for your task. References describe how things work now;
the backlog lists future work. Links to add-on repositories assume they are
checked out next to this one.

## Run a campaign site

| Task | Read |
| --- | --- |
| Install, configure or update the server | [Self-hosting](SELF_HOSTING.md) |
| Install or update add-ons, including from private GitHub repositories | [Add-on installation](SELF_HOSTING.md#add-on-installation) |
| Back up, restore or recover access | [Backups](SELF_HOSTING.md#backups) and [password recovery](SELF_HOSTING.md#password-changes-and-access-recovery) |
| Choose a ruleset, books or service providers | [Rules and sources](reference/RULES_SOURCES.md) |
| Recover Markdown drafts or customize collection views | [Editing and browsing](reference/EDITOR_BROWSING.md) |
| Use quick search, activity and map editing | [Search, activity and maps](reference/SEARCH_ACTIVITY_MAP.md) |
| Build characters, automatic saving and DM grants | [Character sheet workflow](../../addon-dnd-character-sheets/docs/WORKFLOW.md) |

## Develop the host or an add-on

Begin with [Contributing](../CONTRIBUTING.md) and [Architecture](ARCHITECTURE.md).
Add-on authors start with the [authoring guide](../examples/addons/AUTHORING.md),
then the [API reference](../examples/addons/API_V3.md) and the
[machine-readable contracts](../contracts/addons/v3/).

| Area | References |
| --- | --- |
| Records, access and mutations | [Core data](reference/CORE_DATA.md), [authentication](reference/AUTHENTICATION.md) |
| Files and durable storage | [Media](reference/MEDIA.md), [blobs](reference/BLOBS.md), [backups](reference/BACKUP_RESTORE.md) |
| Live updates | [Event stream](reference/EVENT_STREAM.md) |
| Campaign views | [Maps](reference/MAPS.md), [editing and browsing](reference/EDITOR_BROWSING.md), [performance](reference/PERFORMANCE.md) |
| Packages and browser add-ons | [Package lifecycle](reference/PACKAGE_LIFECYCLE.md), [browser add-ons](reference/BROWSER_ADDONS.md), [shared UI](reference/UI_FOUNDATIONS.md) |
| Add-on data, content and services | [Add-on data](reference/ADDON_DATA.md), [content](reference/CONTENT.md), [service broker](reference/SERVICE_BROKER.md), [retained history](reference/RETAINED_ADDON_HISTORY.md), [rule details](reference/RULE_DETAILS.md) |
| Native workers | [Supervision](reference/WORKER_SUPERVISION.md), [worker broker](reference/WORKER_BROKER.md) |

## Decisions and plans

[Architecture decisions](decisions/) explain why the system is shaped the way
it is. [BACKLOG.md](BACKLOG.md) is the only task list for the host and the
first-party add-ons.
