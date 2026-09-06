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

The owner reconfirmed on September 6 that the backups have already been taken.
Use those existing archives and retain the old data for rollback. Deployment
may stop the server: hot updates and zero-downtime rollout are not required.
Keep existing authentication and data-integrity protections, but defer extra
security hardening and availability work unless needed for a concrete exposure
or data-loss defect. Focus remaining implementation on the requested UI and
usable campaign workflows. If a site has changed since its backup, preserve
those later changes at cutover rather than silently restoring an older state.

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
- [x] Restore the DM dashboard and true player-view preview workflow.
  The core DM panel, guarded additive slots, hidden-content fallback, browser
  diagnostics and active tool links are restored. The first-party planning
  totals, workflow cards and recent-item navigation are restored in English
  and Czech. View as player now opens a separate tab with bounded player
  authority; the DM session remains unchanged. Desktop/phone checks cover
  reload/navigation, player data/media/live updates, revocation and failed
  preview startup. Broader planner/import acceptance stays in its own gate.

### Spatial, temporal, and relationship workflows

- [x] Restore the world map and location sub-maps, image/tile preparation,
  markers, marker artwork, saved views, zoom behavior, and map editing.
- [x] Restore multi-attitude marker/card glows and event-path overlays.
- [x] Restore the session timeline, drag ordering, and timeline editing.
- [ ] Restore faction, relationship, and mystery graph views with position
  persistence and their former navigation/detail behavior.
  All three core modes now retain original cards, local position persistence,
  filters/focus, zoom, detail navigation, and elastic drag/collision movement.
  Mind Palace model providers and additive timeline slots now pass installed-
  package checks. Custom graph surfaces and real-campaign acceptance remain open.

### Administration and recovery

- [x] Restore DM-facing shared campaign enum management for relationships,
  genders, map markers, character statuses, event priorities, and attitudes,
  including stable IDs, usage counts, and explicit replace-or-clear deletion.
- [x] Finish persisted-settings compatibility for converted campaigns. Branding,
  map behavior, party identity, and core/add-on sidebar controls are restored;
  offline conversion now retains the original default sidebar and folds older
  `hiddenSidebarPages` preferences into `sidebarLayout`. Review renamed add-on
  route preference keys during the already-required package and campaign
  conversion checks.
- [ ] Restore the useful recovery-point workflow: manual points, coalesced write
  snapshots, restore, and revert-last-N, while retaining verified full backup.
- [ ] Provide reviewed runtime credential rotation or explicitly accept
  deployment-only credential changes as the replacement workflow.
- [x] Provide the DM-facing add-on inspector, permission approval, activation,
  update/reload, failure diagnosis, and rollback UI over the implemented APIs.
  Settings → Add-ons now lists active, disabled and staged packages; inspects
  release ZIPs; displays exact permission/change reviews and blockers; and
  activates, updates, rolls back, reloads or disables without deleting data.
  English/Czech desktop/phone installed checks include cancellation, stale
  reviews, lost responses, invalid ZIPs, persisted generations and player denial.

### First-party add-ons

- [ ] Bring DM Tools planner interaction and editing to accepted parity,
  including graph navigation, card/flow authoring, annotations, and browser
  regression coverage; complete the reviewed Import Center workflow.
  Own-worker discovery now uses explicit browser `includeOwn` access while
  retaining worker self-exclusion. Installed ZIP checks cover planning preview,
  cancellation, exact single-use commit, atomic conflicts, DM-only access and
  generation replacement, plus lost commit responses and reviewed replacement
  deletions. Planner item details now expose objective, setup, resolution,
  tags and event/branch types. View-local drafts preserve opening revisions
  across selection, canvas navigation, other saves, failed writes and refresh;
  removed-record edits remain available to copy. Installed checks cover these
  fields, note/item draft independence, conflicts, lost write responses, failed
  post-save reads and canceled drags, plus desktop/phone theme and overflow.
  Flow type/label editing, visible direction/labels, and whole-item/flow
  consequence anchors are now restored. Flow consequences appear at both
  endpoints. Flow deletion atomically removes its anchored consequences;
  subtree deletion cleans incoming planning references and saved positions
  while retaining the surviving anchors of shared notes. Installed checks cover
  retained flow drafts, cycle rejection, cancellation and stale-record conflicts
  without partial deletion, plus desktop/phone controls.
  Browser writes and reviewed imports now retain all six collection revisions.
  Atomic host guards reject unseen children, annotations, references and
  simultaneous graph edits, including changes to previously empty collections;
  paginated reads pin their original collection revision. Conflicts keep
  editor drafts and require a reload or a newly reviewed import.
  Mounted planner drafts now participate in the host's navigation, sign-out,
  and browser-unload guards. Same-planner queries retain drafts, including
  invalid targets; pending writes block navigation until their outcome is known.
  Kind and parent controls are restored. Moves retain the subtree and authored
  annotations, reject incompatible flows, and follow the saved destination.
  Draft parent choices remain explicit when their destination disappears;
  concurrent children prevent a stale conversion of their parent to a leaf.
  References now support planning/core/external targets, names, relations and
  quantities. Consequences expose optional targets, and shared notes expose
  editable anchors; unanchored notes remain available for relinking. The host
  supplies bounded, role-visible campaign choices through approved read grants.
  Canvas controls now restore the fixed zoom ladder, native 100% reset, fit,
  focus, keyboard/mouse panning and browser fullscreen. Zoom and scroll survive
  selection, saves, reload and same-planner canvas navigation. Zoomed dragging
  converts back to saved coordinates; negative/distant positions stay reachable.
  Remaining work includes original dialog and selection behavior,
  live invalidation, full visual parity and
  localization, and Import Center presentation and other-provider acceptance.
