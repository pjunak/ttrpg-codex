# Project backlog

Current state: October 3, 2026. This is the only durable task list for the five
repositories. [Rewrite handoff](REWRITE_HANDOFF.md) explains the goal, ownership
and working conventions; [current acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md)
records verified delivery. Detailed completed batches remain in Git history
before the documentation cleanup (`8488968`).

**Estimate:** 97% implemented / 96% overall (approximate ranges 93–98% / 92–98%).
The original audit has 33/40 rows closed (83%); open rows include completed
implementation and outstanding acceptance. These are different measures.
A successful replay does not establish the cause of a historical failure.

P1 means preservation, blocked workflows or release confidence. P2 means
usability, resilience or maintenance. Operational and human checks are not
missing implementations. Conditional extensions require a concrete need.

## ttrpg-codex

- [x] ~~Core workflow and reusable UI cleanup~~ — campaign views/editors, role
  projection, shared controls, responsive entity cards/pencil actions, search,
  maps, timelines, graphs, draft/session recovery and optimistic conflicts.
- [x] ~~Package, worker and recovery implementation~~ — reviewed GitHub updates,
  compatible healing/reset with backup offers, automatic selected-build cleanup,
  independent recovery, bounded diagnostics, native cancellation and generation
  isolation; atomic reviewed campaign bundles and offline maintenance.
- [x] ~~Approved host deployment~~ — `1463caf`, 278/278 Linux installed cases,
  exact healthy Asurai/Tiamat images and public desktop/phone/artwork checks.
  [Release receipt](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-approved-follow-up-rollout).

### Lifecycle, maintenance and operations

