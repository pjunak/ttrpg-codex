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
- **Engine 5 and Sheets 5 on Asurai** `ttrpg-codex` — Download fresh backups
  of both sites into `L:\Backups\ttrpg\`. After the host deploy, Sheets stops
  until updated (its worker-only schema identity changed). In Settings →
  Add-ons install Engine 5.0.0, then Sheets 5.0.0 and choose **Remove data and
  update**: existing character sheets are cleared. Re-import the characters
  from the `character-imports/` folder beside the repositories. If DM Tools
  reports dangling consequence targets, fix those planner entries by hand (it
  only reports them).
- **Asurai characters** `addon-dnd-character-sheets` — The players are
  rebuilding Bloodvell, Kael Vor, Ines and Talia in the new builder. The
  September reconstructions are archived with the backups for reference.
- **Tiamat** `ttrpg-codex` — Confirm Settings → Add-ons shows nothing
  installed. Tiamat stays without add-ons.

## Next

- **Compendium translation overlays** `addon-dnd-2024-compendium` — The
  `data/i18n/` record overlays are specified in `data/SCHEMA.md` but nothing
  loads or applies them. Implement them (planned for its own session) so the
  browse UI and the rules-data service can show translated record fields.
- **More context-menu targets** `ttrpg-codex` — Record menus exist
  ([editing and browsing](reference/EDITOR_BROWSING.md#record-context-menus)).
  Candidates the owner has not chosen between yet: map pins and empty map
  space, timeline cards and session columns, relationships ("add relationship
  to…"), faction ranks, the wiki writer (insert a campaign link at the cursor),
  and lending the menu to add-ons through the SDK (a contract change).
- **Character sheet refinement** `addon-dnd-character-sheets` — Compact has
  per-tab context bars, pips and floating windows; the owner keeps refining it.
  Parts of the approved mockup still need contract work first: concentration
  as a saved play value (with the save DC from the Engine), Engine-computed
  advantage/disadvantage so conditions can mark the rolls they affect, and item
  weight with container capacity (a container backed by an item, Bag of Holding
  contents counting as nothing). The Backpack window still uses the older item
  rows rather than the mockup's list-and-editor layout.

## Undecided

> **The owner is still figuring out what to do with these.** Leave their UI and
> data model as they are: no redesigns, migrations or "quick fixes" until a
> decision is recorded here or as an [ADR](decisions/). Bug fixes that keep
> current behaviour are fine.

- **Knowledge and investigation model** `ttrpg-codex` — How much players know
  about characters (the four knowledge levels), mystery clues (many are bare
  event keys), and characters' *open questions* / *what is known* (also shown
  in Mind Palace and the unanswered-questions list). Current behaviour, known
  problems and the questions to answer are in the
  [design note](design/knowledge-and-investigation.md).

## Later

- **Tag host versions** `ttrpg-codex` and add-ons — Add-ons require the host by
  Go pseudo-version. Real tags (for example `v0.1.0`) would read better and let
  the add-ons reference the publish action by tag instead of commit SHA.
- **Apply class damage bonuses to attacks** `addon-dnd-engine`,
  `addon-dnd-character-sheets` — The Martial Arts die and Rage Damage are shown
  from the class tables but not yet applied to the attacks they affect.
- **Align owned-feature filters** `addon-dnd-2024-compendium`,
  `addon-dnd-engine` — The Compendium's owned-feature filter and the Engine's
  ownership rules can disagree; make them match.
- **Collapse add-on confirmation flows when next touched** `ttrpg-codex` —
  Activation, disable, uninstall, cleanup, schema and update reviews each have
  their own review type and SHA-256 confirmation token. Do not add another;
  when one of them changes, move it to a shared plan-and-confirm helper that
  checks expected state revisions. Disable is reversible and could confirm with
  a plain dialog plus the target's state revision.
- **Split the largest UI files when next touched** — `frontend/src/app/codex-app.ts`,
  `campaign-record-editor.ts` and `codex-record-page.ts` in the host, DM Tools'
  `planner-element.ts`, Sheets' `character-element.ts`.

## Ideas

Only start one of these for a concrete need, and design the review UI and docs
with it.

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
- **Operations** `ttrpg-codex` — A restart button in the web UI, per-session
  revocation and a session list, request/correlation
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
- The shared-controls and editors browser fixtures timing out at start-up in a
  full `npm run check` (October).