- [x] Restore standalone compendium browsing and reading: the preserved topic/
  source tree, class/subclass/level nesting, tiles, deep cross-kind search,
  counted filters and sorting, complete Markdown/tables, composed class features,
  monster stat blocks, related records and sourcebook links. Genuine reprints
  participate in source filters without changing provenance or record identity.
  Typed query links retain filters and expanded results through detail navigation
  and Back. Host refresh keeps the mounted view; retry, generation replacement,
  disable/reactivation, English/Czech controls and DM/player desktop/phone
  workflows pass the actual installed ZIP suite. The standalone v1/v3 comparison
  also verifies matching desktop/phone library grid widths and heading metrics;
  preserved styling replaces the rewrite's generic cards.
  Validation: 53 compendium checks, rebuilt/inspected ZIP, seven installed
  browser cases, and the full host gate (279 unit tests, 158 browser cases,
  Go tests and vet). The final package also passed its focused installed suite.
- [ ] Restore campaign-article compendium wiki references and external v1
  compendium hashes through a documented v3 host linking surface. The package
  already translates typed links within its own Markdown. Real-campaign visual
  acceptance remains part of the shared gate above.
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

The canvas navigation batch passes installed desktop/phone checks for zoom,
fit, keyboard panning, fullscreen, retained drafts and per-scope views, and
correct saved coordinates after a 200% drag. The full host gate passes 279 unit
tests, 151 browser cases, Go tests and vet. DM Tools passes 28 Node tests,
22 rendering checks at each DPR, Go tests/vet and rebuilt ZIP inspection.
The restored toolbar keeps the existing theme and fits the phone layout.

The add-on settings workflow passes the full host gate: 279 unit tests,
149 browser cases, Go tests and vet. The new installed manager cases exercise
both viewport sizes and languages with real staged packages. They confirm
forward/reverse generation switches and retained disabled versions, rather than
only testing component markup. This closes the add-on administration UI gate;
it does not close the separate first-party workflow or visual acceptance gates.

The core `#/dm` panel now follows the preserved heading, spacing, dark cards,
and hidden/total counts. It mounts typed `dm:dashboard` slots only for real and
effective DMs and keeps a useful fallback for empty or failed dashboards.
Separate-tab player preview preserves the DM cookie and uses independent,
expiring player credentials for core and add-on requests, events, and rendered
media. Invalid or revoked previews cannot fall back to DM authority. The account
action and preview notice use the existing shell styles and English/Czech copy.
Role-allowed tool links remain available when optional sidebar links are
hidden. Fixture ZIPs verify desktop/phone layout, English/Czech copy, live
counts, authorization, widget state, replacement/disable, failure and reload.
The real rebuilt DM Tools ZIP mounts its own dashboard with the preserved
five totals, workflow cards, and twelve recent items, using English/Czech copy
and the original dark/gold layout. Counts load on entry or explicit refresh;
live add-on data invalidation remains part of broader planner parity. Installed
checks create a quest, event and note, open recent leaves in their parent canvas,
retain unchanged drafts, exercise reload/new-tab/back navigation and recover
from invalid links and failed reads. Import Center now discovers its own planning
worker through a browser-only opt-in. Real installed checks cover preview and
commit, cancellation without writes, consumed tokens, concurrent changes without
partial writes, and generation replacement. A submitted review cannot be retried
blindly after a failed/uncertain commit. All four add-on archives pass inspection;
the engine's stale indirect text dependency was aligned with the current host
SDK so its build and test gate can run again. Broader planner/import UI parity
remains open. Shared isolated startup now sends ready
before resize, removing a false failure diagnostic for healthy widgets.

