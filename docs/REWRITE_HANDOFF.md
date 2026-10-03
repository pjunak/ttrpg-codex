# Rewrite handoff

Current snapshot: October 3, 2026. This is an orientation for continuing work;
[BACKLOG.md](BACKLOG.md) remains the only task list.

## Goal and current state

TTRPG Codex is a self-hosted campaign archive: linked articles, characters,
places, events, maps and relationships, with separate DM/player access.
Optional add-ons provide planning, structured rules and character sheets.

The rewrite replaces the old Node/in-process add-on runtime with a Go host,
SQLite transactions, Lit/TypeScript UI and immutable Add-on API v3 packages.
Preserve useful workflows and authored data while removing legacy coupling.
Node is build/test-only. Production never compiles add-on source.

The reusable, themeable UI remains a central goal: host and integrated add-ons
borrow the same `ui.controls.v1` implementation. Rules, persistence and specialist
layouts stay with their owners; do not hard-code edition mechanics in controls.

Host `1463caf` is deployed and healthy on **Asurai and Tiamat**. Its Linux
acceptance passes 278/278 installed cases with zero skips. Desktop/phone, public
assets, live connections and portraits pass. See the
[exact release receipt](rewrite/HOST_CLEANUP_ACCEPTANCE.md#october-3-approved-follow-up-rollout).
Approximately **97% implemented / 96% overall** is an effort estimate, not a
test score. Historical startup/provider failures and live/human acceptance
remain open. Do not treat passing reruns as their diagnosis.

## Where things live

Five independent Git repositories sit under `L:\GitHub\TTRPG`; the parent is
not a package or Git root. Read each applicable `AGENTS.md` before editing.

| Repository | Ownership and useful entry points |
| --- | --- |
| `ttrpg-codex` | `cmd/` composition/maintenance; `internal/{application,storage,transport,addons}/` host policy/data/runtime; `frontend/src/app/` views, `frontend/src/ui/` reusable controls, `frontend/src/addons/` SDK/runtime; `contracts/addons/v3/` and `examples/addons/` public contracts. |
| `addon-dm-tools` | `src/` planner/Atlas/Import Center; `internal/planning/` validation and `internal/importer/` retained preview/commit; `docs/{GRAPH,PLANNER,IMPORTING,AGENT_GENERATION}.md` behavior and authoring. |
| `addon-dnd-2024-compendium` | `data/<book>/<kind>/<id>.json` authoritative content; `data/{SCHEMA,COVERAGE,GAPS}.md` shapes/provenance/limits; `src/` library/search/details; rules-data v3 provider. |
| `addon-dnd-engine` | `internal/rules/` pure computation, `internal/provider/` rules-data client, `internal/engine/` worker boundary; `contract/README.md` and `rules/README.md`; rules-engine v4 provider. |
| `addon-dnd-character-sheets` | `src/character-element.ts` UI, `src/character-client.ts` service/conflicts, `internal/character/` sole schema-4 save coordinator; `docs/RULES_EDGE_CASES.md`; Compact and Classic. |

## Remaining work, in useful order

| Work | Owner / next action |
| --- | --- |
| T15–T17 site acceptance | Verify real DM access and independently verify full ZIP backups with the deployed matching maintenance binary. Then inspect Asurai's newest reviewed add-on builds, real save/worker feedback, automatic selected-build retention and independent campaign recovery. **Tiamat uses no add-ons and must stay that way**; only verify its inactive inventory. |
| T15-DM existing planning data | After a verified Asurai backup, review consequence targets before activating stricter validation. The code fix exists. Report dangling references and repair only reviewed targets; no automatic rewriting. |
| T57-VERIFY / T18-DM / T18-ENGINE | Capture an actual recurrence of Timeline/phone Settings/rules-policy startup, pre-action planner canvas timeout, or T53 rules-availability loss. Existing originals lack attribution. Diagnose the retained browser/setup/service/native evidence, or obtain an explicit owner decision to close an investigation as inconclusive. Preserve deadlines/assertions. |
| T63 physical acceptance and touch-ups | Use real touch, a spoken screen reader and paper printing with Compact/Classic. Check navigation, focus, enlarged text, dialogs, scroll reachability and clipping. Turn actual defects into bounded changes; no unbounded visual redesign is pending. |
| T08, only if needed | Existing schema healing, explicit reset, backup offer and automatic recovery are complete. Add value-transforming migration only for a concrete incompatible saved JSON preservation case, with an exact reviewed atomic plan. No guessed conversion or legacy startup layer. |
| C05/C10 and other conditional extensions | Atlas wheel/placement refinements need an actual UX request. Magic weapon/shield base-form choices need source facts plus Engine/Sheets support together. Narrative combat effects, renown/facilities/Circle Magic automation and reserved SDK transports are scope decisions, not current cleanup blockers. |

## Preserve these conventions

- One complete instance ruleset; source packages contribute compatible books.
  Stable `(kind, id)` and `book` provenance survive genuine `availableIn` reprints.
- Compendium → rules-data v3 → Engine → rules-engine v4 → Sheets. Discover
  providers by contract, never sibling add-on IDs. Saved sheets remain readable
  without rules; mechanical edits require compatible rules.
- Core records belong to the host. Sheets automatically saves current state
  through its authenticated worker; no manual Save/Apply, device drafts or
  character-history UI. DM Tools owns the visible Import Center.
- Shared controls, semantic skin tokens, accessible focus and generation-owned
  cleanup apply to host and add-ons. Preserve small native selects, searchable
  long choices, and domain-specific layouts. See [UI foundations](rewrite/UI_FOUNDATIONS.md).
- Campaign and add-on recovery are independent. Server housekeeping removes
  superseded packages; a user reviews privileges/requirements and incompatible
  data resolution, not a package-cleanup inventory.
- Preserve authored content, stable namespaces, generated schema ownership,
  immutable package provenance and optional-provider behavior. Keep private
  exports, backups, runtime generations and raw captures outside publication.

## Validation, publication and local state

Host gate: `npm run check`; release gate: `npm run release-check`. TypeScript
add-ons use their `npm run check`; Engine uses `go run ./tools/check.go`.
Package/worker/schema changes require a fresh archive and the host inspector.
Integration uses staged ZIP → review → approve → activate, never source copying.
See [Contributing](../CONTRIBUTING.md#choose-validation-for-the-change).

The cleanup retires Engine's old JavaScript vector generator; its frozen 144
synthetic parity vectors remain. Engine cleanup `9e8085a` passes its full Go/race
gate and rebuilds the identical inspected Windows ZIP. Host companion pins retain
the last accepted published set: DM `316399a`, Engine `f19f634`, Sheets `06ef7a5`
and Compendium `2971a39`. Engine's local cleanup is ahead of that pinned baseline;
use clean pinned checkouts for baseline installed acceptance, or deliberately
advance the pin with full source-set acceptance. These cleanup/documentation
commits remain **local**. If a new source set is later approved for publication,
publish its companions before the dependent host pin.
The earlier deployment approval is already fulfilled; ask before a new push or rollout.

Older detailed audit/batch notes are recoverable in Git history before this
cleanup (`8488968`). Current references describe behavior; the backlog records
only remaining work and compact completion summaries. All 33 accepted release
gates remain unchanged. Do not restore speculative API stubs from old plans.

The previous authenticated browser helper failed before returning state with
`apply deny-read ACLs`; there is no completed live backup/inventory result.
Recheck tool availability when needed, or work through those checks with the
owner. Never extract browser sessions or point development tools at live volumes.
