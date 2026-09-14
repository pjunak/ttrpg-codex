# Project backlog

This is the only durable backlog for the host and its four companion add-ons.
Current contracts describe implemented behavior. The historical
[feature comparison](rewrite/FEATURE_PARITY_AUDIT.md) records earlier omissions
and decisions; it is not the current task list.

## Rewrite status

The Go/TypeScript replacement was accepted for the two personal sites and
cut over on September 9, 2026. The subsequent character rewrite uses Engine 4,
Sheets 4 and retained schema-4 revisions. Architecture and accepted product
parity are implemented; maintenance, integration coverage and the conditional
extensions below are not all complete.

The September 14 audit checked tracked documentation, production source,
public schemas, tests and CI across all five repositories. Initial worktrees
were clean. These are the source baselines, before this documentation cleanup:

| Repository | Audited revision |
| --- | --- |
| Host | `f95aa447b20c` |
| DM Tools | `4b8341078755` |
| Compendium | `86b7f094a44f` |
| Rules engine | `34b373df84a5` |
| Character sheets | `37a4489d8df3` |

A read-only server check on September 14 found both hosts healthy on image
`sha256:c07979bf7729662bf19d299fc0c76e050a7e5ee37e48b365dfdddd37733a58ef`.
Asurai had DM Tools 3.0, Compendium 3.1, Engine 4 and Sheets 4 active, with the
three superseded 3.0 packages retained. Tiamat had all four 3.0 packages stored
and none active. Health does not establish intended add-on configuration or
workflow acceptance. These observations are a dated snapshot, not monitoring.

`npm run check` validates the selected code/test inputs. Installed companion
browser cases require ZIP environment variables; a green default run can skip
them. `npm run release-check` checks the 33 accepted gates and the absence of
`frontend/REWRITE_INCOMPLETE`; it does not prove every item below is complete.

## Remaining work verified on September 14

P1 means address early because it affects safe upgrades, preservation or release
confidence. P2 means useful maintenance or usability work. The order is a
proposed tightening sequence, not new launch gates or permission to publish,
deploy, delete retained data, or enable packages on another site.

### First implementation batch

- [ ] **T01 / P1 — Make migration build bytes platform-independent.**
  [Migration checksums](../internal/storage/sqlite/migrate.go) hash exact embedded
  SQL bytes. Twelve SQL files currently have LF in Git and CRLF in this Windows
  checkout, with no `.gitattributes` rule. A Windows-built maintenance binary can
  therefore reject a Linux-created database as drift. Pin canonical checkout
  bytes and verify Linux/Windows build identity without weakening drift checks
  or rewriting existing database hashes. Account explicitly for disposable or
  retained databases created by earlier Windows builds.
- [ ] **T02 / P1 — Run the complete installed suite in release CI.**
  [Compatibility CI](../.github/workflows/addon-compatibility.yml) builds and
  inspects the ZIPs, but the separate host test job receives none of them.
  [Installed character tests](../frontend/test/browser/installed-character.browser.mts)
  and the other companion suites consequently skip. Feed the exact inspected
  four ZIPs into the host suite using all `CODEX_*_ZIP` variables, require the
  private content for publication, and report the tested sibling commits.
  Also run Sheets Go tests/vet against the candidate host: the compatibility job
  currently builds its worker and runs browser-unit tests, while Go checks run
  only in the separate Sheets repository workflow. Completion requires a
  publication-path run with no companion skips; keep ordinary PR/private-access
  limitations explicit.
- [ ] **T03 / P1 — Resolve dangling planning-consequence targets.**
  [Go validation](../../addon-dm-tools/internal/planning/model.go) checks planning
  reference targets but only the anchors of consequences. The
  [browser model](../../addon-dm-tools/src/planning-model.ts) and
  [subtree cleanup](../../addon-dm-tools/src/planning-repository.ts) have the same
  gap: a surviving consequence can retain a deleted planning target.
  Define consistent import, edit and deletion behavior that preserves annotation
  prose. Verify missing targets, later deletion, conflicts and valid references
  through both validators and the reviewed importer.
- [ ] **T04 / P1 — Remove superseded saved package generations.**
  [Lifecycle storage](../internal/addons/packagemanager/store.go) and
  [uninstall](../internal/addons/packagemanager/uninstall.go) retain immutable
  archives indefinitely. Implement reviewed deletion of an inactive generation,
  including its files and metadata, and a bounded retention policy with explicit
  recovery protection. Show eligibility, retained references and reclaimed size;
  protect active/staged transitions and handle interruption/retry. Verify
  backup/recovery references before deletion. A standalone backup can preserve
  rollback without keeping executable archives in the live installation forever.

