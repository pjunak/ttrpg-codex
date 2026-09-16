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