The September 5 planner editing batch uses the original brown/gold host tokens
and title fonts, bounds the desktop inspector, and wraps the phone Atlas without
page overflow. Card dimensions and native text rendering remain covered at DPR
1 and 2. The rebuilt and inspected DM Tools ZIP passes real-host editing and
recovery checks in `installed-planner-fixture.mjs`; the full host gate passes
270 unit and 137 browser tests. This confirms the restored fields and draft
behavior, not complete equivalence with the original planner's dialogs,
navigation controls, or either real campaign. Keep the planner and visual
release gates open.

The follow-up flow batch adds a real installed-package regression in
`installed-planner-flow-fixture.mjs`. It exercises flow edits from either
endpoint, flow-anchored consequences, stale flow drafts, cycle rejection,
canceled deletion, an atomic conflict after a concurrent consequence edit,
and incoming-reference/shared-note/view cleanup. DM Tools passes 17 Node tests
and 22 rendering checks at each of DPR 1 and 2; the rebuilt ZIP passes package
inspection. The host gate passes 270 unit and 138 browser tests plus Go tests
and vet. Desktop/phone screenshots retain the classic controls and no page
overflow. Complete planner presentation remains open.

The structural concurrency batch adds opt-in collection revisions and atomic
read-dependency guards to HTTP, isolated browser, and Go worker data APIs.
Older callers retain their existing wire responses. Tests cover empty/deleted
collections, unchanged audit/events after rejected writes, pagination changes,
declaration and role enforcement, and retained import guards. The installed
DM Tools ZIP rejects unseen children and flow consequences during deletion and
simultaneous individually valid flows that would form a cycle. An import also
conflicts when a newly added annotation was absent from its reviewed mutations.
The host passes type checking, 272 unit tests, and all 139 browser cases (the
new fixture's quest selection was corrected and the full installed-DM suite
rerun), plus all Go tests and vet. DM Tools passes 19 Node tests, 22 rendering
checks at each DPR, and Go tests/vet. All four packages were rebuilt and
inspected; compendium and sheet checks and engine tests/vet/race checks pass.
The engine's committed binaries were refreshed for the shared worker SDK.
This batch does not change UI styling or complete the remaining planner,
localization, administration, visual acceptance, or site-conversion gates.

The September 6 navigation batch adds a per-mounted-contribution edit-state
handle in integrated and isolated UI modes. Host unit checks cover independent
drafts, stale handles, disposal/abort, and strict flag-only bridge messages.
Installed ZIP checks cover canceled route and query navigation, browser Back,
sign-out, a real canceled reload, failed writes, pending-write navigation and
sign-out blocking, save/discard cleanup, and generation disable. The planner's
desktop/phone checks include hidden drafts and recovery from invalid links.
The full host gate passes 276 unit tests, 142 browser cases, Go tests and vet.
DM Tools passes 19 Node tests, 22 rendering checks at each of DPR 1 and 2, Go
tests and vet; its rebuilt ZIP passes host inspection. Compendium and sheets
also pass their checks, packaging and inspection with no source changes.
Drafts remain local to the view; accepted reload or forced authority/package
teardown does not persist them. The original layout and styling are unchanged.
This closes the planner's leave-view guard slice, not broader interaction or
visual parity, other add-ons' edit-state adoption, or either site's conversion.

The item-structure batch restores the preserved planner's kind/parent form row
and conditional event/branch fields. The installed-package regression in
`installed-planner-structure-fixture.mjs` covers desktop/phone moves, preserved
children and internal flows, unchanged annotations and layouts, hidden drafts,
invalid moves/kind changes, disappeared draft parents, concurrent children,
and recovery after a confirmed move whose following read failed. The original
theme and responsive inspector remain in use; complete dialog/canvas parity
is still open. Data records are preserved instead of removing links to permit
a structural edit.
The full host gate passes 276 unit tests, 143 browser cases, and Go tests/vet.
DM Tools passes 22 Node tests, 22 rendering checks at each of DPR 1 and 2,
Go tests/vet, and inspection of its rebuilt ZIP. Desktop/phone screenshots
confirm the restored form row fits the existing responsive inspector.

