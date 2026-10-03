# Rewrite feature parity

Current state: October 3, 2026. The Go/Lit/TypeScript rewrite and first-party
ports are implemented and the authorized host release is deployed on both sites.
[Current acceptance](HOST_CLEANUP_ACCEPTANCE.md) records source/image evidence;
[BACKLOG.md](../BACKLOG.md) contains the remaining tasks.

## Goal and accepted scope

Preserve the useful campaign experience: authored articles and records,
DM/player privacy, maps, timelines, relationships, planning, structured rules
and character sheets. Replace the legacy in-process runtime with versioned,
reviewed packages and explicit data/service/worker ownership. Common UI remains
reusable, accessible and themeable; add-ons borrow the host's controls.

The initial audit found 21 missing/reduced capabilities and the continuation
found 12 additional workflow/presentation defects. Those historical descriptions
are not current defects. Completed fixes and their detailed batch evidence are
recoverable in Git history before the documentation cleanup (`8488968`).

## Current boundaries

- Core workflow parity, shared UI, reviewed imports, package updates, automatic
  housekeeping, recovery and native-worker reliability fixes are implemented.
- Compact character layout is accepted for continued small refinements; Classic
  remains available. Real touch, spoken assistive technology and physical paper
  checks still need results.
- Three groups of historical startup/provider incidents lack attributable
  original captures. Green replays do not establish their causes.
- Authenticated site backups, Asurai's newest reviewed add-ons and independent
  recovery still need live acceptance. Tiamat uses no add-ons.
- Narrative combat resolution, conditional SDK extensions and value-transforming
  migrations without a concrete preservation case are not implicit release scope.

## Accepted product-parity release gates

These 33 outcomes remain unchanged from the accepted personal-site cutover.
They record faithful ports, accepted redesigns and explicit retirements. They do
not close later investigations or current site/human acceptance.
`npm run release-check` reads the markers below and rejects incomplete gates or
`frontend/REWRITE_INCOMPLETE`. Original independent backups remain preserved.

<!-- product-parity-gates:start -->

### Core campaign experience

- [x] Mount a real responsive application shell with login/logout, DM/player
  projection switching, live refresh, safe core routes, and authenticated
  route, dashboard-slot, sidebar, and record-article add-on outlets.

- [x] Restore the campaign dashboard, party overview, entity cards, portraits,
  badges, and attitude presentation with responsive DM/player behavior.

- [x] Restore dedicated browsing, article viewing, and safe common-field
  create/edit/delete for characters, locations, events, mysteries, factions,
  deities, artifacts, history, and companions without losing unknown or
  add-on-owned fields.

- [x] Restore canonical typed fields for tags and fact lists, scalar and
  multi-record references, attitudes, companion ownership, location hierarchy,
  event links, and role-safe preservation of references hidden from players.

- [x] Restore structured relationship editing with atomic identity changes,
  character ranks and location roles, mystery questions, and stable faction
  rank chains while retaining extension data attached to stable nested IDs.

- [x] Complete collection-specific map fields alongside the rebuilt spatial
  workflows so coordinate and image controls share one authoritative editor.

- [x] Protect dirty record forms across archive navigation, role switching,
  sign-out, cancellation, and browser unload.

- [x] Restore wiki article rendering and editing, sanitized Markdown, headings
  and table of contents, and cross-record wiki links.

- [x] Restore campaign-wide search with useful type grouping and navigation.

- [x] Establish typed bundled English and Czech catalogs, per-browser language
  selection, native plural/date handling, and migrate the shell, dashboard,
  search, and personal settings foundation.

- [x] Complete the English and Czech catalog migration for record pages and
  editors, structured campaign settings, host errors, and first-party add-on
  surfaces.

- [x] Restore campaign-wide appearance selection with classic and moonlit token
  themes, flash-free cached boot, and DM-owned optimistic persistence.

- [x] Audit shared tokens and keyboard/focus behavior on record and add-on
  surfaces.

- [x] Review representative converted campaign pages against the preserved UI
  on desktop and phone.

- [x] Restore the DM dashboard and true player-view preview workflow.

### Spatial, temporal, and relationship workflows

- [x] Restore the world map and location sub-maps, image/tile preparation,
  markers, marker artwork, saved views, zoom behavior, and map editing.

- [x] Restore multi-attitude marker/card glows and event-path overlays.

- [x] Restore the session timeline, drag ordering, and timeline editing.

- [x] Restore faction, relationship, and mystery graph views with position
  persistence and their former navigation/detail behavior.

### Administration and recovery

- [x] Restore DM-facing shared campaign enum management for relationships,
  genders, map markers, character statuses, event priorities, and attitudes,
  including stable IDs, usage counts, and explicit replace-or-clear deletion.

- [x] Finish persisted-settings compatibility for converted campaigns.

- [x] Restore the useful recovery-point workflow: manual points, coalesced write
  snapshots, restore, and revert-last-N, while retaining verified full backup.

- [x] Provide reviewed runtime credential rotation.

- [x] Provide the DM-facing add-on inspector, permission approval, activation,
  update/reload, failure diagnosis, and rollback UI over the implemented APIs.

### First-party add-ons

- [x] Bring DM Tools planner interaction and editing to accepted parity,
  including graph navigation, card/flow authoring, annotations, and browser
  regression coverage; complete the reviewed Import Center workflow.

- [x] Restore standalone compendium browsing and reading: the preserved topic/
  source tree, class/subclass/level nesting, tiles, deep cross-kind search,
  counted filters and sorting, complete Markdown/tables, composed class features,
  monster stat blocks, related records and sourcebook links.

- [x] Restore campaign-article compendium wiki references and external v1
  compendium hashes through the documented `wiki-kind` / `wiki-links.v1`
  provider.

- [x] Differentially validate the Go rules engine against preserved v1 rules and
  builder fixtures, including missing-provider and changed-provider behavior.

- [x] Bring character sheets to accepted presentation and workflow parity,
  including the fate of Compact/Classic layouts, builder progress, equipment,
  spells, resources, and provider-state diagnostics.

### Release evidence

- [x] Build and inspect all four release ZIPs and exercise their basic installed
  workflows.

- [x] Convert each site's backup once into a fresh directory and review its
  report, record counts, representative media, sheets, and planning data.

- [x] Accept the owner's personal-site deployment policy: outages and rollback
  are acceptable.

- [x] Remove `frontend/REWRITE_INCOMPLETE` only after every earlier gate is
  closed and the owner chooses to deploy the replacement.

<!-- product-parity-gates:end -->
