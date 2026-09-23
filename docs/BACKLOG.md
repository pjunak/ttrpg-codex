# Project backlog

Work for the five repositories, reviewed September 23, 2026. This remains
one suite backlog; each task belongs to the repository that owns its change.
Completed fix batches stay in compact checked, struck-through lists with commit
references; their detailed findings and the unchanged accepted release gates live in the
[feature-parity audit](rewrite/FEATURE_PARITY_AUDIT.md).

**Progress estimate, September 17:** about **80% implemented**, or **70–75%**
including release and complete workflow acceptance.
[Estimate and counting method](rewrite/HOST_CLEANUP_ACCEPTANCE.md#cleanup-progress-estimate).
**Rows closed, September 23:** 25 of the original 40; large open tasks contain
completed slices.

**P1:** preservation, blocked workflows or release confidence. **P2:** usability,
resilience and maintenance. **Confirmed** means source/browser evidence exists;
**review** means an unresolved acceptance or design question, not a proven bug.
Implementation is not release acceptance: remaining Engine/Sheets work still
needs its package and workflow checks. Task IDs remain stable; gaps in numbering
are completed work. Historical gates do not close the remaining tasks.

- [Host](#ttrpg-codex)
- [DM Tools](#addon-dm-tools)
- [Compendium](#addon-dnd-2024-compendium)
- [Rules engine](#addon-dnd-engine)
- [Character sheets](#addon-dnd-character-sheets)
- [Delivery order and completion](#delivery-order-and-completion)

## ttrpg-codex

### Completed fix batches

These are implemented and validated. Publication and deployment evidence is
linked where verified; publication alone does not install add-ons on a live site.

- [x] ~~**T20 — DM/player twin management**~~ — `cfa0630`.
- [x] ~~**T26 — Character knowledge and DM inspection**~~ — `939d4cb`.
- [x] ~~**T27 — Private location notes**~~ — `b19648f`.
- [x] ~~**T21 — Saved core URLs and guarded navigation**~~ — `a0bda14`.
- [x] ~~**T22 — Connected articles, rosters and reference links**~~ — `6758d7f`.
- [x] ~~**T23 — Contextual creation and direct card editing**~~ — `6db9afc`.
- [x] ~~**T24 — Investigation status and unanswered question queue**~~ — `2a8e867`.
- [x] ~~**T28 — Compact reading, collection controls and save feedback**~~ — `44053df`.
- [x] ~~**T40-HOST — Restore full-size entity cards and shared pencil actions**~~ — `16155a7`; [shared UI and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#shared-entity-card-sizing-and-editing).
- [x] ~~**T41-HOST — Wrap enlarged character headings and accept repeated feat workflows**~~ — [package and phone acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#repeatable-skilled-choices-and-acquisition-ownership).
- [x] ~~**T42-HOST — Accept origin choices, replacements and autosave focus**~~ — [installed package acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#phb-origin-choices-and-shared-field-focus).
- [x] ~~**T43-HOST — Accept equipment preservation, attunement repair and phone layouts**~~ — [installed package acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#equipment-preservation-and-attunement-eligibility).
- [x] ~~**T44-HOST — Accept guarded command retries, import approval and delayed reads**~~ — [installed package acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#character-command-recovery-and-uncertain-outcomes).
- [x] ~~**T12 — GitHub package/build identity, release notes and compatibility reasons**~~ — `1905469`.
- [x] ~~**T13 — Full-backup verification and offline restore guidance**~~ — `301bd9e`.
- [x] ~~**T09 — Reviewed dependency-aware disabling and recovery**~~ — `9997306`.
- [x] ~~**T10 — Worker monitoring, bounded retries and dependent recovery**~~ — `b74a30c`.
- [x] ~~**T34 — Shared themeable UI library and typed add-on capability**~~ — `d957bfd`; [researched controls and validation](rewrite/UI_FOUNDATIONS.md).
- [x] ~~**T05 — Reviewed permanent add-on namespace removal**~~ — `31ebabb`.
- [x] ~~**T06 — Offline shared/recovery-aware blob collection and resumable unlink**~~ — `31ebabb`.
- [x] ~~**T07 — Measured, separately reviewed log retention and replay checkpoints**~~ — `31ebabb`; [operator procedure](SELF_HOSTING.md#reviewed-offline-storage-maintenance).
- [x] ~~**T11 — Bounded, redacted worker and browser diagnostics**~~ — `9012bf6`.
- [x] ~~**T14-HOST — Build/inspect companion artifacts before installed acceptance**~~ — `20c719c`.
- [x] ~~**T19 — Atomic reviewed campaign bundles and receipt reconciliation**~~ — `94544bc`; [contract and validation](decisions/0001-campaign-bundle-imports.md).
- [x] ~~**T29 — Measured campaign/asset compression and reproducible profiling**~~ — `8d3652a`; [results and measurement limits](rewrite/PERFORMANCE.md).
- [x] ~~**T18-HOST — Core workflow acceptance and draft-preserving session recovery**~~ — `eb2cb7b`; [action-level evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md).
- [x] ~~**T35 — Repair deployment reflow checks and unintended reduced-motion transitions**~~ — `484814c`, `c3d0ac1`; [failure and regression evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#deployment-gate-repair-and-engine-follow-up).
- [x] ~~**T36 — Preserve Linux worker permissions in installed-package fixtures**~~ — `325cf13`, `5cc4945`; [CI diagnosis and regression evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#coordinated-publication-verification).
- [x] ~~**T37 — Prevent pipe-cleanup races from failing worker shutdown**~~ — `07482f0`; [deterministic regression and race checks](rewrite/HOST_CLEANUP_ACCEPTANCE.md#native-shutdown-race-follow-up).
- [x] ~~**T45-HOST — Pin accepted companion sources and stabilize reader navigation**~~ — [recurring CI diagnosis, source coordination and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#repeated-compatibility-failures-and-pinned-source-revisions).
- [x] ~~**T46-HOST — Preserve pending add-on edits through session renewal**~~ — [shared recovery and installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#add-on-session-renewal-without-losing-pending-edits).
- [x] ~~**T48-HOST — Hand off pending record edits across add-on graph replacement**~~ — bounded shared API, guarded teardown and fresh service ownership; [installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#pending-character-edits-across-graph-replacement).
- [x] ~~**T02 (including T02-LOCAL) — Publish and accept all four companion revisions with zero skips**~~ — host `5cc4945`; [104/104 Linux cases, exact sources and ZIP hashes](rewrite/HOST_CLEANUP_ACCEPTANCE.md#coordinated-publication-verification).
- [x] ~~**T15-DELIVERY — Publish the tested host and deploy both sites**~~ — `5cc4945`; [Asurai/Tiamat rollout and health checks](rewrite/HOST_CLEANUP_ACCEPTANCE.md#coordinated-publication-verification).

Contracts and regression evidence: [editor and browsing workflows](rewrite/EDITOR_BROWSING.md),
[GitHub package updates](rewrite/PACKAGE_LIFECYCLE.md#github-package-sources),
[backup recovery](rewrite/BACKUP_RESTORE.md#deliberate-boundary),
[reviewed disabling](rewrite/PACKAGE_LIFECYCLE.md#reload-and-disable),
[worker recovery](rewrite/WORKER_SUPERVISION.md#restart-policy),
and [parity audit](rewrite/FEATURE_PARITY_AUDIT.md#confirmed-findings).

### Lifecycle, maintenance and operations

Host implementation and local core UX acceptance are complete. These rows require
a released schema-preservation need or separate operational authorization.

| ID | Priority | Remaining work and completion condition |
| --- | --- | --- |
| T08 | P2, triggered | Implement reviewed migration orchestration when a released schema actually needs preservation: exact snapshot, atomic commit, stale rejection and recovery. The old-sheet reset does not imply a general converter. [Data lifecycle](rewrite/ADDON_DATA.md#remaining-public-surface). |
| T15 | P1, operational | Publish the latest cleanup candidate in pinned companion/host order, then verify both site rollouts, served frontend identity, manager and full backup with the matching maintenance binary; review intended add-on activation per site. T15-DELIVERY records an earlier successful release. [Current delivery boundary](rewrite/HOST_CLEANUP_ACCEPTANCE.md#repeated-compatibility-failures-and-pinned-source-revisions); [runbook](SELF_HOSTING.md#publishing-and-deploying-updates). |
| T16 | P2, operational | Re-inventory Asurai's superseded archives and historical cutover/maintenance copies; use existing reviewed cleanup where eligible and record retention decisions. Preserve independent backups; do not repeat the completed sheet reset. |
| T17 | P2, operational | Recheck Tiamat's intended add-on state, stored data and wanted packages before activation/retirement. Asurai's reset authorization does not apply to Tiamat. |

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

### Completed fix batches

- [x] ~~**T34-DM — Shared controls in planner forms and Import Center**~~ — `9dac1bd`.
- [x] ~~**T19-DM — Scoped bundle contributions, DM/player review and durable receipt checks**~~ — `da116c3`.
- [x] ~~**T30 — Recover unsaved planning work across forced replacement**~~ — `0eeac9b`; explicit resume/download/discard, original revisions and uncertain-save protection. [Contract](../../addon-dm-tools/docs/GRAPH.md#recovery-across-generations) · [installed evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#dm-tools-draft-recovery-follow-up).

### Remaining work

- [ ] **T18-DM / P1, review — Audit complete planning sessions, including UX.**
  Exercise large/nested plans, card/flow creation, ownership moves, target
  selection, multi-anchor notes, deletion/undo, reader/editor transitions and
  refresh while editing. Compare preserved behavior with current interaction at
  desktop/phone and keyboard/touch. Record concrete failing steps and fixes;
  passing graph fixtures alone do not close workflow parity. Investigate the
  intermittent pre-action canvas-load timeout in the installed group-selection
  case; it passed subsequent package acceptance, but no cause/fix is established
  ([T42 evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#phb-origin-choices-and-shared-field-focus)).
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

### Completed fix batches

- [x] ~~**T34-COMP — Shared search, filters and browsing feedback**~~ — `e8cc635`.
- [x] ~~**T38-COMP — Restore structured class Expertise grants**~~ — `8cb7e43`; [source audit and installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#class-expertise-grants-and-dependent-choice-repair).
- [x] ~~**T39-COMP — Repair PHB skill feats and Rogue language grants**~~ — `46e78a2`; [source facts and installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#phb-skill-feats-and-rogue-languages).
- [x] ~~**T41-COMP — Structure Skilled choices and later Origin-feat eligibility**~~ — `8e1e9d7`; [sources and installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#repeatable-skilled-choices-and-acquisition-ownership).
- [x] ~~**T42-COMP — Finish PHB origin skill, feat and tool choices**~~ — `87c1402`; Human, Musician/Crafter and five backgrounds; [sources and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#phb-origin-choices-and-shared-field-focus).
- [x] ~~**T50-COMP — Declare distinct Elemental Adept damage choices**~~ — `014ed02`; [source facts and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#conditional-feat-choices-and-repetition-limits).
- [x] ~~**T51-COMP — Declare Magic Initiate spell lists and origin presets**~~ — `736f95a`; [source facts and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#acquisition-owned-spell-grants-and-complete-combat-details).
- [x] ~~**T52-COMP — Declare source-specific attunement prerequisites**~~ — `00495d3`; 21 existing items, class/trait distinctions and explicit narrative adjudication; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-progression-and-source-specific-attunement).

### Remaining work

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
  links with representative long content. Review selectable species sizes
  (Human still declares fixed Medium despite its Small/Medium source choice) and
  remaining advancement feat categories, including Fighting Style and level-19
  alternatives. Test English/Czech, missing/disabled books, empty results, Retry
  and generation
  replacement. Separate missing data, misleading presentation and unsupported
  mechanics in the resulting findings.
- [ ] **T14-COMP / P2 — Move generated browser output to build ownership.**
  Update independent build/package/tests and host fixtures before removing tracked
  `web/`. Normalize ZIP timestamps and verify repeated builds from unchanged inputs
  produce the same archive hash; [publication verification](rewrite/HOST_CLEANUP_ACCEPTANCE.md#coordinated-publication-verification)
  reproduced metadata-only hash changes. Preserve content identity, checksums and
  standalone browsing.

**C10, consumer-triggered:** [structured coverage gaps](../../addon-dnd-2024-compendium/data/GAPS.md)
remain in narrative effects and reference-only renown/facilities/Circle Magic.
For a concrete needed mechanic, add source fields, schema/provenance checks and
Engine/Sheets consumption together. Do not count reference prose as automation
or import whole adventures/gazetteers merely to close a checklist.

## addon-dnd-engine

Owns deterministic calculation and validation, not UI or character persistence.
Consumes optional `dnd5e.rules-data` v3 and provides `dnd5e.rules-engine` v4.
[Service contract](../../addon-dnd-engine/contract/README.md).

### Completed fix batches

- [x] ~~**T32-PERF — Bound evaluation catalog work and fix the level-20 timeout**~~ — `f5f5ba3`.
- [x] ~~**T32-FEATS — Validate acquired feat prerequisites and eligible builder options**~~ — `3f9c8e9`; [regression and package evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#deployment-gate-repair-and-engine-follow-up).
- [x] ~~**T32-EQUIPMENT — Reject empty equipment and inactive grants; explain save blockers**~~ — `dfd970b`; [Engine/Sheets acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#progressive-save-and-equipment-follow-up).
- [x] ~~**T32-GUIDANCE — Count required choices and expose invalid advancements for repair**~~ — `dd51374`; [Builder acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#progressive-builder-repair-and-navigation).
- [x] ~~**T32-EXPERTISE — Validate acquisition, distinct skills and dependent slot repair**~~ — `41e26c1`; [Engine and installed evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#class-expertise-grants-and-dependent-choice-repair).
- [x] ~~**T32-REPEATABLE — Keep declared feat choices independent by acquisition**~~ — `e5f1027`; prerequisite checks, legacy assignment and faster option evaluation; [contract and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#repeatable-skilled-choices-and-acquisition-ownership).
- [x] ~~**T32-ORIGINS — Share eligibility across origin skill and tool choices**~~ — `1faa785`; ordered training, distinct picks and dependent repair; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#phb-origin-choices-and-shared-field-focus).
- [x] ~~**T32-EQUIPMENT-SLOTS — Share slot facts and correct attunement eligibility**~~ — `2d1101e`; capacity, prerequisites and custom grants; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#equipment-preservation-and-attunement-eligibility).
- [x] ~~**T32-CONDITIONAL — Enforce distinct finite feat choices per acquisition**~~ — `a5ffae9`; capacity, repair, source changes and DM withdrawal; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#conditional-feat-choices-and-repetition-limits).
- [x] ~~**T32-SPELLS — Preserve acquisition-owned spells/resources and correct multiclass skills**~~ — `9f90e4b`; casts, rests, replacement and saved aliases; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#acquisition-owned-spell-grants-and-complete-combat-details).
- [x] ~~**T32 — Complete progressive-build and equipment validation acceptance**~~ — `a3c5d0a`; deeper multiclass progressions, source-owned attunement and preserved inputs; prior feat, spell, resource and equipment regressions retained; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-progression-and-source-specific-attunement).
- [x] ~~**T53-ENGINE — Preserve acquired state during grant reauthorization**~~ — `c5a9be7`; detached identity remapping, unchanged spent uses and rejected collisions; [session acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#character-session-transfer-and-saved-output).

### Remaining work

- [ ] **T18-ENGINE / P1, review — Close rules/provider evidence gaps.**
  Combine complex progression and DM effects with missing, changed or incompatible
  providers, sourcebook removal and stale generations. Preserve authored play
  through recalculation and separate narrative adjudication (C10) from bugs.
  T53 accepts representative session/transfer preservation; retain pure, service
  and exact-package evidence without claiming exhaustive rules correctness.
  Investigate the one unexplained rules-availability loss during T53 validation;
  character setup now captures provider diagnostics if it recurs.
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

### Completed fix batches

- [x] ~~**T34-SHEETS — Shared fields, choices, states, tabs and modal focus**~~ — `99edd12`.
- [x] ~~**T33-SAVE — Preserve rejected edits, retry uncertain autosaves and guard discard**~~ — `8b3bb30`; host regressions `10ddc3c`. Includes queued corrections/choice withdrawals, concurrent edits and enlarged-text phone recovery; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#progressive-save-and-equipment-follow-up).
- [x] ~~**T33-BUILDER — Preserve valid slots and guide unfinished choices on phones**~~ — `dff6c0b`; [Builder acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#progressive-builder-repair-and-navigation).
- [x] ~~**T33-REPEATABLE — Render independent choices and repair withdrawn DM grants**~~ — `e066de3`; explicit historical assignment and usable enlarged-text ability fields; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#repeatable-skilled-choices-and-acquisition-ownership).
- [x] ~~**T33-FOCUS — Keep autosave focus on the owning Builder choice**~~ — `f184eda`; stable keys for borrowed UI controls; [English/Czech acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#phb-origin-choices-and-shared-field-focus).
- [x] ~~**T33-EQUIPMENT — Preserve stored spares and explain accessible equipment choices**~~ — `b015083`; shared transitions, saved slots, keyboard focus and enlarged layouts; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#equipment-preservation-and-attunement-eligibility).
- [x] ~~**T33-COMMANDS — Recover uncertain play/grant and reviewed-import commands safely**~~ — `6325243`; exact retries, guarded recovery and stale-read protection; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#character-command-recovery-and-uncertain-outcomes).
- [x] ~~**T33-ADOPTION — Adopt changed rules with pending edits and restore editing**~~ — `a8ff7ce`; explicit recovery, exact retries, conflict protection and readable phone actions; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#explicit-rules-adoption-with-pending-character-edits).
- [x] ~~**T33-LIFECYCLE — Keep pending inputs and exact retries through rules/provider changes**~~ — `89f8666`; fresh services, original merge bases, guarded recovery and expired-review handling; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#pending-character-edits-across-graph-replacement).
- [x] ~~**T33 — Finish automatic saving and progressive-builder usability**~~ — `fce458b`, `4696ae7`; localized save explanations, correctable HP and provider-free feedback; prior save/command/lifecycle regressions retained; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#localized-save-feedback-and-correctable-hp).
- [x] ~~**T50-SHEETS — Explain conditional feat limits in both locales**~~ — `eab091d`; existing shared controls and feedback; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#conditional-feat-choices-and-repetition-limits).
- [x] ~~**T25 — Restore Combat details and shared spell filters**~~ — `23d63d7`; saved-state repair, both layouts/locales, phone and provider-free print; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#acquisition-owned-spell-grants-and-complete-combat-details).
- [x] ~~**T52-SHEETS — Keep keyboard focus within repaired inventory items**~~ — `28bc2ea`; shared focus fallback after actions become disabled, both layouts/locales and enlarged phones; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-progression-and-source-specific-attunement).
- [x] ~~**T53-SHEETS — Preserve reviewed transfers and complete saved print output**~~ — `3931526`; grant-owned choices/resources, visible import errors/focus and printed currency/identity; [session acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#character-session-transfer-and-saved-output).

### Remaining work

- [ ] **T18-SHEETS / P1, review — Accept a whole build-and-play session.**
  Complete blank-to-ready UI creation followed by complex play, preparation,
  amended grants and provider/schema transitions. Cover sparse/complex characters,
  both roles/layouts, English/Czech and enlarged phone/keyboard use. Retain
  worker-only extension and archive-preservation gates. T53 accepts the seeded
  session, transfer and frozen output; human screen-reader, physical touch and
  printer checks remain separate from browser/PDF evidence.
- [ ] **T14-SHEETS / P2 — Remove generated browser/worker output from source ownership.**
  Migrate schema/type generation, package/test and host fixture consumers first;
  preserve deterministic standalone packaging and host inspection with T14-HOST.

## Delivery order and completion

| Order | Work | Exit evidence |
| --- | --- | --- |
| 1 | Whole character sessions: execute Engine and Sheets T18 using the completed T32/T33 workflows. | Representative builds and play preserve authored values through provider changes; package evidence and remaining human/device checks are explicit. |
| 2 | Everyday use: Compendium T31; execute DM Tools and Compendium T18 reviews and fix their concrete failures. | Representative complete workflows on desktop/phone, with original interaction comparisons and explicit remaining manual checks. |
| 3 | Remaining add-on artifact ownership: per-repo T14. T08 only for a real schema-preservation need. | Standalone builds and inspected ZIPs preserve current consumer contracts; any needed migration is reviewed and atomic. |
| 4 | Final integration after remaining add-on T18 fixes; retain completed T02 coverage. | All four inspected ZIPs pass without installed-suite skips on the publication path; exact host/sibling commits and package hashes recorded. |
| 5 | Authorized delivery T15–T17 and representative device/site acceptance. | Exact served/installed builds verified; per-site data/retention choices recorded and rollback assets retained. |

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