The annotation batch adds `installed-planner-annotation-fixture.mjs` for
desktop/phone creation, target changes, quantities, unavailable saved targets,
optional consequence targets, shared/unanchored notes and failed-save recovery.
Integrated and isolated route fixtures verify permission/role filtering,
retained mounted drafts during catalog refresh and a large truncated catalog
within the existing bridge limit. DM Tools passes 26 Node tests, 22 rendering
checks at each DPR, Go tests/vet, and inspection of its rebuilt ZIP. The host
passes 279 unit tests, 147 browser cases and Go tests/vet. Screenshots retain the
classic responsive controls; full pre-rewrite visual equivalence and real-site
conversion remain open. No deployment, backup or live data was changed.

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

Offline conversion now materializes the preserved default sidebar for campaigns
without a saved layout and folds in retired hidden-page preferences. Existing
layouts and original hide lists survive unchanged. Conversion tests verify
source immutability, imported counts, original group/collapse/DM flags, route
deduplication, saved-layout precedence, and failure before publication for
malformed hide lists.

Location forms now provide shared marker-type choices, inherited or explicit
size, local-map previews, and guarded links to the existing map/image editor.
Changing the parent clears only the previous image's coordinate placement.
Article Show/Place/Move links target the exact location and scope. Placement
captures the revision before clicking the map, rejecting intervening edits,
reparenting, and deletion without losing the draft. Desktop/phone production
checks cover editing, navigation guards, placement, image upload, and role/scope
restrictions; unit checks cover validation and preserved fields.

The session timeline now restores the original horizontal board, session gaps,
stacked cards, character/faction/location metadata, DM twin display, and desktop
and phone scrolling. Dragging and keyboard/phone controls keep an order draft
until one revision-checked transaction succeeds. Creation, editing, and deletion
use the shared event form. Browser checks cover reload, failed writes, changes
during drag, remote deletion, navigation guards, anonymous access, empty boards,
and Czech labels; preparation tests retain content, map fields, and extensions
and reject malformed or oversized orders. The preserved timeline hashes and
sidebar preferences now reach this board. Desktop/phone screenshots were
reviewed against the preserved styling; full campaign and add-on visual
acceptance remains open.

The Relationships graph now uses canonical relationship keys and the current
role projection, retaining the original cloud-card CSS, fixed zoom steps, edge
colors/styles, and old per-browser position/filter keys. Keyboard and pointer
moves change only the local arrangement. Unit/browser regressions cover
malformed preferences, exact detail identities, parallel edges, focus and filter
behavior, reload, failed storage, concurrent-tab interruption, live removal,
and desktop/phone geometry. Screenshots were reviewed against the preserved
styling. Long edge labels wrap in full along their connections.
Faction and mystery modes now share that canvas, preserving rounded faction
hubs, command roots, territory glows, member locations, purple mystery cards,
and involved characters with question previews. Collection-qualified node and
generated-edge identities avoid cross-collection ID collisions. Valid,
unambiguous old positions seed separate mode layouts without rewriting the
original browser values. Unit/browser checks cover these joins, shared-node
visibility, typed detail routes, storage/mode isolation, route changes during
drag, live removal, touch movement, and all preserved Czech graph hashes.
Desktop/phone screenshots were reviewed against the preserved styling.
Elastic movement now preserves the original curved edge lag and collision
response without pulling uncollided neighbours along. Motion is a browser-only
draft with fixed simulation steps, bounded collision/settling work, reduced
motion support, and no idle animation loop. Dropped centers stay exact. Saves
adopt the settled layout; Escape restores the complete pre-drag arrangement,
completed drops survive immediate navigation, and cross-tab changes cancel
pending motion before applying the winning arrangement. Browser checks cover
animated/reduced-motion touch, collision displacement, cancellation, live
removal, mode isolation, failed saves/retry, and frame shutdown.
Named add-on views and contributions to the three core Mind Palace modes now
use bounded model providers and the same canvas/cards. Provider identities are
namespaced, references require approved core read grants and current role
visibility, and detail links require a same-generation active route. Local
positions survive reload/replacement; navigation, role changes, campaign
refresh, disposal, and replacement cancel outstanding models. Integrated and
isolated fixture ZIPs pass the real upload/review/approve/activate lifecycle
with desktop/phone browser checks, invalid-model isolation, replacement, and
disable. No first-party package currently declares graph providers.
The preserved app routes its timeline through the session board, whose actual
extension points are toolbar, column-header/footer, and card-extra slots. The
old cloud-map timeline builder is not reached by those app routes; graph-model
injection into the session board is not a missing day-to-day workflow.
The four additive timeline slots are now restored with compact integrated and
isolated elements. Widget context includes bounded, approved event references,
intersected with the latest role projection even when an order draft is kept.
Widgets retain state during refreshes and scrolling; core dragging and order
transactions remain separate. Real installed-package checks cover both UI
modes, desktop/phone, role/read grants, replacement, disable, and unsaved drafts.
The generic outlet now preserves connected instances during ordinary refresh;
the three existing visual add-ons pass their gates and host ZIP inspection.
DM Tools also needed its indirect `x/text` requirement aligned with the host SDK
before its Go gate and package build could pass.
Remaining graph work includes custom node-kind/general graph facade decisions,
provider-driven invalidation, and full real-campaign visual acceptance.
The combined graph gate stays open.