| ID | Priority / type | Remaining work and completion evidence |
| --- | --- | --- |
| T15 | P1, operational | Verify real DM manager access and full ZIP backups independently with the matching maintenance binary on both sites. On Asurai, verify newest reviewed add-on builds and actual worker/save feedback. Reviewed ZIP activation is separate from host deployment. [Backup procedure](SELF_HOSTING.md#verify-with-the-running-host-image). |
| T16 | P2, operational | On Asurai, verify automatic selected-build retention and campaign recovery after obsolete add-on contexts are retired. Code is implemented; no completed authenticated live result exists. Preserve current saves and independent ZIP backups. |
| T17 | P2, operational | Verify Tiamat's authenticated add-on inventory remains inactive. The owner requires **no add-ons on Tiamat**; never install or activate packages there. Asurai's reset authorization does not apply to Tiamat. |

### Validation follow-up

- [ ] **T57-VERIFY / P2 — Resolve historical startup investigations.** Timeline
  mounting, one phone Settings load and rules-policy setup timed out without
  attributable original captures. Windows `ERR_NO_BUFFER_SPACE` matched one TCP
  port-exhaustion event; its pressure source remains unknown. Diagnostics and
  several independently reproduced worker/fixture defects are repaired. Capture
  a recurrence and establish cause/fix evidence, or obtain an explicit owner
  decision to close as inconclusive. Keep deadlines and assertions unchanged.
  [Evidence boundary](rewrite/HOST_CLEANUP_ACCEPTANCE.md#remaining-reliability-evidence).

### Conditional host extensions

These are not launch blockers or partially enabled product workflows.

| ID | Add only when justified |
| --- | --- |
| T08 | Reviewed value-transforming migration for a concrete incompatible saved JSON preservation case. Healing, explicit reset, backup offers and automatic recovery already work. Exact atomic plans, stale rejection and recovery remain required. [Current boundary](rewrite/ADDON_DATA.md#remaining-public-surface). |
| C02 | Arbitrary editor fields, combined core/add-on saves or serializable external record renderers. Preserve independent panels and reject raw HTML/live-object overrides. |
| C03 | General graph facade or custom node kinds beyond existing model contributions. |
| C04 | A web restart-server action with an actual operator need. |
| C06 | Persistent sessions or individual session revocation beyond credential rotation. |
| C07 | Reserved standalone SDK/worker/job transports, enum injection, endpoints or progress publication. A reserved schema name is not a callable API. [Availability](../examples/addons/API_V3.md#current-implementation-status). |
| C08 | Additional native containment, resource enforcement, WASI or signatures before broadening the reviewed trust model. |
| C09 | Physical add-on indexes, fair queues or metrics for measured load. |

## addon-dm-tools

- [x] ~~Planner, Atlas and Import Center cleanup~~ — schema-3 ownership/flow,
  card/annotation editing, large nested sessions, drafts, shared controls,
  reviewed exact import plans and consequence-target validation.

- [ ] **T15-DM / P1, operational — Review existing consequence targets.** After
  a verified Asurai backup, inspect intended-site data before activating the
  stricter package. Report and explicitly repair dangling references; no
  automatic rewriting. Then complete the selected ZIP's review under T15.
- [ ] **T18-DM / P1, review — Resolve the historical canvas-load timeout.**
  The September 17 installed group-selection case timed out before an action.
  Successful replays do not establish its cause. Capture a recurrence or obtain
  an explicit inconclusive disposition. [Evidence boundary](rewrite/HOST_CLEANUP_ACCEPTANCE.md#remaining-reliability-evidence).

**C05, optional UX:** rapid Atlas placement and wheel preferences need a concrete
request. Explicit forms and Ctrl/Command-wheel are accepted choices.
[Current planner contract](../../addon-dm-tools/docs/GRAPH.md).

## addon-dnd-2024-compendium

- [x] ~~Library, source policy and content-contract cleanup~~ — standalone
  browse/search, book/topic structure, Markdown/tables, bestiary, typed links,
  shared controls and reviewed source-owned character fields.

No confirmed browse implementation gap remains. **C10, consumer-triggered:**
[structured-data gaps](../../addon-dnd-2024-compendium/data/GAPS.md) include
per-instance magic weapon/shield base forms and narrative effects. Renown,
facilities and Circle Magic are reference summaries without automation.
Add source facts, schema/provenance checks and Engine/Sheets consumption together
for a concrete required mechanic. Do not invent item forms or import adventure
prose merely to close a checklist.

## addon-dnd-engine

- [x] ~~Rules v4 and worker cleanup~~ — deterministic character computation,
  acquisition ownership, bounded play, source/condition effects, provider
  transitions and preserved independent synthetic parity fixtures.
- [x] ~~Retired source cleanup~~ — `9e8085a` removes the old JavaScript reference
  generator; all 144 frozen parity vectors stay. Full Go/race checks and host ZIP
  inspection pass; rebuilt package bytes are unchanged. This commit is local.

- [ ] **T18-ENGINE / P1, review — Resolve the historical T53 availability loss.**
  Accepted multiclass/provider sessions and the later diagnostic replay did not
  reproduce the original loss. Independently repaired saturation/transport
  failures do not attribute it. Capture a recurrence or obtain an explicit
  inconclusive disposition; use versioned results and retain provider absence.
  [Evidence boundary](rewrite/HOST_CLEANUP_ACCEPTANCE.md#remaining-reliability-evidence).

C10 mechanics require provider facts and bounded consumers. No combat resolver,
provider-ID special cases or rules embedded in Sheets controls.

## addon-dnd-character-sheets

- [x] ~~Character creation, building, play and automatic saving~~ — native
  schema-4 worker authority, optimistic commands, imports/exports, saved rule
  details, grants and optional-provider reading/recovery.
- [x] ~~Compact layout and shared-control implementation~~ — accepted six-tab
  layout, Equipment/Backpack/mannequin, class-owned Builder and measured frame;
  Classic retains its arrangement. [Current workflow](rewrite/CHARACTER_BUILD_HISTORY.md).

No confirmed implementation gap remains in this slice. Future UI touch-ups must
name an observed defect or requested refinement.

### T63 Character-sheet design

- [ ] **T63 / P2, human acceptance — Physical touch, spoken screen reader and
  paper printing.** Verify Compact/Classic navigation, focus, enlarged text,
  dialogs, scroll reachability and clipping on real devices/output. Automation,
  emulation and PDF checks do not substitute for those results. Record outcomes
  and implement bounded fixes for actual defects.

Keep shared `ui.controls.v1`, theme tokens, current automatic saves, stable
instance/focus identities and Engine-derived eligibility. Preserve reload,
conflicts, exact retry, session expiry and provider/generation recovery. Do not
restore manual Save/Apply, character-history UI, device drafts or hidden rules.

## Delivery order and completion

1. Verify both full backups and authenticated inventories; Tiamat stays add-on free.
2. Review Asurai consequence targets, newest packages, save feedback and recovery.
3. Resolve historical investigations through attributable captures or an explicit
   owner disposition; complete real-device/assistive-technology/print checks.
4. Implement only identified defects or explicitly selected conditional scope.

Changed runtime/contracts need the owning gates and affected producers/consumers.
Document-only changes need link/diff/claim checks. Keep CI coverage and deadlines.
`npm run release-check` retains all [33 accepted product gates](rewrite/FEATURE_PARITY_AUDIT.md#accepted-product-parity-release-gates).
Publication, activation, deployment and live data changes require their own
explicit authorization. Original backups, offline conversion and stable public
namespaces remain protected; no live legacy runtime is being restored.
