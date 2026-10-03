# Current cleanup acceptance

Current state: October 3, 2026. This records verified implementation and delivery,
not a chronological work log. [BACKLOG.md](../BACKLOG.md) owns remaining work;
[REWRITE_HANDOFF.md](../REWRITE_HANDOFF.md) explains the project and ownership.
Detailed older audit/batch records are recoverable before this cleanup in Git
commit `8488968`; source and regression tests remain the behavior authorities.

## Implemented and accepted scope

| Area | Current behavior / owning reference |
| --- | --- |
| Host campaign UX | Authored dashboards, collection browsing, articles/editors, role projections, maps, timeline and relationship views; shared entity geometry/pencil actions and draft/session/conflict preservation. [Editors](EDITOR_BROWSING.md), [maps](MAPS.md). |
| Shared UI | Themeable native fields, searchable choices, states, actions, tabs and modal focus via `ui.controls.v1`; host and integrated add-ons reuse one implementation. [UI foundations](UI_FOUNDATIONS.md). |
| Packages and saved data | Reviewed immutable packages, GitHub updates, privileges/requirements, compatible healing or explicit reset with optional data backup, automatic selected-build retention and independent campaign/add-on recovery. [Lifecycle](PACKAGE_LIFECYCLE.md), [data](ADDON_DATA.md), [recovery](BACKUP_RESTORE.md). |
| Imports | DM Tools owns the visible format-routed Import Center; host campaign-bundle v3/contributor v1 primitives provide exact atomic plans and receipt reconciliation. [Decision](../decisions/0001-campaign-bundle-imports.md). |
| Native runtime | Bounded cancellation/health, worker failure categories, startup/pipe cleanup, domain/health isolation and rejection of stale-generation replies. [Supervision](WORKER_SUPERVISION.md), [broker](WORKER_BROKER.md). |
| First-party add-ons | DM planning/Atlas/imports; Compendium book/topic browse, typed references and source policy; Engine v4 computation; schema-4 character creation/build/play with automatic saves, transfer/print and provider-free saved reading. [Character workflow](CHARACTER_BUILD_HISTORY.md). |

These outcomes retain original authorization, optimistic revisions, independent
package ownership and optional-provider behavior. They do not implement combat
resolution, guessed source mechanics or every reserved protocol surface.

## October 3 approved follow-up rollout