Still open elsewhere: collection grouping and filter controls,
complete settings/DM screens, and installed add-on
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
| 3 | Host relationship views | Timeline and all three core graph modes, including elastic drag movement, installed Mind Palace model providers, and additive timeline slots, are implemented. Review custom graph surfaces and real campaigns. |
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
| `/mista`, `/misto/:id` | `/locations`, `/locations/:id` | Spatial fields restored; real-campaign visual acceptance remains |
| `/udalosti`, `/udalost/:id` | `/events`, `/events/:id`; shared forms also open from the timeline | Real-campaign article/editor visual acceptance |
| `/zahady`, `/zahada/:id` | `/mysteries`, `/mysteries/:id` | Mystery graph navigation |
| `/frakce`, `/frakce/:id` | `/factions`, `/factions/:id` | Faction graph and saved positions |
| `/panteon`, `/buh/:id` | `/pantheon`, `/pantheon/:id` | Copied-campaign article/editor acceptance |
| `/artefakty`, `/artefakt/:id` | `/artifacts`, `/artifacts/:id` | Copied-campaign article/editor acceptance |
| `/historie`, `/historicka-udalost/:id` | `/history`, `/history/:id` | Copied-campaign article/editor acceptance |
| `/mazlicci` | `/companions` and dedicated companion records | Ownership and sheet-related workflow acceptance |
| Global search and wiki links | `/search` and typed Markdown links | Add-on reference/linking surfaces and localized editors |
| `/mapa/svet`, `/mapa/local/:id` | `/map/world`, `/map/local/:id`; old map hashes also accepted | Real-host acceptance with each campaign's maps |
| `/mapa/vztahy` | `/graph/relationships`; old hash and browser position/filter keys accepted | Campaign/add-on visual acceptance |
| `/mapa/palac`, `/mapa/frakce`, `/mapa/tajemstvi` | `/graph/factions`, `/graph/mysteries`; old hashes and unambiguous browser positions accepted | Campaign/add-on visual acceptance |
| `/casova-osa`, `/mapa/casova-osa` | `/timeline`; old hashes accepted, session creation, atomic order editing and four additive slots restored | Real-campaign visual review |
| `/dm` and player-preview action | Core DM panel, planning totals/recent links, additive slots, fallback counts/status, tool links and separate-tab player preview restored | Desktop/phone preview checks pass for independent DM/player authority, reload, navigation, media, live updates and revocation; planner/import acceptance is tracked separately |
| `/nastaveni`: six enum categories | `/settings` enum panels | Full localization and real-host save/delete/conflict coverage |
| Settings: `language`, `appearance` | Personal language, shared theme and branding/logo panels | Remaining catalogs, tokens, and campaign visual acceptance |
| Settings: `worldmap` | Maps panel at `/settings/maps`, with local-map scope links | Real-host visual acceptance with campaign maps |
| Settings: `playerParty`, `sidebarPages` | Party identity, curated core sidebar, and add-on visibility controls restored | Older hidden-page preference conversion and installed-route key review |
| Settings: `addons` | Reviewed manager restores inspection, permission approval, activation, diagnostics, update, disable and rollback | Installed desktop/phone tests pass; campaign acceptance remains |
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
