# Backlog

The only task list for the host and the first-party add-ons. Keep entries short
and concrete; delete them when done (Git keeps the history).

## Next

- **Check the first nightly smoke test.** The **Installed add-on smoke test**
  workflow runs at 02:41 UTC; confirm it passes and that the `ADDON_SUITE_TOKEN`
  secret still grants read access to the compendium repository.
- **Roll out the native-data release, in this order.** (1) Push the add-on
  branches so Compendium 3.2.0, Engine 4.1.0 and Sheets 4.1.0 publish. (2) On
  Asurai, download a backup, then update those three in Settings → Add-ons; the
  current host accepts them. (3) Merge and deploy the host; migration 0024
  converts both sites' remaining v1 names on startup. (4) Download fresh backups
  from both sites: ZIPs taken before step 2 contain the old Compendium build,
  which the new host refuses, so they restore only on the previous host image.
  If DM Tools reports dangling consequence targets, fix those planner entries by
  hand (it only reports them).
- **Asurai characters.** The players are rebuilding Bloodvell, Kael Vor, Ines
  and Talia in the new sheet builder. The September reconstructions and their
  review notes are archived with the backups for reference.
- **Tiamat.** Confirm Settings → Add-ons shows nothing installed. Tiamat stays
  without add-ons.

## Later

- **Retire the v1 layout on the servers.** Archive each site's v1 `data`,
  `data-snapshots` and `rewrite-v2` evidence to the owner's backups, move
  `rewrite-v2/data` to `data`, deploy the infra change that mounts `./data`,
  then remove the temporary `rewrite-v2/data` link. The local copies are already
  archived. Tiamat's conversion skipped one unreferenced 17 KB image; it stays
  in the archive. The old app is tagged `v1-final` in every repository.
- **Tag host versions.** Add-ons currently require the host by Go
  pseudo-version. Real tags (for example `v0.1.0`) would read better and let
  the add-ons reference the publish action by tag instead of commit SHA.
- **Split the largest UI files when next touched:** `frontend/src/app/codex-app.ts`,
  `campaign-record-editor.ts`, DM Tools' `planner-element.ts`, Sheets'
  `character-element.ts`.

## Ideas (only with a concrete need)

- **Update all add-ons at once.** Each add-on is updated through its own review;
  one combined review could update several.

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
