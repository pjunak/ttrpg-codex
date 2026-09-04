# Project backlog

This is the only durable backlog for the host and its four companion add-ons.
Implementation contracts describe current behavior; they are not roadmaps.

## Rewrite status

The Go host and Add-on API v3 are substantial working foundations, but the
rewrite is not a production replacement for v1. A real campaign-focused shell
now replaces the former generic browser and temporary status page. Its first
read-only dashboard and archive slice is intentionally not presented as full
workflow parity while the old features are ported, deliberately redesigned, or
explicitly retired by the maintainer.

`npm run check` validates implemented code. `npm run release-check` is a
separate product gate: automatic image publication and every requested publish
or deployment remain blocked while any checklist item in the marked section is
open or while `frontend/REWRITE_INCOMPLETE` exists.

## Completed rewrite foundations

- [x] Go HTTP host, role-aware authentication, CSRF protection, and SSE events.
- [x] SQLite campaign records, optimistic revisions, transactional mutations,
  role projections, reference-safe deletion, twins, and enumerations.
- [x] Immutable media/blob storage and verified `codex-backup.v2` archives.
- [x] Offline one-time v1 conversion with fail-closed reports and no live legacy
  compatibility path.
- [x] Add-on API v3 package inspection, permission review, activation,
  generations, rollback, browser graphs, content/data/service contracts, and
  supervised native workers.
- [x] Strict TypeScript clients plus integrated and isolated browser add-on
  lifecycles.
- [x] First-party v3 package shapes for DM Tools, the 2024 compendium, the D&D
  rules engine, and character sheets.

## Product-parity release gates

These items define whether v2 can replace the complete v1 product. A checkbox
may be closed by a faithful port, an accepted redesign with equivalent utility,
or an explicit maintainer decision to retire the workflow.

<!-- product-parity-gates:start -->

### Core campaign experience

- [x] Mount a real responsive application shell with login/logout, DM/player
  projection switching, live refresh, safe core routes, and authenticated
  route, dashboard-slot, sidebar, and record-article add-on outlets.
- [ ] Restore the campaign dashboard, party overview, entity cards, portraits,
  badges, and attitude presentation with responsive DM/player behavior.
- [ ] Restore dedicated browsing, viewing, and editing for characters,
  locations, events, mysteries, factions, deities, artifacts, history, and
  companions without losing unknown or add-on-owned fields.
- [ ] Restore wiki article rendering and editing, sanitized Markdown, headings
  and table of contents, cross-record wiki links, and dirty-form protection.
- [x] Restore campaign-wide search with useful type grouping and navigation.
- [ ] Restore English and Czech UI catalogs and per-browser language selection.
- [ ] Restore the established theme choices and accessible shared design system.
- [ ] Restore the DM dashboard and true player-view preview workflow.

### Spatial, temporal, and relationship workflows

- [ ] Restore the world map and location sub-maps, image/tile preparation,
  markers, marker artwork, saved views, zoom behavior, and map editing.
- [ ] Restore multi-attitude marker/card glows and event-path overlays.
- [ ] Restore the session timeline, drag ordering, and timeline editing.
- [ ] Restore faction, relationship, and mystery graph views with position
  persistence and their former navigation/detail behavior.

### Administration and recovery

- [ ] Restore settings for campaign branding, enums, attitudes, map behavior,
  themes, language, sidebar choices, and other persisted campaign preferences.
- [ ] Restore the useful recovery-point workflow: manual points, coalesced write
  snapshots, restore, and revert-last-N, while retaining verified full backup.
- [ ] Provide reviewed runtime credential rotation or explicitly accept
  deployment-only credential changes as the replacement workflow.
- [ ] Provide the DM-facing add-on inspector, permission approval, activation,
  update/reload, failure diagnosis, and rollback UI over the implemented APIs.

### First-party add-ons

- [ ] Bring DM Tools planner interaction and editing to accepted parity,
  including graph navigation, card/flow authoring, annotations, and browser
  regression coverage; complete the reviewed Import Center workflow.
- [ ] Verify the compendium browser against the old day-to-day browsing and
  reference workflow, then restore any accepted source, linking, filtering, or
  detail behavior that is missing.
- [ ] Differentially validate the Go rules engine against preserved v1 rules and
  builder fixtures, including missing-provider and changed-provider behavior.
- [ ] Bring character sheets to accepted presentation and workflow parity,
  including the fate of Compact/Classic layouts, builder progress, equipment,
  spells, resources, and provider-state diagnostics.

### Release evidence

- [ ] Maintain a route-and-workflow parity inventory that maps every v1 route
  and significant settings action to its v2 implementation or accepted
  retirement decision.
- [ ] Add browser-level host regression tests for login, DM/player projection,
  navigation, view/edit/save, live refresh, and add-on contribution mounting.
- [ ] Build and inspect all four release ZIPs, exercise the real staged package
  lifecycle, and test provider/consumer loss, update, restart, and rollback.
- [ ] Convert fresh copies of both campaign backups and compare record counts,
  media, representative entities, add-on state, and reports before cutover.
- [ ] Complete supervised desktop and mobile acceptance on both copied campaigns,
  including Czech/English, DM/player, all major routes, backup, and rollback.
- [ ] Remove `frontend/REWRITE_INCOMPLETE` only after every earlier gate is
  closed and the maintainer explicitly accepts v2 as the production replacement.

<!-- product-parity-gates:end -->

## Platform follow-ups

- Add coordinated dependent disable and a separately reviewed uninstall/data-
  deletion workflow if routine package removal becomes useful.
- Add migration plan/apply workers when a real released add-on schema change
  requires them; do not build speculative migration machinery.
- Consider a WASI worker target only for a package that benefits from it.
- Add OS-level native worker limits before accepting untrusted third-party
  workers. The current model assumes maintainer-reviewed first-party packages.

## Explicit non-goals

- Permanent v1 save readers, startup migration branches, or a general legacy
  backup UI.
- Building add-on source in production.
- Hardcoding first-party add-on IDs in host or consumer behavior.
- Silently selecting among ambiguous providers.
- Deleting old saves or branches as part of automated cutover.
