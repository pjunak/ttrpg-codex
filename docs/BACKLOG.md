# Project backlog

This is the only durable backlog for the host and its four companion add-ons.
Implementation contracts describe current behavior; they are not roadmaps.

## Rewrite status

The Go host and Add-on API v3 are substantial working foundations, but the
rewrite is not a production replacement for v1. A real campaign-focused shell
now replaces the former generic browser and temporary status page. Its first
dashboard and editable archive slice is intentionally not presented as full
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
- [ ] Complete collection-specific map fields alongside the rebuilt spatial
  workflows so coordinate and image controls share one authoritative editor.
- [x] Protect dirty record forms across archive navigation, role switching,
  sign-out, cancellation, and browser unload.
- [x] Restore wiki article rendering and editing, sanitized Markdown, headings
  and table of contents, and cross-record wiki links.
- [x] Restore campaign-wide search with useful type grouping and navigation.
- [x] Establish typed bundled English and Czech catalogs, per-browser language
  selection, native plural/date handling, and migrate the shell, dashboard,
  search, and personal settings foundation.
- [ ] Complete the English and Czech catalog migration for record pages and
  editors, structured campaign settings, host errors, and first-party add-on
  surfaces.
- [x] Restore campaign-wide appearance selection with classic and moonlit token
  themes, flash-free cached boot, and DM-owned optimistic persistence.
- [ ] Complete the accessible token audit across remaining hardcoded record and
  add-on surfaces before accepting shared design-system parity.
- [ ] Verify every restored page visually against the preserved pre-rewrite UI
  on desktop and mobile, including populated/empty states and DM/player views.
  The rewrite must preserve that design; a new visual design needs an explicit
  maintainer decision. Passing component checks alone does not close this gate.
- [ ] Restore the DM dashboard and true player-view preview workflow.

### Spatial, temporal, and relationship workflows

- [ ] Restore the world map and location sub-maps, image/tile preparation,
  markers, marker artwork, saved views, zoom behavior, and map editing.
- [ ] Restore multi-attitude marker/card glows and event-path overlays.
- [ ] Restore the session timeline, drag ordering, and timeline editing.
- [ ] Restore faction, relationship, and mystery graph views with position
  persistence and their former navigation/detail behavior.

### Administration and recovery

- [x] Restore DM-facing shared campaign enum management for relationships,
  genders, map markers, character statuses, event priorities, and attitudes,
  including stable IDs, usage counts, and explicit replace-or-clear deletion.
- [ ] Restore the remaining settings for campaign branding, map behavior,
  sidebar choices, and other persisted campaign preferences.
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

## Delivery order and acceptance evidence

The visual reference is `origin/deprecated/pre-rewrite-2026-09-01` at
`3aeeacfe7adec985693f8aeb239df58c177f3da8`, confirmed against the live
`asurai.junak.eu` UI and by the maintainer on September 4–5. Preserve its dark
brown surfaces, Cinzel/Lora/Inter typography, gold headings, bundled logo,
240px desktop sidebar, 768px drawer breakpoint, portrait cards, stacked
dashboard sections, and article information rail. This is a fidelity port,
not a redesign of the campaign interface.

The September 5 implementation restores those foundations in the Lit shell,
dashboard, collection cards, article layout, search, and settings surfaces.
Fonts and branding ship in the production assets. The same sidebar and add-on
navigation outlet now serve desktop and mobile; Escape, focus return, hidden
drawer focus exclusion, search shortcut, and dirty-draft navigation are covered.

`frontend/test/browser/visual.browser.mjs` runs against the production build
with synthetic HTTP/SSE fixtures. It compares computed colors, type and geometry
to independently frozen v1 primitives in `test/browser/reference`, checks
responsive layout and overflow, and exercises add-on navigation across resize.
It writes review screenshots to ignored `frontend/test-results/visual/`.
`npm run check` includes this gate; neither the fixtures nor the screenshots
contain campaign data. These are targeted fidelity checks, not pixel-level
acceptance of every original screen or real-host package lifecycle coverage.

Still open: original dashboard inline campaign editing and party-add actions,
saved party/sidebar choices, collection grouping and filter controls, all maps
and timeline/graph views, complete settings/DM screens, and installed add-on
visual acceptance. Keep the visual and release gates open until those workflows
are ported and both copied campaigns pass supervised comparison.

Keep the Go monolith, SQLite ownership, reviewed package lifecycle, optional
service graph, and offline conversion boundary. The next work should complete
campaign workflows on those foundations. A passing build or a ported manifest
does not close a product gate. For each slice, record its implementation,
automated coverage, remaining browser acceptance, and any approved retirement
here before marking it complete.

