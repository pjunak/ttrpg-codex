# Project backlog

Work for the five repositories, updated October 3, 2026. This remains
one suite backlog; each task belongs to the repository that owns its change.
Completed fix batches stay in compact checked, struck-through lists with commit
references; their detailed findings and the unchanged accepted release gates live in the
[feature-parity audit](rewrite/FEATURE_PARITY_AUDIT.md).

**Progress estimate, October 3:** about **97% implemented**, or **96%**
including remaining workflow, release and site acceptance. These are approximate
effort estimates, with plausible ranges of 93–98% and 92–98%, respectively.
[Current estimate and delivery evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-repaired-ci-and-verified-diagnostic-rollout).
**Original rows closed:** 33 of 40 (83%); open workflow tasks contain completed
slices. Compact character and large planning sessions are accepted; smaller UI
refinements, unexplained failures and human/device checks remain visible below.

**P1:** preservation, blocked workflows or release confidence. **P2:** usability,
resilience and maintenance. **Confirmed** means source/browser evidence exists;
**review** means an unresolved acceptance or design question, not a proven bug.
Implementation is not release acceptance: unresolved provider/startup failures
and site workflows still need evidence. Task IDs remain stable; gaps in numbering
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
- [x] ~~**T11-CAUSE — Preserve worker failure categories through recovery**~~ — `d1f5a72`; redacted transport cause, process-exit fallback and native restart regression; [evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#worker-failure-categories-and-planner-startup-recovery).
- [x] ~~**T11-STARTUP — Keep failed recovery workers' own process evidence**~~ — `597e5f2`; retain the new PID/exit and health/timeout category before cleanup, with native backoff and redaction regressions; [evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#failed-recovery-starts-and-retained-fixture-evidence).
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
- [x] ~~**T18-REPLACEMENTS-HOST — Accept class replacements and seven prior save schemas**~~ — exact companion pins, shared controls, imports, retries and preserved JSON/revisions; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#bounded-class-level-replacements).
- [x] ~~**T63-HOST — Accept the agreed character-sheet workspace through installed packages**~~ — complete EN/CS compact sessions, enlarged-text tab measurement and shared keyboard focus; 267/267 installed cases with zero skips; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compact-sessions-and-readable-enlarged-navigation).
- [x] ~~**T18-SESSIONS-HOST — Accept large planning sessions and separate browser failure traces**~~ — 269/269 installed cases with zero skips, EN/CS nested workflows, enlarged phone controls and owned trace cleanup; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#large-planning-sessions-and-shared-target-controls).
- [x] ~~**T57-STARTUP-HOST — Allow sign-out during stalled add-on activation**~~ — `83647ab`; cancel partial generations immediately, reject stale activation and dispose late resources once; [controlled before/after evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#cancellable-startup-and-worker-health-admission).
- [x] ~~**T18-HEALTH-HOST — Keep healthy workers available during domain saturation**~~ — `66f8cbd`; bounded, separate health/shutdown admission in the shared Go SDK, with blocked-output and native-process regressions; [cause, package evidence and delivery boundary](rewrite/HOST_CLEANUP_ACCEPTANCE.md#cancellable-startup-and-worker-health-admission).
- [x] ~~**T18-WRITER-HOST — Honor queued worker deadlines and stop interrupted frames**~~ — `bd9cb98`; cancel unsent writer waits, reject incomplete frame streams and let health deadlines terminate blocked native input; eight controlled cases, race checks and 13 installed provider/startup workflows. [Cause, rebuilt packages and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-worker-writer-cancellation-and-blocked-input).
- [x] ~~**T18-PEER-HOST — Stop late worker routing and queued writes on closure**~~ — `8463f4a`; discard pending-read frames, cancel queued calls/replies/notices and preserve terminal errors; 13 controlled cases, race checks and 14 installed workflows. [Cause, rebuilt packages and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-worker-peer-closure-and-queued-routing).
- [x] ~~**T57-CAMPAIGN-HOST — Release obsolete campaign reads during sign-out**~~ — `6f6d67a`; cancel old authority requests and queued work, reject late bodies/errors and preserve serialized current reads; [controlled failure and repair](rewrite/HOST_CLEANUP_ACCEPTANCE.md#campaign-read-cancellation-and-equipment-source-coverage).
- [x] ~~**T57-EVIDENCE — Preserve separate character setup and service failures**~~ — bounded host output, stage/status/process records, transport capture and original errors survive artifact-write failure; [regressions and controlled setup failure](rewrite/HOST_CLEANUP_ACCEPTANCE.md#failed-recovery-starts-and-retained-fixture-evidence).
- [x] ~~**T63-CATALOG-HOST — Accept source folders and seven-book wearable placements**~~ — EN/CS Compact/Classic filtering, keyboard search, cancel, enlarged phone controls and exact saved placement reload; [installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#campaign-read-cancellation-and-equipment-source-coverage).
- [x] ~~**T02 (including T02-LOCAL) — Publish and accept all four companion revisions with zero skips**~~ — host `5cc4945`; [104/104 Linux cases, exact sources and ZIP hashes](rewrite/HOST_CLEANUP_ACCEPTANCE.md#coordinated-publication-verification).
- [x] ~~**T15-DELIVERY — Publish the tested host and deploy both sites**~~ — `5cc4945`; [Asurai/Tiamat rollout and health checks](rewrite/HOST_CLEANUP_ACCEPTANCE.md#coordinated-publication-verification).
- [x] ~~**T18-PERF-HOST — Pin and accept the faster multiclass calculation**~~ — 277/277 installed cases with zero skips; EN/CS sessions finish in 63/60 seconds with unchanged deadlines and saved-character checks; [package and acceptance evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-calculation-ownership-and-deferred-progression).
- [x] ~~**T57-HEALTH-LOCK — Keep browser access responsive during worker health checks**~~ — wait outside the package-manager lock, reject obsolete results after lifecycle changes and share pending probes; [controlled reproduction and validation](rewrite/HOST_CLEANUP_ACCEPTANCE.md#worker-health-without-blocking-browser-access).
- [x] ~~**T57-REQUESTS-HOST — Release cancelled graph and add-on requests**~~ — discard obsolete queued reads and late responses, allow fresh sign-in after ordered cleanup, and share cancellation across data/content/service clients; [regressions and installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#cancelled-browser-requests-and-fresh-authority).
- [x] ~~**T57-SESSION-HOST — Cancel obsolete session recovery on sign-out**~~ — invalidate queued starts, share awaited cleanup, retire old authority checks and ignore closed-stream errors; [controlled failures and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#session-recovery-cancellation-and-sign-out).
- [x] ~~**T57-APP-HOST — Keep startup and account actions within their application lifetime**~~ — run health diagnostics independently, cancel retired account actions and pending previews, and await cleanup across replacement compositions; [reproductions and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#independent-health-and-application-lifetime).
- [x] ~~**T57-WRITES-HOST — Keep core saves and uploads within their application lifetime**~~ — release cancelled writes while preserving live queue order, ignore obsolete save feedback and navigation, settle callbacks and retain accepted writes/media without replay; [reproductions and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#core-write-cancellation-and-preserved-server-outcomes).
- [x] ~~**T57-RESTORE-HOST — Preserve current drafts during live campaign recovery**~~ — recheck dirty/saving state after refresh, let the latest restore own recovery and cancel retired stream work; [controlled failures and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#live-campaign-recovery-and-event-ownership).
- [x] ~~**T57-SETTINGS-HOST — Retire obsolete add-on Settings requests**~~ — suppress cancelled authority notifications and delayed JSON, reload reconnected configuration/wizards and preserve current inventory/staging feedback; [reproductions and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#add-on-settings-cancellation-and-reconnect).
- [x] ~~**T57-ACCOUNT-HOST — Restore Account navigation after reconnect**~~ — clear retired password saving/draft flags, cancel Account/recovery JSON waits and preserve accepted server writes; [real-server regressions and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#account-reconnect-and-recovery-response-cancellation).
- [x] ~~**T57-CAPTURES-HOST — Preserve original browser failures when evidence capture fails**~~ — `544f3d4`; shared independent page/state, JSON and screenshot capture across Timeline, Settings and saved-spell fixtures; [controlled failures and current suite checkpoint](rewrite/HOST_CLEANUP_ACCEPTANCE.md#current-suite-readiness-and-preserved-browser-failures).
- [x] ~~**T57-SSE-HOST — Stop revoked sessions during initial event output**~~ — `2465bee`; recheck cursor reads, replay rows and the initial flush; measure password-rotation shutdown after credential work commits; [CI failure, controlled reproduction and repair](rewrite/HOST_CLEANUP_ACCEPTANCE.md#initial-stream-revocation-and-password-work-timing).
- [x] ~~**T15-DIAGNOSTICS-HOST — Retain installed acceptance progress during cancellation**~~ — `bda9a2a`; stream bounded stdout/stderr immediately and persist partial TAP output; failed or skipped tests still block publication; [native-process regressions](rewrite/HOST_CLEANUP_ACCEPTANCE.md#streamed-installed-acceptance-diagnostics).
- [x] ~~**T57-RECORD-CONFLICT-HOST — Give stale record drafts consistent guidance**~~ — `54589dd`; share translated conflict text across local checks and server rejection, preserve exact remote records through delayed refreshes and retain failed host browser traces in CI; [controlled ordering and delivery failure](rewrite/HOST_CLEANUP_ACCEPTANCE.md#record-conflicts-before-campaign-refresh).
- [x] ~~**T15-SESSION-PERF-HOST — Reuse real UI save acknowledgements in multiclass acceptance**~~ — `aa7ab3c`; remove 13 repeated evaluations per session while retaining independent persistence checks, all assertions and deadlines; [measured acceptance and Linux boundary](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-acceptance-without-repeated-evaluations).
- [x] ~~**T15-DELIVERY-OCT01 — Publish the accepted cleanup and verify both site rollouts**~~ — `aa7ab3c`; 277/277 Linux installed cases with zero skips, verified image, successful Asurai/Tiamat infrastructure runs and matching served frontend assets; [release identity and site checks](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-1-cleanup-publication-and-both-site-rollouts).
- [x] ~~**T15-DELIVERY-OCT03 — Publish the frozen fixes and verify both site rollouts**~~ — `fb7020f`, then repaired `2bf0cc8`; 278/278 Linux installed cases with zero skips, all four inspected releases, matching image/frontend, successful Asurai/Tiamat health checks and loaded public portraits; [latest release and site evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-repaired-ci-and-verified-diagnostic-rollout).
- [x] ~~**T57-CI-METADATA-HOST — Retain bounded failure metadata and close failed tracing starts**~~ — `2dbcb27`; shared browser/setup/service capture, explicit public CI artifacts and timeline/wiki/standalone-sheet cleanup; [controlled failures and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-public-failure-metadata-and-context-startup-cleanup). Historical timeout attribution stays open.
- [x] ~~**T57-CI-STARTUP-HOST — Coordinate native race fixture setup before cancellation**~~ — `dd4e92b`; retain actual pipe blocking, original cancellation causes and separate configured-timer coverage; [CI failure and controlled repair](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-race-fixture-startup-coordination).
- [x] ~~**T57-CI-TIMEOUT-HOST — Close contexts when a test expires during tracing setup**~~ — `2bf0cc8`; register cleanup before asynchronous startup, reject late contexts from cancelled owners and preserve original failures; [real Node timeout and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-browser-context-ownership-during-test-timeouts).
- [x] ~~**T57-CI-INSTALLED-HOST — Preserve compendium, graph and character-play failures**~~ — local `2b549f0`; shared context ownership and bounded metadata, independent autosave startup captures and the original timeout; [real Chromium failure and package acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-installed-companion-capture-coverage).
- [x] ~~**T15-MEDIA-HOST — Preserve artwork geometry, fallback and retained portrait previews**~~ — `438b5f1`; one shared renderer across all entities, bounded avatars, obsolete-event protection, localized unavailable previews and renewed/released draft URLs; fully loaded public portraits verified on both sites. [Reproductions, permission checks and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-shared-artwork-and-portrait-preview-recovery).
- [x] ~~**T15-NATIVE-PINS-HOST — Coordinate frozen native build inputs and accepted sources**~~ — explicit SDK/model publication order, candidate compatibility and updated companion source pins; [implementation and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-frozen-native-build-dependencies).
- [x] ~~**T18-SAVED-CUE-HOST — Reproduce lost-response feedback and retain autosave traces**~~ — controlled same-revision guidance read, exact retry, restored controls and newer remote-state checks; shared trace/error/cleanup ownership in the older save fixture. [Failure and repair](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-frozen-native-build-dependencies).
- [x] ~~**T18-PLANNER-FAULT-HOST — Target startup faults at the planner's own reads**~~ — depart the opening overview before fault injection, preserve same-origin drafts and retain all desktop/phone recovery assertions; [trace diagnosis and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-frozen-native-build-dependencies).
- [x] ~~**T57-STARTUP-PIPES-HOST — Bound worker startup and process pipe cleanup**~~ — cancelled initialization writes, deadline-bounded final reads, inherited stderr cleanup and actual zero/nonzero exit codes; [nine native failures and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-worker-startup-and-process-pipes).
- [x] ~~**T57-COMPLETION-HOST — Reject expired service and callback completion**~~ — retain method deadlines through catalog revalidation, stop cancelled callback stages and classify interrupted response work correctly; [eleven controlled failures and installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-service-and-callback-completion).
- [x] ~~**T57-HANDOFF-HOST — Reject replies from replaced add-on runtimes**~~ — distinguish each runtime publication during same-package Reload, reject old in-flight results and retain handles for new calls; [five controlled failures and native Reload acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-same-package-runtime-handoff).
- [x] ~~**T57-HEALTH-COMPLETION-HOST — Enforce health probe completion and preserve native causes**~~ — reject expired healthy/degraded replies, retain specific transport failures and preserve bounded recovery; [three controlled failures and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-health-probe-completion-and-native-causes).
- [x] ~~**T57-CREATION-CAPTURES-HOST — Retain character setup failures and close every context**~~ — shared ownership before login across creation, save feedback and player transfer; Node regressions reproduce lost cleanup, and all six affected installed workflows pass. [Failure and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-character-fixture-startup-and-cleanup).
- [x] ~~**T57-TRANSFER-FOCUS-HOST — Wait for completed dialog cleanup before checking focus**~~ — retain native close behavior, focus and player-authorization assertions; the replaced-opener regression and both installed transfer/print locales pass. [CI failure and repair](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-character-transfer-close-readiness).

Contracts and regression evidence: [editor and browsing workflows](rewrite/EDITOR_BROWSING.md),
[GitHub package updates](rewrite/PACKAGE_LIFECYCLE.md#github-package-sources),
[backup recovery](rewrite/BACKUP_RESTORE.md#deliberate-boundary),
[reviewed disabling](rewrite/PACKAGE_LIFECYCLE.md#reload-and-disable),
[worker recovery](rewrite/WORKER_SUPERVISION.md#restart-policy),
and [parity audit](rewrite/FEATURE_PARITY_AUDIT.md#confirmed-findings).

### Validation follow-up

- [ ] **T57-VERIFY / P2 — Explain intermittent startup timeouts.**
  T57 timed out before the timeline mounted; T60 hit one phone-settings timeout;
  T61 timed out fetching rules policy during installed-fixture setup.
  Subsequent runs passed; no shared cause is established. Bounded browser and
  character setup/service metadata now survives failed CI; private detailed
  captures remain local. [Capture and cleanup acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-public-failure-metadata-and-context-startup-cleanup).
  The new native race-fixture failure and late tracing-start context leak have
  controlled reproductions and separate repairs above; neither supplies the
  original captures missing from these historical cases.
  Preserve deadlines and assertions; [T61 evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#passive-feat-bonuses-and-automatic-armor-conditions).
  Concrete request, recovery, worker and UI lifetime defects are fixed above;
  their controlled evidence does not explain these historical timeouts.
  September 28 also retained Chromium `ERR_NO_BUFFER_SPACE` failures before DM
  panel/schema-review navigation. The first exactly matches Windows TCP port
  exhaustion; focused replays pass, but the source of transient pressure remains
  unknown. [Current failure evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#failed-recovery-starts-and-retained-fixture-evidence).
  October 2's complete pinned installed suite passes 278/278 with zero skips;
  [current checkpoint](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-health-probe-completion-and-native-causes)
  distinguishes current acceptance from historical failure attribution.
  October 1's interrupted Linux delivery is now followed by 277/277 Linux
  installed passes and both verified site rollouts. Lost progress, record-conflict
  wording and repeated multiclass evaluations are repaired above; [current delivery](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-1-cleanup-publication-and-both-site-rollouts).
  The first cancelled run had no per-test output, so its exact stopping point
  cannot be reconstructed. This does not attribute the earlier startup failures.
  October 3's published `fb7020f` passes 278/278 Linux installed cases with zero
  skips and verifies both site rollouts. The rejected-startup fixture repair is
  accepted; [current delivery](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-host-rollout-and-public-site-acceptance)
  does not attribute the older missing-capture failures.
  The subsequently approved `2bf0cc8` also passes 278/278 Linux installed cases,
  its repaired native race gate and both verified site rollouts; [current receipt](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-repaired-ci-and-verified-diagnostic-rollout).

### Lifecycle, maintenance and operations

Core host cleanup and compatible schema reviews are implemented. Value-changing
migrations need a concrete preservation case; site operations need separate authorization.

| ID | Priority | Remaining work and completion condition |
| --- | --- | --- |
| T08 | P2, partial | Guided healing, explicit current-save reset and automatic update recovery are complete. Remaining: reviewed value-transforming operations when a concrete preservation case requires converting incompatible JSON. Keep exact plans, atomic commits, stale rejection and recovery; no guessed values or startup converter. [Boundary](rewrite/ADDON_DATA.md#remaining-public-surface). |
| T15 | P1, operational, partial | Host `2bf0cc8`, all four companion releases, both rollouts and public frontend/health/artwork checks are verified. Remaining: authenticated manager and full backup with the matching maintenance binary on each site; newest reviewed add-on builds and worker/save-feedback workflows on Asurai. Tiamat uses no add-ons and must remain that way. Reviewed ZIP activation remains separate from the host image. [Current delivery](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-repaired-ci-and-verified-diagnostic-rollout); [matching-image backup verification](SELF_HOSTING.md#verify-with-the-running-host-image); [runbook](SELF_HOSTING.md#publishing-and-deploying-updates). |
| T16 | P2, operational | Verify Asurai retains only its selected add-on builds and campaign recovery remains available after obsolete add-on contexts are retired. Implementation and host deployment are complete; the browser helper failure prevented live inspection/cleanup. Existing ZIP backups stay intact. [Evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#asurai-saved-packages-and-recovery-retention). |
| T17 | P2, operational | The owner confirms Tiamat uses no add-ons and must stay that way. Verify its authenticated inventory remains inactive; no package installation or activation is intended. Asurai alone targets the newest add-on versions. Asurai's reset authorization does not apply to Tiamat. |

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
- [x] ~~**T15-NATIVE-PINS-DM — Freeze the SDK used by immutable worker builds**~~ — `316399a`; full revision pin, offline bootstrap validation and matching package/vulnerability checkouts; [suite evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-frozen-native-build-dependencies).
- [x] ~~**T18-SESSIONS-DM — Complete large planning sessions with shared controls and readable phones**~~ — `f32e45f`, `2a48d5b`; searchable targets, distinct repeated titles, filtered shared notes, preserved focus/scroll and nested workflow acceptance; [evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#large-planning-sessions-and-shared-target-controls).
- [x] ~~**T18-STARTUP-DM — Recover stalled initial planner reads**~~ — `117487b`; shared Reload cancels pending reads, keeps focus and recovery copies; desktop/phone failure and late-response acceptance; [evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#worker-failure-categories-and-planner-startup-recovery).

### Remaining work

- [ ] **T18-DM / P1, review — Explain the intermittent planner startup timeout.**
  Large/nested sessions and explicit startup recovery are accepted above. The
  pre-action canvas-load timeout in the installed group-selection case remains
  unexplained; passing reruns and new traces do not establish a fix. Retain the existing deadlines
  and capture a failing run ([original evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#phb-origin-choices-and-shared-field-focus)).
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
- [x] ~~**T18-COMP — Complete bounded class-level replacements**~~ — `65eefab`; source-owned Fighter and Blessed/Druidic Warrior allowances, stable records and published-rule provenance; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#bounded-class-level-replacements).
- [x] ~~**T63-COMP — Complete the equipment source-fact review**~~ — `3463daf`; 29 missing wearable placements, 128 total across seven books, prior source values preserved and ordinary hand/grip facts verified; [coverage and consumer acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#campaign-read-cancellation-and-equipment-source-coverage).
- [x] ~~**T15-PACKAGING-COMP — Repair the audited package dependency**~~ — `2971a39`; patched brace expansion, unchanged ZIP bytes and successful inspected release; [checks and publication](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-approved-delivery-and-packaging-dependency-repair).

### Remaining work

**C10, consumer-triggered:** [structured coverage gaps](../../addon-dnd-2024-compendium/data/GAPS.md)
remain in narrative effects, per-instance base forms for magic weapons/shields,
and reference-only renown/facilities/Circle Magic.
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
- [x] ~~**T15-NATIVE-PINS-ENGINE — Freeze the SDK without adding a Node dependency**~~ — `f19f634`; standard-library bootstrap and exact refs for package/vulnerability jobs; [suite evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-frozen-native-build-dependencies).
- [x] ~~**T18-REPLACEMENTS-ENGINE — Enforce source-owned class replacement allowances**~~ — `ffbde98`; typed history, current-level budgets and acquisition-time prerequisites; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#bounded-class-level-replacements).
- [x] ~~**T18-SESSIONS-ENGINE — Accept current authored state through compact play and advancement**~~ — source/provider loss and recovery preserve independent equipment, resources, conditions and replacement history; [exact-package evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compact-sessions-and-readable-enlarged-navigation). T53 availability diagnosis remains open below.
- [x] ~~**T18-PERF-ENGINE — Remove redundant multiclass calculation copies**~~ — `c4063b5`; about 60% faster isolated evaluation with identical output, detached Builder results and unchanged progression rules; EN/CS sessions pass within the original deadline. [Profiling and regressions](rewrite/HOST_CLEANUP_ACCEPTANCE.md#multiclass-calculation-ownership-and-deferred-progression).

### Remaining work

- [ ] **T18-ENGINE / P1, review — Close rules/provider evidence gaps.**
  Final compact Fighter/Warlock/Wizard sessions now preserve the implemented
  T63 state through sourcebook removal, incompatible responses/majors, stale
  handles, restoration and advancement; pure, service and exact-package evidence
  is retained. Narrative adjudication remains C10, not exhaustive correctness.
  Investigate the one unexplained rules-availability loss during T53 validation;
  separate setup/service failure records are now retained. T54's 13-case
  diagnostic replay passed without reproducing it; no cause is established.
  The host SDK fixes independently reproduced health failure under domain
  saturation, interrupted/blocked writer handling and peer closure, but the
  original T53 run lacks evidence attributing it to these defects.

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
- [x] ~~**T15-NATIVE-PINS-SHEETS — Freeze the SDK and public character model**~~ — `89ebe08`; exact compile dependencies with independent runtime provider discovery; [suite evidence](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-frozen-native-build-dependencies).
- [x] ~~**T18-SAVED-CUE-SHEETS — Keep save confirmation through guidance refresh**~~ — `d35a33e`; preserve Saved for an unchanged ready revision without warnings, restore live controls and replace feedback for newer remote state; [controlled failure and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-2-frozen-native-build-dependencies).
- [x] ~~**T15-PACKAGING-SHEETS — Repair the audited package dependency**~~ — `06ef7a5`; patched brace expansion, unchanged ZIP bytes and successful inspected release; [checks and publication](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-approved-delivery-and-packaging-dependency-repair).
- [x] ~~**T18-REPLACEMENTS-SHEETS — Share replacement controls and protect spent allowances**~~ — `6d5807a`; both layouts/locales, keyboard focus, guarded writes and exact retries; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#bounded-class-level-replacements).
- [x] ~~**T63-TABS-SHEETS — Keep compact tabs readable with enlarged phone text**~~ — `c682e88`; natural-width wrapping and rendered keyboard orientation reuse the host tabs; old package fails the regression, rebuilt package passes both locales and four widths; [acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compact-sessions-and-readable-enlarged-navigation).
- [x] ~~**T18-SHEETS — Accept a whole build-and-play session on the compact workspace**~~ — shared Builder advancement, amended grants, source/provider recovery, rest, reload, import cancellation and provider-free output preserve current authored state; [267/267 installed acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compact-sessions-and-readable-enlarged-navigation). Human/device checks remain separate below.
- [x] ~~**T18-FOCUS-SHEETS — Preserve new focus through delayed dialog cleanup**~~ — `8d54166`; a queued Backpack close no longer steals focus from the next selected tab; controlled EN/CS installed regression and owner gates pass; [cause and acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#large-planning-sessions-and-shared-target-controls).
- [x] ~~**T63-SHEETS — Size the compact frame before first tab visits**~~ — `cc27a8b`, `418300b`; temporary inert samples use shared controls, preserve focus/scroll/data and leave one editable panel; desktop, Builder, enlarged-text and phone regression evidence in [frame acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#compact-frame-sizing-before-first-visits).
- [x] ~~**T63-CATALOG-SHEETS — Group equipment through source-owned fields**~~ — `8853959`; shared picker uses armor and magic-item categories with existing localized labels and provider fallbacks; [both-layout acceptance](rewrite/HOST_CLEANUP_ACCEPTANCE.md#campaign-read-cancellation-and-equipment-source-coverage).

### Remaining work

No confirmed implementation gaps remain in this slice. Human/device acceptance
remains open below; future visual refinements should name a concrete defect or
requested change rather than retaining an unbounded cleanup item.

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

The maintainer accepts this layout as a step forward and wants further visual
refinements handled in small, concrete steps. Frame acceptance is complete:
unvisited tabs and current Builder sections are measured with disposable inert
samples, retaining one editable panel, unclipped content and natural phone flow.
**Human/device acceptance remains open:** physical touch, spoken screen-reader
and printer checks remain unperformed and separate from the accepted compact
sessions, installed browser checks and PDF evidence.

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
| 1 | Reliability: investigate planner/host startup failures and the T53 Engine availability loss. | Accepted character/planning sessions stay covered; concrete failures have cause/fix evidence, not just successful retries. |
| 2 | Final integration and authorized delivery T15–T17; retain completed T02 coverage. | All four inspected packages pass without suite skips; exact served/installed builds, site data/retention, human/device checks and rollback assets are recorded. |

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
