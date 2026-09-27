# Project backlog

Work for the five repositories, reviewed September 27, 2026. This remains
one suite backlog; each task belongs to the repository that owns its change.
Completed fix batches stay in compact checked, struck-through lists with commit
references; their detailed findings and the unchanged accepted release gates live in the
[feature-parity audit](rewrite/FEATURE_PARITY_AUDIT.md).

**Progress estimate, September 27:** about **95% implemented**, or **90%**
including remaining workflow, release and site acceptance. These are approximate
effort estimates, with plausible ranges of 90–95% and 85–90%, respectively.
[Estimate and counting method](rewrite/HOST_CLEANUP_ACCEPTANCE.md#cleanup-progress-update-september-27).
**Original rows closed:** 31 of 40 (78%); open workflow tasks contain completed
slices. The later T63 layout and authored state are implemented; smaller UI
refinements and complete session acceptance remain separately visible below.

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
- [x] ~~**T63-ATTUNEMENT-HOST — Accept equipped choices and atomic stowing**~~ — six installed workflows, exact package pins and provider-free output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#equipped-only-selection-and-preserved-attunement).
- [x] ~~**T08-COMPATIBLE — Review compatible schema upgrades without rewriting saved values**~~ — `d1ec1eb`, `2ef6846`; atomic plans, recovery receipts, shared Settings UI and unique-index activation checks; [222/222 installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#reviewed-compatible-saved-data-schema-upgrades).
- [x] ~~**T63-INSPIRATION-HOST — Preserve current characters through the reviewed schema upgrade**~~ — exact prior schema, unchanged JSON/revisions, shared controls and recovery paths; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#authored-inspiration-and-character-schema-preservation).
- [x] ~~**T63-QUICK-USE-HOST — Accept owned-item pins and atomic consumption**~~ — shared quantities, exact retries, provider-free output and both prior schemas; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#quick-use-inventory-and-preserved-characters).
- [x] ~~**T63-STORAGE-HOST — Accept container membership and all prior schemas**~~ — exact retries, concurrent repair, transfer and provider-free output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#storage-containers-and-preserved-inventory).
- [x] ~~**T65-HOST — Repair the storage-selector secret-scan false positive**~~ — exact rule/file/value exception and real-scanner regression checks; [diagnosis and validation](rewrite/HOST_CLEANUP_ACCEPTANCE.md#storage-selector-secret-scan-repair).
- [x] ~~**T66-HOST — Repair backup inspection and reconnect refresh**~~ — both confirmed by the next Linux run; [evidence and remaining session-performance diagnosis](rewrite/HOST_CLEANUP_ACCEPTANCE.md#installed-acceptance-limits-and-stream-reconciliation).
- [x] ~~**T66-PERF-HOST — Accept the optimized engine in the full installed suite**~~ — 247/247 local cases; multiclass sessions and provider-free output now confirmed on Linux; [evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-editor-calculation-cost).
- [x] ~~**T67-HOST — Wait for current play guidance after a retry receipt**~~ — `dcac524`; held-response regression and successful Linux build/deployment-verification jobs; [race diagnosis and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#acknowledged-commands-and-browser-readiness).
- [x] ~~**T63-PLACEMENT-HOST — Accept body placement and four prior schemas**~~ — exact source pins, 254/254 installed cases and provider-free output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-backed-body-placement-and-preserved-equipment).
- [x] ~~**T63-HANDS-HOST — Accept hand suspension and five prior schemas**~~ — 257/257 installed cases, exact retries, shared controls and provider-free output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#hands-grip-and-preserved-off-hand-instances).
- [x] ~~**T63-COMPACT-HOST — Accept the compact workspace through installed packages**~~ — 259/259 cases with zero skips, exact companion pins, shared cards, body fields, Backpack dialogs, class navigation and preserved play; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compact-character-sheet-workspace).
- [x] ~~**T63-CONDITIONS-HOST — Accept shared condition controls and six prior schemas**~~ — 264/264 installed cases, zero skips, exact retries, session/provider recovery and saved output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#authored-conditions-and-preserved-character-state).
- [x] ~~**T68-HOST — Keep the selected disabled package and distinguish saved builds**~~ — `18d7b5c`; protect the selected version from newer unactivated uploads; explain inactive builds and show build IDs in cleanup; [evidence and retention boundary](rewrite/HOST_CLEANUP_ACCEPTANCE.md#asurai-saved-packages-and-recovery-retention).
- [x] ~~**T16-RETENTION — Keep selected builds with independent campaign and add-on recovery**~~ — retire obsolete packages and only their add-on recovery context after healthy startup/updates; preserve campaign recovery, current saves and backups; shared EN/CS recovery controls and atomic rollback tests. [Implementation and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#asurai-saved-packages-and-recovery-retention).
- [x] ~~**T69-HOST — Complete updates through one saved-data confirmation and automatic housekeeping**~~ — optional scoped backup, validated healing or explicit reset, automatic restart/rollback, durable retry receipts, server review expiry and package cleanup; [implementation and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#guided-updates-and-automatic-housekeeping).
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
  Compact layout fixtures now cover the Equipment dialog, body fields, shared
  cards and frame, class navigation and preserved play. Accept the complete
  workflow with exact companion pins and inspected package hashes; continue
  [T63 frame refinements](#t63-character-sheet-design) in smaller follow-ups.
- [ ] **T57-VERIFY / P2 — Explain intermittent startup timeouts.**
  T57 timed out before the timeline mounted; T60 hit one phone-settings timeout;
  T61 timed out fetching rules policy during installed-fixture setup.
  Subsequent runs passed; no shared cause is established. Retain bounded
  timeline/settings page captures and character-fixture host diagnostics.
  Preserve deadlines and assertions; [T61 evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#passive-feat-bonuses-and-automatic-armor-conditions).

### Lifecycle, maintenance and operations

Core host cleanup and compatible schema reviews are implemented. Value-changing
migrations need a concrete preservation case; site operations need separate authorization.

| ID | Priority | Remaining work and completion condition |
| --- | --- | --- |
| T08 | P2, partial | Guided healing, explicit current-save reset and automatic update recovery are complete. Remaining: reviewed value-transforming operations when a concrete preservation case requires converting incompatible JSON. Keep exact plans, atomic commits, stale rejection and recovery; no guessed values or startup converter. [Boundary](rewrite/ADDON_DATA.md#remaining-public-surface). |
| T15 | P1, operational | Publish the latest cleanup candidate in pinned companion/host order, then verify both site rollouts, served frontend identity, manager and full backup with the matching maintenance binary; review intended add-on activation per site. T15-DELIVERY records an earlier successful release. [Current delivery boundary](rewrite/HOST_CLEANUP_ACCEPTANCE.md#repeated-compatibility-failures-and-pinned-source-revisions); [runbook](SELF_HOSTING.md#publishing-and-deploying-updates). |
| T16 | P2, operational | After deployment, verify Asurai retains only its selected add-on builds and campaign recovery remains available after obsolete add-on contexts are retired. Implementation is complete; the browser helper failure prevented live inspection/cleanup. Existing ZIP backups stay intact. [Evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#asurai-saved-packages-and-recovery-retention). |
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
- [x] ~~**T14-DM — Build browser assets and workers from source-only checkouts**~~ — `7f1d02b`; standalone packaging, ignored output and source-clean CI; [build and package evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-owned-add-on-builds-and-reproducible-packages).

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
- [x] ~~**T63-PLACEMENT-COMP — Declare source-backed worn-item placements**~~ — `d826a6d`; 99 PHB/DMG records with prior fields preserved; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-backed-body-placement-and-preserved-equipment).
- [x] ~~**T63-CONDITIONS-COMP — Correct and declare published condition facts**~~ — `2809098`; fifteen source-owned definitions, attributed summaries and preserved PHB record identity; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#authored-conditions-and-preserved-character-state).
- [x] ~~**T14-COMP — Build browser output and reproducible ZIPs from source**~~ — `e0d9040`; fixed archive metadata/order, ignored output and unchanged content; [build and package evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-owned-add-on-builds-and-reproducible-packages).

### Remaining work

- [ ] **T63-COMP / P2 — Supply source facts needed by the agreed equipment UI.**
  Initial PHB/DMG placement facts are accepted. Continue the [T63](#t63-character-sheet-design)
  source audit; add only missing placement, hand/grip or filtering facts with
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
- [x] ~~**T63-INSPIRATION-ENGINE — Preserve authored Inspiration through calculation and play**~~ — `c0d2984`; optional DTO, support guidance and saved explanation; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#authored-inspiration-and-character-schema-preservation).
- [x] ~~**T63-QUICK-USE-ENGINE — Validate inventory references and consume exact instances**~~ — `a4763ca`; optional pins, live guidance and preserved depleted state; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#quick-use-inventory-and-preserved-characters).
- [x] ~~**T63-STORAGE-ENGINE — Validate named groups and owned-item membership**~~ — `b15fcb8`; optional DTOs, unchanged mechanics and strict references; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#storage-containers-and-preserved-inventory).
- [x] ~~**T66-ENGINE — Avoid redundant editor progression calculations**~~ — `66b5bfb`; unchanged validation rules, rebuilt workers and about 45% less measured calculation time; [regressions and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-editor-calculation-cost).
- [x] ~~**T63-PLACEMENT-ENGINE — Validate body placement independently of mechanics**~~ — `69e3d05`; source-owned options, saved explanations and schema freshness; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-backed-body-placement-and-preserved-equipment).
- [x] ~~**T63-HANDS-ENGINE — Preserve owned hands, grip and exact suspension**~~ — `495ca51`; source-owned damage/effects, restoration fingerprints and detached validation; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#hands-grip-and-preserved-off-hand-instances).
- [x] ~~**T63-ENGINE — Define authored conditions and their supported effects**~~ — `c62e358`; closed optional inputs, source eligibility, bounded Speed/D20 effects and preserved explanations; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#authored-conditions-and-preserved-character-state).
- [x] ~~**T14-ENGINE — Build native workers as release artifacts**~~ — `0e8747f`; ignored binaries, versioned schemas and reproducible target packages; [build and package evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-owned-add-on-builds-and-reproducible-packages).

### Remaining work

- [ ] **T18-ENGINE / P1, review — Close rules/provider evidence gaps.**
  T64 completes the representative Fighter/Warlock/Wizard session through
  sourcebook removal, incompatible responses/majors, stale handles and restoration,
  retaining DM effects and authored play. Repeat final session acceptance on the
  implemented T63 state/workspace. Keep pure, service and exact-package evidence;
  narrative adjudication remains C10, not a claim of exhaustive correctness.
  Investigate the one unexplained rules-availability loss during T53 validation;
  character setup captures provider diagnostics if it recurs. T54's 13-case
  diagnostic replay passed without reproducing it; no cause is established.

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
- [x] ~~**T63-ATTUNEMENT — Preserve allocations and add explicit Stow & unattune**~~ — `d85bc8a`, `6a0a75c`; equipped-only selection, repair explanations, atomic autosave and keyboard focus; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#equipped-only-selection-and-preserved-attunement).
- [x] ~~**T63-INSPIRATION-SHEETS — Autosave shared Inspiration and retain saved output**~~ — `11d56aa`; one native control, explicit false values, provider compatibility and reviewed transfer/print; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#authored-inspiration-and-character-schema-preservation).
- [x] ~~**T63-QUICK-USE-SHEETS — Share pinned items across Sheet and Combat**~~ — `3ee2ccd`; real quantities, safe removal, keyboard focus and saved output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#quick-use-inventory-and-preserved-characters).
- [x] ~~**T63-STORAGE-SHEETS — Edit containers and share item destinations**~~ — `250c442`; safe group removal, preserved control keys, worker checks and saved output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#storage-containers-and-preserved-inventory).
- [x] ~~**T63-PLACEMENT-SHEETS — Preserve placement in shared inventory controls**~~ — `460c728`; localized fields, shared targets, atomic transitions and saved output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-backed-body-placement-and-preserved-equipment).
- [x] ~~**T63-HANDS-SHEETS — Share hand and grip controls across Sheet and Combat**~~ — `1dbb048`; exact suspension, guarded worker writes, responsive controls and saved output; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#hands-grip-and-preserved-off-hand-instances).
- [x] ~~**T63-COMPACT-SHEETS — Adopt the final compact character workspace**~~ — `d00da27`, `9a99722`; shared cards, right attributes, Equipment/mannequin, Backpack dialog, explicit stacks, localized saved values and class-owned levels; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compact-character-sheet-workspace).
- [x] ~~**T63-CONDITIONS-SHEETS — Share authored conditions across both Combat layouts**~~ — `40f11a8`; localized host controls, worker preservation, automatic saving and provider-free reading/transfer/print; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#authored-conditions-and-preserved-character-state).
- [x] ~~**T14-SHEETS — Build browser assets and workers as package artifacts**~~ — `a1ce463`; ignored runtime output, versioned schemas/interfaces and unchanged package bytes; [build and package evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#source-owned-add-on-builds-and-reproducible-packages).

### Remaining work

- [ ] **T63-SHEETS / P2 — Refine the compact frame in smaller follow-ups.**
  Compact follows the final standalone mockup and both layouts share authored
  conditions. Resolve the unvisited-tab sizing boundary while retaining the
  accepted working layout. Complete session acceptance under T18; see the
  [remaining work](#t63-character-sheet-design).
- [ ] **T18-SHEETS / P1, review — Accept a whole build-and-play session.**
  T64 completes the existing workspace's representative multiclass play,
  amended grants, source/provider loss, restoration, rest, advancement and frozen
  output. Run the final session against the implemented T63 workspace; earlier
  passes do not accept that new design. Human screen-reader, physical touch and
  printer checks remain separate from browser/PDF evidence.

<a id="t63-character-sheet-design"></a>

### T63 — Character-sheet design: completed layout and remaining work

The September 27 reference is `character-sheet-mockup-standalone.html` from
local visualization task `01a0a087-6e2a-78a3-9928-435fdea0e377`. Compact now uses
its six-tab layout, shared stat cards, right-hand attributes, Equipment
mannequin/Other worn/Storage, Backpack dialog and class-owned Builder levels.
Classic retains its previous arrangement. Current behavior belongs in the
[workflow reference](rewrite/CHARACTER_BUILD_HISTORY.md) and
[Sheets README](../../addon-dnd-character-sheets/README.md), rather than a second
copy of the completed specification here.

The implementation uses real saved projections and Engine eligibility, shared
host controls/theme tokens, native dialogs and stable instance/focus identities.
The reference's sample values, simulated saves, hard-coded rules and standalone
application chrome are not runtime behavior. Inspiration, quick use, containers,
body placement and hands/grip retain their previously accepted contracts. The
layout itself requires no schema migration, permission change or saved-data reset.
The subsequent [condition slice](rewrite/HOST_CLEANUP_ACCEPTANCE.md#authored-conditions-and-preserved-character-state)
adds optional authored state through the existing reviewed compatible upgrade;
all six preceding schema generations retain their JSON and revisions.

The maintainer accepts this layout as a step forward and wants remaining UI
details finished in smaller steps. These refinements do not block unrelated
audit fixes. Remaining work:

1. **Frame acceptance.** Compact retains the largest measured tab at the current
   width, grows for new/expanded content and uses normal flow on narrow screens.
   Predicting an unvisited tab's full height remains different from the mockup's
   duplicate hidden sizing forms. Resolve that remaining design boundary without
   clipping content, imposing inner tab scrollers or duplicating editable forms.
2. **Final T18 sessions on the complete workspace.** Preserve current automatic
   saving, incomplete builds, retroactive progression, independent DM grants,
   source adoption and provider failure/recovery. Keep physical touch, spoken
   screen-reader and printer acceptance separate from browser/PDF evidence.

Every new state-changing slice must retain reload, disjoint/conflicting edits,
exact retry, session expiry and provider/generation recovery. Keep host-owned
identity, shared `ui.controls.v1`, Engine-derived calculations and saved rule
explanations. Do not restore manual Save/Apply, device drafts, character history
or hidden mechanical defaults. Validate both layouts/locales/skins, enlarged
text and 1,360/1,024/390/320 px viewports through the installed package lifecycle.
Record exact source pins and inspected package hashes before closing acceptance.

## Delivery order and completion

| Order | Work | Exit evidence |
| --- | --- | --- |
| 1 | Finish bounded class-level replacements across Compendium, Engine and Sheets. | Source-owned allowances survive advancement, save/import and provider transitions; any needed T08 migration is reviewed and atomic. |
| 2 | Whole character sessions: finish Engine and Sheets T18 on the current T63 workspace. | Representative builds and play preserve authored values through provider changes; package evidence and remaining human/device checks are explicit. |
| 3 | Everyday planning and reliability: finish DM Tools T18 and investigate recurring startup failures. | Complete desktop/phone workflows and concrete failures have action-level evidence; successful retries alone do not establish a fix. |
| 4 | Continue smaller T63 frame refinements and the remaining source-fact review. | Shared controls, saved state, focus and responsive layouts remain intact; missing facts have owner/provenance evidence. |
| 5 | Final integration and authorized delivery T15–T17; retain completed T02 coverage. | All four inspected packages pass without suite skips; exact served/installed builds, site data/retention, device checks and rollback assets are recorded. |

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
