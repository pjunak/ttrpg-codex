# Backlog

The only task list for the host and the first-party add-ons. Keep entries short
and concrete; delete them when done (Git keeps the history).

## Next

- **Check the first nightly smoke test.** The **Installed add-on smoke test**
  workflow runs at 02:41 UTC; confirm it passes and that the `ADDON_SUITE_TOKEN`
  secret still grants read access to the compendium repository.
- **Asurai add-ons.** Take a backup, then update all four add-ons to their
  latest published packages in Settings → Add-ons. If DM Tools reports dangling
  consequence targets, fix those planner entries by hand (it only reports them).
- **Asurai characters.** The players are rebuilding Bloodvell, Kael Vor, Ines
  and Talia in the new sheet builder. The September reconstructions and their
  review notes are archived with the backups for reference.
- **Tiamat.** Confirm Settings → Add-ons shows nothing installed. Tiamat stays
  without add-ons.

## Later

- **Retire the already-converted v1 data.** Decide what to keep, archive or
  delete: the v1 `data` and `data-snapshots` directories and conversion
  artifacts next to `rewrite-v2/` on both servers, the September sheet-reset
  backups, and the local copies (`ttrpg-codex/data/`, `data-snapshots/`, the
  archived backups). Optionally spot-check a few records against the current
  sites first. Tiamat's conversion skipped one image (17 KB) that no record
  referenced; look at it in the v1 data before deleting anything. The
  converter is in Git history before the October cleanup and the old app is
  tagged `v1-final` in every repository.
- **Tag host versions.** Add-ons currently require the host by Go
  pseudo-version. Real tags (for example `v0.1.0`) would read better and let
  the add-ons reference the publish action by tag instead of commit SHA.
- **Split the largest UI files when next touched:** `frontend/src/app/codex-app.ts`,
  `campaign-record-editor.ts`, DM Tools' `planner-element.ts`, Sheets'
  `character-element.ts`.

## Ideas (only with a concrete need)

- **Restore a full backup from the web UI.** The old app could upload and
  restore a backup ZIP in Settings; the new host restores only with
  `codex-maintenance restore` on the server. A web flow could upload and verify
  the archive, stage it with the existing restore journal and restart.
- **Update all add-ons at once.** The old app had an "Update all" button; now
  each add-on is updated through its own review.

- **Cloud backup add-on.** Workers have no network access and cannot read backup
  archives today; it would need both as new, reviewed host capabilities.
- **Saved-data migrations that transform values.** Add-on updates can already
  keep compatible data or reset it with a backup download. Add transforming
  migrations only for a real incompatible case.
- **More add-on surfaces:** record renderers, custom graph node kinds, `kind`
  enum injection, HTTP endpoints and WASI workers were removed from the manifest
  until an add-on needs one. Each needs its runtime, review UI and docs.
- **Editor extensions:** arbitrary add-on editor fields or combined core/add-on
  saves (panels save independently today).
- **Operations:** a restart button in the web UI, persistent sessions or
  per-session revocation, add-on resource limits or signatures, add-on data
  indexes for measured load.
- **DM Tools:** faster Atlas placement and mouse-wheel preferences, if wanted.
- **Rules data:** per-item magic weapon/shield base forms, narrative combat
  effects, renown/facilities/Circle Magic automation. Add source data, Engine
  support and Sheets UI together for a mechanic someone needs
  ([gaps](../../addon-dnd-2024-compendium/data/GAPS.md)).

## Watch for

These failed once in September and have not recurred; reopen with a fresh
failure log if they do: the Timeline page and a phone Settings load timing out
at start-up, the planner canvas timing out before its first action, and the
rules service briefly reporting rules unavailable.
