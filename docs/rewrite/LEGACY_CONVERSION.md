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
- Each supplied `-addon-package` ZIP is inspected twice: once before conversion
  and once immediately before publication. The converter accepts only the v3
  `dm-tools` and `dnd-sheets` packages and records their version and archive
  SHA-256 in the report.
- The six stable DM Tools collection files are validated against the target
  package schemas and their cross-record planning invariants before they are
  written. An explicitly empty collection remains materialized and empty.
- Each legacy `characters.addonData["dnd-sheets"]` object is stamped as sheet
  schema v3, validated against the target record-extension schema, written with
  the character's creation identity, and only then removed from the core
  character JSON. All of this happens inside the unpublished staging output;
  any failure discards the whole staged directory.

The command still inventories unknown `addon-data`, old add-on package copies,
registry/auth metadata, other files, unreferenced media, and embedded namespaces
other than `dnd-sheets`. Those values are listed separately rather than guessed
into a target package. Keep both original ZIPs until the supervised conversion
and live comparison have been verified.

## Dry conversion

Run once per website into distinct new directories:

```powershell
go run ./cmd/codex-convert-v1 `
  -in C:/backups/site-one-v1.zip `
  -out C:/migration/site-one-rewrite `
  -report C:/migration/site-one-conversion-report.json `
  -addon-package ../addon-dm-tools/dist/dm-tools-3.0.0.zip `
  -addon-package ../addon-dnd-character-sheets/dist/dnd-sheets-3.0.0.zip

go run ./cmd/codex-convert-v1 `
  -in C:/backups/site-two-v1.zip `
  -out C:/migration/site-two-rewrite `
  -report C:/migration/site-two-conversion-report.json `
  -addon-package ../addon-dm-tools/dist/dm-tools-3.0.0.zip `
  -addon-package ../addon-dnd-character-sheets/dist/dnd-sheets-3.0.0.zip
```

The command prints a `codex-v1-conversion-report.v3` JSON document and, when
`-report` is supplied, creates the same document at that new path without
overwriting an existing file. Its media
section separates imported source files and bindings, rewritten records, and
discarded generated tiles. Its add-on section records target package hashes,
document counts, stripped core records, imported source files, and any embedded
namespaces left for manual review. `deferred.media` contains only unreferenced
media and `deferred.addonData` only unrecognized collection files. Preserve the
report beside the corresponding backup so source identity, package identity,
imported counts, and deferred inventories can be compared during the supervised
migration. If a run fails or needs to be repeated, remove or choose a different
unused output directory after inspecting it; the converter never overwrites it.

Do not point either website at a generated directory until its report and
offline contents have been reviewed. Keep the old site stopped and its data
untouched while the converted directory is first exercised under the v2 host;
the supervised acceptance and rollback sequence is in `../SELF_HOSTING.md`.
