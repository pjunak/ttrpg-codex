# Project backlog

Work for the five repositories, reviewed September 15, 2026. This remains
one suite backlog; each task belongs to the repository that owns its change.
Completed fix batches stay in compact checked, struck-through lists with commit
references; their detailed findings and the unchanged accepted release gates live in the
[feature-parity audit](rewrite/FEATURE_PARITY_AUDIT.md).

**P1:** preservation, blocked workflows or release confidence. **P2:** usability,
resilience and maintenance. **Confirmed** means source/browser evidence exists;
**review** means an unresolved acceptance or design question, not a proven bug.
Uncommitted implementation is not completion: current Engine/Sheets work still
needs its final package and workflow checks. Task IDs remain stable; gaps in
numbering are completed work. The historical gates do not close these tasks.

- [Host](#ttrpg-codex)
- [DM Tools](#addon-dm-tools)
- [Compendium](#addon-dnd-2024-compendium)
- [Rules engine](#addon-dnd-engine)
- [Character sheets](#addon-dnd-character-sheets)
- [Delivery order and completion](#delivery-order-and-completion)

## ttrpg-codex

### Completed fix batches

These are implemented and validated in the local checkout. A local commit does
not mean it has been pushed, deployed, or installed on a live site.

- [x] ~~**T20 — DM/player twin management**~~ — `cfa0630`.
- [x] ~~**T26 — Character knowledge and DM inspection**~~ — `939d4cb`.
- [x] ~~**T27 — Private location notes**~~ — `b19648f`.
- [x] ~~**T21 — Saved core URLs and guarded navigation**~~ — `a0bda14`.
- [x] ~~**T22 — Connected articles, rosters and reference links**~~ — `6758d7f`.
- [x] ~~**T23 — Contextual creation and direct card editing**~~ — `6db9afc`.
- [x] ~~**T24 — Investigation status and unanswered question queue**~~ — [contract and tests](rewrite/EDITOR_BROWSING.md#investigations), September 15.

Contracts and regression evidence: [editor and browsing workflows](rewrite/EDITOR_BROWSING.md)
and [parity audit](rewrite/FEATURE_PARITY_AUDIT.md#confirmed-findings).

### Backend and core workflows

- [ ] **T19 / P1 — Restore reviewed campaign-bundle imports.** Confirmed omission.
  The [intended host provider](decisions/0001-campaign-bundle-imports.md) is absent;
  the planning adapter alone does not import core campaign bundles. Implement
  current-format ID/reference review, optional scoped planning contributions and
  atomic publication of the exact retained plan. Prove stale/cancel/lost-response
  and core/add-on rollback behavior. DM Tools owns the visible Import Center.
- [ ] **T02 / P1 — Require installed companion tests on the publication path.**
  [Compatibility CI](../.github/workflows/addon-compatibility.yml) builds/inspects
  packages but does not feed all four ZIPs to installed host tests. Supply all
  `CODEX_*_ZIP` inputs, require private content for publication, and test/vet the
  Sheets worker against the candidate host. Record exact sibling commits and
  inspected hashes; completion requires a release-path run with no companion
  skips. Ordinary PR/private-access limitations remain explicit.

### UX/UI

The [continuation evidence](rewrite/FEATURE_PARITY_AUDIT.md#confirmed-findings)
contains the before/after comparisons for R01–R12 and screenshots for U01–U04.

- [ ] **T28 / P2 — Improve sparse profiles, collections and save feedback.** U01–U03,
  design review. Compact absent artwork and empty facts, surface meaningful
  summaries, and decide the NPC/party default. Keep useful filters and secondary
  controls discoverable. Compare sparse/rich pages at 390px and desktop, both
  themes/languages, keyboard and 200% zoom; preserve focus and dirty guards.
  Sheets' related work is T33 below, using its current autosave contract.
- [ ] **T29 / P2 — Measure delivery and interaction costs before optimizing.** U04.
  Record cold/warm load, search, article and spatial interaction with large
  synthetic campaigns and a throttled phone profile. A bundle warning alone is
  not a regression. Optimize demonstrated costs, preserving workflow/error gates.

### Lifecycle, maintenance and operations

All rows below remain open; completed archive-pruning implementation is omitted.

| ID | Priority | Remaining work and completion condition |
| --- | --- | --- |
| T05 | P2 | Separate reviewed permanent add-on namespace deletion: counts, recovery/archive implications and backup requirements. Uninstall/archive cleanup must not silently delete campaign data. [Data ownership](rewrite/ADDON_DATA.md). |
| T06 | P2 | Offline unused-blob collection with live/recovery reference accounting, preview and resumability; shared media and restore must survive. [Blob store](../internal/storage/blobstore/store.go). |
| T07 | P2 | Measure and bound stored SSE/lifecycle/audit logs separately; test replay/reset across retention boundaries. No silent expiry of authored data or existing archives. [Events](rewrite/EVENT_STREAM.md). |
| T08 | P2, triggered | Implement reviewed migration orchestration when a released schema actually needs preservation: exact snapshot, atomic commit, stale rejection and recovery. The old-sheet reset does not imply a general converter. [Data lifecycle](rewrite/ADDON_DATA.md#remaining-public-surface). |
| T09 | P2 | Extend the reviewed dependency coordinator to disable: affected-package preview, stop order and rollback. Today disable refuses active dependents. Preserve optional consumers. [Lifecycle](rewrite/PACKAGE_LIFECYCLE.md). |
| T10 | P2 | Wire production worker monitoring to the existing health/backoff helpers; test crashes, hangs, crash loops and shutdown. Invalidate dependent state and never replay uncertain writes. [Supervision](rewrite/WORKER_SUPERVISION.md). |
| T11 | P2 | Expose actionable worker health/exit and browser activation/disposal diagnostics; preserve bounded, redacted output and request correlation. Existing review/activation UI stays. [Browser lifecycle](rewrite/BROWSER_ADDONS.md). |
| T12 | P2 | Show source commit/build identity, release changes and incompatibility reasons for GitHub updates; version alone cannot distinguish commit releases. Retain exact-package review. [Candidate client](../frontend/src/core/addon-github.ts). |
| T13 | P2 | Link the correct verify/offline whole-installation restore procedure from Recovery Settings in English/Czech. [Recovery UI](../frontend/src/app/codex-recovery-settings.ts). |
| T14-HOST | P2 | Coordinate CI/fixture consumers of generated add-on artifacts with each repository's T14 work below. Keep standalone deterministic package builds before removing tracked output. |
| T15 | P1, operational | On an authorized release, refresh remote/deployment state, publish the chosen validated host/add-on commits, then verify served build identity, manager and full backup with the matching maintenance binary. Do not rely on old SHA snapshots. [Runbook](SELF_HOSTING.md#publishing-and-deploying-updates). |
| T16 | P2, operational | Re-inventory Asurai's superseded archives and historical cutover/maintenance copies; use existing reviewed cleanup where eligible and record retention decisions. Preserve independent backups; do not repeat the completed sheet reset. |
| T17 | P2, operational | Recheck Tiamat's intended add-on state, stored data and wanted packages before activation/retirement. Asurai's reset authorization does not apply to Tiamat. |
| T18-HOST | P2, review | Fill action-level gaps for core editing, role preview, settings, maps/timeline/graphs, recovery and lifecycle using [browser fixtures](../frontend/test/browser/) and relevant backend tests. Apply the completion criteria below. |

### Conditional host extensions

These require a concrete consumer, measured problem or product decision.

| ID | Deferred scope |
| --- | --- |
| C02 | Arbitrary editor fields, combined core/add-on saves and typed external record renderers; preserve separate panels and no raw HTML/live-object overrides. |
| C03 | General graph facade, custom node kinds and provider invalidation beyond current graph contributions. |
| C04 | Web restart-server action if an operator need justifies its impact/result contract. |
| C06 | Persistent sessions and individual session listing/revocation if needed beyond existing credential rotation. |
| C07 | Unimplemented reserved SDK/worker/job transports: standalone browser handles, worker blob/event/network/progress, enum injection, namespaced endpoints, progress topics and initialization-time self-binding. Add only a needed versioned surface. [API status](../examples/addons/API_V3.md#current-implementation-status). |
| C08 | Additional native-worker containment, OS resource enforcement, WASI or package signatures before broadening the maintainer-reviewed trust model. |
| C09 | Physical add-on indexes, waiting/fair worker queues and metrics only for measured load; current declarations and admission limits do not provide them. |

## addon-dm-tools

Owns planner interaction, planning data and the visible Import Center. Existing
card/flow/annotation editing is implemented; this section tracks remaining work,
not a new generic-planner rewrite. [Product contract](../../addon-dm-tools/docs/PLANNER.md).

- [ ] **T30 / P1 — Preserve unsaved planning work during forced replacement.**
  Confirmed limitation, promoted from C01. Drafts are
  [view-local](../../addon-dm-tools/src/planner-drafts.ts), and reconnection
  [clears them](../../addon-dm-tools/src/planner-element.ts). Ordinary navigation
  guards do not cover externally forced add-on graph replacement. Design scoped
  recovery across replacement/provider loss with explicit stale-revision and
  discard behavior; never reuse old-generation handles. Prove item, flow,
  reference, consequence and note drafts survive or can be recovered.
- [ ] **T19-DM / P1 — Integrate the restored campaign-bundle provider.** Depends on
  host T19. Route the advertised format through the existing Import Center;
  explain core/planning scope, ID remaps and affected records in preview. Prove
  cancel/stale/lost-response behavior using an installed package, with no duplicate
  provider-owned core import implementation.
- [ ] **T18-DM / P1, review — Audit complete planning sessions, including UX.**
  Exercise large/nested plans, card/flow creation, ownership moves, target
  selection, multi-anchor notes, deletion/undo, reader/editor transitions and
  refresh while editing. Compare preserved behavior with current interaction at
  desktop/phone and keyboard/touch. Record concrete failing steps and fixes;
  passing graph fixtures alone do not close workflow parity.
- [ ] **T15-DM / P1, operational — Validate existing consequence targets before
  activating stricter planning validation.** The target-validation fix is already
  implemented. Check the intended site's data after a verified backup; report
  and explicitly repair dangling references, then activate the chosen ZIP under
  T15. No automatic rewriting or separate duplicate release task.
- [ ] **T14-DM / P2 — Remove tracked generated web/worker ownership safely.**
  Migrate this repository's package/test consumers to built artifacts, preserve
  its standalone package gate, then remove obsolete tracked output with T14-HOST.

**C05, optional UX:** rapid Atlas placement and wheel preferences may be revisited
through a concrete product decision. Explicit forms and Ctrl/Command-wheel are
accepted choices; they are not confirmed regressions.

## addon-dnd-2024-compendium

Owns reference content, search/library/bestiary UI and `dnd5e.rules-data` v3.
Standalone browsing must remain useful without Engine or Sheets.
[Current scope](../../addon-dnd-2024-compendium/README.md).

- [ ] **T31 / P2 — Keep library navigation reachable on phones.** Source-backed
  UX concern: at 768px and below, [the reading pane is ordered before the library
  drawer](../../addon-dnd-2024-compendium/src/index.css). A long detail/list can
  push topic/source navigation far below the reading content. Review in-browser
  and provide a readily reachable library control without resetting the current
  query, filters or reading position. Verify long class/monster/spell pages,
  Back, keyboard order and 200% zoom; record this as a UX fix, not yet a proven
  historical regression.
- [ ] **T18-COMP / P1, review — Complete browsing and reading parity acceptance.**
  Exercise topic/source/class/level navigation, cross-kind search, counted facets,
  reprints, ambiguous typed links, tables/stat blocks, related records and source
  links with representative long content. Test English/Czech, missing/disabled
  books, empty results, Retry and generation replacement. Separate missing data,
  misleading presentation and unsupported mechanics in the resulting findings.
- [ ] **T14-COMP / P2 — Move generated browser output to build ownership.**
  Update independent build/package/tests and host fixtures before removing tracked
  `web/`. Preserve immutable content identity, checksums and standalone browsing.

**C10, consumer-triggered:** [structured coverage gaps](../../addon-dnd-2024-compendium/data/GAPS.md)
remain in narrative effects and reference-only renown/facilities/Circle Magic.
For a concrete needed mechanic, add source fields, schema/provenance checks and
Engine/Sheets consumption together. Do not count reference prose as automation
or import whole adventures/gazetteers merely to close a checklist.

## addon-dnd-engine

Owns deterministic calculation and validation, not UI or character persistence.
Consumes optional `dnd5e.rules-data` v3 and provides `dnd5e.rules-engine` v4.
[Service contract](../../addon-dnd-engine/contract/README.md).

- [ ] **T32 / P1 — Finish progressive-build and equipment validation acceptance.**
  In-progress source adds `guidance.canSave`, class/choice eligibility and
  per-item equipment guidance. Verify legal incomplete builds save while invalid
  selections fail and play still requires `ready`. Cover point-buy boundaries,
  prerequisite changes, duplicate/replaced choices, multiclass progressions,
  equip/attune restrictions and exclusive slots. Outputs must be deterministic,
  explainable, source-policy aware and leave caller inputs unchanged. Finish
  against Sheets T33 and the compatible host; source edits alone do not close it.
- [ ] **T18-ENGINE / P1, review — Close rules/provider evidence gaps.**
  Use representative single/multiclass builds through level changes, spells,
  granted casts, resources/rest, HP, inventory and DM effects. Check missing,
  changed and incompatible providers, sourcebook removal, stale generations and
  unsupported prerequisites. Preserve saved play values through recalculation;
  separate unsupported narrative effects (C10) from calculation bugs. Run pure,
  service and installed consumer checks on exact packages; no exhaustive rules
  correctness claim from a small set of happy-path fixtures.
- [ ] **T14-ENGINE / P2 — Move native binaries to generated/release artifacts.**
  Replace worker/package/host-fixture consumers before removing tracked binaries;
  preserve reproducible target builds and record actual native execution apart
  from cross-compilation. Coordinate T14-HOST.

Engine fixes must expose results/guidance through the versioned contract; no
edition rules in Sheets controls, provider-ID special cases or combat resolver.

## addon-dnd-character-sheets

Owns the character workflow and worker-authorized current state. Its current
working contract uses progressive building and automatic saving; historical
review-every-save, browsable history and device-draft work are not to be restored.
Provider-free saved reading/notes/print/export remain required.
[Current contract](../../addon-dnd-character-sheets/docs/RULES_EDGE_CASES.md).

- [ ] **T25 / P2 — Restore complete Combat details and consistent spell filters.**
  Confirmed R09/R10, still present in current source. Show damage type, versatile
  damage, mastery and senses with units/conditions using saved explanations in
  [Combat](../../addon-dnd-character-sheets/src/character-sheet.ts). Share name/level
  filtering across class, ritual and [granted rows](../../addon-dnd-character-sheets/src/character-play.ts);
  announce zero matches. Verify both layouts/languages and provider-free saved
  details/print. Engine remains the calculation authority.
- [ ] **T33 / P1 — Finish automatic saving and progressive-builder usability.**
  In-progress source, not accepted completion. Verify new/partial characters,
  changing origin/earlier levels, point buy, duplicate choices, class selection,
  equipment and grants against Engine T32. Keep save/pending/failure/conflict
  states clear, preserve focus and rapid edits, and make the next required choice
  obvious on phones. Test coalesced writes, independent versus overlapping
  concurrent edits, session expiry, lost responses and exact retries, navigation
  guards, provider loss, explicit rules adoption and reviewed imports. Do not
  claim pending in-memory edits are durable or restore removed history UI.
- [ ] **T18-SHEETS / P1, review — Accept a whole build-and-play session.**
  Build, save/reload, advance, equip, prepare/cast, spend resources, rest, amend
  grants, print/export and review an import using the exact installed ZIP. Cover
  Compact/Classic, sparse/complex characters, DM/player, English/Czech, phone,
  keyboard and 200% zoom. Check provider-free reading and clearly disabled
  mechanics. Verify the host worker-only extension boundary, provider/schema
  incompatibility and preserved existing archives during upgrades. Record human
  screen-reader, physical touch and printer checks separately from browser/PDF tests.
- [ ] **T14-SHEETS / P2 — Remove generated browser/worker output from source ownership.**
  Migrate schema/type generation, package/test and host fixture consumers first;
  preserve deterministic standalone packaging and host inspection with T14-HOST.

## Delivery order and completion

| Order | Work | Exit evidence |
| --- | --- | --- |
| 1 | Preserve authored intent: DM T30; finish Engine T32 + Sheets T33. Start T02 alongside them. | Safe role/stale/error behavior; recoverable planning edits; incomplete character saves and bounded play work through the installed contract. |
| 2 | Everyday use: host T28, Sheets T25, Compendium T31; execute each repository's T18 review and fix its concrete failures. | Representative complete workflows on desktop/phone, with original interaction comparisons and explicit remaining manual checks. |
| 3 | Imports and resilience: host + DM T19, host T09–T13; T08 only for a real schema-preservation need. | Exact reviewed transactions, understandable failures and safe provider/lifecycle recovery. |
| 4 | Final integration: T02, relevant T18 cases and T29 measurements. | All four inspected ZIPs exercised without installed-suite skips on the publication path; exact host/sibling commits and package hashes recorded. |
| 5 | Authorized delivery T15–T17; independent maintenance T05–T07 and per-repo T14. | Exact served/installed builds verified; per-site data/retention choices recorded and rollback assets retained. |

T14 suffixes divide the existing generated-artifact task by repository; T18
suffixes divide workflow acceptance. Cross-repository changes need producer and
consumer checks and separate compatible commits. A task closes only after its
changed behavior and relevant owning gates pass; move it to its repository's
compact completed list with a checked box and struck-through title. Keep detailed
evidence in its owning contract/audit or Git history; do not remove these batch
completion markers during later cleanup.

For changed workflows, cover success, cancel/Back, reload, stale/concurrent edits,
failed or uncertain responses, session expiry and provider/lifecycle changes as
applicable. Use disposable synthetic data and representative roles, languages,
themes and screen sizes. Do not repeat the entire matrix for prose-only edits.
`npm run release-check` enforces the [historical 33-gate acceptance](rewrite/FEATURE_PARITY_AUDIT.md#accepted-product-parity-release-gates);
`npm run check` proves technical consistency, with optional installed tests
requiring package inputs. Neither substitutes for these open product tasks.

Planning authorizes no publication, deployment, live conversion or deletion.
Preserve accepted retirements: no old-sheet compatibility, live legacy readers,
production source compilation, raw renderer overrides or silent data cleanup.
