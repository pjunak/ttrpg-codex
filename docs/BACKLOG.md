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

The owner accepts deployment failures, outages, fixes after launch, and rollback
for these two personal sites. Keep the requested original UI and campaign
workflows, but do not require an exhaustive operational rehearsal to release.
Retain the original backups and data, convert each campaign into a fresh
directory once, and perform a short first-start smoke check. Detailed test
matrices and repeat rehearsals are follow-up work, not release prerequisites.

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

- [x] Restore the world map and location sub-maps, image/tile preparation,
  markers, marker artwork, saved views, zoom behavior, and map editing.
- [x] Restore multi-attitude marker/card glows and event-path overlays.
- [ ] Restore the session timeline, drag ordering, and timeline editing.
- [ ] Restore faction, relationship, and mystery graph views with position
  persistence and their former navigation/detail behavior.

### Administration and recovery

- [x] Restore DM-facing shared campaign enum management for relationships,
  genders, map markers, character statuses, event priorities, and attitudes,
  including stable IDs, usage counts, and explicit replace-or-clear deletion.
- [ ] Finish persisted-settings compatibility for converted campaigns. Branding,
  map behavior, party identity, and core/add-on sidebar controls are restored;
  older `hiddenSidebarPages`-only backups still need explicit offline conversion
  into `sidebarLayout`. Review renamed add-on route preference keys during the
  already-required package and campaign conversion checks.
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

- [ ] Build and inspect all four release ZIPs and exercise their basic installed
  workflows. The full provider loss/update/restart/rollback matrix can follow
  deployment; use the real package lifecycle for installation.
- [ ] Convert each site's backup once into a fresh directory and review its
  report, record counts, representative media, sheets, and planning data. Keep
  the input and old data unchanged; no second conversion rehearsal is required.
- [x] Accept the owner's personal-site deployment policy: outages and rollback
  are acceptable. Use a short first-start smoke check on each site; defer the
  exhaustive desktop/mobile, language, failure, and restore rehearsal matrix.
- [ ] Remove `frontend/REWRITE_INCOMPLETE` only after every earlier gate is
  closed and the owner chooses to deploy the replacement. This does not require
  the deferred operational matrix or a claim that every edge case is verified.

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

The dashboard follow-up restores the original per-field pencil controls and
party-add header action. DM name/tagline edits merge one field into
`campaign/main` with the opening revision and preserve unknown fields. Inline
forms use explicit Save/Cancel (Enter/Escape also work), retain failed drafts,
and participate in the shell's unsaved-change guard. Anonymous actions focus
the existing sign-in form; player mode respects the host's DM-only campaign
identity policy. `#/party/new` reuses the character editor with party faction,
knowledge 4, and alive status when that definition is available. An absent or
retired alive definition leaves status unset instead of creating an unsaveable
preset. Cancellation returns to the roster; successful creation opens the record.

`frontend/test/browser/dashboard.browser.mjs` exercises the production bundle
with synthetic HTTP writes and SSE refresh: single-field saves, preserved
extensions, unrelated refresh, stale revisions, HTTP conflicts, player party
creation, cancel/discard behavior, missing status definitions, and desktop/phone
sign-in focus. The visual primitive gate also compares the original pencil and
Add button styles. These checks do not replace real-host session acceptance.

World and local maps now use the preserved Leaflet coordinate frame and original
toolbar, floating zoom controls, and bundled marker artwork. The map supports
pan/zoom, search, location/article links, new and existing marker placement,
dragging and numeric position drafts, unplacing, saved views, and world/local
image uploads through the existing media API. Mutations retain opening
revisions and unrelated fields. Browser coverage exercises both viewport sizes,
map scoping, live conflicts, dragging, placement, saved views, and local uploads.

Saved views now support name/icon editing, map-area capture and preview, and
deletion with opening-revision checks and preserved IDs/extensions. Event-path
overlays restore the original session ordering, explicit-pin precedence,
location-based trails, marker appearance, and legend. Event/location markers
support keyboard activation. Production browser checks cover both viewport
sizes, stale view saves/deletes, event geometry and scope, refresh, and teardown.
Public projection now removes coordinates together with an unavailable map
parent; player saves preserve the original hidden placement.

Event articles now link to their map pins and start placement. World/local maps
support direct event-pin placement, dragging, coordinate edits, and removal
with protected opening revisions. Removing the explicit pin retains the event
and its linked locations, restoring the location-based overlay. Desktop/phone
browser checks cover article links, scope, draft conflicts, remote deletion,
and anonymous/missing targets.

Maps settings now provide world/local image previews and uploads, scoped marker
zoom scaling, and links to the map and saved-view editor in the original settings
style. Shared configuration saves retain other maps and extensions, protect
drafts during live refresh, and reject stale or malformed data. Zoom controls
restore the original steps and wheel sensitivity, enforce the image-fit minimum,
and keep fitted maps fitted through viewport changes. Desktop/phone browser
checks cover scaling, navigation guards, uploads, live updates, and DM-only access.

Map marker glows now match the preserved diagonal bands, including individual
attitude strength, size-dependent blur, and dark artwork/glyph outlines. Card
and article glows restore the original radii, portrait border rings, and glyph
silhouette filters. Desktop/phone browser fixtures cover multi-attitude artwork
and glyphs, scope, keyboard activation, scaling, live updates, and zero-strength
settings. Unit checks lock the old band geometry and effective-attitude rules.
Together with the existing event-path coverage, this completes the glow/overlay
gate. Other visual and real-host acceptance gates remain open.