- [ ] **T19 / P1 — Restore reviewed campaign-bundle imports in the current architecture.**
  The preserved host commit `3aeeacfe7adec985693f8aeb239df58c177f3da8` registers
  `server/campaign-bundle-provider.cjs` and the
  `ttrpg-codex-campaign-bundle` format. Current production code has no matching
  provider/schema/route: only the DM Tools planning adapter is implemented.
  [ADR-0001](decisions/0001-campaign-bundle-imports.md) preserves the intended
  ownership, but does not prove current support. Implement a current-format
  host-owned provider with reserved ID/reference review, core validation,
  optional scoped planning contributions and atomic publication of the exact
  accepted plan. Test stale plans, cancellation, lost responses and core/add-on
  rollback. Retain the visible format-routed Import Center; do not restore the
  old JavaScript runtime. Any deliberate retirement needs an explicit product
  decision. This omission was not captured by the earlier F01–F21 list.

### Other concrete maintenance and product work

- [ ] **T05 / P2 — Permanently remove unwanted add-on data.**
  Uninstall deliberately keeps collections, detached extensions and retained
  history. Add a separate reviewed namespace-deletion contract with counts,
  recovery/history implications and a backup requirement where data is lost.
  This is distinct from T04; removing an old Compendium archive must not purge
  current campaign data. See [extension lifetimes](rewrite/ADDON_DATA.md#record-extensions)
  and [retained history](rewrite/RETAINED_ADDON_HISTORY.md).
- [ ] **T06 / P2 — Collect unused blob objects.**
  [Blob deletion](../internal/storage/blobstore/store.go) invalidates handles,
  while shared bytes and crash-orphaned objects remain. Add an offline collector
  that checks live and recovery references, supports preview and interruption,
  and proves that shared media and restore remain usable. Do not equate deleting
  a media handle with reclaiming its bytes.
- [ ] **T07 / P2 — Define durable log retention and replay checkpoints.**
  [SSE storage](../internal/events/events.go) bounds replay responses but does not
  prune stored events. Package lifecycle/review records also accumulate.
  Measure growth, define retention separately for invalidation logs and audit
  records, and test reconnect/reset across the retained boundary. Existing
  [recovery-point retention](../internal/storage/sqlite/recoverystore/store.go)
  already exists. Authored drafts and retained character history must not gain
  silent expiry as a side effect.
- [ ] **T08 / P2, schema-change triggered — Implement reviewed add-on migrations.**
  [Data lifecycle](rewrite/ADDON_DATA.md#remaining-public-surface) detects schema
  incompatibility; `addon/migration.plan` / `apply` are not orchestrated. Provide
  exact-snapshot review, atomic commit, stale-plan rejection and recovery when a
  real released schema needs preservation. The approved schema-3 sheet reset is
  implemented offline; it is not a general converter or a reason to restore F15.
- [ ] **T09 / P2 — Coordinate dependent disable.**
  [Disable](../internal/addons/packagemanager/controls.go) refuses active
  dependents. Uninstall already has a reviewed dependency transition. Extend
  that coordinator to disable, with an affected-package preview, proper stop
  order and rollback on failure; preserve optional-consumer behavior.
- [ ] **T10 / P2 — Wire worker health and crash recovery.**
  [The supervisor](../internal/addons/workersupervisor/supervisor.go) has health
  and completion primitives; [restart policy](../internal/addons/workersupervisor/state.go)
  is a tested helper with no production caller. Add coordinator-owned monitoring,
  bounded restart/backoff, crash-loop failure/quarantine and provider invalidation.
  Verify hung/crashed workers, dependent state, shutdown races and no replay of
  non-idempotent calls. Manual reload and host-start recovery already work.
- [ ] **T11 / P2 — Complete useful Inspector diagnostics.**
  The [manager UI](../frontend/src/app/codex-addon-manager.ts) already shows
  generations, review differences, runtime state and lifecycle errors. Its
  [client](../frontend/src/core/addon-admin.ts) discards richer worker snapshots.
  Add bounded health/exit/negotiation and browser activation/disposal details,
  then redacted request/security-event correlation and support export as needed.
  Test redaction before exposing raw stderr or payloads. Do not rebuild the
  already implemented review/activation screen.
- [ ] **T12 / P2 — Explain update builds and release changes.**
  [GitHub candidates](../frontend/src/core/addon-github.ts) expose name, version,
  digest and active state, but no release notes or source commit field. Tested
  commit releases can share a package version. Show source/build identity,
  useful change details and incompatibility reasons without changing exact
  package review. Checking all sources already exists; atomic bulk activation
  is not required. This is the remaining D01 usability work.
- [ ] **T13 / P2 — Link installation recovery from Settings.**
  [Recovery Settings](../frontend/src/app/codex-recovery-settings.ts) explains
  offline restore and provides campaign recovery/backup download, but does not
  link the verify/restore procedure. Make the correct whole-installation route
  discoverable in both languages. Keep full archive replacement offline (D02).
- [ ] **T14 / P2 — Remove generated distribution assets from source ownership.**
  Add-on builds still require intentionally tracked `web/` output and native
  worker binaries. Replace every checkout/test/package consumer with generated
  or versioned release artifacts, retain standalone deterministic package builds,
  and then change ownership rules and remove tracked outputs. Do not merely
  delete them or rewrite historical branches. This is repository cleanup,
  separate from pruning installed generations.

### Operations and remaining acceptance

- [ ] **T15 / P1 — Publish and deploy the already-fixed host issues.**
  Host commits `d718db2` (saved-package labels and schema-blocker explanations)
  and `f95aa44` (shared large-backup manifest limits) are local and beyond the
  recorded upstream. Both sites still run the image recorded above. After an
  explicitly authorized release, verify the served manager and a full backup
  with the deployed maintenance binary. A standalone maintenance utility used
  for Asurai does not update the server image. Follow [deployment](SELF_HOSTING.md#publishing-and-deploying-updates).
- [ ] **T16 / P2 — Finish Asurai retirement after cleanup exists.**
  Engine 4 / Sheets 4 activation and the four-sheet reset were completed after
  verified backups. Old Compendium/Engine/Sheets 3.0 generations remain. Use T04
  to remove eligible live archives. Separately inventory old cutover directories,
  images and maintenance artifacts and record their retention/deletion decision;
  this audit has not established which historical copies are still required.
  Preserve the verified backup independently. Do not repeat the reset.
- [ ] **T17 / P2 — Reconcile Tiamat's intended package state.**
  The read-only audit found four stored 3.0 packages with no active generation.
  Determine whether this is intentional and which current packages are wanted,
  then review their schemas and stored data before any activation or retirement.
  Asurai's reset approval does not authorize deleting Tiamat's sheet values.
- [ ] **T18 / P2 — Close specific workflow and platform evidence gaps.**
  Associate each changed workflow with success, cancellation, stale-save,
  session-expiry and provider-loss evidence. Exercise restore/rollback with
  relevant packages and safe disposable data. Expand representative DM/player,
  English/Czech and desktop/phone coverage where missing, and record supported
  native-target smoke checks; cross-compiling a worker is not executing it.
  Physical touch, human screen-reader, full contrast and physical-printer
  acceptance remain distinct from Chromium screenshots or PDF inspection.
  Do not rerun an exhaustive matrix for every prose edit. See the
  [workflow inventory](#workflow-inventory) and [character verification](rewrite/CHARACTER_BUILD_HISTORY.md#verification-result).

## Conditional extensions and deliberate limits

These are not mandatory rewrite completion work. Resume an item only for a
concrete consumer, measured problem or explicit product decision. Listing a
reserved API name does not mean its implementation is promised.

| ID | Deferred part | Current boundary and condition for doing more |
| --- | --- | --- |
| C01 | Draft survival across externally forced add-on graph replacement | Local guards and Sheets device drafts exist; DM Tools drafts are view-local and can be lost on forced teardown. The full browser-graph restart is accepted. Add durable planner drafts or narrower restarts if this actual failure needs addressing; preserve generation safety. [Browser lifecycle](rewrite/BROWSER_ADDONS.md#cold-graph-switch). |
| C02 | Arbitrary editor fields, combined core/add-on saves, external record renderers | F11 separate panels and saved-revision printing work. Broader transactions and typed renderer selection need a real consumer; do not revive raw HTML/live-object overrides (D04). [Panel contract](rewrite/BROWSER_ADDONS.md#record-panels-and-planning-prose). |
| C03 | General graph facade and custom graph node kinds | F12: host graph views/contributors exist; `context.graphs`, node-kind renderers, provider-driven invalidation and contribution into other add-on graphs do not. [Graph contract](../examples/addons/API_V3.md#mind-palace-graph-providers). |
| C04 | Restart-server button | F06 remains deferred; deployment and supervised restart already exist. Add a web action only for a concrete operator need with clear impact and result reporting. |
| C05 | Atlas rapid placement and wheel preference | D05: explicit forms and Ctrl/Command-wheel are intentional. Optional reversible placement and gesture preferences are separate from the completed planning reader. [Planner](../../addon-dm-tools/docs/PLANNER.md). |
| C06 | Persistent sessions and individual session management | Current sessions are in memory; credential rotation and revocation work. Persist/list/revoke individual sessions only if needed. [Authentication](rewrite/AUTHENTICATION.md). |
| C07 | Broader SDK, worker and job transports | Standalone browser `imports/events/settings/navigation/log` handles, worker blob/event/network/progress methods, enum-kind injection, namespaced `http-endpoint` execution and job/import progress topics are not implemented. Current imports use brokered adapters and contribution contexts; native initialization-time self-binding is also unimplemented. Add only the required versioned surface; migration orchestration is T08. [Available API](../examples/addons/API_V3.md#current-implementation-status). |
| C08 | Additional worker containment and package trust mechanisms | WASI execution, OS CPU/memory enforcement and package-signature verification are absent. Native first-party workers are maintainer-reviewed, not sandboxed. Establish needed controls before broadening that trust model; no WASI port is required just to finish this rewrite. [Supervision](rewrite/WORKER_SUPERVISION.md). |
| C09 | Scale-driven indexing, queues and metrics | Non-unique add-on indexes are declarations, not physical indexes. Worker admission rejects excess work without a waiting queue. Add indexes, fairness or latency metrics from measured workloads, preserving current limits. [Data](rewrite/ADDON_DATA.md), [RPC](rewrite/WORKER_BROKER.md). |
| C10 | More structured rules automation | Many item/feature effects remain prose; only declared mechanics or explicit DM effects can automate them. Renown, facilities and Circle Magic have reference summaries, not workflows. Add source fields, consumer behavior and tests together for a real need. Combat/encounter resolution and wholesale adventure/gazetteer imports remain outside scope. [Coverage](../../addon-dnd-2024-compendium/data/COVERAGE.md), [gaps](../../addon-dnd-2024-compendium/data/GAPS.md). |

Extending release metadata/waiting to Music or static-site producers remains a
separate request for those owners. It is not unfinished TTRPG implementation.

## Delivery order and acceptance evidence

1. Address T01–T04 and T19: reproducible maintenance, installed release coverage,
   planning integrity, finite saved-package retention and campaign-bundle imports. T01 is necessary before using
   new locally built maintenance tools against existing Linux data.
2. Deliver T05–T11 in independent changes with their data/lifecycle tests. Design
   package, namespace and blob deletion separately; share reference accounting
   where justified. T08 waits for a real preservation requirement.
3. Finish T12–T14 usability/source cleanup. Preserve existing package builds and
   exact reviewed installation while changing distribution ownership.
4. Use explicit release/operation authorization for T15–T17. Complete relevant
   T18 evidence on the final artifacts. Choose conditional work independently.

## Workflow inventory

Use [current routes](../frontend/src/app/routes.ts), the
[original source comparison](rewrite/FEATURE_PARITY_AUDIT.md#baselines-and-method),
and the following evidence owners. Existing tests demonstrate their recorded
cases; they do not make every state/device combination complete.

| Workflow | Current evidence owner | Remaining acceptance |
| --- | --- | --- |
| Campaign records, settings, maps, timeline and graphs | [Host browser tests](../frontend/test/browser/), [core data](rewrite/CORE_DATA.md) | T18: changed-action coverage, session expiry/in-flight saves and site-specific representative pages. |
| Package lifecycle, sources, updates and credentials | [Manager fixture](../frontend/test/browser/installed-addon-manager-fixture.mts), [GitHub browser tests](../frontend/test/browser/addon-github.browser.mts) | T02 installed CI; T04–T13 changed lifecycle/diagnostics; T15–T17 actual deployed artifacts. |
| Planning and import | [DM Tools tests](../../addon-dm-tools/tests/), [Go importer](../../addon-dm-tools/internal/importer/) | T03 target/deletion semantics; T02 installed CI; C01 forced-teardown limitation. |
| Compendium, rules and character history | [Installed rules](../frontend/test/browser/installed-rules.browser.mts), [installed character](../frontend/test/browser/installed-character.browser.mts) | T02 continuous coverage; T18 targeted provider/restore/device cases; C10 supported-content limits. |
| Full backup, conversion and retirement | [Backup tests](../internal/backuparchive/), [retirement tests](../internal/maintenance/sheetretirement/) | T01 platform byte identity; T15 deployed large-backup verifier; T16–T17 per-site decisions. |

## Feature-parity audit follow-up (2026-09-11)

| Earlier finding | Current disposition |
| --- | --- |
| F01–F05 | Implemented: Markdown recovery, collection views, quick search, activity summaries and focused map editor. |
| F06 | Deferred restart action, C04. |
| F07–F10 | Implemented: instance rules/sources, provider selection, reviewed uninstall and settings panels. Archive/data cleanup remains T04–T05. |
| F11 | Implemented separate editor/map panels; broader saves/injection remain C02. |
| F12 | Deferred graph extensions, C03. |
| F13–F14 and F16–F20 | Implemented by [character decisions, history and explanations](rewrite/CHARACTER_BUILD_HISTORY.md): print, reviewed transfer/undo, attunement, derived builds, details, senses and HP bounds. |
| F15 | Explicitly retired; no old-sheet compatibility implementation is outstanding. |
| F21 | Implemented shared planning reader. |
| D01–D02 | Current reviewed-package/offline-restore boundaries retained; concrete usability work T12–T13. |
| D03–D04 | DM recovery administration and retirement of raw renderer overrides retained; only C02/C06 if a concrete need arises. |
| D05–D06 | Optional Atlas work C05; offline conversion remains the boundary. Site-specific unresolved data belongs to T16–T17, not startup compatibility. |
| V01–V04 | Source, installed test and production evidence are distinct. T02 and T18 track coverage; T15–T17 track operations. No full combinatorial rules guarantee is claimed. |

## Completed suite cleanup (2026-09-14)

Consolidated the prior open checkboxes, scattered subsystem follow-ups and newly
verified gaps into T01–T19 and C01–C10. Removed duplicate chronological test
counts and stale pending-v1 acceptance language while preserving all 33 accepted
release-gate outcomes. Historical comparisons remain available in their owner
and Git history.

Corrected public documentation that presented planned SDK handles, migrations,
quarantine, restart policy and full Inspector diagnostics as current behavior.
Corrected normal backup support to v2 only, marked old ADR delivery lists as
historical, and documented permanent commit releases alongside expiring Actions
artifacts. This cleanup changes documentation only; none of the open runtime
or production tasks is marked complete by it.

Validation for this documentation cleanup: all 69 tracked Markdown documents
and 431 local links/anchors checked; source-language and 33-gate release checks
passed. Existing Go tests passed for SQLite migrations, backup archives, package
management, worker supervision/dispatch, planning validation and planning imports
(including documented examples). Cached Go results were reused where inputs
were unchanged. No runtime or schema files changed, so full builds, ZIP
regeneration and the complete browser matrix were not repeated for this edit.

This is a source-backed inventory of known unfinished work and observed
operational state, not an exhaustive security audit or proof that no other
runtime defects exist. The site checks read health/package metadata only;
no live campaign records were edited, packages activated or data removed.

## Product-parity release gates

These 33 outcomes were accepted for the personal-site cutover. Each can be
satisfied by a faithful port, accepted redesign or explicit retirement. Their
checked state is historical acceptance, not completion of the tightening list.
Current behavior lives in the linked contracts and workflow evidence above.

The owner's policy permits outages, post-launch fixes and rollback; an
exhaustive operational rehearsal is not a new release prerequisite. Preserve
original backups and use a short first-start smoke check for an authorized
cutover. Do not repeat conversion merely because this backlog was reorganized.

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

## Explicit non-goals

- Permanent v1 readers, startup converters, old-sheet compatibility or general
  legacy repair in the running application.
- Compiling add-on source in production, hardcoding provider IDs, silently
  choosing ambiguous providers or bypassing exact permission/schema review.
- Deleting old saves, protected history or branches as an automatic consequence
  of an upgrade or this audit.

Immutable SQL migrations, offline conversion tools, regression fixtures and
separate verified backups have specific integrity/recovery purposes. They are
not a second legacy runtime. Retire obsolete live archives through T04 and
historical operational copies through T16–T17, with explicit reference and
retention decisions.
