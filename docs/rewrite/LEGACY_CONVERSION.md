# One-time v1 campaign conversion

The two website backups downloaded from the v1 Settings UI are the migration
source. The rewrite does not read old JSON during startup and does not expose a
general legacy restore endpoint. Instead, `codex-convert-v1` creates one fresh
rewrite data directory from one old UI ZIP.

## Safety contract

- `-in` accepts only a ZIP shaped like the v1 `/api/backup` download, with
  entries below `data/`.
- The input is opened read-only and its SHA-256 is included in the report.
- `-out` must not exist. The converter builds and checks a sibling staging
  directory, then publishes it with one rename; it never merges into or
  replaces an existing host.
- ZIP paths, duplicates, symbolic links, entry sizes, total expansion, and
  entry count are bounded before publication.
- A fresh migrated SQLite database receives all known core collection files in
  one transaction. Missing and deliberately empty collections remain distinct,
  list order is retained, and record bodies and visibility are preserved.
- Referenced character and pet portraits, local maps, configured marker icons,
  the custom logo, and the one canonical world-map source are validated through
  the normal media service and stored as opaque blobs. Their known record URLs
  are rewritten to `/api/media/b_...` handles. Missing referenced files and
  ambiguous world-map sources fail the conversion.
- Generated map tiles are counted and deliberately discarded because they are
  derived cache data. Unreferenced media is reported and left only in the
  source backup rather than guessed into campaign ownership.
- `auth.json` is inventoried but not imported. Passwords and sessions are
  deployment configuration and must be configured afresh.
- `secrets.json` is rejected. The old UI intentionally excluded it, so its
  presence means the archive is not the expected backup artifact.

The command still inventories, but does not publish, `addon-data`, add-on
package copies, registry/auth metadata, other files, and unreferenced media.
Those groups are listed separately with exact file and byte counts in the JSON
report. Their final import belongs to v3 package/data ownership rather than an
unowned filesystem copy. Keep both original ZIPs until those owning slices and
the supervised final conversion have been verified.

## Dry conversion

Run once per website into distinct new directories:

```powershell
go run ./cmd/codex-convert-v1 `
  -in C:/backups/site-one-v1.zip `
  -out C:/migration/site-one-rewrite

go run ./cmd/codex-convert-v1 `
  -in C:/backups/site-two-v1.zip `
  -out C:/migration/site-two-rewrite
```

The command prints a `codex-v1-conversion-report.v2` JSON document. Its media
section separates imported source files and bindings, rewritten records, and
discarded generated tiles; `deferred.media` contains only unreferenced media.
Preserve that output beside the corresponding backup so source identity,
imported counts, and deferred inventories can be compared during the
supervised migration. If a run fails or needs to be repeated, remove or choose
a different unused output directory after inspecting it; the converter never
overwrites it.

Do not point either website at the generated directory yet. The final run and
live smoke tests wait until the remaining rewrite surfaces and add-on-owned
data conversion are complete.
