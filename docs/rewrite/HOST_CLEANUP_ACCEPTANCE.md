# Host cleanup acceptance

Local and publication acceptance, September 16, 2026. This closes T18-HOST's actionable core
workflow review and links the completed backend work. The historical comparison
remains in [the feature-parity audit](FEATURE_PARITY_AUDIT.md); current remaining
work belongs only in [the suite backlog](../BACKLOG.md).

Core acceptance began with host `eb2cb7b`. The coordinated publication used
`5cc4945`, including the deployment-gate repairs, DM recovery, progressive-save
and Linux worker fixture tests below. It passed Linux installed acceptance and
deployed both sites; see [release evidence](#coordinated-publication-verification).
A later publication run exposed the [native shutdown race](#native-shutdown-race-follow-up)
corrected in `07482f0`.
All test campaigns, passwords, installed fixtures and recovery operations used
disposable directories. The release did not activate add-ons or edit live campaign data.

## Action-level evidence

| Workflow | Exercised behavior and remaining boundary | Executable evidence |
| --- | --- | --- |
| Core reading and editing | Knowledge levels, explicit DM inspection, private notes, twin create/link/unlink, old URLs, connected articles, contextual creation and investigations; save/cancel/Back, dirty/pending guards, failed/uncertain replies, stale edits and preserved unknown fields | [Real-host record workflows](../../frontend/test/browser/record-workflows.browser.mts), [editor actions and Markdown recovery](../../frontend/test/browser/editors.browser.mts), campaign application/HTTP tests |
| Session loss and preview | DM/player reauthentication in place; incorrect password and role mismatch; private draft retained during live revocation; original revision still rejects a concurrent edit; no automatic replay; successful recovery announces state and restores focus. Preview remains a separate player tab and expires independently | Record workflows above; [transport scope tests](../../frontend/test/player-preview.test.ts); [installed preview tests](../../frontend/test/browser/installed-dm.browser.mts); Go auth expiry tests |
| Shared UI and reading layout | Shared combobox/search/native fields, IME, disabled/loading choices, validation, disposal, modal Escape and keyboard tabs; English/Czech, classic/moonlit, desktop/390 px phone, 200% text, 720/320 CSS-pixel reflow, forced colors and visible focus. Core profile/collection matrices cover all eight locale/theme/viewport combinations with bundled and unavailable fonts | [Shared control browser tests](../../frontend/test/browser/ui-controls.browser.mts), [visual baseline tests](../../frontend/test/browser/visual.browser.mts), record workflows |
| Settings and recovery | Branding/sidebar/party controls; changed/deleted settings and malformed values retain drafts; current-password checks and uncertain credential outcomes; reviewed recovery points, automatic edit-group reversal, verified full backup and offline restore boundary | [Chrome settings](../../frontend/test/browser/chrome-settings.browser.mts), [party settings](../../frontend/test/browser/party-settings.browser.mts), [credentials](../../frontend/test/browser/credentials.browser.mts), [recovery](../../frontend/test/browser/recovery.browser.mts), maintenance/backup Go tests |
| Maps, timeline and graph | Map placement/dragging creates reviewable revision-bound drafts; upload failure/retry, image fallback, view presets and scope preservation; timeline create/edit/delete/reorder/reload/conflicts; graph keyboard/pointer position edits, cancellation, exact navigation and read-only content | [Maps](../../frontend/test/browser/maps.browser.mts), [timeline](../../frontend/test/browser/timeline.browser.mts), [relationship graph](../../frontend/test/browser/relationship-graph.browser.mts) |
| Add-on lifecycle and diagnostics | Review/activate/update/rollback; required/optional dependency disabling; worker failure/retry; browser activation/disposal; bounded DM-only diagnostics and redaction. Installed integrated/isolated settings and record panels retain their separate save boundaries | [Installed DM/lifecycle entry point](../../frontend/test/browser/installed-dm.browser.mts), worker supervisor/manager/service-broker/HTTP tests |
| Campaign-bundle import | Real installed Import Center reviews core plus planning fields, reference allocation and visibility; preview writes nothing; cancel invalidates the plan; lost commit/status replies recover through receipts including reload; stale data, authority/generation and injected transaction failures cannot partially commit | [Installed bundle fixture](../../frontend/test/browser/installed-campaign-bundle-fixture.mts), [coordinator tests](../../internal/application/campaignimport/service_test.go), [owning contract](../decisions/0001-campaign-bundle-imports.md) |
| Large campaign delivery | 3,300 records, desktop and throttled phone, three cold/warm/search/article/map samples; raw HTTP body equality and transfer sizes. Synthetic campaign/asset bodies shrink 87.3%; local browser decompression prevents a download-time improvement claim | [Measurements and limitations](PERFORMANCE.md), [reproducible harness](../../scripts/profile-campaign.mts), [HTTP encoding tests](../../internal/transport/httpapi/compression_test.go) |

The core session-loss defect was found during this review and fixed, rather
than accepted as a new rewrite convention. Browser fixtures revoke actual
sessions through logout; Go tests cover clock-based expiry. The sign-in form
reuses the shared controls and semantic theme tokens. Phone screenshots of that
form and campaign-bundle review were visually inspected for readable wrapping,
reachable actions and overflow.

## Validation

- `npm run check`: passed on the final implementation. Source guard and both
  TypeScript projects passed; 29 tooling tests, 389 frontend unit tests and
  277 browser cases passed; all project Go tests and vet passed.
- The ordinary browser run reports 33 optional installed-package skips. This
  is explicitly not the zero-skip publication matrix.
- `npm run release-check`: all unchanged historical 33 gates passed. This
  verifies their accepted status, not completion of new add-on work.
- Race checks passed for events and cleanup, worker supervisor,
  package manager, HTTP, campaign imports, request context, service/worker
  brokers, worker host and the campaign/add-on stores. HTTP race checks were
  repeated after the compression change.
- DM Tools' required integration passed its full check (56 unit tests and
  28 browser render checks at each of DPR 1 and 2), Go tests/vet, all three worker
  builds and host ZIP inspection. Windows workers were exercised; the other
  targets were built/inspected. Installed cases were included in host acceptance.

The final installed companion result and exact package identities are recorded
below. No skipped or failed case is converted into a passing acceptance claim.

## Installed companion matrix

The full candidate rerun on host `10ddc3c` completed **104 cases: 104 passed, zero
failed, zero skipped** in 146.3 seconds. This includes
`installed sources evaluate every class with bounded projections and explicit
incomplete choices`, including level-20 artificer under the unchanged service
deadline, and all enlarged-text host/add-on theme/language comparisons.
This completed T02-LOCAL. The later [Linux publication verification](#coordinated-publication-verification)
closes T02.

The run includes seven new character save cases and the five planner recovery
cases alongside campaign-bundle, lifecycle, role, provider and record-panel
workflows. All four archives passed host inspection before installation. The host
and all four companion source repositories were clean when that provenance was
captured. Later fixture validation is recorded in the CI follow-up below.
Runtime source and built frontend matched the tested host commit. The initial
preview timeout and unchanged passing rerun are recorded
[below](#progressive-save-and-equipment-follow-up). These hashes identify the
local archives; later CI and published archive hashes are recorded separately.

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| dm-tools | `0eeac9b` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| dnd-engine | `dfd970b` | `2d8772e46ff7ea7e2f46a17787cddfdaea71445350b45b6366d184c1ef5b9476` |
| dnd-sheets | `8b3bb30` | `1f127bf1f4c52c7bf5094117200c3892050b5e754aeb645f601ad11963392ec9` |
| dnd-2024-compendium | `e8cc635` | `02961fd304935e806f66785e5f205226c7b620daa040cba08eef9c4e9b1ac136` |

The runner retains exact full commit IDs and package hashes in ignored
`release/companions/provenance.json`, and TAP results in `installed.tap`.
Rebuild and reinspect any changed package before a subsequent run.

## Completed local commits

| Repository | Commit | Scope |
| --- | --- | --- |
| Host | `39fb986` | Bound browser concurrency after demonstrated Chromium resource exhaustion |
| Host | `31ebabb` | Reviewed offline add-on namespace, blob and log cleanup with verified backup and recovery |
| Host | `9012bf6` | Bounded, redacted worker/browser diagnostics |
| Host | `20c719c` | Build/inspect companion publication wiring, provenance and zero-skip enforcement |
| Host | `94544bc` | Atomic host-owned campaign bundle planning, contribution and durable receipt contracts |
| Host | `8d3652a` | Measured HTTP compression and reproducible performance probe |
| Host | `eb2cb7b` | Draft-preserving session recovery and action-level regressions |
| Host | `484814c` | Correct deployment-gate reflow coverage and verify font fallback |
| Host | `c3d0ac1` | Disable unintended reduced-motion transitions and verify immediate enlarged text |
| Engine | `f5f5ba3` | Bound per-evaluation catalog decoding while preserving isolation |
| Engine | `3f9c8e9` | Validate normalized feat references and builder prerequisites |
| DM Tools | `da116c3` | Compatible import adapter v3 consumption, scoped planning contribution and receipt UI |
| DM Tools | `0eeac9b` | Bounded planner draft recovery with original revisions and explicit review/discard |
| Host | `88e7bea`, `62e8da6` | Installed recovery, navigation and native/searchable choice acceptance |

## Acceptance boundaries

The initial local acceptance did not publish or deploy. The authorized follow-up
published packages and deployed the host to both sites, as recorded below.
T15–T17 retain live UI/backup/package acceptance and site/device/retention decisions;
no live cleanup or data conversion was performed. Actual
screen-reader speech, physical touch, real campaign scale/content and non-Chromium
browsers were not tested here. Those are not represented by emulated touch,
keyboard assertions or viewport/text-size checks.

T08 and the conditional API extensions still require a concrete released-data
preservation need or consumer; they are not unexplained missing host fixes.
DM Tools now owns recovery of its drafts across forced lifecycle replacement,
recorded in the [T30 follow-up](#dm-tools-draft-recovery-follow-up). It uses the
existing public lifecycle/edit contracts and shared host controls. Broader
DM workflow acceptance remains under T18-DM.

## Deployment-gate repair and Engine follow-up

[Actions run 35046542014](https://github.com/pjunak/ttrpg-codex/actions/runs/35046542014)
tested `7814c75` and failed seven profile assertions during `npm run check`.
Deployment configuration and the earlier compatibility jobs passed; image build
and both deployment targets were skipped. It did not reach a server rollout.

Host `484814c` replaces inline CSS magnification with explicit viewport reflow
checks. CSS magnification left desktop breakpoints active and could disappear
during navigation, so the previous assertion was inconsistent across runs.
The 16 profile/collection scenarios now retain every English/Czech,
Classic/Moonlit and desktop/phone combination, with both bundled and unavailable
web fonts, and verify 720 and 320 CSS-pixel widths after navigation. The
[shared UI verification reference](UI_FOUNDATIONS.md#reflow-verification)
records the W3C basis and manual browser-zoom boundary.

Host `c3d0ac1` also fixes the global reduced-motion rule. Its tiny nonzero
transition duration introduced transitions on otherwise static controls, so the
installed host/add-on comparison could read a 16 px host field while the root
and add-on fields were already enlarged to 32 px. The fix disables transitions
under reduced motion. A same-frame font/transform regression fails before the
fix and passes afterward; all four installed theme/language comparisons pass.

The final `npm run check` passed 29 tooling, 389 unit and 277 browser cases,
with the expected 26 optional installed-package skips, followed by all Go tests
and vet. All 17 workflow-policy checks and the 33 historical release gates
passed. An earlier local check hit a native Node/V8 crash in the unchanged
recovery browser process; its six focused cases and the full rerun passed.

Engine `f5f5ba3` avoids repeated feature-catalog decoding within an evaluation;
mutable source lookups remain detached and every evaluation receives a fresh
cache. A local source-data profile of level-20 artificer dropped from exceeding
40 seconds to about 2.4 seconds before the separate prerequisite correction.
Engine `3f9c8e9` restores skipped feat prerequisites: normalized references are
objects, not strings. Regression cases cover a feat qualifying itself, earlier
ability advances, acquisition levels, unsupported requirements and exact DM
waivers. All Engine Go tests/vet, rules/provider/engine race tests, sheet worker
Go tests/vet, three worker target builds and host ZIP inspection passed.

The earlier 92-case installed rerun passed after both fixes. Windows native workers
were executed locally; Linux targets were cross-compiled and inspected, without
local native Linux execution. Broader Engine T32 and Sheets T33 workflow acceptance
remains open and is not implied by the 92 passing cases.

These are local commits. The corrected Engine source must reach its main branch
before the host publication matrix is run, because that job builds companions
from their repositories. A fresh authorized Actions run and subsequent live
rollout remain operational acceptance; neither was triggered here.

## DM Tools draft recovery follow-up

DM Tools `0eeac9b` closes T30 with a bounded tab-local recovery copy. Forced
replacement or disable/re-enable offers Resume, Download and Discard through
the existing shared host controls. Item, flow, reference, consequence and note
text, new-flow/reference values and provisional item identity/parent survive.
Recovery retains opening revisions; concurrent updates still reject stale saves,
and deleted records or owners leave copyable text. Recovered unconfirmed saves
cannot be submitted again, while confirmed writes leave no stale copy even if
their confirming read fails. Old-generation replies cannot clear current drafts.

Host `88e7bea` adds the [installed recovery fixture](../../frontend/test/browser/installed-planner-recovery-fixture.mts)
and extends accepted navigation/sign-out discard checks. It covers no automatic
writes, keyboard resume, fresh-generation saves, stale/deleted records,
confirmed/held replies, blocked read/write storage, malformed copies, separate
tabs and player UI isolation. Desktop and 390 px phone views pass; Czech phone
controls also retain 200% text without horizontal page overflow. Recovery phone
screenshots were visually inspected. Storage lifetime and limitations remain in
the [owning add-on contract](../../../addon-dm-tools/docs/GRAPH.md#recovery-across-generations).

The first full run exposed a fixture assumption: enough accumulated parent
choices activate the shared searchable combobox, so the native-select locator
was ambiguous. Host `62e8da6` exercises either public control and deliberately
seeds enough phone choices to cover the searchable case independently. The
focused six lifecycle/navigation cases and the standalone searchable-phone case
pass, alongside both TypeScript projects. This does not change host controls.

DM Tools passed 56 unit tests, all 28 rendering checks at both DPR 1 and 2,
Go tests/vet, all three native worker builds and host ZIP inspection. The host's
full check passed 29 tooling, 389 unit and 277 browser cases, with the expected
26 optional-package skips, plus Go tests/vet. Actual Windows native workers were
executed; Linux workers were cross-compiled and inspected. The final exact-package
DM recovery matrix passed all 97 cases without skips; the current matrix above
adds subsequent character fixes. Broader DM T18 review,
physical-device and live-site acceptance remain open; no package was published
or activated on either site.

## Progressive save and equipment follow-up

Engine `dfd970b` closes T32-EQUIPMENT. Empty inventory can remain carried or
stored, but cannot stay equipped or attuned. Custom equipment checks matching
DM mechanics against activation, effective level and expiry. Equip guidance
tests the proposed equipped state, including equipped-only conditions, without
mutating input. Additive `guidance.saveIssues` separates actual save blockers
from required choices that may legally remain unfinished. Pure regressions
cover partial point buy/array, unavailable origins/unknown abilities, empty
equipment and current grant eligibility.

Sheets `8b3bb30` closes T33-SAVE. Rejected input, active text focus/caret and
navigation protection survive failed saves. Retry retains the uncertain
operation's exact ID, revision and inputs; later edits wait for acknowledgment.
Newer corrections continue after an older rejection, and accepted choice
withdrawals do not reappear when other choices change in flight. Reload requires
explicit discard confirmation. Depleting equipped inventory clears equipment
and attunement together.

Host `10ddc3c` adds seven
[installed save regressions](../../frontend/test/browser/installed-character-save-fixture.mts).
The real Engine and Sheets workers handle validation, transactions and
idempotency. A client range is deliberately bypassed to exercise server rejection;
lost replies are injected after the real transaction commits. Independent edits
rebase, overlapping edits retain their existing conflict protection, and retries
do not duplicate writes. All 13 character cases pass, including the existing
build, play, import and provider-loss workflows.

The phone regression exposed a compact-card minimum-width override and a rail
that squeezed enlarged text into a narrow column. The fix allows cards to shrink
and stacks vertical navigation above the content when needed. English Compact
and Czech Classic recovery controls pass at 390 px with 200% text, including
keyboard discard cancellation; both viewport screenshots were visually checked.
This is automated text-resize coverage, not physical-device or screen-reader
acceptance.

Engine Go tests/vet and Sheets `npm run check` pass. Both packages were rebuilt
through their owning tools and inspected by the host. The host check passes
29 tooling, 389 frontend unit and 277 browser cases, with 33 expected optional
package skips, plus Go tests/vet. Actual Windows workers ran; Linux workers were
cross-compiled and inspected.

The first all-four matrix passed 103 of 104 cases: the existing player-preview
pop-up/logout case timed out locating “View as player.” Both isolated preview
cases passed unchanged afterward. This failure is retained in the evidence;
it is not claimed as a fixed product defect. The unchanged full rerun then passed
all 104 cases with zero skips, using the exact commits and hashes recorded above.

T32/T33 still retain earlier-decision/multiclass/attunement acceptance and
pending-edit session/provider transitions. Recovery buttons/notices are localized;
some returned worker/Engine reasons still fall back to English and remain in T33.
Direct play/grant and reviewed-import commands have separate uncertain-outcome
paths. Broader T18 build-and-play,
physical-device and live-site acceptance remain open. No package was published
or activated on either live site.

## Linux compatibility failure and companion delivery

[Build run 35121526361](https://github.com/pjunak/ttrpg-codex/actions/runs/35121526361)
on host `64cd3f8` passed the ordinary host gate but failed installed companion
acceptance: 73 passed, 31 failed, zero skipped. **Build image** and deployments
were skipped. Two independent causes were identified:

1. CI checked out older companion default branches, missing nine locally
   committed fixes. The following remote heads were also verified during the
   investigation on September 16; they are an incident snapshot, not a moving
   release target.

   | Repository | CI/remote source | Locally accepted source | Missing commits |
   | --- | --- | --- | --- |
   | DM Tools | `40fe452` | `0eeac9b` | 3: shared controls, campaign bundles, draft recovery |
   | Engine | `8c0c9a1` | `dfd970b` | 3: bounded evaluation, prerequisites, equipment/save guidance |
   | Character Sheets | `5e82fd6` | `8b3bb30` | 2: shared controls, retained edits/exact retry |
   | Compendium | `d03af34` | `e8cc635` | 1: shared search/filter controls |

2. The host's `replacementImportPackage` test helper rebuilt ZIPs without Unix
   creator/permission metadata. The production extractor consequently wrote the
   Linux workers without executable permissions. Replacement activation returned
   `ACTIVATION_FAILED`; later manager cases also saw retained failure alerts.
   Windows worker execution did not expose the missing Unix metadata.

The replacement helper now preserves each original Unix permission mode, and
synthetic ZIPs encode regular-file modes explicitly. Worker bytes, package
checksums and production extraction rules retain their existing behavior. The
[cross-platform regression](../../scripts/installed-package-fixtures.test.mts)
uses an independently generated Go ZIP with different Linux executable modes and
ordinary non-executable entries. It failed before the change and passed after it;
a separate case verifies unchanged payloads and refreshed manifest checksums.
Go's standard ZIP reader independently verified all 51 modes of a rewritten real
DM Tools package, including both `0755` Linux workers. Host inspection accepted
that replacement archive.

The replacement fix is committed as `325cf13`; the follow-up below completes T36
for freshly constructed native-worker packages as well. The full host gate passed:
31 tooling tests, 389 unit tests, 277 browser cases with the ordinary 33 optional
package skips, plus Go tests and vet. Full installed acceptance then passed
**104/104, zero failures and zero skips**, in 142.5 seconds. This exercised the
worktree patch subsequently committed as `325cf13`; provenance correctly records
base host `64cd3f8` with working-tree changes. All four companion repositories
were clean and used the same exact commits/hashes as the
[installed companion matrix](#installed-companion-matrix). Native Windows workers
ran; Linux ZIP metadata was verified independently. Fresh native
Linux CI was still pending at this stage and is verified in the follow-up below.

The next operational step was to push all four accepted companion revisions
and the host fixture fix, then verify a fresh Linux compatibility run and the
intended host release. Rerunning the old host commit alone cannot include the
fixture correction. Follow the [coordinated delivery procedure](../SELF_HOSTING.md#coordinate-host-and-companion-commits).
A host main push can publish and deploy both sites; add-on publication does not
install or activate a package on either site. No push, publication, deployment or
live-data change was performed during that initial investigation.

## Coordinated publication verification

The authorized follow-up on September 16 found all five reviewed commits already
on their remote main branches. Each companion's test/package workflow succeeded
and published its inspected ZIP to the immutable commit release below. Publication
does not install or activate these packages on either campaign.

| Companion | Tested source and release | Workflow run | Published ZIP SHA-256 |
| --- | --- | --- | --- |
| dm-tools | [`0eeac9b`](https://github.com/pjunak/addon-dm-tools/releases/tag/build-0eeac9bc84f50836fa30f134b5edee9358656676) | [35124716442](https://github.com/pjunak/addon-dm-tools/actions/runs/35124716442) | `05eb3b6f5a081b89640f4c862c97a2a61166cc2796d46a57a703d4f6da7a5fdc` |
| dnd-engine | [`dfd970b`](https://github.com/pjunak/addon-dnd-engine/releases/tag/build-dfd970bd07d42f74735f55150bfe86ebe07a9c3f) | [35124732892](https://github.com/pjunak/addon-dnd-engine/actions/runs/35124732892) | `172060443d0a6081e635bd72aeeeccec3042e6a99d6961ff93d9c6a4cc349a03` |
| dnd-sheets | [`8b3bb30`](https://github.com/pjunak/addon-dnd-character-sheets/releases/tag/build-8b3bb30ce9ae06135fc6e40b7a9a8a6621c1a1a8) | [35124721493](https://github.com/pjunak/addon-dnd-character-sheets/actions/runs/35124721493) | `e4f1163db61de9055d421b13930b40ba5cdbf8113cd158066391e3d4b5b13229` |
| dnd-2024-compendium | [`e8cc635`](https://github.com/pjunak/addon-dnd-2024-compendium/releases/tag/build-e8cc6353b0f357a89d661f3458dff98e594cd32f) | [35124733108](https://github.com/pjunak/addon-dnd-2024-compendium/actions/runs/35124733108) | `1fc3e387075480e74710a7595d5fba7cc6cfd640d173998030446a6298ad3304` |

The first host follow-up, [run 35124703185](https://github.com/pjunak/ttrpg-codex/actions/runs/35124703185)
on `c8216c4`, passed the main host gate but finished compatibility at 93/104.
Its checkout timestamps show a delivery race: Engine was fetched at 16:53:10 UTC
before its 16:53:17 push, and Compendium at 16:53:14 before its push. Those jobs
therefore still used `8c0c9a1` and `d03af34`. The published revisions above were
subsequently verified on every remote branch before the corrected host push.

The same run exposed a separate synthetic Import Center provider whose fresh ZIP
also omitted its worker's execute bit. Its builder now explicitly packages the
native entrypoint as `0755`; a regression calls that actual builder and catches
`0644` on Windows as well as Linux. The test failed before the fix and passed
afterward. Error assertions now target the active review dialog, direct operation
feedback or the exact configuration failure, allowing unrelated retained
generation alerts to coexist. No coverage or deadlines were relaxed.

The corrected candidate passed `npm run check` with all four inspected companion
ZIP inputs: 32 tooling tests, 389 unit tests and all 339 browser cases, zero
failures/skips, plus Go tests/vet. Release readiness passed all 33 gates.

The corrected host commit `5cc49456092bf4042e584680a74373c9de6a030d` passed
[run 35126440334](https://github.com/pjunak/ttrpg-codex/actions/runs/35126440334):
the host suite, deployment configuration, all **104 installed compatibility
cases with zero failures/skips**, image build and both deployments succeeded.
The installed suite executed the native Linux workers. Its
[companion provenance artifact](https://github.com/pjunak/ttrpg-codex/actions/runs/35126440334/artifacts/10460160282)
records the exact four source commits in the release table above and a clean
host checkout. This closes T02 and completes the T36 Linux verification.

DM Tools, Engine and Sheets used ZIP hashes identical to their published packages
in the table. Compendium's independently built CI ZIP instead has SHA-256
`6f0aca4f1543fb78c06891fa81fc820c93afe9ca96d6058fbcb0673d25b76dce`
(2,854,109 bytes), from the same `e8cc635` source. Its
[packager](../../../addon-dnd-2024-compendium/tools/package.ts) leaves ZIP
timestamps variable: two clean local builds preserved all 3,268 entry payloads
and permission modes while changing 181 timestamps and the archive hash.
The CI and published Compendium payloads were not directly compared; these
separate hashes do not establish byte-identical artifacts. Reproducible packaging
is recorded under T14-COMP. Post-build provenance also reports `sourceDirty: true`
for DM Tools, Engine and Sheets, and `false` for Compendium; generated-artifact
ownership remains the per-repository T14 follow-up.

The image startup and GitHub HTTPS checks passed before publication. Both sites
received the immutable image
`ghcr.io/pjunak/ttrpg-codex@sha256:89ce99616b2c9579f09e7b958263cabc35dc29c2ff9dff41e3d87ee66cede564`:

| Site | Exact infrastructure run | Result |
| --- | --- | --- |
| Asurai | [35127386396](https://github.com/pjunak/infra/actions/runs/35127386396) | Successful rollout and health verification |
| Tiamat | [35127386310](https://github.com/pjunak/infra/actions/runs/35127386310) | Successful rollout and health verification |

The host parent waited for both exact results and completed successfully at
17:24:50 UTC. The infrastructure jobs each passed their validated-infrastructure
gate and `Stage configuration, deploy under lock, and verify health` step.
T15-DELIVERY is complete. Live frontend/manager/backup acceptance, site-specific
add-on review/activation and device checks remain under T15–T17; workflow health
checks do not substitute for those operations.

## Native shutdown race follow-up

The documentation publication [run 35128522454](https://github.com/pjunak/ttrpg-codex/actions/runs/35128522454)
on `294823a` again passed all 104 installed cases with zero skips, but its ordinary
Go gate exposed an intermittent `TestWorkerMonitoringWithNativeCrashAndHealthHang/crash`
failure. Shutting down the healthy replacement returned
`INVALID_STATE: transition failed -> stopped is forbidden`. Image publication and
deployments were skipped; the previously successful release remained in place.

After an accepted shutdown and zero process exit, closing the host-owned stdout
pipe could wake the peer reader before the final stopped transition. The reader's
closed-file error was mistaken for an independent transport failure.
Commit `07482f0` records closure ownership under the supervisor mutex before
closing descriptors. Only the resulting `os.ErrClosed` callback is ignored;
unexpected closure and other protocol errors still fail the generation.

The [real-pipe regression](../../internal/addons/workersupervisor/transport_cleanup_test.go)
reproduced the exact CI error before the fix and passed afterward, including 50
repetitions. The full `npm run check` passed with all four inspected ZIP inputs:
32 tooling tests, 389 unit tests, 339 browser cases, zero failures/skips, plus Go
tests/vet. `go test -race` passed both supervisor and package-manager packages with
`-count=10`; release readiness passed all 33 unchanged gates. This closes T37.
The worker protocol, lifecycle state graph and deadlines are unchanged.

## Progressive Builder repair and navigation

Engine `dd51374` and Sheets `dff6c0b` close T32-GUIDANCE and T33-BUILDER.
Earlier edits now withdraw only the exact previously saved selection identified
by `<choice ID>#<slot>`; the issue's group target no longer deletes valid
siblings. Reduced choice counts and dependency chains longer than four steps
settle without silently accepting newly supplied invalid choices.

Engine counts the required first class and class cantrips/spellbook choices.
Invalid ability arrays and acquired feat prerequisites no longer appear complete;
repair guidance keeps the authored decision available for correction. English
fallback labels have additive translation templates, preserving authored names
and unchanged public service/schema versions.

Sheets exposes a next-choice action even with the progress rail collapsed.
Navigation reaches first-class, lineage, subclass, advancement and spell
controls; it opens the relevant disclosure, reveals the selected tab and focuses
the first unfinished visible control. Immediate host enhancement avoids focusing
the hidden native select. Stable level IDs preserve repeated field focus, and
detached disclosure events no longer reset the current rail state.
Engine wording and the previously missing Background field label are localized
in English/Czech. Catalog text and untranslated save explanations retain their
separate ownership and remaining backlog scope.

The interaction follows the existing host controls contract, checked against the
[W3C combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/),
[focus-order guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
and [reduced-motion technique](https://www.w3.org/WAI/WCAG22/Techniques/css/C39).
These references informed focus placement and motion behavior; automated browser
checks do not establish screen-reader or physical-device acceptance.

Validation includes Engine tests/vet and native race checks for rules, provider
and engine; Sheets `npm run check`, package build and native coordinator race
checks; host inspection of all four ZIPs; and all 17 installed character cases
with zero skips. Four added
[installed Builder cases](../../frontend/test/browser/installed-character-builder-fixture.mts)
cover keyboard navigation at 390px with 200% text in English/Czech, collapsed
progress retention, visible active tabs, subclass/spell targets, first-class
changes reducing four skill slots to one, expansion focusing the next empty
slot, recorded HP field focus, and later advancement withdrawal while preserving
other selections and notes. Phone screenshots were visually inspected.

The final host `npm run check` passed with all four inspected packages:
32 tooling tests, 389 unit tests and 343 browser cases, with zero failures/skips,
plus Go tests/vet. An intermediate rerun hit Chromium
`ERR_NO_BUFFER_SPACE` while opening an unrelated Settings fixture; the unchanged
gate subsequently passed. No test coverage or concurrency setting was weakened.

The tested package set is:

| Add-on | Source commit | ZIP SHA-256 |
| --- | --- | --- |
| DM Tools | `0eeac9b` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `dd51374` | `81f7fe068588ba0c73b91e984c2c3f490a55575830fe7a3b14a238cd13184a03` |
| Sheets | `dff6c0b` | `cec7fb51c7379f9171cbad59d75f644d246b3bec9b6d761e72a52c5eae0f26a4` |
| Compendium | `e8cc635` | `2a5a0a19f7116a380470e26e99232d82567cb4e4b6c98113c750e5ff447a323c` |

All companion worktrees were clean at inspection. The host acceptance worktree
started from `d28221b`. The package lifecycle ran against disposable local data;
this batch does not establish new CI publication or live-site activation.

This acceptance identified the missing Rogue Expertise grant recorded as
T38-COMP; the [following batch](#class-expertise-grants-and-dependent-choice-repair)
closes it. Deeper origin/multiclass/equipment acceptance, save-explanation
localization, session/provider changes and uncertain direct-command recovery
remain under T32/T33.


## Class Expertise grants and dependent choice repair

September 16, 2026. This closes T38-COMP and the T32-EXPERTISE slice.

Compendium now supplies the seven missing core class choices: Rogue at levels
1 and 6, Bard at 2 and 9, Ranger at 2 and 9, and Wizard Scholar at 2. Scholar
retains its restricted skill pool. Deft Explorer's stale tracking description
is corrected and its two language choices are structured. The
[provider coverage record](../../../addon-dnd-2024-compendium/data/COVERAGE.md#character-rules-and-contextual-details)
links the official class rules, language tables and Expertise glossary used
for this audit. Record IDs, book ownership and the public grant schema remain
stable.

Engine evaluates proficiency eligibility at the acquiring character level.
Valid earlier Expertise selections and fixed grants exclude duplicate skills
without making a choice invalidate itself. Combined proficiency/Expertise
grants and declared replacement timing remain supported. Guidance and exact
slot validation agree; invalid raw option IDs cannot reserve another choice's
skill. Catalog enumeration is sorted so multi-feature plans stay deterministic.
These rules are generic; class names, levels and grant counts remain in
Compendium data. See the [Engine contract](../../../addon-dnd-engine/contract/README.md#character-evaluation).

The two added
[installed cases](../../frontend/test/browser/installed-character-builder-fixture.mts)
check all four classes before/at their grants, distinguish total level from
Rogue level, and exercise Rogue through shared host comboboxes and autosave.
Replacing an earlier proficiency withdraws only its dependent Expertise slot.
Moving early Expertise onto a later selection keeps the early decision and
withdraws the later duplicate. Valid sibling slots, notes and current HP
survive; skill totals update; removing level 6 withdraws its grant; reload
retains the repaired values. The generated desktop screenshot was visually
inspected. Sheets needs no special class UI or persistence change.

Validation: Compendium build/tool types and 58 tests; Engine tests/vet and
native race checks for rules/provider/engine; Sheets build, five browser-unit
tests and Go tests/vet; all four package inspections; and 19 installed
character cases with zero skips. The complete host gate passed 32 tooling,
389 unit and 345 browser tests, zero failures/skips, plus Go tests/vet.
After the final Engine invalid-ID correction and rebuild, the final package
set was reinspected and passed all 110 installed cases with zero skips through
`node scripts/companion-suite.mts test full`.

| Add-on | Source commit | ZIP SHA-256 |
| --- | --- | --- |
| DM Tools | `0eeac9b` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `41e26c1` | `f058838a1a6f47408ceb26d87ea13ba714c4dd00cf8154cc216d04a7ea544f8a` |
| Sheets | `dff6c0b` | `cec7fb51c7379f9171cbad59d75f644d246b3bec9b6d761e72a52c5eae0f26a4` |
| Compendium | `8cb7e43` | `2f7154f51a69c210d118d52caa5cbbb9350ea2ddf3b9cb9b9f9392dd36d20820` |

All companion worktrees were clean at final inspection. Host acceptance began
at `0de9ad9` with this batch's fixture changes. Tests use disposable local data;
these results establish no new CI publication or live-site activation.
T39-COMP records the separate Skill Expert, Boon of Skill and Thieves' Cant
data gaps discovered during the audit. Remaining T32/T33 workflow acceptance
and human device/screen-reader checks stay open.

## Shared entity-card sizing and editing

September 16, 2026. T40-HOST repairs the reported portraitless-character shrink
and the edit action placed below the card. Collection fallback marks now reserve
the same media area as artwork, including the character 3:4 ratio. Grid cards
stretch together; long names wrap. Article mastheads retain their compact
identity treatment.

All nine collection types, party members and companions call the same pencil
link renderer and use the shared semantic-token card-action styles. The action
stays at the top-right with a localized accessible name, tooltip, visible
keyboard focus and 44-pixel default target. The main card link and pencil are
siblings, preserving native navigation and existing DM/player permissions.
DM badges occupy the opposite corner. Collection headings also wrap correctly
when text is enlarged. Add-on reuse is documented in
[UI foundations](UI_FOUNDATIONS.md#entity-card-actions).

The visual fixture covers artwork/fallback geometry in every collection,
dashboard/party cards, action bounds, badge separation, icon labels, keyboard
activation into each record editor, anonymous/player permissions, English/Czech,
Classic/Moonlit, desktop/320-pixel layouts and 200% text. All 13 visual cases
passed; existing real-host contextual editing and return-route coverage remains.
Desktop and phone card screenshots were visually reviewed.

The final host gate passed 32 tooling, 389 unit and 353 browser tests with zero
failures/skips, plus Go tests/vet, using all four inspected companion ZIPs.
Two earlier full runs each hit a different fixture-startup timeout before the
affected workflow began. Both cases passed in isolation and the unchanged final
gate passed; no concurrency, timeout or coverage settings were relaxed.

## PHB skill feats and Rogue languages

September 16, 2026. T39-COMP is complete in Compendium `46e78a2`.
[Coverage and sources](../../../addon-dnd-2024-compendium/data/COVERAGE.md#character-rules-and-contextual-details)
document the 2024 facts and retained prose. Skill Expert supplies a canonical
skill choice and a dependent Expertise choice, level-4 prerequisite and
six-ability +1 grant capped at 20. Boon of Skill supplies all 18 skills, one
nonduplicate Expertise choice, level-19 prerequisite and a +1 grant capped at
30. Thieves' Cant supplies its fixed language plus one different standard/rare
table language; obsolete tools text is removed. Permanent record IDs and public
grant shapes remain stable.

Three installed Engine/Sheets regressions cover the actual rebuilt provider:
Skill Expert autosave repairs when proficiency changes, choosing Expertise in
the newly granted skill, reload, feat replacement and preserved notes/current
HP; the boon retaining earlier Expertise, correct totals and cap, rejected
early acquisition and withdrawal after its source level is removed; and Rogue
language selection/replacement/reload followed by replacing Rogue with Fighter.
The existing generic Engine and Sheets implementations need no changes.

Compendium passed 60 tests, build/tool types and packaging. Engine tests/vet
and Sheets build, five unit tests and Go tests/vet passed. The final complete
host gate passed 32 tooling, 389 unit and 353 browser cases with zero skips plus
Go tests/vet. The new cases also passed separately against real installed ZIPs.
All checks use disposable local campaigns; no live packages were activated.

T39 left Skilled's fixed `any (3)` placeholder for a coordinated follow-up.
Its mixed choices and acquisition ownership are now covered by
[T41 acceptance below](#repeatable-skilled-choices-and-acquisition-ownership).
Neither batch claims that every PHB mechanic is structured.

The final committed companion sources were rebuilt/reinspected and passed
`node scripts/companion-suite.mts test full`: **113/113**, zero skips.
The final Compendium packaging refresh adds the committed coverage note;
archive-content comparison confirmed that only `data/COVERAGE.md` and
`checksums.json` differ from the archive used by the full host gate. All runtime
bytes are identical, and the final archive itself passed the installed gate.

| Add-on | Source commit | Final ZIP SHA-256 |
| --- | --- | --- |
| DM Tools | `0eeac9b` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `41e26c1` | `f058838a1a6f47408ceb26d87ea13ba714c4dd00cf8154cc216d04a7ea544f8a` |
| Sheets | `dff6c0b` | `cec7fb51c7379f9171cbad59d75f644d246b3bec9b6d761e72a52c5eae0f26a4` |
| Compendium | `46e78a2` | `abffab476350ab5845487d97140a717ed78cc259d5a96835f2fa21a6c8e9cc18` |

Companion worktrees were clean at final inspection. Host acceptance used
`16155a7` plus this batch's installed fixtures and documentation. These local
results do not establish publication, deployment or live add-on activation.

## Repeatable Skilled choices and acquisition ownership

September 17, 2026. T41-COMP, T32-REPEATABLE, T33-REPEATABLE and T41-HOST
complete this coordinated batch. Source commits: Engine `e5f1027`,
Sheets `e066de3`, Compendium `8e1e9d7`.
[Provider coverage and primary sources](../../../addon-dnd-2024-compendium/data/COVERAGE.md#character-rules-and-contextual-details)
document Skilled's three mixed skill/tool slots, all 18 skills and 37 individual
tool proficiencies. Origin feats are now eligible at later class advancements;
the level-19 Epic Boon policy remains unchanged.

The Engine derives acquisition IDs from declared background/species grants,
feat choices, class advancements and DM grants. Each repeat keeps independent
choices and a source label. Removing an earlier source never renumbers another.
Parents resolve before dependent choices; arbitrary input-key suffixes cannot
create grants. Nonrepeatable duplicates and invalid prerequisites block saving.
Mixed proficiency pools exclude fixed and earlier selected proficiencies while
retaining the current acquisition's choices.

Sheets renders this through the existing borrowed comboboxes and generic Builder
panels. Changing an origin, advancement, level or DM grant withdraws only the
previously saved slots that become invalid, preserving valid siblings, notes and
current HP. Historical unscoped choices bind only to a sole owner in detached
evaluation; loading never writes. Ambiguous choices remain visible for explicit
assignment to an empty source or discard and block saving until resolved.

Six [installed regressions](../../frontend/test/browser/installed-character-repeatable-fixture.mts)
exercise repeated background/advancement choices in English/Czech, keyboard
selection, autosave/reload, source replacement, level removal, DM grant
revocation/amendment and historical assignment. The ambiguity UI case simulates
a historical snapshot at the read boundary; its evaluation and subsequent save
use the real installed workers. The other cases use real package-owned state.
At 390 pixels and 200% text, the tests exposed an overflowing host character
heading and squeezed Builder ability fields. Shared heading wrapping,
adaptive ability columns and bounded steppers fix both. Final phone screenshots
were visually reviewed.

The first complete host run exposed a 60-second timeout in the existing
level-19 Boon of Skill case. Feat-option filtering repeatedly hydrated full
progression for simple level/waiver predicates. Those options now use the same
prerequisite interpreter at their acquisition level; ability/feature predicates
and dependent feat replacement retain full candidate validation. New synthetic
regressions cover ordered multiclass levels, waiver timing and nested source
replacement. The focused Boon case then passed in about 16 seconds; no test
timeouts, concurrency limits or coverage were relaxed.

Validation: Engine tests/vet, native race checks and all three worker targets;
Sheets build, five TypeScript tests, Go tests/vet and coordinator race checks;
Compendium build/types and 61 tests; all four package inspections. The complete
host gate passed 32 tooling, 389 unit and 359 browser tests with zero failures,
cancellations or skips, plus Go tests/vet. After the companion commits,
`node scripts/companion-suite.mts test full` passed **119/119**, zero skips.

| Add-on | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools | `0eeac9b` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `e5f1027` | `54b5bc72b5607488a7f023dd4542d7df256915fc09532bd26c40e97351a7aaa9` |
| Sheets | `e066de3` | `ca34fc804f70795e0344670684bf22d202195fdf590e7df27fbf122d4a127d99` |
| Compendium | `8e1e9d7` | `58ad68af87015d55ca8a875bd54ad188878b7a9d7fc3f41c80654bb9c824a71b` |

Host acceptance used `17b3224` plus this batch's heading styles and installed
fixtures. Companion worktrees were clean at final inspection. Workers executed
natively on Windows; Linux workers were cross-compiled and inspected. These
results establish local acceptance, not publication, deployment or activation
on either site. Physical touch, screen-reader and live-site checks remain open.

This closes declared repeatable Builder choices, not repeated spell/resource
effects or conditional-repeat mechanics. Human and instrument/game origin
choices were completed in [T42 below](#phb-origin-choices-and-shared-field-focus);
the broader Engine T32, Sheets T33 and T18 acceptance tasks remain open.

## PHB origin choices and shared field focus

September 17, 2026. T42-COMP, T32-ORIGINS, T33-FOCUS and T42-HOST
complete this batch. Source commits: Engine `1faa785`, Sheets `f184eda`,
Compendium `87c1402`.
[Provider coverage and sources](../../../addon-dnd-2024-compendium/data/COVERAGE.md#character-rules-and-contextual-details)
document Human's explicit skill and eligible Origin-feat choices, Musician's
three instruments, Crafter's three tools from its eight-entry table, and
individual tool choices for Noble, Guard, Soldier, Entertainer and Artisan.
Skilled remains a recommendation for Human, never an automatic selection.

The Engine applies one canonical eligibility policy to typed skills, typed tools
and mixed proficiency choices. Fixed and earlier valid proficiencies are
excluded while each acquisition retains its own selections. Class and direct
origin training precede feats granted at that level. Combined skill/Expertise
training can improve an existing proficiency; rest-replaceable training checks
current fixed and permanent training without invalidating earlier choices.
Six synthetic regressions cover ordering, aliases, input immutability, feat
eligibility, dependent ownership, later grants and replaceable training.

Five [installed regressions](../../frontend/test/browser/installed-character-origin-fixture.mts)
exercise independent background/Human Skilled acquisitions, explicit feat
selection, source replacement, duplicate rejection, targeted slot repair,
autosave and reload. Tool coverage uses every changed background and both
changed tool feats. Invalid requests leave the saved revision unchanged; valid
replacement preserves unrelated acquisitions, notes and current HP. The existing
Skill Expert case now also asserts that its pool excludes the two skills
already granted by its background while retaining its own selected skill.

Screenshot review exposed a focus collision between repeated Selection labels.
Sheets now supplies source-scoped field keys before the host enhances the tree,
using the existing `ui.controls.v1` contract. The same shared controls render
these provider declarations without species- or feat-specific UI. The installed
English desktop and Czech 390-pixel/200%-text cases assert focus after each
autosave, keyboard feat selection, saved values after reload and no horizontal
page overflow. Final screenshots were visually reviewed.

Validation: Engine tests/vet, native race checks and all three worker targets;
Sheets build, five TypeScript tests, Go tests/vet and a fresh package;
Compendium build/types and 64 tests; all four package inspections. The final
complete `npm run check` passed 32 tooling, 389 unit and 364 browser tests with
zero failures, cancellations or skips, followed by all host Go tests and vet.

`node scripts/companion-suite.mts test full` passed **124/124**, zero skips,
using the clean committed companion sources below.

An earlier full-host attempt passed the character regressions but timed out
waiting for `selection-a` before the first action in the existing installed
planner group-selection case. That case passed in the subsequent complete
installed suite and final full host gate with unchanged DM Tools bytes. No cause
or repair is established; the intermittent startup failure remains an
investigation under T18-DM.

| Add-on | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools | `0eeac9b` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `1faa785` | `b570f3f913445615ae40aeded885f0767a221719c4da855ee86ffab2144b0b4b` |
| Sheets | `f184eda` | `706750b7954d5eb677bcf409d407e71ba16340407bacfa5d9ff69b890bd4ea2e` |
| Compendium | `87c1402` | `b88bd0335946b27e4660e4db7949ca76c4ea35e9c258eb87008048facb601ef1` |

Host acceptance used `e7aea00` plus this batch's installed fixtures. Native
workers ran on Windows; Linux targets were cross-compiled and inspected.
Physical touch, screen-reader and live-site checks remain separate. These local
results do not establish publication, deployment or live add-on activation.

This closes the declared PHB origin skill/feat/tool choices and the observed
focus defect. Inspiration, crafting actions/discounts, starting equipment,
species size choices and the broader Engine T32, Sheets T33 and T18 workflow
reviews remain outside this completed scope. The remaining Human Small/Medium
data gap is recorded in T18-COMP.

## Equipment preservation and attunement eligibility

September 17, 2026. T32-EQUIPMENT-SLOTS, T33-EQUIPMENT and T43-HOST
complete this batch. Source commits: Engine `2d1101e`, Sheets `b015083`.

The backpack's equip action moved every matching armor/shield instance into
carried inventory, including stored spares. Both entry points now use one
transition that replaces only the equipped occupant of the Engine-declared slot.
The Engine shares slot classification across guidance, validation and saved
projections; Sheets no longer guesses from catalog kind or special item IDs.
Older saved sheets use retained source facts, and changed/unavailable rules
continue to freeze mechanical editing.

Attunement guidance now supplies translated rejection reasons and supports
explicitly authorized custom-item grants. Checks exclude the candidate's own
attunement benefits and conditional waivers from its prerequisite evaluation.
Independent active grants can qualify it; expired/revoked prerequisites block
saving without silently changing authored inventory. Capacity uses the final
authorized limit, eliminating a misleading warning based on the lower class
limit. Unsupported predicates still require exact recorded DM adjudication.

The equipment rule boundaries were checked against the official
[2024 equipment rules](https://www.dndbeyond.com/sources/dnd/br-2024/equipment#Attunement)
and [magic-item prerequisites](https://www.dndbeyond.com/sources/dnd/br-2024/magic-items).
The implementation keeps equipped state separate from attunement, enforces
capacity and duplicate-copy policy, and leaves unmodeled rest timing, distance
and death events to authored decisions. It does not add class/spellcaster
predicate vocabulary or infer mechanics from prose.

Four pure Engine regressions cover arbitrary slot IDs/kinds, conflicting
occupancy, capacity/duplicate rejection, grant withdrawal, custom attunement,
self-qualification and unknown-prerequisite waivers. Four Sheets regressions
cover preserved inventory, denied actions and repair, saved slot/evidence
fallback and both languages' explanations.

Four new [installed cases](../../frontend/test/browser/installed-character-equipment-fixture.mts)
exercise backpack moves and keyboard slot selection, atomic duplicate/capacity
rejection, deliberate unattuning, autosave/reload, preserved HP/notes/item
provenance and rule-derived ability changes. The existing provider-removal case
also verifies armor/shield grouping without the Compendium.

English Compact and Czech Classic run at 390 pixels with 200% text. Visual
review exposed intrinsic ability-card overflow, long skill labels, a squeezed
Add item action and a dialog that initially skipped its explanation. Shared
layout rules now wrap these elements. The reusable dialog helper focuses its
heading for long equipment choices and restores focus to the refreshed trigger,
following the [WAI-ARIA modal-dialog guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
The host's borrowed controls, styling and keyboard containment remain in use.

Validation: Engine tests/vet and three rebuilt worker targets; Sheets build,
nine browser-module tests, Go tests/vet and a fresh package; all four host ZIP
inspections. The complete `npm run check` passed **32 tooling, 389 unit and
368 browser tests**, zero failures/cancellations/skips, plus host Go tests/vet.
Final English/Czech phone screenshots were visually reviewed.

`node scripts/companion-suite.mts test full` passed **128/128**, zero skips,
using the clean committed companion sources and inspected ZIPs below.

| Add-on | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| dm-tools | `0eeac9b` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| dnd-engine | `2d1101e` | `69241f9c74e696afbd8a348be0bacd643993a511cb5fffd042b2242e2e04378d` |
| dnd-sheets | `b015083` | `bb7e2dec30c014fec80bcabfe856b0e041863571facfbccdf880c6cdcdeaaf4a` |
| dnd-2024-compendium | `87c1402` | `b88bd0335946b27e4660e4db7949ca76c4ea35e9c258eb87008048facb601ef1` |

Host acceptance used `c1350cb` plus this batch's fixtures. Companion worktrees
were clean at final inspection. Native workers ran on Windows; Linux targets
were cross-compiled and inspected. These results establish local acceptance;
publication, deployment, live activation, physical touch and human screen-reader
checks remain separate.

This closes inventory preservation, shared slot behavior and the exercised
attunement capacity/repair paths. Source-specific installed prerequisite cases,
conditional repeats, repeated spell/resource effects, deeper multiclass builds
and the remaining T33 command/session failure cases stay open in the backlog.

## Character command recovery and uncertain outcomes

The autosave queue retained uncertain requests, but direct play/grant commands
lost their request after a failed reply. Their generic error also left editing
and navigation unguarded. Reviewed import commits retained their token in a
modal closure, without a shared recovery path. An older background read could
also replace the result displayed after a completed command.

Sheets now holds one exact command until a response confirms it or the user
explicitly checks saved state. Play, grant/amend/revoke and rules-adoption saves
share this path with approved import commits. Retry preserves the operation ID,
expected revision, payload and approved import token. It never creates or
approves another import preview and never rebases a command onto another
editor's revision. Conflicting responses require an explicit check and decision.

While an outcome is unresolved, mechanical changes and background refresh pause,
the host navigation guard stays active, and shared controls show recovery in
English/Czech. The review dialog closes when committing so it cannot hide Retry.
Checking saved state requires confirmation and clears the pending command only
after a successful read; it does not undo an action. Grant name/reason remain
visible during recovery. Saved export remains available. Acknowledgments that
omit evaluation refresh the current guidance through a read, without another
write. Reads started before the command cannot overwrite its newer result.

The native coordinator's existing current-state deduplication is retained.
Three worker regressions simulate a durable write followed by a lost reply,
restart the coordinator without its transient previews, and acknowledge play,
grant and import operations even with the Engine unavailable. They also verify
host read authorization and rejection of an older request after a later write.
No persisted history, device drafts, schema or service contract was introduced.

Eight new [installed cases](../../frontend/test/browser/installed-character-command-fixture.mts)
cover failed delivery and lost acknowledgments for play/import, grant amendment
and revocation, exact request reuse, one saved effect, original import approval,
delayed reads, competing edits, and failed/cancelled/successful checks of saved
state. Both Compact English and Classic Czech exercise keyboard recovery at
390 pixels with 200% text; both screenshots were visually reviewed. Recovery
uses the existing host controls and state styling.

Validation: Sheets passed its build, nine browser-module tests and Go tests/vet,
then rebuilt its package. All four companion ZIPs passed host inspection with
clean companion worktrees. The full host `npm run check` passed **32 tooling,
389 unit and 376 browser tests**, zero failures/cancellations/skips, plus Go
tests/vet. The host guide now links the command recovery fixtures.

`node scripts/companion-suite.mts test full` passed **136/136**, zero skips,
using the clean committed companion sources and inspected ZIPs below.

| Add-on | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| dm-tools | `0eeac9b` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| dnd-engine | `2d1101e` | `69241f9c74e696afbd8a348be0bacd643993a511cb5fffd042b2242e2e04378d` |
| dnd-sheets | `6325243` | `95b4b07293b5ddd12399a3cc07a4c1c942daf19d994753cb3cfe5a7b92edd84c` |
| dnd-2024-compendium | `87c1402` | `b88bd0335946b27e4660e4db7949ca76c4ea35e9c258eb87008048facb601ef1` |

Host acceptance used `a00c3de` plus this batch's fixtures. Native workers ran on
Windows; Linux binaries were cross-compiled and inspected. No live activation,
physical touch, printer or human screen-reader check was performed.

This closes T33-COMMANDS and T44-HOST. Session expiry, provider/generation
replacement with pending edits, remaining returned-message localization and
broader Engine/Sheets workflow acceptance stay open in the backlog.

## Repeated compatibility failures and pinned source revisions

September 17, 2026. T45-HOST addresses the recurring publication failure.
The latest [run 35173540840](https://github.com/pjunak/ttrpg-codex/actions/runs/35173540840)
on host `a00c3de` passed **Run test suite** and deployment configuration, but
installed compatibility failed **11 of 128** tests. **Build image** and deployment
were skipped. This failure did not reach either production server.

The last three failed runs tested different companion sources from the locally
accepted batches:

| Run / host | Engine in CI | Sheets in CI | Compendium in CI | Installed result |
| --- | --- | --- | --- | --- |
| [35156730360](https://github.com/pjunak/ttrpg-codex/actions/runs/35156730360) / `17b3224` | `41e26c1` | `8b3bb30` | `e8cc635` | 104 passed, 9 failed |
| [35162568876](https://github.com/pjunak/ttrpg-codex/actions/runs/35162568876) / `e7aea00` | `41e26c1` | `8b3bb30` | `8e1e9d7` | 107 passed, 12 failed |
| [35173540840](https://github.com/pjunak/ttrpg-codex/actions/runs/35173540840) / `a00c3de` | `e5f1027` | `e066de3` | `8e1e9d7` | 117 passed, 11 failed |

All three used DM Tools `0eeac9b`. The latest run lacked Engine `1faa785` /
`2d1101e`, Sheets `f184eda` / `b015083`, and Compendium `87c1402`.
Its failures covered dependent Skill Expert repair, Human/background/tool
choices, equipment slots, attunement reasons and source adoption. Those features
were already accepted locally with the newer matching packages.

The compatibility workflow omitted checkout refs, so GitHub selected each
companion's moving remote default branch. Local acceptance used adjacent local
checkouts. A host push could therefore arrive before its dependencies, and a
rerun could silently test a different source set. The runbook described delivery
order but did not enforce it. These were coordination failures; the earlier
[Linux ZIP permissions](#linux-compatibility-failure-and-companion-delivery),
[native shutdown race](#native-shutdown-race-follow-up) and
[reflow checks](#deployment-gate-repair-and-engine-follow-up) were separate defects.

The fix makes [`companion-revisions.json`](../../companion-revisions.json) the
explicit source set. The new [revision tool](../../scripts/companion-revisions.mts)
records clean committed checkouts, rejects mutable/unknown/duplicate pins, checks
exact remote commit availability and supplies the four checkout refs. CI verifies
the resulting clean checkouts before packaging. Local inspection and installed
acceptance reject packages attributed to different source revisions. Missing
commits produce an early repository/SHA error with no default-branch fallback.
Failed acceptance now includes safe source/hash evidence in the job summary;
private package contents remain outside public artifacts. The existing full
compatibility, zero-skip, package and publication gates remain in force.

Run 35162568876 also independently failed the desktop reader-inspection test.
It navigated from an inspected character to Locations and immediately back,
without waiting for the intermediate hash route to render. Same-document
navigation completion did not establish that the character component had
unmounted. The fixture now waits for the Locations heading and character-view
detachment before returning, then asserts the normal reader view. Desktop and
phone regressions passed; no timeout or product visibility rule was relaxed.

Validation for the host worktree based on `17a3d2f`:

- Strict TypeScript and **27 focused tooling/policy regressions** passed,
  including all **18 workflow-policy checks**.
- Full `npm run check` passed **38 tooling, 389 unit and 376 browser tests**,
  zero failures or skips, plus Go tests/vet.
- Release readiness passed all **33 historical product-parity gates**.
- All four existing packages passed fresh inspection against their pins.
  `node scripts/companion-suite.mts test full` passed **136/136**, zero skips.

The pinned sources and ZIP hashes are unchanged from the
[T44 acceptance table](#character-command-recovery-and-uncertain-outcomes):
DM Tools `0eeac9b`, Engine `2d1101e`, Sheets `6325243`, Compendium `87c1402`.
Companion worktrees were clean at inspection. Native workers ran on Windows;
this change has not yet run in Linux CI or published/deployed a new image.

A live availability check accepted the pinned public DM/Engine commits and
correctly rejected Sheets `6325243` with HTTP 404. Its remote main was still
`b015083`; the private Compendium remote main was verified as `87c1402` using
Git. During authorized delivery, publish the pending Sheets commit before the
host fixes, then require the full pinned Linux suite and both site results.
Earlier successful rollouts remain historical evidence, not acceptance of this
candidate. Follow the [coordinated delivery procedure](../SELF_HOSTING.md#coordinate-host-and-companion-commits).

## Add-on session renewal without losing pending edits

September 17, 2026. T46-HOST closes the same-generation session-recovery part of
Sheets T33 through the shared host runtime. No companion source or package
revision changed.

The new installed regression first failed against the previous host: after
revoking a real session, making an unsaved inventory-name edit and signing in
again, the original character element was disconnected. The shell restarted
all add-ons during recovery, retiring the element's pending input/request.
Existing host-issued data/service clients also captured the old CSRF token,
so a same-role cookie renewal could leave an otherwise valid mounted client
unable to save.

The host now renews credentials after verifying the same real and effective
role, retaining unchanged contribution elements and their opening revisions.
Graph authorization rejection can pause refresh while the existing shared
sign-in form remains on screen. Explicit logout and unrecoverable authority
changes still dispose generations, including when stop races the recovery
decision. A renewed token does not revive an aborted scope or change a service's
provider generation, binding revision, permissions or a mutation's expected
revision. Authentication remains server-owned.

The [installed session fixture](../../frontend/test/browser/installed-character-session-fixture.mts)
covers DM desktop and Czech player phone recovery, wrong passwords, wrong-role
sign-in, preserved input and unload guards, retained element identity, explicit
retry with the exact original request, concurrent edits while signed out, and
same-role cookie renewal without a reload. Signing in sends no replacement save.
A conflicting retry leaves the local input pending and the newer saved state
untouched. The interface reuses the host's existing controls and recovery form.

Focused unit tests cover paused refresh/resume, stop during pending recovery,
declined/failed recovery and credential renewal on both service and data clients.
The existing generation and optimistic revision checks remain in force.

Validation on host `e6217bc` plus this batch's changes: full `npm run check`
passed **38 tooling, 394 unit and 380 browser tests**, zero failures/skips,
plus Go tests/vet. The four companion contract suites passed (DM Tools 56,
Compendium 64, Sheets 9 browser-module tests plus Go, and Engine Go). All 18
workflow-policy checks and 33 historical release-readiness gates passed.
Fresh inspection accepted all four unchanged pinned ZIPs. The separate
`node scripts/companion-suite.mts test full` run passed **140/140 installed
package tests**, with zero failures or skips.

Actual provider/package graph replacement remains a cold switch and is not
closed by this batch. Sheets T33 still needs pending-edit acceptance across
that replacement, explicit rules adoption after a rejected autosave, and remaining
returned-message localization. No device-draft storage or history was restored.
Validation used disposable local hosts and Windows workers; publication,
Linux CI and live-site acceptance remain separate.

### Cleanup progress estimate

This is an approximate effort assessment, not a count of the growing number of
completed sub-batches:

| View | Estimate | Basis |
| --- | --- | --- |
| Implementation across the five repositories | About **80%**, with a plausible 75–85% range | Most host/backend/shared-UI restoration is complete. Large open Engine T32 and Sheets T33 tasks already contain several accepted slices. |
| Complete cleanup including release and workflow acceptance | About **70–75%** | Add-on full-session reviews, current publication/site acceptance and physical-device/printer checks remain. |
| Strict original task-row closure | **23 of 40**, about 58% | The September 14 repository-organized baseline `ed50919`; 23 of 39 (about 59%) if the conditional future-migration task T08 is excluded. Open umbrella tasks receive no partial credit in this count. |

The original September 11 audit (`48d2692`) and September 14 continuation
(`5b9f7ae`) provide the historical restoration scope; the organized backlog
provides the stable task IDs. Later shared UI, data corrections and reliability
batches expanded that scope, and their completion is not counted twice as
original tasks. Historical 33-gate release readiness is not a current completion
percentage.

Most remaining development is in Engine/Sheets edge cases and recovery,
Sheets T25 combat/spell presentation, Compendium T31 phone navigation, full
add-on workflow reviews, and generated-artifact ownership in all four add-ons.
T15–T17 retain operational/site work. Conditional C-items and untriggered
schema migrations are not promises required for cleanup completion. The
remaining reviews can discover additional defects, so the estimate has
moderate confidence and should be refreshed after those reviews.

## Explicit rules adoption with pending character edits

September 17, 2026. T33-ADOPTION (batch T47) repairs three connected defects:
a rejected autosave did not update the sheet's rules status; adoption waited
for the blocked autosave; and successful persistence left `rulesChanged` true.
Both the installed missing-action case and the coordinator acknowledgment test
failed before the fix.

Sheets now keeps the pending input and opening revision while exposing
**Review changed rules**. It moves focus to the borrowed Tools control,
**Adopt rules and save pending changes**, with an explicit explanation.
Reviewing sends no write. Adoption saves that input directly using the existing
worker validation and command recovery. Uncertain requests retain their exact
operation ID and revision; stale adoption never rebases over another editor.
Successful persistence clears the changed-rules flag, restoring editing without
requiring a subsequent event. English/Czech controls share the same path.
Tools actions now wrap at their natural label widths on narrow screens.

The [installed cases](../../frontend/test/browser/installed-character-rules-recovery-fixture.mts)
use a real source-policy change and worker rejection. The event stream is
deliberately disconnected to cover a save response arriving before its lifecycle
event. DM Compact desktop and player Classic Czech at 390 px/200% text retain
the pending inventory name, navigate recovery by keyboard, save exactly one
revision and clear the navigation guard. A lost adoption reply retries the
identical request; a concurrent edit preserves the remote saved value and local
pending value. The enlarged Tools layout was also inspected visually.

These T47 cases establish recovery in a mounted generation. Input transfer
between generations is accepted separately in
[T48](#pending-character-edits-across-graph-replacement). No device draft,
history, schema, manifest, permission or service-version change was added.

Sheets source: `a8ff7ce1a861f54c2ceb532b1f6ee619c751f504`; inspected ZIP SHA-256:
`5c776f6ac1fc14a98c12666256e3073131b659b7691fb94390accbaebaea205a`.
The host's [companion pins](../../companion-revisions.json) record that exact
source. The other three companion sources and inspected packages are unchanged.

Validation: Sheets `npm run check` passed (9 browser-module tests plus Go
tests/vet); standalone packaging and host inspection passed. Four focused
installed recovery cases passed, followed by the enlarged-phone case after the
Tools layout correction. Against host `1c01bb5` plus this batch, full
`npm run check` passed **38 tooling, 394 unit and 384 browser tests**, zero
failures/skips, plus Go tests/vet. The separate
`node scripts/companion-suite.mts test full` passed **144/144 installed tests**
with zero failures/skips on the inspected source set. All 33 historical release-
readiness gates passed.

Checks used disposable local data and native Windows workers. Linux targets
were cross-compiled and inspected; Linux CI and live-site acceptance were not
performed. During authorized publication, publish the Sheets commit before
the host commit that pins it; site owners still review and activate its package.

## Pending character edits across graph replacement

September 22, 2026. T48-HOST and T33-LIFECYCLE address pending character input
lost when a rules-policy or provider change cold-restarts the browser graph.
The unchanged package's cached custom-element class also captured its first
activation's aborted services. New instances now take current services while
old instances keep their expired handles.

The host exposes an optional, typed
[record edit handoff](../../examples/addons/API_V3.md#pending-record-edits-during-generation-replacement)
through the existing shared edit handle. It copies bounded plain JSON, keeps
the navigation guard through a reload/update gap and scopes recovery to the
same outlet, add-on, contribution and record. Failed mounts retain the copy
and a localized waiting notice. Ordinary departure, authority/outlet disposal,
disable/uninstall and removal from the settled graph clear it. Other outlets
and isolated frames retain the existing flag-only contract.

Sheets transfers pending inputs, their original saved base/revision and queued
version, and exact uncertain autosave or approved command requests. It reloads
current saved state through fresh handles, verifies the actor/role, restores
pending input visibly and focuses its translated recovery status. Recovery
does not automatically write or adopt rules. Retry keeps the original request;
independent edits merge against the original base, while overlapping changes
remain guarded conflicts. An import already committed before a lost reply is
acknowledged once after replacement; a definitively expired review requires
checking saved state before a new import review.

The [nine installed cases](../../frontend/test/browser/installed-character-generation-fixture.mts)
use real SSE delivery, reviewed ZIPs and native workers. They cover DM/player
source-policy changes, same-package provider reload, lost save replies,
overlapping edits, a failed replacement load, deliberate record departure,
rejected input with a concurrent independent edit, and delivered/undelivered
approved imports across package replacement. They assert exact operation IDs,
opening revisions, no automatic replay, current saved values, dirty guards
and keyboard focus. The failed-load case explicitly identifies the replacement
instance so it cannot accidentally click the outgoing sheet's similarly named
reload control.

The Czech Classic phone case at 390 px/200% text uses the borrowed shared
controls; its screenshot was visually inspected and horizontal overflow is
checked. Host unit tests cover bounded JSON, detached copies, stale handles,
one-time retrieval, guard continuity, failed mounting, contribution removal
and context/outlet disposal. A regression also proves an older replacement that
only publishes edit flags cannot silently discard an unclaimed handoff. Sheets
tests cover pending schema and request validation. No durable schema, manifest,
permission or service-version change was needed.

Sheets source: `89f86660014147096d9f1d17a20ce3bbe5c0e1d1`; inspected ZIP SHA-256:
`edfe63a285b7586eb9195295aac81d553c2ad52083ea5cba747887c2669f3a81`.
The host's [companion pins](../../companion-revisions.json) record that exact
source; the other three companions are unchanged.

Validation: Sheets `npm run check` passed (11 browser-module tests plus Go
tests/vet); packaging and host inspection passed. All nine focused installed
cases passed. Against host `3fe7376` plus this batch, full `npm run check`
passed **38 tooling, 400 unit and 393 browser tests**, zero failures/skips,
plus Go tests/vet. The separate `node scripts/companion-suite.mts test full`
passed **153/153 installed tests** with zero failures/skips on the inspected
source set. All 33 historical release-readiness gates passed.

This is page-memory recovery, not device drafts or character history.
Page reload/closure and unsubmitted dialog-only fields are outside the handoff.
Checks use disposable local data and native Windows workers. Linux binaries
were cross-compiled and inspected; Linux execution and live-site acceptance
remain separate. No commits were pushed or deployed. During authorized
publication, publish the Sheets commit before the dependent host commit;
site owners still review and activate its package.

## Localized save feedback and correctable HP

September 23, 2026. T49 completes T33's remaining save-feedback localization.
The installed Czech currency-rejection regression failed before the fix:
the surrounding recovery controls were translated, but both the coordinator
summary and the actual rule blocker remained in English.

Sheets now translates known coordinator responses and Engine blockers in the
existing shared status area. The current string-based contract uses exact
catalog entries and 14 bounded, complete-message templates. Numeric limits
come from the Engine; captured names, IDs, source wording and literal
placeholders remain unchanged. Unknown or changed diagnostics remain readable
plain text. No rules calculation, save schema, API or worker change was needed.
The [feedback contract](../../../addon-dnd-character-sheets/docs/RULES_EDGE_CASES.md#service-feedback)
records that boundary.

Installed acceptance also exposed a blocked correction: an HP rejection made
the entire character unready, disabling the same input that needed repair.
A pending HP blocker now keeps that field editable under the existing
permissions, while play commands remain blocked. The shared vitals control
uses a stable focus identity in both layouts, preserving keyboard focus after
rejection and successful correction. Incomplete builds and unavailable rules
still cannot enable ordinary HP editing.

A separate provider-free regression failed after loading settled: failed live
catalog requests replaced the worker's unavailable-rules explanation. Frozen
reading now uses the saved projection without those requests, keeping the
translated explanation visible. The installed check waits for loading to finish,
asserts zero catalog calls, preserves the saved revision and keeps HP disabled.

The [installed feedback cases](../../frontend/test/browser/installed-character-feedback-fixture.mts)
use real worker rejection, English/Czech, DM/player, Compact/Classic and
390 px/200% text. They check the exact returned limit, unsaved value, original
revision, focus and navigation guard; keyboard retry does not write, and
correction saves once. The existing Czech currency-recovery case now checks the
summary and blocker text as well as its translated actions. The Czech Classic
phone screenshot was inspected visually with no horizontal overflow.

Sheets commits: `fce458b` and `4696ae7`. Final source:
`4696ae7df38e80809d97f578f1bed1e0839174c9`; inspected ZIP SHA-256:
`027869562ac01f635d5cefec754a7cefc42608d495ddd88c0dd5a85d758f9a42`.
The host's [companion pins](../../companion-revisions.json) record that exact
source; the other three companion sources and packages are unchanged.

Validation: Sheets `npm run check` passed **15 module tests** plus Go tests/vet.
Standalone packaging and host inspection passed. Four focused feedback cases
passed; after the provider-free correction, five focused creation, play,
equipment and unavailable-rules cases passed. Against host `452c863` plus this
batch, full `npm run check` passed **38 tooling, 400 unit and 396 browser tests**,
zero failures/skips, plus Go tests/vet. The separate
`node scripts/companion-suite.mts test full` passed **156/156 installed tests**
with zero failures/skips on the inspected source set. All 33 historical
release-readiness gates passed.

Checks use disposable local data and native Windows workers. Linux binaries
were cross-compiled and inspected; Linux execution and live-site acceptance
remain separate. No commits were pushed or deployed. During authorized
publication, publish Sheets before the host revision that pins it; site owners
still review and activate its package.

## Conditional feat choices and repetition limits

September 23, 2026. T50 closes the finite-choice part of T32. The source marked
Elemental Adept freely repeatable and omitted its damage-type choice; the Engine
also treated every object-shaped repetition policy as unrestricted. Four initial
synthetic regressions failed before the correction.

The provider now declares the existing Energy Mastery options and a distinct
choice per acquisition, checked against the
[licensed 2024 reference](https://roll20.net/compendium/dnd5e/Feats%3AElemental%20Adept?expansion=32231).
The Engine interprets the generic finite-choice policy, preserving acquisition
IDs and caller inputs. Earlier valid choices reserve their values; later
duplicates receive ordinary slot-specific repair guidance. Unfinished choices
can save. Exhausted or unsupported repetition blocks saving and is excluded
from eligible feat options.

Sheets uses the existing borrowed Builder controls and dependent-choice
withdrawal. Only the two new diagnostic translations and generated catalogs
changed there. The [installed cases](../../frontend/test/browser/installed-character-conditional-feat-fixture.mts)
verify rejected writes preserve the saved revision, keyboard correction,
removal of only the invalid later pick, both ability increases, DM pool
exhaustion/revocation, reload, notes and HP. Both languages pass at 390 px/200%
text with retained focus and no horizontal overflow; the Czech screenshot was
visually reviewed. Six synthetic Engine cases also cover deterministic,
detached evaluation, unknown policies, acquisition order across classes and
changed source facts.

| Repository | Source commit | Inspected ZIP SHA-256 |
|---|---|---|
| Engine | `a5ffae95e8be31228cbb7bb1d277ad5cdf7ac13b` | `03c1f9d100418e94f4be33f2bb8b7e40b530518b9dd091e6cef9b56a0806a20f` |
| Sheets | `eab091da89aa1e10995cb564de055e122f605ceb` | `85c183a336f3dee8b8b3386bf214424e24ff9a31fbe27c240ed59f4e77b2ef4f` |
| Compendium | `014ed02c15d31e7bd41f4151ff0f9b2f3d3417ca` | `55e333c422d41c8e420adf69b0fb8f529d1ab6becaac76b2f3fe637bd2667d41` |

The [host pins](../../companion-revisions.json) record these exact sources;
DM Tools is unchanged. Engine Go tests/vet, Compendium `npm run check`
(**65 tests**), Sheets `npm run check` (**15 module tests** plus Go tests/vet),
all three package builds/inspections and **3/3 focused installed cases** passed.
Against host `e8bb8ff` plus this batch, full `npm run check` passed **38 tooling,
400 unit and 399 browser tests**, zero failures/skips, plus Go tests/vet.
All **33 release-readiness gates** and **166 local document links/anchors** passed.
The separate `node scripts/companion-suite.mts test full` passed **159/159
installed tests**, zero failures/skips, on the inspected source set.

Magic Initiate's repeated spell-list choices, repeated spell/resource effects,
deeper multiclass acceptance and source-specific attunement remain in T32.
Elemental Adept's narrative prerequisite still needs explicit authenticated DM
adjudication; encounter damage resolution remains prose. Checks use disposable
local data and native Windows workers. Linux workers are cross-compiled and
inspected, with Linux execution and live-site acceptance separate. No publication
or deployment was performed. During authorized publication, make the companion
commits available before the dependent host revision; activate the supporting
Engine before the new source package through ordinary review.

## Acquisition-owned spell grants and complete Combat details

September 23, 2026. T51 closes T25 and the repeated spell/resource part of
T32. It keeps the existing progressive build, current-state save and reusable
host UI contracts.

Repeated feats previously shared spell choices, casting abilities and resource
keys. Two acquisitions could therefore overwrite one another's choices or
share a free cast. The Engine now carries the existing acquisition identity
through grant evaluation, activations and resources. Each grant retains its
own casting ability, pool and rest behavior. A chosen spell's free allowance
belongs to its choice, so replacing or temporarily clearing the spell cannot
refresh a spent cast. Unambiguous old keys move to one unoccupied owner in
detached evaluation; ambiguous state remains available for explicit assignment.
A play command uses the normalized inputs, preserving previously spent uses
on the first command after an update. The
[Engine contract](../../../addon-dnd-engine/contract/README.md) records these
generic source and identity rules.

Magic Initiate now declares one cleric, druid or wizard list for all three
selected spells and different lists on repetition. Five existing backgrounds
declare their source-owned origin preset. The existing prose and record IDs
are preserved. These mechanics were checked against the
[official 2024 feat](https://www.dndbeyond.com/sources/dnd/br-2024/feats#MagicInitiate);
the [provider schema](../../../addon-dnd-2024-compendium/data/SCHEMA.md) owns the
preset field. No feat ID or edition-specific rule was added to Sheets controls.

The broader spell fixture exposed a separate multiclass defect: adding Wizard
after Fighter incorrectly requested the Wizard's starting skill choices.
Only the initial class now uses its starting proficiency declaration; every
later class uses the reduced multiclass declaration, including an empty one.
Synthetic cases cover class order and absent, empty and smaller skill pools.
This follows the official
[multiclass proficiency rule](https://www.dndbeyond.com/sources/dnd/br-2024/creating-a-character#Multiclassing)
and [Wizard entry](https://www.dndbeyond.com/sources/dnd/br-2024/character-classes#BecomingaWizard).

Sheets removes invalid dependent spell selections only when they still equal
the previously saved values. New invalid input remains a visible save blocker;
valid sibling selections and still-present spent pools survive structural
changes. Autosave reconciliation preserves newer browser edits. Ambiguous
saved choices, abilities, resources and activations use explicit assignment
or discard through the existing borrowed controls.

One shared name/level filter now serves Builder, class, ritual, granted and
saved provider-free spell views. It announces empty results, preserves selected
values, uses stable field identities and performs no save. Granted rows name
their source and casting ability. Combat restores damage type, versatile
damage, mastery and conditional senses with units and saved rule explanations.
Print includes the same sense details and granted spells. Enlarged phone
acceptance exposed overlapping resource labels; the shared Combat layout now
wraps them above their counters. Compact and Classic remain on the host's
semantic styling and controls.

The [installed cases](../../frontend/test/browser/installed-character-spell-fixture.mts)
exercise three repeated grants, independent casts, short/long rests, grant
withdrawal, reload, historical aliases and three PHB background presets. The
English/Czech phone cases use Fighter/Wizard with class, ritual and granted
versions of the same spell, both layouts and 390 px/200% text. They assert name
and level filtering, zero matches, no filter writes, weapon/sense details,
no horizontal overflow and no resource-label overlap. The English spell-filter
and Czech Combat screenshots were visually inspected. The existing
provider-free case now also checks saved spell filtering, Combat and print
after removing the provider, without changing the saved revision.

| Repository | Source commit | Inspected ZIP SHA-256 |
|---|---|---|
| Engine | `9f90e4b305d0a166987cb4588eaadee2b54a0aff` | `fcc4ef1a6e8cf1d0036d480f73a85e0523c59e53cbd91d6b5d37c1bcbed6f776` |
| Sheets | `23d63d7c94841b521d9b5f783e1f6f50ae1919f5` | `5a0d564ec967611723d8d9cf9222d1c57510e5f778e4c70ea7d92f427f51620f` |
| Compendium | `736f95a4dfb1a248443cf3414f7536be911b0d62` | `1084cf7f3b7aec13daaf4af86e2a0f7a5d96d75ca0ea248239f9fb081f70d8ae` |

The [host pins](../../companion-revisions.json) record these sources; DM Tools
is unchanged. Engine Go tests/vet, Compendium `npm run check`
(**66 tests**), Sheets `npm run check` (**17 module tests** plus Go tests/vet),
and all three standalone package builds/host inspections passed. Seven
synthetic spell-grant regressions additionally cover detached inputs, repeated
activation costs, bonus slots, and retained free allowances during repair.
Captured historical parity oracles remain unchanged; their comparison explicitly
records the corrected grant resource identities and pending allowance.

Against host `71da8f0` plus this batch, full `npm run check` passed
**38 tooling, 400 unit and 404 browser tests**, zero failures/skips, plus Go
tests/vet. The separate `node scripts/companion-suite.mts test full` passed
**164/164 installed tests**, zero failures/skips, against the exact committed
source set and inspected hashes above. All **33 release-readiness gates** and
**160 local document links/anchors** passed.

Deeper multiclass progressions and source-specific attunement acceptance remain
in T32; whole-session/device acceptance remains in T18. Checks use disposable
local data and native Windows workers. Linux workers are cross-compiled and
inspected; Linux execution, human assistive-technology checks, physical printing
and live-site acceptance are separate. No publication or deployment was
performed. During authorized publication, make the companion commits available
before the dependent host revision and activate the supporting Engine before
the new source package through ordinary review.

## Multiclass progression and source-specific attunement

September 23, 2026. T52 completes T32's remaining progressive-build and
equipment validation acceptance. Whole-session and device acceptance stays in
T18; this is not an exhaustive proof of every rules combination.

Three calculation defects were reproduced with synthetic source records.
Pact Magic incorrectly made one Spellcasting class use the combined table,
reducing an Eldritch Knight's slots. An ordinary subclass feature table could
replace its class's spell progression. A later class without a reduced
proficiency declaration received its starting armor, weapon and tool training.
The Engine now selects the owning spell table, counts only Spellcasting
classes for the combined pool, and shares the initial-versus-later proficiency
decision across skills, equipment training and weapon attacks. Per-class
preparation limits remain independent of shared slots. These decisions follow
the [official multiclass rules](https://www.dndbeyond.com/sources/dnd/br-2024/creating-a-character#Multiclassing)
and the generic [Engine contract](../../../addon-dnd-engine/contract/README.md).

The Compendium declares existing restrictions on 21 DMG items: 13 named-class
requirements, seven intrinsic-spellcaster requirements, and Dwarven Thrower's
unsupported species/item condition as an explicit adjudication requirement.
The Engine interprets generic class minimums and intrinsic spell capability,
including trait/feat casting; item-granted spells cannot qualify another item,
and spent uses do not remove eligibility. This follows the
[official attunement rules](https://www.dndbeyond.com/sources/dnd/br-2024/magic-items).
Record IDs and prose are unchanged. These declarations do not implement item
charges, actions or effects; those still require typed source mechanics or
authenticated DM adjudication. See the
[source schema](../../../addon-dnd-2024-compendium/data/SCHEMA.md#item-attunement-prerequisites).

Five [installed acceptance cases](../../frontend/test/browser/installed-character-multiclass-fixture.mts)
cover:

- Eldritch Knight 4/Warlock 1 advancing to Knight 7/Warlock 1/Wizard 3,
  separate and shared slots, cross-pool casting, higher-level preparation
  rejection, upcasting, short/long rests and preserved spent uses and notes.
- Named-class versus Magic Initiate qualification, rejected loss of a required
  trait, and unchanged stored state after rejection.
- An exact independent DM waiver for an unsupported requirement, blocked
  withdrawal while attuned, then explicit unattunement and withdrawal while
  retaining the item's other grant and notes.
- English/Czech keyboard attunement and class-removal repair in Compact/Classic
  at 390 px and 200% text, retained inventory metadata, reload and no horizontal
  overflow. These use explicit manual-effect grants, not automated item powers.

The phone cases exposed focus falling to the document body after a repair
disabled its own action. The shared Sheets focus helper now moves to the next
usable control within the same declared item row, or the preceding control if
necessary. It retains host controls, semantic styling and Engine eligibility.
Both locales assert focus on the same item's location field after unattunement;
the Czech before/after screenshots were visually inspected. The approach
preserves a related [keyboard focus order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
without introducing an item-specific widget.

| Repository | Source commit | Inspected ZIP SHA-256 |
|---|---|---|
| Engine | `a3c5d0a66c945443be4db6fa25be2a12d54a5f9b` | `caaa1aaa4a2617e076986be2b00ad665807a05c11615cbb72216165b07dfe281` |
| Sheets | `28bc2ea900bbc2844dc02781b08eeda2b7f6a8af` | `9862d847d3440d9236e10b266d423fb36184b802aafcc1a7da0a8995b907e484` |
| Compendium | `00495d31446e7f4a9bc13a3e1279d1d002d03d2c` | `e5a6bbc9876d26f7f03c9d214239b70038aa247a38b142bd5f49f87451291dc4` |

The [host pins](../../companion-revisions.json) record these sources; DM Tools
is unchanged. Engine Go tests/vet, Compendium `npm run check` (**67 tests**),
Sheets `npm run check` (**17 module tests** plus Go tests/vet), and all three
standalone package builds/host inspections passed. Synthetic regressions
cover missing proficiency declarations, class/subclass spell-table ownership,
Pact class order, per-class preparation and detached attunement inputs.
The historical parity data remains unchanged; comparisons explicitly record
the corrected source-owned spell table and absent reduced proficiencies.

Against host `8543f07` plus this batch, full `npm run check` passed
**38 tooling, 400 unit and 409 browser tests**, zero failures/skips, plus Go
tests/vet. The separate `node scripts/companion-suite.mts test full` passed
**169/169 installed tests**, zero failures/skips, against the exact committed
source set and inspected packages above. All **33 release-readiness gates**
and **178 local document links/anchors** passed.

Checks use disposable local data and native Windows workers. Linux workers
are cross-compiled and inspected; native Linux execution, human assistive
technology, physical touch/printing and live-site acceptance remain separate.
No publication or deployment occurred. During authorized delivery, publish
the companion commits before the dependent host revision and activate the
supporting Engine before the new source package through ordinary review.

## Character session transfer and saved output

September 23, 2026. T53 completes a continuous-session transfer/output slice
of T18-ENGINE and T18-SHEETS. The broader acceptance rows remain open.

A real export containing a DM-granted feat and its chosen spells failed import:
reauthorization replaced the grant ID but left its acquired choices and spent
resources pointing to the old owner. The coordinator also modified slices
belonging to the supplied export. The Engine now owns one acquisition encoder
and a pure, detached reference remapper. Sheets authenticates the current DM,
rejects ambiguous grant IDs, remaps the acquired state and stamps fresh grant
provenance before the existing exact review/commit path. Counters retain their
spent amounts; imports cannot refresh allowances by changing identity.

[Engine regressions](../../../addon-dnd-engine/character/grant_references_test.go)
cover nested owners, all supported reference fields, simultaneous ID swaps,
collisions, invalid encoding and unchanged authored values/caller input.
[Coordinator regressions](../../../addon-dnd-character-sheets/internal/character/import_inputs_test.go)
cover authenticated provenance, preserved acquired choices/resources/item links,
imported claim markers and rejected empty/duplicate identities.

Printed sheets omitted currency, and basic character identity appeared only
when extra provenance was selected. Print now includes saved species/lineage/background,
class levels and every stored currency value. Turning off equipment or spells
does not hide currency or identity. Labels come from saved evidence and mechanics
from the saved projection; neither printing nor export recalculates or saves.

Local import errors previously appeared behind the modal. File parsing/size and
missing-DM-authorization errors now remain visible inside it with input preserved.
The replacement review focuses its heading, and cancellation returns focus to
the current Import action after rendering. This uses the existing shared dialog,
notice and focus conventions, following the
[WAI-ARIA modal-dialog guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
Server authorization remains mandatory; a forged player approval is rejected.

Four [installed acceptance cases](../../frontend/test/browser/installed-character-output-fixture.mts)
cover:

- English Compact and Czech Classic journeys starting from an API-seeded ready
  Fighter with an authenticated Magic Initiate grant. UI actions advance a level,
  equip a shield, change currency, take damage, cast, rest and reload. Raising
  maximum HP does not heal; short/long rest preserve/reset the declared allowance.
- Actual downloaded exports, canceled and confirmed replacement reviews, fresh
  grant provenance, unchanged choice/spell/resource values and inventory notes.
  Cancellation writes nothing and restores the Import button's focus.
- Default and reduced print options, literal item-note text, saved identity and
  currency, PDF generation and phone Tools at 390 px with 200% text.
- Player export, in-dialog authorization feedback with preserved input, absence
  of the DM approval control and rejection of a forged server request.

The existing [standalone-package cases](../../frontend/test/browser/installed-sheets.browser.mts)
now verify malformed pasted/file input, oversized-file rejection, retained text,
visible error focus and return to Import for DM/player without an Engine.
Full English print-media and enlarged Czech phone screenshots were visually
inspected; the output remains readable without horizontal overflow.

The final provider-removal case also reopens both session characters, exports
their frozen inputs and prints their saved details without changing revisions.
This is a continuous play/transfer journey after a seeded ready character,
not an end-to-end UI creation test from a blank sheet.

| Repository | Source commit | Inspected ZIP SHA-256 |
|---|---|---|
| Engine | `c5a9be713512472287479f045ebbabaf928b7648` | `1376e1d672e40a43b190d5097dc0429eafb41c0688ffbcea02401be13230cdea` |
| Sheets | `3931526d50b9c982b48afd5522f1558340aafff5` | `5defd40d878ad845ac431833451ef3643f7e6bb7c6e914c13532e7c1733c9a2d` |
| Compendium (unchanged) | `00495d31446e7f4a9bc13a3e1279d1d002d03d2c` | `e5a6bbc9876d26f7f03c9d214239b70038aa247a38b142bd5f49f87451291dc4` |
| DM Tools (unchanged) | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |

The [host source pins](../../companion-revisions.json) record this compatible set.
Engine Go tests/vet and Sheets `npm run check` (**17 module tests** plus Go
tests/vet) passed. Both standalone builds and host inspections passed.

The strict installed publication suite passed **173/173 tests**, zero failures
or skips, against the exact committed source set above. All four companion
worktrees were clean after package preparation. **33 release-readiness gates**
passed.

One intermediate full host run unexpectedly lost rules availability during
character setup; its later failures followed from the absent evaluation. The
previous fixture dereferenced that result without recording provider state, so
the cause was not established. Setup now emits bounded administrative lifecycle
and worker diagnostics on unexpected unavailability. Both the final strict and complete host runs passed
without recurrence; T18 retains follow-up if the outage recurs. No production
timeout, retry or health policy was weakened.

Against host `38f5314` plus this batch, final `npm run check` passed
**38 tooling, 400 unit and 413 browser tests**, zero failures/skips, plus Go
tests/vet. **174 local document links/anchors** passed.

Checks use disposable local data and native Windows workers. Linux workers
are cross-compiled and inspected; native Linux execution, human assistive
technology, physical touch/printing and live-site acceptance remain separate.
T18 retains blank-to-ready UI creation and broader complex-session/provider
combinations. No publication, deployment or production data change occurred.

## Blank-to-ready creation and stable spell selection

September 23, 2026. T54 accepts representative UI creation followed by saved
play within T18-SHEETS. The host creates only an empty public character article;
all sheet inputs, origin choices, abilities, class choices and spell selections
are entered through the installed UI. Service reads verify the results without
seeding a ready sheet or writing decisions behind the controls.

[Installed acceptance](../../frontend/test/browser/installed-character-creation-fixture.mts)
covers an English Compact Fighter as DM using point buy, and a Czech Classic
Wizard as player using the standard array and Sage origin. Guided next-choice
navigation completes the required tool, ability, skill, cantrip, spellbook and
origin spell/casting-ability selections. The player has no DM-grant action.
Both characters enter play, rest, change currency and preserve their exact saved
state and layout on reload. The Wizard additionally prepares/unprepares a spell,
casts with an ordinary slot and an origin allowance, and recovers both on a long
rest. The final provider-removal case preserves both characters' complete inputs,
saved projections and revisions.

Creation exposed a real UI regression: selecting a spell replaced its checkbox
and reset the expanded group on autosave. Search and level filters were also
recreated empty. The new shared
[spell picker](../../../addon-dnd-character-sheets/src/character-spells.ts)
serves class cantrips, spellbooks, preparation and origin/feat/granted selections
in both Builder and Manage spells. Stable field keys use the host's existing
ui.controls.v1 focus restoration. Per-character view state retains filters and
expanded groups through saves and tab changes; it is not persisted as authored
character state. The enclosing Manage spells disclosure also retains its state.

Screenshot review found a second issue at 390 px with 200% text: a score tile
left too little horizontal room for skill labels, splitting words into a few
letters per line. All ability cards now share a container-width rule that stacks
scores and skills when necessary, retaining the heading first in Classic.
The browser regression checks readable skill-label height and no page overflow
in both layouts/locales. Focused ability-card screenshots are visually inspected.

The earlier T53 rules-availability outage did not recur in the diagnostic replay:
all 13 selected graph-handoff, import-retry, stale-read and uncertain-command
cases passed. Worker health, cancellation and provider-cache paths were traced,
but no root cause was demonstrated. T18-ENGINE retains the unexplained outage;
production timeouts, health checks, retries and admission limits are unchanged.
Empty-record setup now shares the existing bounded provider diagnostics.

Sheets commits `29838b23479b5f4920669a9f5ca5d96a5a1043ae` (spell picker) and
`93396af1803b86e780548af469289a2946f58a3d` (ability reflow) form the final package.
Its inspected SHA-256 is
`1e1814875493e72893e30826b2cbf1ee85e00c5b93cd9bdccc2c1a09f292e535`.
The host pins that final source; the Engine, Compendium and DM Tools revisions
and archive hashes are unchanged from T53. Sheets `npm run check` passed all
17 module tests plus its build, Go tests and vet; standalone packaging and host
inspection passed. Both final ability-card screenshots were visually inspected.

Against host `2e8dab6` plus this batch, complete `npm run check` passed
**38 tooling, 400 unit and 415 browser tests**, zero failures/skips, plus Go
tests and vet. Local documentation links and anchors passed (**169 checks**).
The full run again passed the former outage scenario without recurrence.

Strict installed acceptance passed **175/175 tests**, zero failures/skips,
against those exact pinned source revisions and inspected ZIP hashes. All four
companion worktrees remained clean. The earlier outage did not recur in this
run either. All **33 release-readiness gates** passed.

Checks use disposable local data and native Windows workers. Linux workers
remain cross-compiled and inspected rather than natively exercised here.
Broader amended-grant/provider/schema combinations and human assistive-technology,
physical touch/printing and live-site acceptance remain open under T18.
No publication, deployment or production data change occurred.

## DM grant amendments and provider transitions

September 23, 2026. T55 covers amended multi-grant sessions within T18-SHEETS
and T18-ENGINE using installed, reviewed packages and disposable campaign data.

The coordinator decoded a copy over existing Go slices/maps, which could change
the saved snapshot while preparing an amendment. Rejected or unavailable
commands could then return proposed values as though they were saved.
A fresh detached input now protects both saved and supplied values. Amendments
retain grant identity and list position, update current DM provenance, and
clear obsolete item links when moved or revoked. Unrelated grants and authored
inventory remain intact. Coordinator regressions cover rebinding, detaching,
revocation and unchanged rejection/unavailability responses.

The shared create/amend form previously rebuilt every effect control after a
target change, losing keyboard position. It now retains each row and gives it a
unique field identity and named group. Adding an effect focuses its target;
removing one focuses a surviving row or Add effect. Required controls use
native form validation, leaving incomplete effects editable in the dialog.
Feat and item choices borrow the existing host ui.controls.v1 combobox.
The Sheets worker retains DM authorization; the Engine retains mechanical
validation.

This treatment follows the logical focus flow described by the
[WAI dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
and the browser constraint-validation behavior documented by
[MDN](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Form_validation).
No replacement combobox or rules calculation was added to the sheet UI.
Phone screenshot review also found that repeated panel padding squeezed action
labels into broken words. Shared dialog spacing now adapts to available width,
and effect headings expose the full selected name with wrapping text even when
the native select's single-line value is clipped at 200% text.

[Installed grant acceptance](../../frontend/test/browser/installed-character-grant-fixture.mts)
runs English Compact and Czech Classic sessions. Each starts with two independent
Magic Initiate acquisitions and spends both free casts, then performs the
following through the installed grant editor:

- Add, change and remove typed effects while retaining focus and sibling values.
- Reject an incomplete effect without a command or saved revision.
- Search an item, apply an ability/speed amendment, and retain acquisition IDs,
  other grants, spell choices and spent uses.
- Rebind that grant to another item and clear its old item reference.
- Restart the rules worker without rewriting the saved snapshot or rules identity.
- Change an unused allowed source, explicitly adopt that rules revision, and
  preserve every authored input apart from the evaluation timestamp.
- Revoke the amended grant, reverse its effects, and retain the surviving
  acquisition's spent cast, inventory, notes and current HP through reopening.

The fixture checks 390 px / 200% dialog overflow, readable action wrapping,
complete effect headings and both language layouts. Both final screenshots
were visually inspected. Existing uncertain grant/amendment/revocation retry
cases also pass, preserving exactly one action after a lost acknowledgment.

Sheets commit `b9319d30f6e24964ab3958a070a9c9c3caa242b8` includes the code,
coordinator regressions, localized labels and regenerated web/native workers.
Its inspected ZIP SHA-256 is
`744007cc711a230edf68e4c11b58ef9ea4e53a5fab6432e1a25e181a3dc166cf`.
Sheets `npm run check` passed its 17 module tests, Go tests and vet; standalone
packaging, host inspection and focused installed acceptance passed. The host
pins that source. Other companion revisions and archive hashes are unchanged
from T54; all four companion worktrees are clean.

Against host `cff6c4c` plus this batch, complete `npm run check` passed
**38 tooling, 400 unit and 417 browser tests**, zero failures/skips, plus Go
tests and vet. Local documentation links and anchors passed (**166 checks**).
Strict installed acceptance passed **177/177 tests**, zero failures/skips,
against the four pinned sources and inspected archives above. All **33
release-readiness gates** passed. The earlier unexplained availability loss did
not recur in either full run; its cause remains unproven.

These checks exercise native Windows workers. Linux workers are cross-compiled
and inspected, with native Linux acceptance left to CI. Incompatible-provider
and schema transitions, broader progression combinations, the unexplained T53
availability loss and human assistive-technology/physical-device acceptance
remain in T18. No publication, deployment or production data change occurred.

## Incompatible providers, schema preservation and reachable libraries

September 24, 2026. T56 completes Compendium T31 and adds installed compatibility
and preservation evidence to T18-SHEETS and T18-ENGINE. The existing ownership
boundaries remain: the host owns lifecycle and shared UI; Sheets owns saved
character state; Engine owns calculations; Compendium owns book-partitioned
reference content. No record IDs, book/kind directories, source membership,
reprint representation or public service versions changed.

A provider validation error previously escaped a sheet load before its saved
state reached the browser. Loads now return that unchanged state with unavailable
rules when a provider rejects the request contract or returns an incompatible
response. Edit validation still fails authoritatively. Coordinator regressions
cover malformed results, incompatible outer/evaluation versions and both broker
validation/request failures, checking unchanged saved bytes and revisions.
Offline notes preserve the accepted projection and rules identity.

[Installed compatibility acceptance](../../frontend/test/browser/installed-character-compatibility-fixture.mts)
uses real inspected packages and workers. Two independent Magic Initiate grants
are saved and one free cast is spent before replacing the engine with either an
incompatible response schema or an incompatible service major. Both cases retain
the exact saved state, disable mechanical controls, and allow saved English/Czech
export and print. Reactivating the original immutable engine restores compatible
evaluation without adoption, revision changes or reset spent uses.

A separate real package changes the Sheets extension schema version. The
activation review reports DATA_MIGRATION_REQUIRED; approval and activation are
refused, the existing generation remains active, and browser writes remain
forbidden. A downloaded host backup contains the exact schema-4 character and
revision, verified through a read-only SQLite connection. This tests preservation
at the current migration boundary; it neither adds a migration nor treats the
synthetic future schema as a released product requirement.

Compendium previously placed its library after the entire reading pane on
phones. Its native disclosure now stays above the reader with a bounded
scrollable panel. Tree organization and branch changes retain the reading DOM,
URL and scroll position. Explicit collapse overrides automatic active-path
expansion; opening another record reveals its path. Escape returns focus to the
disclosure, leaving the panel closes it, and following a library link closes the
panel and focuses the new heading. Desktop/phone resizing retains usable
navigation and never leaves focus in hidden content.

The host route container now clips overflow without creating an unintended
scroll container that traps sticky add-on controls. This is a shared route fix;
the Compendium does not reach into host DOM. Existing borrowed controls and
theme tokens remain in use. Navigation stays semantic HTML rather than adding
ARIA tree/menu keyboard obligations. This follows the rationale in the
[WAI disclosure navigation example](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation/).
Closing overlays on navigation/focus departure and returning focus follows the
[WAI focus-not-obscured guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).

[Installed navigation acceptance](../../frontend/test/browser/installed-compendium-navigation-fixture.mts)
reads Wizard, Aboleth and Wish on phones in English and Czech, with Czech text
enlarged to 200%. It checks immediate/deep-scroll library reachability, retained
reading DOM and position, keyboard disclosures, Escape, viewport transitions and
focus departure. Screenshot review found overlapping enlarged book titles and
counts; responsive rows now place counts below wrapping titles, with explicit
overflow/overlap assertions. Both final open-library screenshots were visually
inspected. Existing desktop/phone browsing checks retain search/facets through
Back and reload, follow typed cross-record links, use source groups, and exercise
Retry and package replacement.

T56 exposed flattened Core Traits tables in seven PHB class records.
[T57 repairs those tables and the affected progression/subclass lists](#compendium-source-policy-and-readable-class-tables),
with preserved source facts and installed reading acceptance.

Sheets commit `d4895336f78aa57bd86c5a3ce598022557b3f64f` includes the coordinator
fix, regression tests, contract documentation and regenerated native workers.
Its inspected ZIP SHA-256 is
`cfb9d4df373d8889ce264ae9b33858762b87e6460ed33ed20b4d2ffb346113d9`.

Compendium commit `f87513366c605585d60c621f84c4c0e6534c5ff7` includes the UI,
navigation contract and regenerated browser assets. Its inspected ZIP SHA-256 is
`ae26bff58a8bc6dd0ab466798f4010d86a141cc6e9796732b3bb010027c955ba`.
The Engine and DM Tools sources/ZIPs are unchanged from T55. All four companion
worktrees are clean and the host pins these exact sources.

Owning checks passed: Sheets' 17 module tests, Go tests and vet; Compendium's
67 tests, build and tools typecheck; both package inspections; all three new
installed provider/schema cases and both long-reading cases. Against host
`0318942` plus this batch, complete `npm run check` passed **38 tooling, 400 unit
and 422 browser tests**, zero failures/skips, plus Go tests and vet. All **33
release-readiness gates** passed. Strict installed acceptance passed **182/182**
tests with zero failures/skips against all four pinned packages. Local document
links and anchors passed **189 checks**. The earlier unexplained availability
loss did not recur in either full run; its cause remains unproven.

These checks use disposable local data and native Windows workers. Linux
workers are cross-compiled and inspected; native Linux execution remains a CI
boundary. Broader multiclass/provider combinations, source-policy browsing and
content gaps, human assistive-technology/physical-device acceptance, and live
publication/activation remain open. The unexplained T53 availability loss remains
unproven; this batch does not attribute it to the newly reproduced load failure.
No publication, deployment or production data change occurred.

### Cleanup progress update, September 24

The implementation estimate is now about **90%** (roughly 85–95%), or **80–85%**
including remaining workflow, release and site acceptance. These are effort
estimates, not equal-weight counts of completed sub-batches. The original
September 14 baseline has **26 of 40 tasks closed (65%)** after closing T31;
large T18 and T14 umbrella tasks receive no partial credit in that count.
The [earlier counting method](#cleanup-progress-estimate) remains the basis.

Host restoration, Engine T32, Sheets T25/T33 and Compendium T31 are complete.
Remaining work is concentrated in the explicit T18 acceptance/content gaps,
generated-artifact ownership across the add-ons (T14), human/device checks and
authorized operations (T15–T17). Conditional extensions and an untriggered
future schema migration are not additional cleanup promises.

## Compendium source policy and readable class tables

T57 closes the remaining source-policy browsing matrix and the confirmed class
table formatting defect. It preserves the book-first record tree, typed
(kind, id) identities, canonical book provenance and genuine reprint membership.

The source formatting repair covers 24 tables in Barbarian, Cleric, Druid, Monk,
Sorcerer, Warlock and Wizard: seven Core Traits tables, eleven progression
tables and six included subclass lists. Direct comparison with the previous
commit verifies unchanged structured fields and unchanged prose/cell text.
No rules facts are inferred or added. Data regressions check each trait value,
all 20 progression levels and the retained subclass lists. The content revision
advances to 3.0.1; the rules-data service remains v3.

Source filters and book links now use the host's effective book catalog.
Disabled canonical books retain a plain provenance label on readable reprints,
without a dead book link. A stale source filter stays selected with zero matches
and an English/Czech recovery explanation; clearing it restores eligible results.
The obsolete Ravenloft empty-book note now agrees with the documented conversion
and canonical Dhampir reprint.

[Installed source and reading acceptance](../../frontend/test/browser/installed-compendium-sources-fixture.mts)
covers canonical-only, reprint-only, both-enabled and neither-enabled states for
Dhampir, Domestic Wonder and Windskiff in English desktop and Czech phone views.
It checks exact source-tree membership, book-to-kind navigation, cross-kind
search without duplicate identities, source facets, missing books, typed
rule-details links and refreshed generations without losing the requested route.
Separate class/subclass/level checks toggle Heroes of Faerûn while browsing
Wizard, Bladesinger, Arcane Recovery and a filtered spell list, including Back.
Existing installed cases retain Retry, replacement, roles, themes and ambiguous
versus typed references.

All seven class pages exercise real semantic table headers and trait cells in
English and Czech, with Czech at 200% text size. Screenshot review exposed words
fragmenting inside narrow table cells. The shared Compendium table styling now
preserves whole words and keeps wide tables in keyboard-scrollable containers;
the page itself remains bounded. This keeps the table relationship while
following the [WAI reflow guidance for data tables](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
Regression checks measure word fragments and exercise ArrowRight scrolling. The final enlarged table and source-recovery screenshots were visually reviewed.

The matrix also exposed an immediate hover preview covering a neighboring
details action. The shared host control now uses a cancellable 300 ms dwell
for mouse previews while keyboard focus, click and touch remain immediate.
Focus restoration after dismissal suppresses only that restoration event;
a later keyboard visit can reopen the preview. Deterministic browser timing
checks cover brief crossings, leaving/re-entering, hoverable content, pinning,
Escape, keyboard reopening and navigation disposal. This uses the existing
[shared interaction contract and research](RULE_DETAILS.md#interaction).

Compendium commits `8d46929` and `d189995` repair the content and source UI;
`0c3e5d7380b08a0f78195d6fe15f8656d62c244f` adds the final table styling and is
the pinned source. The inspected ZIP SHA-256 is
`a7631cf58139546ed1177ff5da31f5c486f224e9973ddd3f237ebc7d128ffc01`.
Engine, Sheets and DM Tools sources and packages are unchanged from T56.

Owning Compendium checks passed **74 tests**, build and tools typecheck, and the
final package passed host inspection. An initial complete `npm run check`
passed **38 tooling, 400 unit and 428 browser tests**, plus Go tests and vet.
A repeat with the final table styling passed 427/428 browser cases but hit one
seven-second wait for the initial timeline board, before the drag case started.
The original fixture did not capture enough startup state to establish a cause.

Commit `bb93e65` adds bounded request/page diagnostics and a failure screenshot
to the [timeline fixture](../../frontend/test/browser/timeline.browser.mts).
It changes neither the timeout nor the drag/revision assertions. Standalone
timeline checks passed **11/11**, concurrent reproduction passed **68/68**, and
the final host-browser group passed **240/240** with the diagnostics enabled.
The isolated failure remains open as T57-VERIFY; a passing retry is not a root
cause or a claimed runtime fix.

Final strict installed acceptance passed **188/188** against the four pinned
packages, with zero failures/skips. Together, the final host and installed
groups exercise all **428 browser cases**. All **33 release-readiness gates**
passed, and **191 local document links/anchors** were verified. The strict
provenance records host `afb91e9` plus this batch's working
changes and the exact companion sources/hashes above. These are local Windows
checks, not Linux CI, physical-device or live-site acceptance.

T58 below resolves the selectable-species-size finding. Advancement feat
categories, including Fighting Style and level-19 alternatives, remain open.
Physical touch/screen-reader review and live-site acceptance remain separate.

## Source-defined species sizes and saved character display

September 24, 2026: T58 follows the remaining T18-COMP source-mechanics review.
Three PHB records (Human, Aasimar and Tiefling) declared fixed Medium despite
their retained prose allowing a Small/Medium choice. Eleven other species
already displayed alternatives without a structured selection: Changeling,
Khoravar, Shifter, Warforged, Flamekin, Lorwyn Changeling, Rimekin, Dhampir,
Hexblood, Lupin and Reborn.

### Source and consumer contracts

Compendium content revision `3.0.2` adds `sizeOptions` to those fourteen
records. The three PHB display summaries now agree with their source text.
Human/Tiefling were checked against the
[official species rules](https://www.dndbeyond.com/sources/dnd/br-2024/character-origins);
the other declarations preserve existing reviewed source facts. A Git comparison
verified every other JSON field unchanged, including English prose, canonical
`(kind,id)`, book provenance and Dhampir's alternate `aboh` membership.
The book → kind → record browser structure remains intact.

The Engine interprets the source field through one ordinary creation descriptor,
`species:<id>:size`. Generic option/count validation and exact-slot repair IDs
apply. Choices remain in the existing `build.choices` array. Fixed-size species
need no extra choice, and no default is invented for earlier characters.
Missing picks can save as incomplete builds; undeclared values and extra slots
cannot. Evaluation is detached, and invalid old selections remain inputs until
the coordinator handles an explicit save or adoption.

The saved projection includes `derived.size` and species evidence. Unselected
declared choices are null; old unstructured compound summaries omit the field
instead of suggesting an impossible selection. This is base species size, not
temporary transformation or encounter automation. Stored schema 4, public
Engine v4 and rules-data v3 identities remain unchanged.

Sheets uses the existing shared Builder combobox. Optional option `labelKey`
values translate UI labels without translating authored record names. Both
layouts and print read the saved value and evidence; older projections without
size still render. No provider lookup or recalculation is required for frozen
reading/printing.

### Reflow and workflow acceptance

The new stat exposed the old grid's two-row assumption: at 200% text on a
390px Czech phone, Classic created a third column outside the viewport.
The shared stat grid now wraps by available space, with readable labels and a
single column when needed. The design follows
[W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html);
the checked viewport/text-size combinations are not a blanket WCAG claim.
Generated screenshots were visually reviewed after the fix.

The [installed size fixture](../../frontend/test/browser/installed-character-size-fixture.mts)
adds five cases and extends the existing provider-free final case:

- Both size options from all fourteen actual package records resolve with their
  source evidence; forged values and extra slots cannot change stored state.
- English Compact and Czech Classic use keyboard selection through borrowed
  controls, keep focus through autosave, survive reload, and show/export/print
  the saved choice. Enlarged-phone controls and stats stay within the viewport.
- Changing Human to fixed-size Dwarf removes only Human-owned choices. Other
  choices, HP, inventory, notes, currency and spent resources survive. Returning
  to Human does not resurrect a retired size.
- Dhampir retains its saved size when canonical Ravenloft is disabled and its
  reprint is adopted. Removing both eligible sources refuses recalculation
  without rewriting saved state; restoring sources retains the selection.
- After provider removal, both localized saved sheets and print retain size and
  exact inputs/revision without querying live rule records.

Pure Engine regressions independently use synthetic Tiny/Large options,
unknown/extra slots, changed option pools, fixed-size replacement, detached
inputs and unsupported compound summaries. The 144 preserved arithmetic/Builder
vectors remain unchanged.

### Failures found by the full suite

The first strict run passed 191 of 193 cases. Its multiclass progression case
reached a real snapshot limit: Fighter 7 / Warlock 1 / Wizard 3 could not save.
Every learned/prepared spell reference was copied into unrelated statistic
explanations. The new fixed-size explanation exposed a snapshot already close
to the unchanged 250,000-byte storage limit. The assertion now includes the
coordinator's message, which previously disappeared behind an empty issue list.

Engine commit `50eebb2` captures calculation sources before retaining the
additional spellbook/preparation records. Full spell summaries, mechanical
facts, hashes and package provenance remain in evidence for offline reading.
Spells actually read by a calculated grant remain calculation sources. No
authored input or storage limit changes. A synthetic 32-spell regression failed
before the fix and passed afterward, proving unrelated explanations stay
constant while every spell's evidence and authored state survive. The exact
installed multiclass progression then passed, including casts, independent
spent pools, both rests and reload.

The second failure came from the rules-recovery fixture starting its ten-second
UI deadline while the intercepted save was still applying a real source-policy
graph change. It now awaits and asserts that save's `rules-changed` response
before timing UI feedback. The existing UI deadline, whole-case timeout,
pending-edit preservation, lost-reply and conflict assertions are unchanged.
All four focused recovery cases passed. This fixture correction does not close
the unrelated T57 timeline-startup investigation.

### Exact sources and validation

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools, unchanged | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `50eebb29cf40b4c8f90c63a8a2235289111c8051` | `12911216b5f90aebd8cc33234fe8d02f2dfdb3cb3ca14feca1d2c9424cb3deea` |
| Sheets | `dd435a85b45f5400ae0652269e0809aacf0fb6d9` | `397a3798e258358dcfdbebec89eef237274636aa834b9f1ceffe8c7577d5d638` |
| Compendium | `173ac3182fd24e605a4fab214079b96faf04af67` | `bf01ce55a1d4bf6b9a4b07bae0a9547837651490416d2a47c1c81ba574dac295` |

Owning gates passed: Compendium **76/76** tests plus build/tool typechecking,
Sheets **18/18** browser-module tests plus build and Go tests/vet, and complete
Engine Go tests/vet. All rebuilt packages passed host inspection; native
execution was Windows AMD64, while Linux AMD64/ARM64 were cross-compiled.

Host `npm run check` passed source-language and type checks, **38 tooling** and
**400 unit** tests, its browser run (**282 passed**, **122 optional installed
cases skipped**), and all Go tests/vet. All **33 release-readiness gates** passed.
Final strict installed acceptance passed **193/193**, with zero failures or
skips, against the exact source set above. All **197 local document targets and
anchors** were verified.

The pinned package provenance records clean companion commits and host
`6a77578` plus this batch's working changes. These are local Windows checks;
no Linux CI, physical-device, live-site or printer acceptance is claimed.
No push, release or deployment was performed. T57-VERIFY remains open because
a passing timeline run does not explain its earlier startup timeout.

At T58, advancement feat categories and level-19 alternatives remained open;
T59 below closes that slice. Class-granted choices and passive-stat gaps remain
listed in the current backlog.


## Legal advancement feats and saved feat details

T59, September 24, addresses advancement eligibility and the defects found while
exercising it through real packages. It preserves Compendium book/kind/record
identity, shared host controls, rules-data v3, Engine v4 and saved schema 4.
No sourcebook-specific rules were added to Sheets controls.

### Reviewed source declarations

The [official feat rules](https://www.dndbeyond.com/sources/dnd/br-2024/feats)
and [class advancement rules](https://www.dndbeyond.com/sources/dnd/br-2024/character-classes)
confirm unrestricted qualifying advancement categories. The Engine already added
level-specific categories to its base list, so ordinary alternatives at class
level 19 were not broken. The actual exclusions were Fighting Styles and Epic
Boons earned at a later multiclass advancement.

Compendium now leaves categories unrestricted and applies source prerequisites:
all ten PHB Fighting Styles require the feature, and all twelve PHB Epic Boons
have a structured character-level prerequisite and explicit ability pools/caps.
Two-Weapon Fighting keeps its record ID with its category corrected. Spell Recall
requires an acquired Spellcasting feature, including the two spellcasting
subclasses; Pact Magic or innate spells alone do not qualify. See the owning
[coverage](../../../addon-dnd-2024-compendium/data/COVERAGE.md#character-rules-and-contextual-details)
and [schema](../../../addon-dnd-2024-compendium/data/SCHEMA.md) references.

A semantic comparison verified all 21 changed feat records preserve unrelated
fields, identity, book placement and prose. The only prose change corrects Spell
Recall's prerequisite header. Boon of Skill already had the intended declaration.
The content revision is 3.0.3; package/service major versions are unchanged.
A targeted audit also confirmed that the 39 non-PHB feats in the special
categories retain narrative prerequisites requiring explicit adjudication.

### Shared Engine and display repairs

- The fast option filter evaluated class/spellcaster predicates without the
  acquired sheet, hiding options that passed validation. Those predicates now
  use the same complete progression check as feature/ability predicates.
- Subclass feature tables use local IDs. Hydration now resolves them to canonical
  IDs within their owning class/subclass, with record levels authoritative.
  Earlier, Eldritch Knight and Arcane Trickster could not satisfy an exact
  Spellcasting prerequisite. Future and unrelated features remain excluded.
- Replacing an ability-granting feat with one without an increase left a hidden
  assignment blocking autosave. The Engine now reports the removed budget as
  an unavailable choice. Existing coordinator repair removes only its previously
  saved assignment; it does not accept a newly forged choice or reset play.
- Acquired feats were missing from Combat details and print. The additive saved
  `sheet.feats` list retains identities and acquisition counts, separate from
  unselected catalog options. Sheets uses one renderer in both views, shared
  rule-detail controls and exact kind/ID evidence. Older projections remain
  readable and need deliberate recalculation to obtain the additive list.

Synthetic regressions cover predicate agreement, ordered multiclass eligibility,
canonical/inline/future feature identities, withdrawn assignments, detached inputs
and repeated acquisitions. The 144 preserved arithmetic/Builder vectors remain
unchanged: the new feat list belongs to character evaluation, not legacy hydration.

### Installed acceptance

The [advancement fixture](../../frontend/test/browser/installed-character-advancement-fixture.mts)
adds five cases and extends the existing provider-free final case:

- Actual Fighter/Paladin/Ranger advancements offer the ten qualified styles;
  Wizard cannot forge one. Ordinary and Origin alternatives remain available.
- Fighter 3 / Rogue 15 / Fighter 4 can select an Epic Boon at character level 19.
  Reordering the fourth Fighter level earlier rejects retroactive eligibility;
  removing it withdraws only its feat and ability increase.
- All ten currently declared Spellcasting feature sources qualify for Spell
  Recall. Pact Magic, innate spells and a caster level acquired afterward do not.
- English Compact and Czech Classic exercise keyboard selection, enlarged phone
  reflow, ability steps, feat replacement, focused autosave, reload, Combat
  details, export and print. Notes, HP, currency and other authored play survive;
  the coordinator's save timestamp may advance normally.
- After rules-provider removal, Combat details, print and export retain exact
  saved state without live record queries.

Desktop and enlarged Czech phone screenshots were visually reviewed. The phone
capture follows text reflow and scrolling to the feat section; long feat names
remain readable within the viewport. The existing Combat proficiency summary still exposes raw values;
that separate usability defect is now explicitly retained under T18-SHEETS.

### Exact sources and validation

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools, unchanged | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `a3ba0df37200bbd667aaf4ba959c39af64b2987f` | `d15f03e22f98e949651b946197ef42903096cdb5f576c043bf916c8d9376433a` |
| Sheets | `0626c3e060e23db5ae6a01957cb8597480cedfe5` | `840fb9c9d0b0e43f2c54c37693f0aa6545148b505ccbe9fceb1301cc76af8a46` |
| Compendium | `7d44bd8eebe4de2c1537fc3461556825dc2a56bd` | `20248f4e491f497b71ad9c2e9fa1f57e4f54f21b327614bcd97c48ea0c52775b` |

Compendium **78/78** tests, build and tool typechecking passed. Sheets **18/18**
module tests, build, Go tests/vet and package build passed. Engine Go tests/vet,
regressions and preserved parity passed. All changed ZIPs passed host inspection;
the four-package preparation records the clean source commits above.

Host `npm run check` passed source/type checks, **38 tooling** and **400 unit**
tests, its browser run (**282 passed**, **127 optional installed cases skipped**),
and all Go tests/vet. All **33 release-readiness gates** passed. The changed
seven documents have **127 distinct local targets and anchors** verified.

Strict installed acceptance passed **198/198**, with zero failures or skips,
against this exact package set, including the extended provider-free final case.

Package provenance records host `506be14` plus this batch's working changes.
Native execution was Windows AMD64; Linux AMD64/ARM64 workers were cross-compiled.
No Linux CI, physical-device, screen-reader, printer or live-site acceptance is
claimed. No push, release or deployment occurred. T57-VERIFY remains open.

Remaining work is explicit: class-granted Fighting Style/Champion choices,
Blessed/Druidic Warrior alternatives and replacement, the named passive sheet
benefits, and the existing Combat proficiency presentation. Encounter resolution
remains outside this character workflow. This closes a T18 slice without claiming
exhaustive rules correctness or changing the suite's overall progress estimate.

## Class-granted styles and conditional cantrips

T60, September 24–25, 2026, restores the missing Fighter, Paladin, Ranger and
Champion style choices and the Blessed/Druidic Warrior alternatives. The
Compendium keeps its book -> kind -> record organization, four feature IDs,
class progression and original prose. A semantic comparison confirmed the
four records change only by adding structured grants; content revision is 3.0.4.
The [source coverage](../../../addon-dnd-2024-compendium/data/COVERAGE.md#character-rules-and-contextual-details)
records the official rules reference and the remaining replacement boundary.

### Shared behavior and preserved state

Class/subclass/feature choice packages now use one selection resolver for the
Builder and calculation. Enumerated parent choices are resolved before their
dependent feats even when the child ID sorts first. Source levels, subclasses,
feat categories and nonrepeatable acquisition rules continue to apply. An
inactive branch grants neither its former feat nor its spells.

Cantrip alternatives retain their source list, fixed casting ability and explicit
class membership without renaming the granting source. Existing coordinator
repair removes only previously saved selections that become unavailable;
newly forged choices are rejected. This uses existing schema-4 choices and spell
grants without a new UI rule implementation or automatic source adoption.

Visual review found spell names running directly into their Details controls
on desktop. The common spell picker now uses its existing wrapping control
layout and skin spacing tokens. Builder and Manage spells share the repair;
borrowed host comboboxes, checkboxes, search and rule details retain their
existing focus behavior.

Provider-free acceptance also found that saved spell details sent full record
metadata into the host's closed evidence contract. The host rejected the payload,
so spell labels disappeared although their saved grants and names were intact.
Spell, sheet and projection details now share one adapter that supplies only
reference, name, summary and hash. Stored facts and provenance remain unchanged.

### Installed acceptance

The [class-style fixture](../../frontend/test/browser/installed-character-class-style-fixture.mts)
adds six cases and extends the existing provider-free final case:

- Fighter's style is available at class level 1; Paladin/Ranger at class level 2.
  Their feat slots offer all ten styles and reject an ordinary feat.
- Champion's class-level-7 style remains a separate acquisition. Duplicate
  nonrepeatable styles are rejected; removing the seventh level withdraws
  only the additional style.
- Both cantrip alternatives enforce their own list, level and count, retain
  their casting ability and class membership, and reject an ineligible spell.
  Branch or level removal withdraws only the affected saved choices/spells.
- English Compact desktop and Czech Classic at 390px/200% text exercise shared
  keyboard controls, focused autosave, branch switches, spell selection,
  reload, print and export. Notes, HP, temporary HP and currency survive;
  the ordinary save timestamp can advance.
- Spell checkbox labels and Details have visible separation both inline and
  wrapped. Desktop and enlarged Czech phone screenshots were inspected.
- Provider-free saved spell display, export and print retain exact state and
  make no live record queries. Both locales open Guidance's detail dialog and
  display its exact saved source hash through the host's shared control.

### Exact sources and validation

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools, unchanged | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `ceaa19aea8990faad104137e285f516c3d1679ba` | `7077565c723226b654f12a76e4b8baa2ed6a240246a7d12167f2d43b37e19b28` |
| Sheets | `e415b0a91c1c765cf32d7b89b9e083bb8ff0ac0c` | `1da20e58bf2ffed4fde48fe0c42d3055a59b6010b9e818be042bcfc818836c72` |
| Compendium | `0b351ba24f4c61f33dcd6dbaae98ea2d6878badf` | `b8b3c143de3ef86be76b513038f24f8a031e76f27807fbb8b588ab151561e9da` |

Compendium **79/79** tests, build and tool checks passed. Engine Go tests/vet,
synthetic branch/ownership regressions and the **144 preserved parity vectors**
passed. Sheets **18/18** module tests, build and Go tests/vet passed. All three
changed packages were built and host-inspected; preparation records the clean
companion source commits above. The six focused installed cases passed; both
UI cases also passed after the shared spacing repair. An isolated real-package
run passed all six cases plus provider removal, saved-source details, export and
print after the evidence-adapter fix.

Host `npm run check` passed: **38 tooling, 400 unit and 282 browser tests**,
plus Go tests/vet. The **133 optional installed skips** in that gate are covered
by the separately required suite below. `npm run release-check` passed all
**33 product-parity gates**.

The final strict installed suite passed **204/204 with zero skips** against
the exact package set above. Provider-free spell labels, saved source dialogs,
export/print and the context-release assertions all passed.

The first host gate hit a 7-second phone-settings startup timeout before
`.settings-page` mounted. The two sidebar cases passed unchanged in isolation.
No application error or root cause was established; T57-VERIFY retains this
observation alongside the earlier timeline timeout, without asserting a shared
cause or increasing deadlines. Bounded settings startup page/request captures
now preserve evidence on a recurrence.

A second early host run failed the hidden-settings draft assertion. The failure
also occurred once in three isolated repetitions. Holding the initial GitHub
inventory response proved the cause: the visible contribution was still `inert`,
and Playwright's `fill` returned while its input remained empty. No edit had been
created for the navigation guard to protect. The fixture now deliberately holds
startup, checks the inert state, releases it, waits for management readiness and
checks the typed value before testing navigation. All four integrated/isolated
desktop/phone cases and the subsequent complete host gate passed. Failure
snapshots remain available. This explains the draft assertion, not the separate
startup timeout; no deadlines, assertions or coverage were relaxed.

The first strict installed run passed **203/204**, exposing the saved-spell
evidence defect above. Its provider-free regression stays in the final suite.
A second run passed **203/204**, but Chromium returned `ERR_NO_BUFFER_SPACE`
while opening the final Czech provider-free page. The combined verification
retained each completed browser context until the parent test ended. Each phase
now closes its completed contexts promptly, and the parent asserts that no phase
leaves extra contexts behind. This bounds fixture resource use without retries,
longer timeouts or removed behavior checks; it does not establish the cause of
the separate startup timeout.

Package provenance records host `8ca42ee` plus this batch's working changes.
Native execution was Windows AMD64; Linux workers were cross-compiled. Human
screen-reader, physical touch, printer, Linux CI and live-site checks are not
claimed. No push, release or deployment occurred.

Dedicated bounded level-up replacement actions and the named passive feat
benefits remain open. DM build editing can revise current choices, but is not a
replacement ledger. Combat proficiency presentation and broader multiclass
session acceptance also remain in T18. This completes a concrete slice without
changing the suite's overall progress estimate.

## Passive feat bonuses and automatic armor conditions

Reviewed September 25, 2026 (T61). This closes the five named passive-stat gaps
in T18-COMP while preserving the book -> kind -> record structure and the
existing shared sheet controls. It does not close bounded level-up replacement
or the broader whole-session acceptance tasks.

### Source and calculation changes

The Compendium now declares Blind Fighting's blindsight, Defense's worn-armor
bonus, and the fixed HP, Speed and truesight benefits of their Epic Boons.
Record IDs, categories, prerequisites, ability choices, book tags and prose are
unchanged. Content revision is 3.0.5. The
[source coverage record](../../../addon-dnd-2024-compendium/data/COVERAGE.md#character-rules-and-contextual-details)
links the publisher research; the
[grant vocabulary](../../../addon-dnd-2024-compendium/data/SCHEMA.md)
owns the exact fields.

The Engine previously read speed bonuses only from lineages and had no
fixed-HP grant path. It now sums selected source grants once, adds fixed HP
after recorded level gains, and applies typed item/DM adjustments afterwards.
This also makes the existing Mark of Passage speed declaration effective.
Sense ranges retain their existing greatest-range semantics.

Passive AC declarations test worn body armor automatically. Carried/stored
armor, zero-quantity equipment and a shield alone do not qualify. Applied and
inactive terms retain their source and condition. A synthetic regression also
exposed an older mismatch: equipment guidance accepted armor declared in
another catalog kind while hydration searched only the armor catalog.
Hydration now honors the exact reference kind and declared armor type; a
colliding ID in another kind cannot silently substitute different equipment.

Sheets needs no special feat code or new controls. Its existing shared stat,
rule-detail, Combat, print and export surfaces consume the resulting projection.
Recalculation preserves authored HP, temporary HP, currency, notes and inventory.
The existing coordinator policy clamps current HP when a lower maximum demands
it; raising maximum HP never heals.

### Acceptance

Six pure regression cases cover detached/deterministic evaluation, recorded
dice, per-level/fixed stacking, lineage and typed effects, class-choice package
withdrawal, armor conditions, unsupported conditions and catalog-kind collisions.
All 144 preserved parity vectors remain unchanged and pass.

Four new installed cases exercise:

- light/medium/heavy body armor, shields, carried/stored gear and style withdrawal;
- the three Epic Boons, exact source explanations, replacement, reload and HP bounds;
- English Compact desktop and Czech Classic at 390px with 200% text;
- host rule details, focused equipment autosave, all five feat grants together,
  readable sense ranges, exact printed stat values, export and unchanged saved inputs.

Both desktop and phone screenshots were inspected. The final provider-removal
workflow additionally opens saved Defense evidence, checks its exact source hash,
prints the exact saved numeric values and exports unchanged inputs in both locales.
It makes no live record queries and closes each completed browser context.

### Exact sources and validation

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools, unchanged | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `eb2f2f023b819b6ec919f17dd6a1a886e761244f` | `d75dadd2ccb28a1119aca8abeffbf49d97a96baba322da715c8c856de5a29211` |
| Sheets, unchanged | `e415b0a91c1c765cf32d7b89b9e083bb8ff0ac0c` | `1da20e58bf2ffed4fde48fe0c42d3055a59b6010b9e818be042bcfc818836c72` |
| Compendium | `87f79ad6470a027003f7e97a20734205482414dc` | `0f0777159ac4c1074fb59d1662aa4f3bf27d70f53e154ff5a1b4725a31abad3c` |

Engine Go tests/vet and the cross-platform package build passed. Compendium
build, tool checks and **80/80** tests passed; its package was rebuilt.
Sheets build, **18/18** module tests and Go tests/vet passed. The changed packages
passed host inspection, and preparation verified all four exact package hashes
and clean source commits above.

Host `npm run check` passed: **38 tooling, 400 unit and 282 browser tests**,
plus Go tests/vet. Its **137 optional installed skips** are covered by the
separate strict suite. Release readiness passed all **33 product-parity gates**.
The isolated five-case passive/provider-removal replay passed. The final strict
suite passed **208/208 with zero skips**, including the provider-free evidence,
print/export and context-release assertions.

The first strict run passed **207/208** with zero skips. Its one failure was
the new frozen-stat test matching 30 hidden nested source-evidence sections
inside the shared detail control. Scoping the selector to the opened dialog's
direct evidence section preserved the intended source-hash assertion; the
isolated replay then passed both locales, numeric print/export and context cleanup.
No product behavior or deadline changed for this correction.

The first focused run timed out after 30 seconds fetching the rules-policy
endpoint during fixture setup, before any new feat assertion. The subsequent
run passed that setup unchanged; no root cause or connection to T57/T60 is
established. The fixture now retains a bounded host-log/process-state capture
on a recurrence without changing deadlines. T57-VERIFY remains open.
Two UI test setup errors were corrected during iteration: explicitly focusing
the equipment control before asserting focus retention, and locating Senses
from its heading instead of searching for the outer sheet inside a section.
The final checks retain all intended behavior assertions.

Provenance records host `496eeeb` plus this batch's working changes. Native
execution was Windows AMD64; Linux workers were cross-compiled. No human
screen-reader, physical touch, printer, Linux-runtime or live-site acceptance
is claimed. No push, release or deployment occurred.

Remaining work includes bounded Fighter-style/Blessed/Druidic Warrior
replacement, readable Combat proficiency summaries, representative multiclass
sessions across provider changes and generated-output ownership. This slice
does not change the overall suite estimate.

## Readable saved proficiencies and saving-throw indicators

Reviewed September 25, 2026 (T62). This closes the confirmed Combat proficiency
display defect in T18-SHEETS and adds a complete Fighter/Rogue training workflow.
It preserves the compendium's book -> kind -> record structure and the Engine's
existing calculation and stored-state contracts.

### Findings and changes

Combat passed the whole saved proficiency dictionary through a generic formatter.
It displayed trained and untrained saves/skills together as raw booleans, status
strings and IDs. Print omitted this training summary. Saving-throw shields also
remained unfilled because their CSS expected an attribute the renderer never set.

Sheets now uses one saved-data renderer in Combat and print, grouping saving
throws, ordinary skills, Expertise, armor, weapons, tools and languages.
Expertise appears once, separately from ordinary proficiency. Explicit empty
groups and unavailable saved data have different localized messages; languages
are no longer repeated elsewhere. Known UI/category labels are translated, exact
kind-and-ID evidence supplies saved record names when available, and unmatched
saved text remains readable without current-catalog lookups.

The existing host rule-details control presents available saved explanations and
sources. Native description/unordered lists retain group/value relationships and
individual entries; layouts wrap by available space and relative text size.
[W3C content structure](https://www.w3.org/WAI/tutorials/page-structure/content/)
and [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) informed these
choices. No new interaction widget, renderer boundary or rule calculation was
introduced. Shared ability labels feed both views. Saving-throw markers now
use their actual saved flag for fill and an accessible name containing the
ability, save and training status.

### Acceptance

Four module regressions cover trained-only selection, distinct Expertise,
exact evidence identity despite colliding IDs, detached references, unknown or
missing values, and English/Czech labels without translating authored names.

Two installed workflows start from a ready Fighter, show the explicit empty
Expertise group, add a Rogue level and complete its training, then authorize
Wisdom-save and Medicine proficiency through a DM grant. They verify:

- exact trained-save and equipment lists, distinct skill/Expertise groups,
  tools/languages and absence of raw status/identifier text;
- unchanged authored HP, temporary HP, inventory/provenance/notes, currency,
  resource counters and other play values through grant and withdrawal;
- an Engine restart preserving the exact saved state and rules identity;
- active/inactive saving-throw shield fill and accessible labels;
- shared explanation dialogs opened with the keyboard and returning focus;
- English Compact desktop and Czech Classic at 390px with 200% text,
  individual group wrapping and no horizontal page overflow;
- identical summary values in print even with equipment/spell output unchecked,
  unchanged export, grant withdrawal through the UI, and reload.

The final provider-removal workflow reopens both saved characters, reads exact
Rogue source hashes through the shared explanation control, prints the same
training groups, exports unchanged inputs and makes no live record queries.
Each workflow releases its browser context. Desktop and enlarged phone
screenshots were inspected; no human screen-reader or physical-print claim is made.

### Exact packages and validation

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools, unchanged | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine, unchanged | `eb2f2f023b819b6ec919f17dd6a1a886e761244f` | `d75dadd2ccb28a1119aca8abeffbf49d97a96baba322da715c8c856de5a29211` |
| Sheets | `951d7ef43d14e6b6080586a6a44d7761bc30d4ef` | `9ca47a9ab23f5bb46fa94be0032e0ed50b0a78a6c504b8e2e2188e0058009a76` |
| Compendium, unchanged | `87f79ad6470a027003f7e97a20734205482414dc` | `0f0777159ac4c1074fb59d1662aa4f3bf27d70f53e154ff5a1b4725a31abad3c` |

Sheets build, **22/22** module tests, Go tests and vet passed. The package was
rebuilt through its owning command and inspected by the host. Companion
preparation verified all four clean source commits and exact hashes above.
The isolated installed replay passed **3/3 with zero skips**.

Host `npm run check` passed: **38 tooling, 400 unit and 282 browser tests**,
plus Go tests/vet. Its **139 optional installed skips** are covered separately
by the strict suite, which passed **210/210 with zero skips**. All **33
product-parity release gates** passed.

Fixture iteration corrected shadow-DOM text/focus assertions, closed the print
options dialog before subsequent navigation, and excluded only the coordinator's
advancing `asOf` clock from authored-play comparisons. Exact saved-state
comparisons still include that clock after read/print/export and provider
removal. No product deadlines or behavior assertions were weakened.

Provenance records host `8e0f619` plus this batch's working changes. Native
execution was Windows AMD64; Linux workers remain cross-compiled. T18's broader
multiclass/source-change sessions, bounded class-level replacements, generated
artifact ownership and T57's unexplained startup investigation remain open.
This slice does not change the overall suite estimate. No push, publication,
deployment or live data change occurred.

## Multiclass snapshots and provider-session recovery

Reviewed September 25, 2026 (T64). Engine `093472f`, Sheets `424a0d0` /
`e37549b` and host `2184554` close two confirmed save failures
and unclear import-review headings found while extending
T18's installed whole-session coverage. Stored schema 4, service versions,
compendium records and the host's shared controls remain unchanged. This
accepts the existing workspace; the separately agreed T63 design remains open.

### Findings and changes

A mechanically ready Fighter 7 / Warlock 1 / Wizard 3 with independent Magic
Initiate grants could not save: its roughly 297 KB snapshot exceeded the
existing 250,000-byte limit. About 208 KB was calculation explanations, largely
from repeating all 36 selected source references on every statistic.
Engine now links abilities, training, HP, caster statistics and resource
counters to their contributing source groups. Typed item/effect sources remain
attached to their calculation terms and references. The full source evidence,
hashes, prose, formulas, values and authored inputs are retained. The original
representative snapshot fell to about 195 KB; the extended installed session,
including an optional-book feat and spent resource, saved at 202,281 bytes.
The storage limit was not raised.

The next save exposed a separate failure after the write had succeeded:
Sheets returned 525 comparison entries against the service schema's maximum
of 500. Ordinary saves no longer generate an unused import-review comparison.
Import previews compare authored inputs, rules identity and calculated sheet
values; large subtrees become one complete before/after entry. Values are
grouped, never truncated, and exact reviewed commits, revisions and retries
retain their existing behavior. Whole-character comparison roots also receive
localized Character, Rules and Calculated values labels, replacing empty or
path-fragment headings in the existing native disclosure UI.

### Acceptance

Two Engine regressions cover deterministic contributing-source references,
independent acquisition resources, typed item effects and 48 extra narrative
features without multiplying unrelated calculation references or dropping full
source evidence. Two Sheets regressions cover a 600-value generated projection,
acknowledged saves and exact retry, bounded import preview/commit, and three
simultaneously large comparison groups with every value preserved.

Two installed English/Czech sessions use the real package-review lifecycle.
They start with a ready multiclass character and combine:

- Pact and ordinary spell-slot casts through the shared UI, two independent
  Magic Initiate free casts, and a spent optional-book feat resource;
- a DM grant amendment preserving existing spells, counters and authored play;
- removal of a used sourcebook, blocked adoption without silent choice loss,
  read-only mechanics, and restoration of the exact source identity without
  rewriting the character;
- incompatible Engine response and major-version packages, rejected stale
  handles and writes, saved print/export, and original-provider restoration;
- a short rest through Combat resetting only the intended pool, Wizard level-up,
  grant withdrawal, surviving acquisition uses, equipment/notes and reload;
- final provider-free reading, print and exact export of both saved sessions
  after the rules-data provider is disabled.

Two additional first-import workflows verify meaningful localized group and
change headings, complete nested item/notes values, no writes during review or
cancellation, and enlarged Czech phone reflow.

English Compact desktop and Czech Classic at 390 px with 200% text retain
readable saved values without horizontal page overflow. Screenshots were
inspected. Read/print/export and provider transitions compare exact stored
state; authored-play comparisons exclude only the coordinator's advancing
`asOf` clock. Each workflow releases its browser context.

### Exact packages and validation

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools, unchanged | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `093472f5a723d86464f4a3ce08a7137aae8973eb` | `518966cb341e9a60b82075bf7f69c61a1fed0d0d0b19de8d2d858b533dda3c32` |
| Sheets | `e37549b553fe7fad1b18ebe1ec6ed1b7a7fc2dde` | `229651fa37672802eb2f03f25bcc0cce898c38f54bf6db98301391488f33b69a` |
| Compendium, unchanged | `87f79ad6470a027003f7e97a20734205482414dc` | `0f0777159ac4c1074fb59d1662aa4f3bf27d70f53e154ff5a1b4725a31abad3c` |

Engine Go tests/vet and its owning package build passed. Sheets `npm run check`
passed, including **22/22** module tests and Go tests/vet; its final
package was rebuilt and host-inspected. Both focused multiclass sessions and
both focused first-import reviews passed. Companion preparation verified the
four clean source commits and exact hashes above.

Host `npm run check` passed: **38 tooling, 400 unit and 282 browser tests**,
plus Go tests/vet. Its **143 optional installed skips** are covered separately
by the final strict suite, which passed **214/214 with zero skips**. All **33
product-parity release gates** passed.

The fixture retains bounded host diagnostics on failed service calls. Iteration
corrected test assumptions about restored source identity, print-dialog closure,
Combat rest controls and acquisition ordering; deadlines and product assertions
were retained. These two confirmed save defects do not establish a cause for
the earlier unexplained T53 rules-availability loss or T57 startup timeouts.

Provenance records host `4a57c17` plus this batch's working changes. Native
execution was Windows AMD64; Linux workers were cross-compiled. Human
screen-reader, physical touch, printer, Linux-runtime and live-site checks are
not claimed. No push, publication, deployment or live-data change occurred.

T18-ENGINE/SHEETS stay open for final sessions on the implemented T63 workspace.
Bounded class-feature replacements also remain open: existing spell swaps track
ordinary class spell replacement only. A durable, acquisition/class-level
allowance must preserve already spent opportunities across saves, imports and
provider changes. Coordinate its typed-state design with T63 and reviewed T08
migration if the released schema changes; this batch adds no new state fields.
Generated-artifact ownership remains separate. This slice does not change the
dated overall estimate.

## Equipped-only selection and preserved attunement

September 25, 2026, T63-ATTUNEMENT. Sheets commits `d85bc8a` and `6a0a75c`
implement the first compatible equipment slice. New attunement selections use
positive-quantity equipped instances and Engine eligibility. Equipped
candidates blocked by prerequisites or capacity retain readable explanations;
otherwise eligible inventory items explain that they must first be equipped.

Existing carried/stored allocations remain visible with their location and
count toward the Engine's saved capacity. Ordinary moves still preserve
attunement. **Stow & unattune** moves the same instance to Stored and clears
its allocation in one optimistic autosave, preserving quantity, reference,
identity, acquisition, grant links and notes. The action returns keyboard focus
to that item's Move control. Explicit repair retains prerequisite diagnostics
even when the existing allocation no longer qualifies.

The implementation reuses native buttons/selects, the host's borrowed controls,
shared inventory transitions and current worker save/retry/conflict handling.
There is no new stored field, service version, permission or rules calculation.
Engine eligibility continues to accept existing carried/stored allocations;
the equipped-only requirement is a new-selection UI rule.

### Acceptance

Six additional installed workflows cover both locales, old allocations,
ordinary moves, equipped-only choices, stowing, zero-quantity cleanup and
reload; requests lost before delivery and after commit retry their exact
operation, revision and complete inputs; disjoint edits rebase while overlapping
inventory edits remain visibly conflicted without partial writes. The existing
capacity, duplicate, prerequisite and class-removal repair cases remain intact.

Final provider-free acceptance reads both saved retry sessions, displays their
stored allocations, disables mutations, prints item names/notes and exports
exact authored inputs. Reading, printing and export compare the complete saved
state before/after and never write the character. Browser contexts are released.

Two focused helper regressions cover all three existing locations, exhausted
quantities, Engine-denied actions and preservation of item/reference/grant
identity, quantity, acquisition, notes and other allocations. Both layouts use
the same transitions and rendering. English Compact at 390 px and Czech Classic
at 320 px, both with 200% text, retain keyboard focus and have no horizontal page
overflow. Corrected unobstructed screenshots were inspected.

### Exact packages and validation

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools, unchanged | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine, unchanged | `093472f5a723d86464f4a3ce08a7137aae8973eb` | `518966cb341e9a60b82075bf7f69c61a1fed0d0d0b19de8d2d858b533dda3c32` |
| Sheets | `6a0a75cf3715506eab0c7482a3277ce6fb044ff6` | `61a6ba4361de5a5bbe7d77b3780901fa16a811185e5bbb04acb43ace94fe6472` |
| Compendium, unchanged | `87f79ad6470a027003f7e97a20734205482414dc` | `0f0777159ac4c1074fb59d1662aa4f3bf27d70f53e154ff5a1b4725a31abad3c` |

Sheets `npm run check` passes **24/24** module tests plus Go tests/vet.
The owning package build and host inspection passed. Focused installed
acceptance passed **14/14**, followed by both corrected phone captures.
Host `npm run check` passed **38 tooling, 400 unit and 282 browser tests** plus
Go tests/vet. Its **149 optional installed skips** are covered by the strict
final package suite: **220/220, zero skips**. All **33 release gates** passed.

The first host gate hit Chromium `ERR_NO_BUFFER_SPACE` while navigating an
unchanged map fixture. The complete gate passed on repeat with the same
concurrency, assertions and deadlines. This does not establish a product defect
or a cause for the earlier unexplained T53/T57 failures.

Provenance records host `cdbf4b0` plus this batch's tests/pins. Native execution
was Windows AMD64; Linux workers were cross-compiled. Human screen-reader,
physical touch, printer, Linux-runtime and live-site checks remain unclaimed.
No push, publication, deployment or live-data change occurred.

T63 remains open for its typed-state preservation design, body placement,
containers, hands/grip/suspension, quick-use references, Inspiration, conditions
and remaining workspace/Builder layout. The audit in the backlog identifies
which fields need reviewed schema evolution under T08; no reset or ad hoc
conversion is introduced by this slice.

## Reviewed compatible saved-data schema upgrades

T08-COMPATIBLE completes the host path needed before compatible typed-state
extensions can be adopted. It does not complete general value-transforming
migrations or the remaining T63 character-sheet fields.

### Behavior and preservation

Settings reuses the existing add-on activation dialog and shared review,
button, status, disclosure and focus patterns. A disabled add-on can review an
inspected target against every saved document. The English/Czech panel shows
counts, schema transitions, blockers, expiry and fingerprints, offers the
private pre-upgrade download, and applies only the exact stored plan. Uncertain
responses retain the review and offer Check saved result. Activation and its
permission review remain separate.

The SQLite transaction preserves raw JSON bytes, document revisions, order,
timestamps, detached target identity and tombstones. It advances changed
data-set and package-state revisions and commits the durable receipt, lifecycle
audit and DM-only event together. Pending reviews are bounded and expire after
30 minutes; stale state, deleted/tampered targets, wrong fingerprints and
incompatible values cannot apply. Applied receipts survive process restarts
and later activation. Permanent namespace deletion also removes that namespace's
private review snapshots.

The batch also closes a discovered activation gap: adding a unique index
without changing the JSON schema previously skipped validation of existing
duplicates. Ordinary writes, schema reviews and activation now share the same
unique-index check.

### Acceptance

- Storage tests cover byte preservation, empty materialized sets, private data,
  detached extensions, order, revision markers, lost-response receipts, expiry,
  active/state/data/tombstone/generation changes, superseded reviews, wrong
  fingerprints, bounded snapshots and injected transactional rollback.
- Service and manager tests cover optional-field compatibility, required-value
  conversion, removed definitions, changed key mode, duplicate index values,
  active-addon rejection, inspected package tampering, stale activation review,
  generation revocation and explicit activation after applying.
- HTTP tests reject unreviewed operations and unauthorized access; recovery
  responses are uncached. The strict frontend parser rejects identity changes,
  invalid counts/dates and contradictory receipts.
- Two installed-package cases stage actual synthetic ZIPs, preserve authored
  values through reviewed schema changes, keep activation separate, reject an
  incompatible follow-up and exercise player, effective player-preview and CSRF
  boundaries. English desktop at 200% zoom and Czech phone retain heading focus
  and page reflow; screenshots were inspected. The phone case deliberately
  loses the successful apply response and resolves it without a second write.

Final host gates: **38 tooling tests, 402 frontend unit tests, 284 browser tests**,
all Go tests and vet. The host browser gate has **149 optional installed skips**;
the strict package suite below supplies the required companion coverage.
Race-enabled tests passed for package management, add-on application/storage,
HTTP and namespace cleanup. All **33 release-readiness gates** passed.

Companion source commits and ZIP hashes are unchanged from the preceding
[attunement acceptance](#equipped-only-selection-and-preserved-attunement).
All four archives were reinspected against this host candidate. DM Tools passed
its unit/Chromium rendering/Go/vet gates; Engine passed Go/vet; Sheets passed
24 module tests and Go/vet; Compendium passed 80 tests, build and tool types.

Strict installed acceptance passed **222/222, zero skips** in 827,927 ms.
The run records host base `73afeff` plus this batch's working-tree changes.
The activation guard is committed as `d1ec1eb`; the review backend as
`2ef6846`. Only host source changed; companion pins and worktrees are unchanged.

Native execution was Windows AMD64. Human screen-reader, physical touch,
Linux-runtime and live-site verification remain outside this local acceptance.
No push, release publication, deployment or campaign-data operation occurred.

## Authored Inspiration and character schema preservation

T63-INSPIRATION adds optional authored play state without rewriting current
characters. Engine `c0d2984` owns the boolean input, support guidance and saved
projection/explanation. Sheets `11d56aa` owns automatic saving, one shared native
checkbox, transfer, print and rejection of Engine responses that lose or change
the value. English/Czech controls reuse `ui.controls.v1` and semantic skin tokens.

An absent value displays as unavailable and remains absent until deliberately
edited. Explicit false records spending Inspiration. Incomplete legal builds can
save it; calculation, rest and other play operations preserve it. This slice
does not automate awards, rerolls or encounter resolution.

### Preservation and acceptance

- The installed fixture reconstructs the exact pre-Inspiration schema
  (SHA-256 `d50dd66156a2a9e9aa1c25f20f069d6b86eeacb2d8d206b0aee461c3351ae317`).
  It uses current workers/UI, not archived executable behavior. It creates an
  ordinary worker-owned character without the optional field, verifies that
  direct activation of the changed schema is blocked, then disables Sheets,
  reviews/applies compatibility and separately reviews/activates the new ZIP.
  The recovery download and portable SQLite backup prove byte-identical stored
  JSON and an unchanged character revision.
- Six new installed cases cover the schema review, keyboard focus, shared
  Sheet/Combat state, explicit spending, reload, reviewed replacement import,
  printing, lost save replies, exact retries and disjoint/conflicting edits.
  Both locales and Compact/Classic layouts are exercised at 1,360, 1,024, 390 and
  320 px. Narrow layouts use 200% text; Classic and Moonlit skins retain shared
  label targets and document reflow. Desktop and enlarged phone screenshots
  under `frontend/test-results/installed-character/inspiration-*.png` were inspected.
- Existing session-renewal, source-adoption and provider-restart cases now carry
  pending Inspiration together with item text. They verify the original request,
  explicit adoption, conflicting revisions and preservation after reconnecting.
- The final provider-free pass verifies saved checkbox values with editing
  disabled and unchanged export/print for both locales.
- Engine tests cover optional input, explicit true/false, detached values,
  incomplete builds, damage/rest preservation and non-boolean request rejection.
  Worker regressions cover dropped/changed provider values, exact retry after
  restart and unavailable rules. Client tests cover merge and transfer semantics.

The namespace/schema version remain `dnd-sheets` / `4.0.0`, with a changed
schema hash. Existing materialized installations need the updated host and its
[reviewed upgrade workflow](../../../addon-dnd-character-sheets/docs/RULES_EDGE_CASES.md#inspiration-and-compatible-schema-upgrades).
No new data reset or startup converter is introduced. The optional v4 Engine
input retains old requests; UI editing requires explicit support guidance.
Older providers rejecting the field leave saved reading/output usable.

### Exact packages and validation

| Repository | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| DM Tools | `0eeac9bc84f50836fa30f134b5edee9358656676` | `ba4ec18594f595af47c4454de9a5a99c077199d7757e93a6ba7b52370278d9f0` |
| Engine | `c0d2984f8946a8bdb0685a00ea02a8a5b54640e3` | `9b933366d55ed1ba8b6e06011f7c607ed72aab32a1105c72145731593d87ce2a` |
| Sheets | `11d56aaac69bc5b077e884a57e705a5c6a212b4e` | `8e2fa55250f89b1775aecea7fd1cc29b85ead40f2a9ecb62318bd9b6f58dddcf` |
| Compendium | `87f79ad6470a027003f7e97a20734205482414dc` | `0f0777159ac4c1074fb59d1662aa4f3bf27d70f53e154ff5a1b4725a31abad3c` |

Engine Go tests/vet and Sheets `npm run check` passed (25 module tests plus
Go/vet). Both packages were rebuilt and inspected. Unchanged DM Tools and
Compendium source gates are reused from the preceding accepted batch.

The host passed 38 tooling, 402 frontend unit and 284 browser tests, Go tests/vet,
and all 33 release-readiness gates. Its browser gate has 155 optional installed
skips; strict exact-package acceptance supplies that coverage below.

Strict exact-package acceptance passed **228/228, zero skips**, in 934,552 ms.
All expanded session/adoption/restart cases and the provider-free output pass
ran against the pinned packages above.

The run records host base `6676217` plus this batch's fixtures/pins. Native
execution was Windows AMD64; Linux workers were cross-compiled. Human screen-reader,
physical touch, printer, Linux-runtime and live-site checks remain separate.
No push, publication, deployment or live-data operation occurred.

T63 remains open for body placement, containers, hands/grip/suspension, quick-use
references, bounded conditions and the remaining workspace/Builder layout.
Inspiration acceptance does not close the final shared-card geometry or T18
whole-session acceptance for that future workspace.