World/local maps now generate disposable PNG tile pyramids from immutable media
on first use, preserving the original image coordinate frame and zoom behavior.
Every tile read checks current media visibility; replacement handles cannot mix
generations. Bounded decoding, cancellation, complete-directory publication,
cache reuse and original-image fallback are covered by Go and browser tests.
One-pixel source overlaps remove fractional-zoom seams without stretching the
map. Desktop/phone checks cover geometry, over-zoom, local image replacement,
and tile failure fallback. This completes the map implementation gate, with
the format/size fallback limits recorded in `docs/rewrite/MEDIA.md` and actual
campaign acceptance still covered by the separate release gates.

Player-party settings now restore the original name, icon, glow/chip color,
text color, and linked member list in the shared settings panel. The accepted
identity reaches the dashboard/roster heading, character placeholders, party
badges and inherited glows, faction choices, article facts, and companion
ownership labels. Saves preserve extensions and the original icon/badge mirror,
retain dirty drafts during live refresh, and reject stale/deleted revisions or
malformed settings. English/Czech desktop/phone production-browser checks cover
these behaviors, role restrictions, clean refresh, conflicts, and navigation.

Branding now restores the Appearance panel's logo preview, upload/default-logo
controls, and wordmark fields. The accepted record updates the sidebar and tab
title/favicon; drafts keep selected files and text through upload/save failures.
Core sidebar settings restore section names/icons, role visibility, collapse
preferences, page/section ordering and dragging, hiding, add/delete and reset.
Unavailable saved routes remain reviewable without exposing broken links.
Installed add-on links default to hidden and offer Everyone/DM/Hidden choices
after the existing role and generation checks. Layout and visibility saves use
one revision-checked transaction and retain unknown and inactive entries.
Production desktop/phone checks cover these controls, stale/live changes,
file retry, role filtering, and original preview and row styling.

Still open elsewhere: older hidden-page preference conversion, collection grouping and filter controls,
timeline/graph views, complete settings/DM screens, and installed add-on
visual acceptance. Keep the visual and release gates open until the requested
workflows are ported; apply the lighter operational policy above at cutover.

Keep the Go monolith, SQLite ownership, reviewed package lifecycle, optional
service graph, and offline conversion boundary. The next work should complete
campaign workflows on those foundations. A passing build or a ported manifest
does not close a product gate. For each slice, record its implementation,
automated coverage, remaining browser acceptance, and any approved retirement
here before marking it complete.

| Order | Slice and owner | Evidence needed before closing its remaining gates |
|---|---|---|
| 1 | Host editing and session behavior | Keep focused regression tests for implemented behavior. Check login, DM/player visibility, saving, and live refresh at first start; expand the full session/failure matrix after launch. |
| 2 | Host maps and map settings | Implement map fields, immutable media preparation, coordinate editing, saved views, marker art, and path/glow rendering as one workflow; verify world and local maps plus role-filtered locations together. |
| 3 | Host timeline and relationship views | Restore drag/reorder persistence and graph navigation using canonical record identities; test reload, stale writes, and position-only edits. |
| 4 | First-party add-on workflows | Compare compendium browse/source/link behavior, DM planner/import review, engine calculations, and sheet play state against preserved v1 fixtures. Exercise absent/replaced providers through actual installed ZIPs. |
| 5 | Host administration and recovery | Complete branding, party/sidebar preferences, add-on inspection/approval/rollback, recovery points, and the accepted credential workflow; retain explicit operator review. |
| 6 | Release acceptance | Review one fresh conversion per site, retain old data, and perform the short first-start smoke check. Outages, fixes after launch, and rollback are accepted; full rehearsal matrices can follow. |

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
acceptance still need to be expanded as follow-up documentation.

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
| `/mapa/svet`, `/mapa/local/:id` | `/map/world`, `/map/local/:id`; old map hashes also accepted | Real-host acceptance with each campaign's maps |
| `/mapa/palac`, `/mapa/frakce`, `/mapa/vztahy`, `/mapa/tajemstvi` | Not yet restored | Faction, relationship, mystery views and saved positions |
| `/casova-osa` | Not yet restored | Timeline slice above |
| `/dm` and player-preview action | Session role switch exists; dedicated DM dashboard and tab-isolated preview remain open | Preserve the distinction between session role switching and true preview |
| `/nastaveni`: six enum categories | `/settings` enum panels | Full localization and real-host save/delete/conflict coverage |
| Settings: `language`, `appearance` | Personal language, shared theme and branding/logo panels | Remaining catalogs, tokens, and campaign visual acceptance |
| Settings: `worldmap` | Maps panel at `/settings/maps`, with local-map scope links | Real-host visual acceptance with campaign maps |
| Settings: `playerParty`, `sidebarPages` | Party identity, curated core sidebar, and add-on visibility controls restored | Older hidden-page preference conversion and installed-route key review |
| Settings: `addons` | Lifecycle APIs exist; manager and add-on settings UI remain open | Permission review, activation, diagnostics, update and rollback |
| Settings: `backup`, `account` | Verified backup/maintenance and session APIs exist; full recovery/server controls remain open | Recovery points, restore/revert and accepted credential rotation |
| Add-on routes and graph/settings contributions | Versioned v3 mounting infrastructure and package routes exist | Per-add-on workflow inventory and installed-package acceptance |

## Platform follow-ups

- Expand the route/action inventory and real-host browser regression matrix,
  including session expiry and edits during an in-flight save. These improve
  coverage without blocking this personal-site launch once basic checks pass.
- Run exhaustive desktop/mobile, Czech/English, package-provider failure,
  restart, update, restore, and rollback rehearsals after launch as useful.

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