| Order | Slice and owner | Evidence needed before closing its remaining gates |
|---|---|---|
| 1 | Host editing and session behavior | Real-host browser coverage for login/logout, role changes, navigation, save/conflict recovery, SSE refresh, and add-on outlets. Include dirty drafts, remote deletion, edits during an in-flight save, and session expiry. |
| 2 | Host maps and map settings | Implement map fields, immutable media preparation, coordinate editing, saved views, marker art, and path/glow rendering as one workflow; verify world and local maps plus role-filtered locations together. |
| 3 | Host timeline and relationship views | Restore drag/reorder persistence and graph navigation using canonical record identities; test reload, stale writes, and position-only edits. |
| 4 | First-party add-on workflows | Compare compendium browse/source/link behavior, DM planner/import review, engine calculations, and sheet play state against preserved v1 fixtures. Exercise absent/replaced providers through actual installed ZIPs. |
| 5 | Host administration and recovery | Complete branding, party/sidebar preferences, add-on inspection/approval/rollback, recovery points, and the accepted credential workflow; retain explicit operator review. |
| 6 | Release acceptance | Finish localization and token checks in each restored slice, then run desktop/mobile acceptance on copies of both campaigns, verify conversion reports and rollback, and obtain maintainer acceptance. |

The September 4 review added Chromium regressions for record, enum, and theme
forms in `frontend/test/browser/editors.browser.mjs`. They verify retained
drafts and opening revisions after live refresh, remote deletion, reviewed
relationship replacement, and successful saves after unrelated changes. These
are real component tests with synthetic datasets, not a completed host/SSE or
installed-add-on acceptance test. The corresponding release gates stay open.

The technical gate now includes those browser regressions. The worker add-ons
use the host SDK's Go 1.27.1 baseline; engine CI runs the Go suite and race
checks, and DM Tools CI follows the host's default branch. Chromium must be
installed before either host or planner browser checks. Package inspection
proves archive validity; activation and campaign acceptance require separate
evidence.

## Workflow inventory

This initial host inventory was checked against preserved v1 commit
`3aeeacfe7adec985693f8aeb239df58c177f3da8`, specifically `web/js/app.js`,
`web/js/settings.js`, and `web/index.html`. It maps workflow destinations, not
an implemented legacy URL redirect contract. Current host routes are owned by
`frontend/src/app/routes.ts`. Add-on actions and detailed editing/administration
acceptance still need to be expanded, so the inventory release gate remains open.

| V1 route or action | V2 destination / current state | Remaining acceptance |
|---|---|---|
| `/`, `/dashboard`, `/parta` | `/`, `/dashboard`, `/party`; dashboard and party projections | Real-host role changes, live refresh, and mobile navigation |
| `/postavy`, `/postava/:id` | `/characters`, `/characters/:id` | End-to-end edit/save plus sheet mounting |
| `/mista`, `/misto/:id` | `/locations`, `/locations/:id` | Spatial fields and local maps |
| `/udalosti`, `/udalost/:id` | `/events`, `/events/:id` | Paths and timeline ordering |
| `/zahady`, `/zahada/:id` | `/mysteries`, `/mysteries/:id` | Mystery graph navigation |
| `/frakce`, `/frakce/:id` | `/factions`, `/factions/:id` | Faction graph and saved positions |
| `/panteon`, `/buh/:id` | `/pantheon`, `/pantheon/:id` | Copied-campaign article/editor acceptance |
| `/artefakty`, `/artefakt/:id` | `/artifacts`, `/artifacts/:id` | Copied-campaign article/editor acceptance |
| `/historie`, `/historicka-udalost/:id` | `/history`, `/history/:id` | Copied-campaign article/editor acceptance |
| `/mazlicci` | `/companions` and dedicated companion records | Ownership and sheet-related workflow acceptance |
| Global search and wiki links | `/search` and typed Markdown links | Add-on reference/linking surfaces and localized editors |
| `/mapa/svet`, `/mapa/local/:id` | Not yet restored | Maps slice above |
| `/mapa/palac`, `/mapa/frakce`, `/mapa/vztahy`, `/mapa/tajemstvi` | Not yet restored | Faction, relationship, mystery views and saved positions |
| `/casova-osa` | Not yet restored | Timeline slice above |
| `/dm` and player-preview action | Session role switch exists; dedicated DM dashboard and tab-isolated preview remain open | Preserve the distinction between session role switching and true preview |
| `/nastaveni`: six enum categories | `/settings` enum panels | Full localization and real-host save/delete/conflict coverage |
| Settings: `language`, `appearance` | Personal language and shared theme panels | Remaining catalogs, tokens, and old appearance/branding actions |
| Settings: `playerParty`, `worldmap`, `sidebarPages` | Not yet restored | Party, map, sidebar and shared preference controls |
| Settings: `addons` | Lifecycle APIs exist; manager and add-on settings UI remain open | Permission review, activation, diagnostics, update and rollback |
| Settings: `backup`, `account` | Verified backup/maintenance and session APIs exist; full recovery/server controls remain open | Recovery points, restore/revert and accepted credential rotation |
| Add-on routes and graph/settings contributions | Versioned v3 mounting infrastructure and package routes exist | Per-add-on workflow inventory and installed-package acceptance |

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
