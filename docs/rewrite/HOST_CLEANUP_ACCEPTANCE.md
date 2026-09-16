# Host cleanup acceptance

Local acceptance, September 16, 2026. This closes T18-HOST's actionable core
workflow review and links the completed backend work. The historical comparison
remains in [the feature-parity audit](FEATURE_PARITY_AUDIT.md); current remaining
work belongs only in [the suite backlog](../BACKLOG.md).

Core acceptance began with host `eb2cb7b`; the latest source candidate is
`c3d0ac1`, including the deployment-gate repairs recorded below.
All campaigns, passwords, packages installed by fixtures and recovery operations
used disposable local directories. Neither live site was read or modified.

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
- The ordinary browser run reports 26 optional installed-package skips. This
  is explicitly not the zero-skip publication matrix.
- `npm run release-check`: all unchanged historical 33 gates passed. This
  verifies their accepted status, not completion of new add-on work.
- Race checks passed for events and cleanup, worker supervisor,
  package manager, HTTP, campaign imports, request context, service/worker
  brokers, worker host and the campaign/add-on stores. HTTP race checks were
  repeated after the compression change.
- DM Tools' required integration passed its full check (49 unit tests and
  28 browser render checks at each of DPR 1 and 2), Go tests/vet, all three worker
  builds and host ZIP inspection. Windows workers were exercised; the other
  targets were built/inspected. Installed cases were included in host acceptance.

The final installed companion result and exact package identities are recorded
below. No skipped or failed case is converted into a passing acceptance claim.

## Installed companion matrix

The full candidate run on host `c3d0ac1` completed **92 cases: 92 passed, zero
failed, zero skipped** in 126.4 seconds. This includes
`installed sources evaluate every class with bounded projections and explicit
incomplete choices`, including level-20 artificer under the unchanged service
deadline, and all enlarged-text host/add-on theme/language comparisons.
T02-LOCAL is complete; T02 retains fresh remote publication verification.

The run includes both newly added installed campaign-bundle cases and the
existing lifecycle/role/provider/record-panel workflows. All four archives
passed host inspection before installation. All four companion source repositories
were clean; host dirtiness in the provenance was documentation only. Runtime source
and built frontend matched the tested host commit. No remote CI run is claimed.

| Package | Source commit | Inspected ZIP SHA-256 |
| --- | --- | --- |
| dm-tools | `da116c3` | `9b7d07384eeb051ff04d80549715f5bb81680d77504e3ca161a17efd0248d08d` |
| dnd-engine | `3f9c8e9` | `91dac170081052f272f4eb61c1ac4d35800e8a2b994762818f1d6f80a1d3fffa` |
| dnd-sheets | `99edd12` | `23d008405112b0d032839067ef1f9e3363c6404a6f9f7816cf8a02e6494ae6a5` |
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

## Acceptance boundaries

No publication, deployment, live cleanup or data conversion was authorized or
performed. T15–T17 retain the supervised site/device/retention decisions. Actual
screen-reader speech, physical touch, real campaign scale/content and non-Chromium
browsers were not tested here. Those are not represented by emulated touch,
keyboard assertions or viewport/text-size checks.

T08 and the conditional API extensions still require a concrete released-data
preservation need or consumer; they are not unexplained missing host fixes.
DM Tools T30 still owns recovery of add-on-local drafts across forced lifecycle
replacement. The host's core session recovery does not claim to implement it.

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

The exact installed rerun above passed after both fixes. Windows native workers
were executed locally; Linux targets were cross-compiled and inspected, without
local native Linux execution. Broader Engine T32 and Sheets T33 workflow acceptance
remains open and is not implied by the 92 passing cases.

These are local commits. The corrected Engine source must reach its main branch
before the host publication matrix is run, because that job builds companions
from their repositories. A fresh authorized Actions run and subsequent live
rollout remain operational acceptance; neither was triggered here.