The owner approved the four tested host commits through `2dc6776` and repairs
needed for that deployment. The first
[run 37132964947](https://github.com/pjunak/ttrpg-codex/actions/runs/37132964947)
failed the character-transfer post-close focus assertion before publication;
no image or site rollout resulted from that attempt. Tested repair `1463caf`
completed the same approved rollout.

[Build and dispatch 37136713791](https://github.com/pjunak/ttrpg-codex/actions/runs/37136713791)
and [secret scan 37136713560](https://github.com/pjunak/ttrpg-codex/actions/runs/37136713560)
finished successfully. The Linux host gate passed **103 tool tests, 585 unit
tests, 344 browser cases and Go/race checks**. Its 199 optional installed skips
are separate from the mandatory installed suite, which passed **278/278**, with
zero failures, cancellations or skips, in **1,682,879 ms** (28 minutes 3 seconds).

Downloaded `companion-provenance` artifact `11279082814` identifies clean host
`1463caf` and clean published sources DM `316399a`, Engine `f19f634`, Sheets
`06ef7a5` and Compendium `2971a39`, with the inspected Linux ZIP identities.
Downloaded `release-metadata` artifact `11279756103` identifies:

```text
repository: pjunak/ttrpg-codex
sha: 1463caf7afb4c5c21b2eba6911a9ed8027a1f91d
run_id: 37136713791
image_ref: ghcr.io/pjunak/ttrpg-codex@sha256:c6dbad0289bbd15a4d4aaa6f368c1bb57b8462cbc12c1f43bc5e1137c99bb25f
```

| Verified job | Host job ID | Actual infrastructure run | Deployment job |
| --- | --- | --- | --- |
| Host tests | 111242614679 | — | — |
| Installed compatibility | 111242615011 | — | — |
| Image publication | 111248055341 | — | — |
| Asurai deployment/health | 111248249496 | [37138645252](https://github.com/pjunak/infra/actions/runs/37138645252) | 111248324537 |
| Tiamat deployment/health | 111248249478 | [37138644929](https://github.com/pjunak/infra/actions/runs/37138644929) | 111248322531 |

Both infrastructure runs succeeded on
`d4f056bb947b1c631c0f5b4c491a51d21b6634ae`. Their downloaded logs confirm the
exact dispatched digest running healthy on each site. Image build, dispatch
success or the static health version alone is not substituted for that evidence.

Public checks after both rollouts returned HTTP 200 for both roots, selected
assets and health endpoints, with health `ok`. Roots remain `no-cache` and
fingerprinted assets immutable. Entry `index-CUhpgqE4.js`, app
`codex-app-DfMBwdJ7.js`, preload helper and CSS matched the Docker build and
had identical hashes across the sites. These unchanged assets do not identify
the source; release metadata and running-image logs do.

Ephemeral Chromium at 1360×900 and 390×844 confirmed visible campaign content,
live connections, no page errors/failed requests and no horizontal overflow.
Separate checks loaded four Asurai portraits and six Tiamat images at both
widths, with positive natural dimensions and bounded 88/56-pixel geometry.
All four artwork screenshots were visually inspected.

No live campaign data was edited and no add-on package was installed or
activated by these checks. **Tiamat uses no add-ons and must stay that way;
Asurai alone targets the newest reviewed packages.** Local deployment evidence
remains ignored under `frontend/test-results/current-followup-release-*`.

## Character transfer focus repair

The actual failed-CI metadata was downloaded from artifact `11278605613`.
Test hash `f5659b974a` identifies the player-transfer case; it recorded no page
errors. The independent forged-player worker call already returned expected 403.

The fixture asserted focus before queued native dialog cleanup could replace
and refocus the current opening button. Controlled opener replacement reproduces
an immediate false assertion followed by correct focus. The repair waits for
closed-dialog removal **and** current Import focus together, bounded to two
seconds, then retains the original identity assertion. The real Close-button
interaction, forged 403, preserved input/state and global 60/90-second deadlines
remain. The permanent replacement regression and EN/CS transfer/print workflows
passed locally (3/3, zero skips) and in the full Linux suite.

Native cleanup, late tracing-start ownership and character-fixture startup
regressions remain covered by the shared browser owners and Node tool tests.
This evidence does not attribute the older missing-capture incidents.

## Compact frame sizing before first visits

Compact uses six navigation tabs, shared statistics, Equipment/Backpack and
class-owned Builder levels; Classic retains its previous arrangement. Desktop
frame measurement uses disposable inert samples for unvisited tabs/Builder
sections, preserves one editable panel and focus, and refreshes after width,
font or data changes. Narrow screens use ordinary document flow.

Installed compact/multiclass/planning sessions and enlarged desktop/phone checks
are accepted. Real touch, spoken screen-reader and physical printer results
remain separate under [T63](../BACKLOG.md#t63-character-sheet-design).

## Remaining reliability evidence

| Investigation | Established boundary / useful fixture |
| --- | --- |
| T57-VERIFY | Original Timeline mount, phone Settings and rules-policy setup timeouts lack attributable captures. Inspect `installed-timeline.browser.mts`, `installed-settings-fixture.mts` and character setup/service diagnostics. |
| T18-DM | September 17 group-selection canvas startup timed out before an action. Large-session replays and startup-recovery fixes do not establish its cause. Inspect `installed-planner-selection-fixture.mts` and `installed-planner-startup-fixture.mts`. |
| T18-ENGINE / T53 | One rules-availability loss is not attributed by the later 13-case replay or independent worker saturation/transport fixes. Inspect `installed-rules.browser.mts` and `installed-character-rules-recovery-fixture.mts`. |

These fixtures live under `frontend/test/browser/`. Shared setup/browser/service
metadata and partial TAP now survive actual failures. Private detailed captures
remain local; public CI retains only the bounded permitted projections. One
Windows `ERR_NO_BUFFER_SPACE` event matches TCP port exhaustion, but its transient
pressure source remains unknown. Capture a recurrence with its exact source,
package hashes and request stages; preserve assertions/deadlines. Only an
explicit owner disposition can close a missing-evidence investigation as
inconclusive. Successful repeats alone do not close it.

## Remaining live and human acceptance

- T15: authenticated manager checks and independently verified full ZIP backups
  on both sites with the [matching running-image verifier](../SELF_HOSTING.md#verify-with-the-running-host-image).
- T15-DM/T16: review existing Asurai consequence targets after backup, activate
  newest reviewed packages, exercise actual save/worker feedback, verify
  selected-build retention and independent campaign recovery.
- T17: authenticated Tiamat inventory stays inactive; no add-on activation.
- T63: real touch, spoken screen-reader and paper-print results in both layouts.

The previous browser helper failed before returning authenticated state with
`apply deny-read ACLs`. No live backup or inventory acceptance is inferred from
public checks. The owner intends to work through these remaining points jointly.
T08 and C02–C10 remain conditional scope in the backlog, not invented blockers.

## Documentation and retired-source cleanup

The handoff cleanup removes superseded chronological work logs and completed
issue duplication from current documentation while retaining all 33 accepted
product-parity gates unchanged. Supported public contracts, tests, source data,
provenance, offline conversion and generic retained-history support remain.
Reserved protocol/schema names remain explicitly unsupported, not partial UI.

Local Engine `9e8085a` retires the old JavaScript reference-vector generator.
The 144 frozen synthetic vectors retain their source hashes and fixture-only
adapters. Full Go quality/test/race checks pass. Rebuilding and inspecting the
Windows ZIP preserves SHA-256
`8a73e218e98c466108d110ffb53fa05f10d4370db3fe888162c67f06b72dfadb`.
No worker, schema, manifest or runtime behavior changes. Host source pins retain
the last published accepted set; advancing them is a separate full source-set
acceptance, not established by a documentation edit. Cleanup commits are local;
the deployed source remains `1463caf`.

Estimates remain **97% implemented / 96% overall**, with **33/40 original rows
closed**. Documentation cleanup does not establish site or human acceptance.
