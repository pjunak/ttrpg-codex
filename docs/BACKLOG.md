# Backlog

The only task list for the host and the four first-party add-ons. Reference
docs describe what exists; this file says what to do next. Delete an entry when
it is done (Git keeps the history) and update the reference it changes.

**Entry format.** A bold title, the affected repositories in backticks, then
what and why in one or two sentences. Add **Done when** if the finish line is
not obvious. Move an entry between sections instead of duplicating it.

| Section | Meaning |
| --- | --- |
| [Owner checks](#owner-checks) | Live-site tasks only the owner does; each needs an explicit go-ahead |
| [Next](#next) | Agreed development work, ready to start |
| [Undecided](#undecided) | The owner is still deciding; do not start |
| [Later](#later) | Worth doing when the area is next touched |
| [Ideas](#ideas) | Only with a concrete need |
| [Watch for](#watch-for) | Failures seen once; reopen with a fresh log |

## Owner checks

- **Nightly smoke test** `ttrpg-codex` — The **Installed add-on smoke test**
  workflow runs at 02:41 UTC. Confirm it passes and that the
  `ADDON_SUITE_TOKEN` secret still reads the compendium repository.
- **Native-data rollout on Asurai** `ttrpg-codex` — Confirm Compendium 3.2.0,
  Engine 4.1.0 and Sheets 4.1.0 are active (Settings → Add-ons; the host refuses
  the old Compendium build), then download fresh backups of both sites into
  `L:\Backups\ttrpg\`. If DM Tools reports dangling consequence targets, fix
  those planner entries by hand (it only reports them).
- **Asurai characters** `addon-dnd-character-sheets` — The players are
  rebuilding Bloodvell, Kael Vor, Ines and Talia in the new builder. The
  September reconstructions are archived with the backups for reference.
- **Tiamat** `ttrpg-codex` — Confirm Settings → Add-ons shows nothing
  installed. Tiamat stays without add-ons.

## Next

- **Context menus** `ttrpg-codex` — Explore right-click (and long-press) menus,
  nested by context, for linking, adding records into others and similar
  actions that would otherwise need extra buttons. Start with a shared,
  keyboard-accessible menu control in `frontend/src/ui/`, then a few high-value
  record and card actions. **Done when** the control is documented in
  [shared UI](reference/UI_FOUNDATIONS.md) and at least cards and record facts
  use it.
- **Character sheet UI pass** `addon-dnd-character-sheets` — Review the sheet
  for the same compactness and consistency problems fixed in the host
  (October 2026 compact pass), together with the owner.
- **Shared controls inside installed add-ons** `ttrpg-codex` and the three UI
  add-ons — The compact control size, the `ui-controls` cascade layer and the
  `data-ui="chips"` picker have not been tried in real installed add-ons. Run
  the installed smoke test with release ZIPs and review the add-on screens.

## Undecided

> **The owner is still figuring out what to do with these.** Leave their UI and
> data model as they are: no redesigns, migrations or "quick fixes" until a
> decision is recorded here or as an [ADR](decisions/). Bug fixes that keep
> current behaviour are fine.

- **Knowledge and investigation model** `ttrpg-codex` — How much players know
  about characters (the four knowledge levels), mystery clues (many are still
  v1 event keys), and characters' *open questions* / *what is known* (also shown
  in Mind Palace and the unanswered-questions list). Current behaviour, known
  problems and the questions to answer are in the
  [design note](design/knowledge-and-investigation.md).

## Later

- **Tag host versions** `ttrpg-codex` and add-ons — Add-ons require the host by
  Go pseudo-version. Real tags (for example `v0.1.0`) would read better and let
  the add-ons reference the publish action by tag instead of commit SHA.
- **Split the largest UI files when next touched** — `frontend/src/app/codex-app.ts`,
  `campaign-record-editor.ts` and `codex-record-page.ts` in the host, DM Tools'
  `planner-element.ts`, Sheets' `character-element.ts`.

## Ideas

Only start one of these for a concrete need, and design the review UI and docs
with it.

- **Update all add-ons at once** `ttrpg-codex` — Each add-on is updated through
  its own review; one combined review could update several.
- **Cloud backup add-on** — Workers have no network access and cannot read
  backup archives; both would be new, reviewed host capabilities.
- **Value-transforming add-on data migrations** `ttrpg-codex` — Updates can
  keep compatible data or reset it with a backup download. The reserved worker
  methods `addon/migration.plan` and `addon/migration.apply` are not
  implemented; add them only for a real incompatible case.
- **More add-on surfaces** `ttrpg-codex` — Record renderers, custom graph node
  kinds, `kind` enum injection, HTTP endpoints, WASI workers, standalone
  `context.imports/events/settings/navigation/log` SDK handles and native
  self-binding during worker start-up. Each needs its runtime, review UI and
  docs.
- **Editor extensions** `ttrpg-codex` — Arbitrary add-on editor fields or
  combined core/add-on saves (panels save independently today).
- **Operations** `ttrpg-codex` — A restart button in the web UI, persistent
  sessions with per-session revocation and a session list, request/correlation
  IDs and security-event diagnostics (never recording credentials or tokens),
  add-on resource limits or signatures, add-on data indexes for measured load.
- **DM Tools** `addon-dm-tools` — Faster Atlas placement and mouse-wheel
  preferences, if wanted.
- **Rules data** `addon-dnd-2024-compendium`, `addon-dnd-engine`,
  `addon-dnd-character-sheets` — Per-item magic weapon/shield base forms,
  narrative combat effects, renown/facilities/Circle Magic automation. Add
  source data, Engine support and Sheets UI together for a mechanic someone
  needs ([gaps](../../addon-dnd-2024-compendium/data/GAPS.md)).

## Watch for

These failed once and have not recurred:

- The Timeline page and a phone Settings load timing out at start-up (September).
- The planner canvas timing out before its first action (September).
- The rules service briefly reporting rules unavailable (September).
- The shared-controls browser fixture timing out at start-up in a full
  `npm run check` (October).
