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
- `auth.json` is inventoried but not imported. Passwords and sessions are
  deployment configuration and must be configured afresh.
- `secrets.json` is rejected. The old UI intentionally excluded it, so its
  presence means the archive is not the expected backup artifact.

The command currently inventories, but does not publish, old media,
`addon-data`, add-on package copies, registry/auth metadata, and other files.
Those groups are listed separately with exact file and byte counts in the JSON
report. Their final import belongs to the rewrite's media store and v3
package/data ownership rather than an unowned filesystem copy. Keep both
original ZIPs until those owning slices and the supervised final conversion
have been verified.

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

The command prints a `codex-v1-conversion-report.v1` JSON document. Preserve
that output beside the corresponding backup so source identity, imported core
counts, and deferred inventories can be compared during the supervised
migration. If a run fails or needs to be repeated, remove or choose a different
unused output directory after inspecting it; the converter never overwrites it.

Do not point either website at the generated directory yet. The final run and
live smoke tests wait until the remaining rewrite surfaces and deferred asset
owners are complete.
