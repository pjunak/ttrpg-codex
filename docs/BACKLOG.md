# Project backlog

Work for the five repositories, reviewed September 25, 2026. This remains
one suite backlog; each task belongs to the repository that owns its change.
Completed fix batches stay in compact checked, struck-through lists with commit
references; their detailed findings and the unchanged accepted release gates live in the
[feature-parity audit](rewrite/FEATURE_PARITY_AUDIT.md).

**Progress estimate, September 24:** about **90% implemented**, or **80–85%**
including release and complete workflow acceptance.
[Estimate and counting method](rewrite/HOST_CLEANUP_ACCEPTANCE.md#cleanup-progress-update-september-24).
**Rows closed, September 24:** 26 of the original 40; large open tasks contain
completed slices.
These dated estimates predate the additional T63 character-sheet design below;
they do not measure implementation or acceptance of that new scope.

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
- [x] ~~**T56-HOST — Accept incompatible packages and enable sticky add-on route controls**~~ — shared route clipping, denied schema replacement and portable saved-state preservation; [installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#incompatible-providers-schema-preservation-and-reachable-libraries).
- [x] ~~**T57-HOST — Delay hover previews and restore keyboard reopening**~~ — shared cancellable hover intent and scoped focus restoration; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compendium-source-policy-and-readable-class-tables).
- [x] ~~**T58-HOST — Accept species choices, saved size and provider-free output**~~ — five installed cases, exact source pins and response-synchronized recovery; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-defined-species-sizes-and-saved-character-display).
- [x] ~~**T59-HOST — Accept qualifying advancements and saved feat output**~~ — five installed cases and frozen-output coverage; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#legal-advancement-feats-and-saved-feat-details).
- [x] ~~**T60-HOST — Accept class styles and correct the settings readiness test**~~ — six installed cases, saved outputs and delayed-startup draft guards (`7cf4b9b`); [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#class-granted-styles-and-conditional-cantrips).
- [x] ~~**T61-HOST — Accept passive feats through installed shared views**~~ — `5dccbcf`; exact pins, 208/208 cases and bounded startup diagnostics; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#passive-feat-bonuses-and-automatic-armor-conditions).
- [x] ~~**T62-HOST — Accept saved training through multiclass and provider changes**~~ — `df8d453`; exact pins, keyboard details and provider-free print/export; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#readable-saved-proficiencies-and-saving-throw-indicators).
- [x] ~~**T64-HOST — Accept whole multiclass sessions through source/provider loss**~~ — `2184554`; real casts, recovery, rest, level-up and frozen outputs; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-snapshots-and-provider-session-recovery).
- [x] ~~**T02 (including T02-LOCAL) — Publish and accept all four companion revisions with zero skips**~~ — host `5cc4945`; [104/104 Linux cases, exact sources and ZIP hashes](rewrite/HOST_CLEANUP_ACCEPTANCE.md#coordinated-publication-verification).
- [x] ~~**T15-DELIVERY — Publish the tested host and deploy both sites**~~ — `5cc4945`; [Asurai/Tiamat rollout and health checks](rewrite/HOST_CLEANUP_ACCEPTANCE.md#coordinated-publication-verification).

Contracts and regression evidence: [editor and browsing workflows](rewrite/EDITOR_BROWSING.md),
[GitHub package updates](rewrite/PACKAGE_LIFECYCLE.md#github-package-sources),
[backup recovery](rewrite/BACKUP_RESTORE.md#deliberate-boundary),
[reviewed disabling](rewrite/PACKAGE_LIFECYCLE.md#reload-and-disable),
[worker recovery](rewrite/WORKER_SUPERVISION.md#restart-policy),
and [parity audit](rewrite/FEATURE_PARITY_AUDIT.md#confirmed-findings).

### Validation follow-up

- [ ] **T63-HOST / P2 — Accept the agreed character-sheet workspace through installed packages.**
  Own the shared-control integration and installed acceptance for
  [T63](#t63-character-sheet-design). Extend the existing character fixtures with
  the new Equipment tab, shared frame, hand transitions and saved play fields.
  Record exact companion pins and package hashes; expand the host UI contract
  only if a required interaction cannot use `ui.controls.v1`.
- [ ] **T57-VERIFY / P2 — Explain intermittent startup timeouts.**
  T57 timed out before the timeline mounted; T60 hit one phone-settings timeout;
  T61 timed out fetching rules policy during installed-fixture setup.
  Subsequent runs passed; no shared cause is established. Retain bounded
  timeline/settings page captures and character-fixture host diagnostics.
  Preserve deadlines and assertions; [T61 evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#passive-feat-bonuses-and-automatic-armor-conditions).

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
- [x] ~~**T31 — Keep library navigation reachable on phones**~~ — `f875133`; preserved reader, working disclosures, focus and readable enlarged titles/counts; [English/Czech acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#incompatible-providers-schema-preservation-and-reachable-libraries).
- [x] ~~**T57-COMP — Repair class tables and finish source-policy browsing acceptance**~~ — `8d46929`, `d189995`, `0c3e5d7`; 24 preserved source tables, readable enlarged cells and enabled-book/reprint navigation; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compendium-source-policy-and-readable-class-tables).
- [x] ~~**T58-COMP — Declare selectable sizes for fourteen species**~~ — `173ac31`; source choices, corrected PHB summaries and preserved book/reprint identity; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-defined-species-sizes-and-saved-character-display).
- [x] ~~**T59-COMP — Restore qualifying advancement categories and PHB feat declarations**~~ — `7d44bd8`; ten Fighting Styles, twelve Epic Boons and preserved source identities; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#legal-advancement-feats-and-saved-feat-details).
- [x] ~~**T60-COMP — Declare class styles and conditional cantrip alternatives**~~ — `0b351ba`; four source-owned features, unchanged IDs/prose and class/list/ability facts; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#class-granted-styles-and-conditional-cantrips).
- [x] ~~**T61-COMP — Restore five passive Fighting Style/Epic Boon grants**~~ — `87f79ad`; preserved IDs, prose and book structure; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#passive-feat-bonuses-and-automatic-armor-conditions).

### Remaining work

- [ ] **T63-COMP / P2 — Supply source facts needed by the agreed equipment UI.**
  Audit existing item declarations for [T63](#t63-character-sheet-design).
  Add only missing source-owned placement, hand/grip or filtering facts with
  schema/provenance checks and Engine consumption. Preserve item IDs, books,
  custom-item authority and standalone browsing. A visual body field does not
  establish an edition rule, slot limit or armor bonus.
- [ ] **T18-COMP / P1, review — Complete bounded class-level replacements.**
  Add bounded level-up replacement for Fighter's style and Blessed/Druidic
  Warrior cantrips. First define a durable acquisition/class-level allowance
  with Engine/Sheets; the existing spell-swap ledger cannot represent these
  choices. Coordinate typed state with T63 and reviewed T08 migration if the
  released schema changes. Preserve spent allowances through save/import and
  provider transitions. Encounter resolution remains C10.
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
- [x] ~~**T58-ENGINE — Evaluate species size and prevent redundant spell evidence growth**~~ — `04a1973`, `50eebb2`; generic choices, explicit repair, saved explanations and a multiclass snapshot fix; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-defined-species-sizes-and-saved-character-display).
- [x] ~~**T59-ENGINE — Align acquired prerequisites and repair withdrawn feat increases**~~ — `a3ba0df`; canonical subclass features, matching picker/validation and saved feat counts; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#legal-advancement-feats-and-saved-feat-details).
- [x] ~~**T60-ENGINE — Resolve conditional class choices and preserve spell ownership**~~ — `ceaa19a`; shared package resolution, dependency order and source-scoped withdrawal; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#class-granted-styles-and-conditional-cantrips).
- [x] ~~**T61-ENGINE — Calculate passive HP, Speed and armor-conditioned AC**~~ — `eb2f2f0`; generic grants, exact armor references and saved explanations; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#passive-feat-bonuses-and-automatic-armor-conditions).
- [x] ~~**T64-ENGINE — Stop repeated references from blocking multiclass saves**~~ — `093472f`; scoped calculation references with full saved evidence retained; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-snapshots-and-provider-session-recovery).

### Remaining work

- [ ] **T63-ENGINE / P2 — Define and evaluate the new equipment and play state.**
  Establish the [T63](#t63-character-sheet-design) data/eligibility contract before
  Sheets persists new fields: worn placement, held items and grip, suspended
  off-hand effects, containers, quick-use references, Inspiration and conditions
  as needed after auditing existing representations. Return saved explanations
  and option guidance; preserve input identity and authored state. Coordinate
  schema/service compatibility with the Sheets worker; do not implement these
  mechanics as browser arithmetic or broaden this into a combat resolver.
- [ ] **T18-ENGINE / P1, review — Close rules/provider evidence gaps.**
  T64 completes the representative Fighter/Warlock/Wizard session through
  sourcebook removal, incompatible responses/majors, stale handles and restoration,
  retaining DM effects and authored play. Repeat final session acceptance on the
  implemented T63 state/workspace. Keep pure, service and exact-package evidence;
  narrative adjudication remains C10, not a claim of exhaustive correctness.
  Investigate the one unexplained rules-availability loss during T53 validation;
  character setup captures provider diagnostics if it recurs. T54's 13-case
  diagnostic replay passed without reproducing it; no cause is established.
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
- [x] ~~**T54-SHEETS — Complete UI creation and preserve spell selection context**~~ — `29838b2`, `93396af`; shared picker focus/filters, readable enlarged ability cards and Fighter/Wizard creation-to-play; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#blank-to-ready-creation-and-stable-spell-selection).
- [x] ~~**T55-SHEETS — Preserve amended grants and usable effect editing**~~ — `b9319d3`; detached saved state, stable grant/item ownership, shared searches and keyboard/phone editing through provider restart and source adoption; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#dm-grant-amendments-and-provider-transitions).
- [x] ~~**T56-SHEETS — Keep saved characters readable through incompatible providers**~~ — `d489533`; authoritative edit rejection, frozen outputs, original-provider restoration and schema/backup preservation; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#incompatible-providers-schema-preservation-and-reachable-libraries).
- [x] ~~**T58-SHEETS — Reuse shared size controls and keep enlarged stat grids readable**~~ — `dd435a8`; localized saved/printed sizes, both layouts and provider-free output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-defined-species-sizes-and-saved-character-display).
- [x] ~~**T59-SHEETS — Show saved feats in Combat and print**~~ — `0626c3e`; one shared renderer, repeated counts, both locales/layouts and provider-free output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#legal-advancement-feats-and-saved-feat-details).
- [x] ~~**T60-SHEETS — Repair shared spell pickers and provider-free rule details**~~ — `28e2281`, `e415b0a`; wrapping/focus and one saved-evidence adapter for readable spell details; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#class-granted-styles-and-conditional-cantrips).
- [x] ~~**T61-SHEETS — Accept passive stats in shared saved-data UI**~~ — host fixture `5dccbcf`; existing controls, both locales/layouts and exact provider-free outputs; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#passive-feat-bonuses-and-automatic-armor-conditions).
- [x] ~~**T62-SHEETS — Present readable saved proficiencies and active save markers**~~ — `951d7ef`; one Combat/print renderer, localized training groups and accessible indicators; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#readable-saved-proficiencies-and-saving-throw-indicators).
- [x] ~~**T64-SHEETS — Acknowledge large saves and bound complete import reviews**~~ — `424a0d0`, `e37549b`; bounded complete comparisons, localized review labels and exact retries; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-snapshots-and-provider-session-recovery).

### Remaining work

- [ ] **T63-SHEETS / P2 — Implement the agreed Sheet, Combat, Equipment and Builder design.**
  Follow the [implementation sequence and acceptance criteria](#t63-character-sheet-design)
  below. The mockups are design references, not shipped behavior or production
  code. Preserve completed T32/T33/T34/T53–T62 behavior while replacing the
  remaining layout and workflow differences.
- [ ] **T18-SHEETS / P1, review — Accept a whole build-and-play session.**
  T64 completes the existing workspace's representative multiclass play,
  amended grants, source/provider loss, restoration, rest, advancement and frozen
  output. Run the final session against the implemented T63 workspace; earlier
  passes do not accept that new design. Human screen-reader, physical touch and
  printer checks remain separate from browser/PDF evidence.
- [ ] **T14-SHEETS / P2 — Remove generated browser/worker output from source ownership.**
  Migrate schema/type generation, package/test and host fixture consumers first;
  preserve deterministic standalone packaging and host inspection with T14-HOST.

<a id="t63-character-sheet-design"></a>

### T63 — Agreed character-sheet design and implementation sequence

Added September 25, 2026 from the September 14–25 mockup review. The final visual
reference is `equipment-body-slots.html` in local visualization task
`01a0a087-6e2a-78a3-9928-435fdea0e377`; it includes all character tabs. The
requirements below are self-contained so implementation does not depend on that
local file. Use its layout and interactions, not its sample character values,
hard-coded rules, local widget persistence, duplicate hidden sizing DOM or
standalone application chrome. Reuse the host controls and add-on lifetime.

This is planned work, not a replacement description of current behavior.
The current [workflow reference](rewrite/CHARACTER_BUILD_HISTORY.md) and
[Sheets README](../../addon-dnd-character-sheets/README.md) still describe a
1,120 px frame, a Levels tab and inventory/currency in the existing workspace.
Current Engine slot guidance is `armor`/`shield`/`worn`; current saved Play/Item
types do not provide all the distinct presentation and active-hand state in the
mockups. Implement and validate those differences before updating current-state
documentation or marking T63 complete.

#### Preserve the completed baseline

- Builder remains the ordered progression of the character, editable as a
  campaign advances and retroactively. Do not restore character change logs,
  history services/storage, snapshots, undo/restore UI, device drafts, manual
  Save/Apply buttons or an edit-mode toggle. Ordered levels and acquired choices
  are character facts, not a log. Keep current-state concurrency and exact retry
  identifiers, authenticated DM commands and reviewed replacement imports.
- Valid changes, including an incomplete but legal build, save automatically.
  Offer only eligible values with immediate bounds/budgets, but retain worker
  and Engine validation, conflict/retry handling and honest save status.
  Network, permission and changed-rule failures are still possible; do not
  discard pending input or claim it saved. Preserve provider-free saved reading,
  explanations, print/export and the existing rules-adoption boundary.
- Use `ui.controls.v1`, shared skin tokens, native semantic controls and stable
  focus keys. Searchable comboboxes combine typing with browsing; option details
  work on hover and keyboard/touch without blocking selection. Do not repeat
  selected values beneath fields solely as decorative text.

#### Target layout and behavior

| Area | Required result |
| --- | --- |
| Navigation and identity | Vertical left tabs: Sheet, Combat, Equipment, Spells, then Builder immediately above Tools at the bottom. Use the host-owned character identity once; no repeated character-sheet headings or nested application frame. Character Notes remain in the profile; preserve item notes in inventory. Tools alone owns export, plus existing print/import, layout and rules recovery. |
| Width, density and frame | Start from the mockup's approximately 1,360 px desktop maximum instead of 1,120 px, bounded by the available host article width. Keep form widths readable and Compact denser. At a given width, text scale and density, tab changes retain the same outer width/height and navigation position. Fit the tallest content and recompute when content, class details or density change; do not clip or introduce fixed-height tab scrollers. Allow normal document flow on small screens; preserve enlarged text and touch controls rather than squeezing to a desktop height. |
| Shared top cards | Sheet and Combat use the same HP, AC, Speed, Proficiency and Inspiration row with identical card positions and dimensions. Narrow Speed/Proficiency to make room for Inspiration. In Sheet this row stays left of the right-hand attributes, aligned with their top; it must not push the attributes down. Inspiration is editable authored state shared by both tabs, not a mockup-only toggle. |
| HP and explanations | Current HP is directly rewritable within Engine bounds; no damage-instance workflow is required. Use a shorter, thicker health bar whose color changes with HP percentage while keeping numeric health readable. Max-HP hover/click details include the calculation and hit dice by class. Clicking any displayed modifier opens a calculation card from saved Engine explanations, with keyboard/touch equivalents. Preserve temporary HP, rest/resource behavior and the existing max-HP change policy. |
| Sheet | Keep the ability/skill column on the right, including scores, modifiers and shield saving-throw indicators. Include Initiative with Dexterity, passive Perception with Wisdom, and spell DC/attack with the applicable casting ability when present; preserve distinct casting sources when they differ. The left side contains hands, quick-use items, resources and useful exploration information. Main inventory and all currency move to Equipment. Do not show weapon hit/damage values in Sheet's hand fields. |
| Combat | Keep conditions visible and editable near the top. Show a compact six-ability row containing only modifier bonuses and saving-throw bonuses; remove absolute ability scores and the word Save, using the same accessible shield/training markers as Sheet. Also show Initiative, passive Perception and conditional spell DC/attack beside the top values. Keep hand attacks/damage, quick use and resources. Preserve already accepted feat, proficiency, spell and saved-detail access; this layout change must not retire them. |
| Builder | Character, one tab per selected class, + Class, existing spell choices and a separate DM given tab. Remove the standalone Levels tab. Add/remove levels inside their class; reaching zero removes that tab. Preserve global level order and acquisition ownership when editing multiclass levels. Remap progress/repair links formerly targeting Levels to the owning class/choice, including empty-class and removed-class focus fallback. Progress starts expanded on the left and reflows on narrow screens. |
| Builder choices | Point buy updates used/remaining cost during distribution, with up/down controls and Engine-provided minima/maxima. Apply the same bounded controls to other numeric choices. Granted selections enforce count, duplicates, prerequisites and source eligibility; + Class offers only eligible classes. Preserve dependent-choice repair, per-class spell ownership, focus and existing search/filter state through autosave. |

#### Equipment, storage and hands

- Equipment has a taller plain-body mannequin with ten clickable fields, five
  on each side. The final layout is left: **Head, Body, Wrists, Legs, Feet**;
  right: **Face, Neck, Shoulders, Waist, Gloves**. Neck stays above Shoulders.
  Legs supports compatible trousers/greaves; Face supports compatible
  goggles/masks. Keep these fields distinct from engine-enforced mechanical
  exclusivity. Compatibility and bonuses come from source/Engine facts, not a
  hard-coded humanoid slot rule or the mockup's sample items. Class-specific
  silhouette artwork is not required for this iteration.
- **Other worn** is a dynamic list with **+ Add item**, covering rings and other
  accessories outside the dedicated fields. No fixed ten-ring grid or arbitrary
  empty spaces. Equipped items retain stable inventory instance IDs and can be
  returned to storage without duplication or loss of quantities, grants or notes.
- **Storage** provides general backpack/pouch organization, without mandatory
  top straps, side straps, map-case geometry or the reference image's homebrew
  capacity/Strength rules. Opening Backpack shows a structured floating dialog
  with search, compartment filtering and category/name/quantity sorting. It may
  exceed the sheet's width, but must fit the viewport; scroll only where a long
  dialog/list actually needs it, not inside every character tab.
- Storage and the open Backpack both expose **+ Add item**, invoking the same
  searchable/browsable picker with source-backed filters (including type/magic),
  quantity steppers and destination. Preserve parent search, filters, sort,
  focus and the route back to Backpack. Handle an existing stack versus a new
  instance explicitly; adding another copy must not rename or replace the
  equipped instance. Equipment pickers and the catalog agree on new item types.
- Put **CP, SP, EP, GP and PP** in one editable row at the bottom of Equipment.
  Remove currency from Sheet, Combat and the separate Storage coin-purse block.
  Tab/content changes keep that row at the bottom without overlap. Currency
  stays authored state, and existing print/export includes all denominations.
- **Attuned items** offers only eligible, currently equipped inventory instances;
  available capacity and prerequisites remain Engine-owned, not a fixed demo
  count. This new selection filter must not silently rewrite existing
  attunements: the current contract permits carried/stored attuned items and
  ordinary unequip does not unattune. Show/count preserved allocations and give
  explicit repair or **Stow & unattune** actions where appropriate. Quantity-zero
  cleanup retains its atomic behavior. Record any required contract change
  before implementation; do not hide unresolved saved allocations.
- Main/off hand belong only in Sheet and Combat. Use one joined two-hand area
  with a central, clearly labelled grip switch and fitting hand/link icon.
  Allow a compatible main-hand weapon to use both hands even with an occupied
  off hand: keep that exact off-hand item visible but gray/inactive, temporarily
  unequip it, and exclude its attacks, AC and other active equipment effects.
  Turning two-handing off restores the same item when still available/eligible.
  Do not silently clear attunement allocation, delete inventory or recreate a
  missing item. If it was consumed, removed, moved by another editor or made
  ineligible, leave the hand free and explain why it was not restored.
- Derive grip options, versatile/required-two-hand damage, shields, capacity
  and active effects through the Engine. Persist the main/off-hand references,
  chosen grip and suspended-item identity through autosave/reload/transfer.
  Sheet omits hit/damage numbers; Combat and explanation cards update together.
  Quick-use pins reference owned instances, share quantities with Storage and
  preserve consumed/spent state. Conditions are authored play state with bounded
  supported effects; T63 does not authorize an encounter/combat-resolution engine.

#### Ordered implementation and exit checks

| Step | Owners and work | Required evidence before closing the step |
| --- | --- | --- |
| 1. Model and contracts | T63-ENGINE with the Sheets worker, and T63-COMP for missing source facts. Audit existing representations before adding closed fields for body placement, containers, hand/grip/suspension, quick-use references, Inspiration and conditions. Separate display organization from mechanical rules. | Agreed serializable inputs, eligibility, saved projections/explanations and worker commands; stable instance identity, atomic transitions and exact retries. Regenerate owning schemas/types. Demonstrate current-character preservation and version compatibility; use T08 only if an actual released-schema migration is required, never another sheet reset or ad hoc startup converter. |
| 2. Frame and Builder | T63-SHEETS; extend shared host controls only for a demonstrated gap. Implement navigation, sizing/density, remove Levels and remap its repair/navigation targets. | Tab and class controls work with keyboard/touch, both locales and enlarged text. Earlier progression remains editable, class-zero removal picks a valid destination, and invalid options cannot be selected. Existing incomplete-build autosave, conflicts and DM authorization regressions pass. |
| 3. Equipment and storage | T63-SHEETS consumes step 1 for mannequin/Other worn, shared item addition, Backpack dialog, bottom currency and equipped-only attunement selection. | Add, equip, replace, stow, unattune, consume and remove flows preserve identity and authored fields. New Face/Legs items are correctly filtered; no arbitrary ring/body limits or invented item bonuses. Search/sort/compartment and focus survive additions, cancellation, retries and tab changes. |
| 4. Sheet and Combat | T63-SHEETS/ENGINE implement shared cards, explanations, attribute arrangements, conditions, Inspiration, hands and quick use. | Both tabs show identical shared-card geometry and authored values. Demonstrate occupied-shield two-handing, gray suspended off hand, changed AC/damage and exact restoration; also missing/ineligible off-hand cases and duplicate item copies. Verify current/max HP, hit-dice details, differing spellcasting sources and resource/consumable preservation. |
| 5. Installed acceptance | T63-HOST with all affected producer/consumer gates, then T18-ENGINE/T18-SHEETS session acceptance. Update current workflow/README/edge-case contracts only as behavior lands. | Record exact commits, inspected ZIPs, schema/service compatibility and screenshots at desktop 1,360/1,024 px and narrow 390/320 px, Compact/Classic, English/Czech, both skins and 200% text as applicable. Tab height and shared card positions remain stable; long/dynamic content, expanded class details and larger inventories neither clip nor create unnecessary inner scrollbars. Preserve keyboard/dialog focus, screen-reader labels and touch targets. |

Every state-changing slice must cover reload, disjoint/conflicting edits,
lost replies/exact retry, session expiry, source adoption and provider/generation
loss/restoration as applicable, using the actual worker/package path. Validate
saved provider-free display, printing and replacement export/import of new
fields, including suspended hands and currency. Do not substitute mockup
interaction tests, screenshots or a generic technical check for installed
workflow acceptance. Keep the existing validation gates and record outstanding
human screen-reader, physical-device and printer checks separately.

## Delivery order and completion

| Order | Work | Exit evidence |
| --- | --- | --- |
| 1 | Implement the agreed T63 character-sheet design in its ordered producer/consumer slices. | New data and equipment semantics, final layout and shared controls pass their owning gates and exact-package acceptance; completed T32/T33 workflows remain intact. |
| 2 | Whole character sessions: finish Engine and Sheets T18 on the T63 workspace. | Representative builds and play preserve authored values through provider changes; package evidence and remaining human/device checks are explicit. |
| 3 | Everyday use: execute remaining DM Tools and Compendium T18 reviews and fix their concrete failures. | Representative complete workflows on desktop/phone, with original interaction comparisons and explicit remaining manual checks. |
| 4 | Remaining add-on artifact ownership: per-repo T14. T08 only for a real schema-preservation need. | Standalone builds and inspected ZIPs preserve current consumer contracts; any needed migration is reviewed and atomic. |
| 5 | Final integration after T63 and remaining add-on T18 fixes; retain completed T02 coverage. | All four inspected ZIPs pass without installed-suite skips on the publication path; exact host/sibling commits and package hashes recorded. |
| 6 | Authorized delivery T15–T17 and representative device/site acceptance. | Exact served/installed builds verified; per-site data/retention choices recorded and rollback assets retained. |

T14 suffixes divide the existing generated-artifact task by repository; T18
suffixes divide workflow acceptance; T63 suffixes share the design and ordered
acceptance above without duplicating its requirements. Cross-repository changes
need producer and consumer checks and separate compatible commits. A task closes only after its
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
