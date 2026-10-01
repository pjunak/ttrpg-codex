# Native backup and restore

The rewrite backup is a versioned recovery archive, not a directory copy and
not the legacy JSON/ZIP restore format. `codex-backup.v2` contains:

- one online SQLite image at `codex.db`, including committed WAL state;
- every published immutable add-on generation under `addons/`;
- every immutable hash-addressed blob object under `blobs/sha256/`;
- an exact manifest with the host version, creation time, and each file's
  path, byte count, SHA-256, and portable permission mode.

Transient add-on and blob `.staging` content is excluded. Blob archive paths
must match their content hash, and verification proves every object referenced
by the restored database exists with the expected size and digest. The database
also retains [immutable add-on history payloads](RETAINED_ADDON_HISTORY.md) and
their revision/operation records. Add-on recovery appends a retained head;
it does not erase later revisions. Browser device drafts are outside backups.
The database
includes versioned DM/player password hashes, never clear-text passwords.
Restoring an archive restores those credentials. Archives made before password
persistence have no saved credentials and bootstrap from the environment on
their next start. The offline password-reset command can recover access after
restore; see [self-hosting](../SELF_HOSTING.md#password-changes-and-access-recovery).

GitHub repository links and generation provenance are included in `codex.db`.
GitHub access tokens are stored separately in `credentials/github.db`, outside
the backup allowlist, and are never included or restored. Configure GitHub
access again after moving a campaign backup to a new server. Campaign recovery
points do not change repository links or tokens.

Normal verification and restore accept only `codex-backup.v2`. Retired
formats require their separate offline conversion procedure.

Creation, verification and restore share a manifest size limit of 64 MiB by
default, alongside the 100,000-file, 1 GiB archive and 4 GiB expanded-data
limits. Creation refuses to publish an archive whose manifest exceeds that
limit. The earlier verifier's fixed 1 MiB limit could reject backups produced
by the host once retained add-on packages added enough files; use the updated
maintenance utility to verify and restore those archives.

## Commands

Create a new archive. The destination must not already exist and must be
outside the live data directory:

```powershell
go run ./cmd/codex-maintenance backup `
  -data-dir data/rewrite `
  -out C:/backups/codex-2026-09-01.zip
```

The SQLite online-backup API gives one committed database image while the host
is running. Add-on generations and blob objects are safe to collect afterward
because both publish complete immutable files before recording their database
references. Online creation holds the add-on lifecycle lock from the SQLite
snapshot through archive publication, so reviewed package cleanup, staging and
activation wait for it. Offline maintenance instead holds the host-process lock.
Blob objects are not physically collected. Existing backup ZIPs own their copies
of package files and do not prevent cleanup of an inactive live generation.
Add-on recovery contexts retain exact package identities. Default
[latest-only retention](PACKAGE_LIFECYCLE.md#automatic-package-file-retention)
retires only obsolete add-on contexts, preserving their campaign snapshots.
With `CODEX_ADDON_KEEP_RECOVERY_PACKAGES=true`, superseded files may instead be
downloaded again when needed. Before publishing a full
backup, online and offline creators materialize every missing recovery package
into temporary staging and verify its exact add-on ID and archive SHA-256.
The snapshot records those files as local; the running installation is unchanged.
Temporary materialization is bounded to 512 packages, 100,000 files and 4 GiB,
with a five-minute preparation deadline; the ordinary full-archive limits still
apply to the combined campaign and package files.

Missing or changed historical packages fail the backup before an output archive
is published. The web response directs the operator to check GitHub access or
upload the matching ZIP. Verification and restore also require every active and
recovery-referenced package ZIP and its extracted files to be complete and
correct. A restored full backup can therefore start offline. Default latest-only
retention also runs after healthy startup of a restored directory; to retain
the archive's historical add-on contexts, set `CODEX_ADDON_AUTO_CLEANUP=false`
before starting it, or choose the recoverable-package policy above. The input
backup ZIP itself is never modified.
An archive may include an approved pending cleanup receipt and remaining files;
the restored host resumes that approved cleanup at startup.

An authenticated real-and-effective-DM can download the same format from
`GET /api/backup`. The handler creates the bounded archive in operating-system
temporary storage, streams it with no-store download headers, and removes the
stage after success, failure, or cancellation.

Verify an archive without touching live data:

```powershell
go run ./cmd/codex-maintenance verify `
  -in C:/backups/codex-2026-09-01.zip
```

Verification rejects traversal, symbolic links, duplicates, undeclared or
missing files, changed modes, size-limit violations, and hash mismatches. It
extracts into operating-system temporary storage, applies known forward-only
migrations to that isolated copy, then runs SQLite quick and foreign-key
checks.

Restore only while the host is stopped:

```powershell
go run ./cmd/codex-maintenance restore `
  -data-dir data/rewrite `
  -in C:/backups/codex-2026-09-01.zip
```

The host and restore command contend for the same operating-system file lock,
so a live restore fails closed. Restore fully verifies and migrates a sibling
staging directory before changing the target. Publication journals one
directory swap: the current directory moves aside, the prepared directory
takes its place, and only then is the old directory removed. Startup resolves
an interrupted journal before opening SQLite, either finishing a validated
installation or restoring the previous directory.

## Deliberate boundary

The two backups downloaded from the old websites are not accepted here. They
are consumed by the separate, narrowly scoped
[`codex-convert-v1`](LEGACY_CONVERSION.md) command, which writes a fresh data
directory and database. This keeps legacy shape handling out of normal startup
and out of the permanent native restore surface.

Settings → Backup & recovery downloads this same full archive and links the
[verification and offline full-restore procedure](../SELF_HOSTING.md#verify-and-restore-a-full-backup)
from both English and Czech interfaces. Archive upload
and publication remain an offline maintenance operation; campaign recovery
points below are available without restarting the host.

## Campaign recovery points

The original Settings history workflow is available in English and Czech:
manual points, coalesced automatic points, reviewed restore/delete, and revert
of the last N retained automatic edit groups in the selected scope. The newest 50 snapshots are retained
across all three kinds (`manual`, `save`, `pre-restore`). A point contains at
most 64 MiB of campaign metadata, not copies of the immutable file bytes.
Manual points do not delay the next automatic group. After a restore, the next
edit starts a new group. Revert counts automatic groups, not individual field
changes, manual points or safety points; its review shows the selected date.
Each snapshot holds independently selectable campaign and per-add-on contexts.
Deleting one context preserves all others; only an empty envelope is removed.
Campaign recovery remains available when add-on context or packages are absent.

Migration 0012 stores core collection materialization, ordered records with
unknown fields and creation identities, add-on datasets/documents and their
ownership metadata, logical blob deletion state, and core media bindings.
Media files and opaque handles remain in immutable storage, allowing recovery
of a deleted portrait or an older world-map slot. Passwords, sessions, package
installations, permissions, service bindings, and audit history are excluded.
The existing native full backup includes these recovery points in its SQLite
image and retains their immutable objects.

The host wires `recoverystore.BeforeWrite` into core/add-on transactions and
blob creation/deletion. It captures once before the first mutation, at most
once per minute, in the same transaction. A failed edit rolls back its point.
Per-row triggers advance the review revision without taking intermediate
snapshots. Offline conversion does not capture partly converted states;
package lifecycle transitions use the full backup/rollback boundary.

Restore acquires the SQLite write transaction with the exact reviewed revision,
checks the point's format and selected scope, and captures a `pre-restore`
safety point. Campaign restore changes only core records and core-owned media;
it never checks add-on package compatibility or rewinds current add-on saves.
An add-on restore changes only that owner's datasets, documents and logical
file handles. It requires that owner's exact active generation and compatible
dataset definitions, regardless of other active or missing add-ons. Saved
record extensions must match the current target record's creation identity;
restore the campaign first if necessary. A reused record key is insufficient.

All selected data changes, the payload-free restore audit (including scope
and add-on ID from migration 0022), and the durable
`campaign-restored` publication commit together. A failure rolls back all of
them. Restored live records get fresh revisions; removed keys keep deletion
tombstones, so stale editors and reviewed import plans cannot overwrite the
recovered data. Only the selected scope's collection/dataset revisions advance,
including empty collections. Campaign restore preserves saved extensions even
if their targets are temporarily absent; normal ownership checks prevent them
from attaching to a different record. Add-on recovery across different package
or schema identities is refused; campaign recovery is independent.

The HTTP surface requires a real and effective DM, plus CSRF for writes:

| Route | Request / response |
| --- | --- |
| `GET /api/recovery` | `recovery-points.v2`: review revision, newest-first metadata, `campaignAvailable`, `campaignMedia`, and per-owner `addons` summaries with exact generation and compatibility; no saved bodies |
| `POST /api/recovery` | Exact `{}` creates a manual point and returns the list |
| `POST /api/recovery/restore` | `scope: "campaign"` or `scope: "addon"` with `addonId`; `expectedRevision` plus either positive `id` or `count` (1–50) |
| `POST /api/recovery/delete` | Same explicit scope, positive `id` and `expectedRevision` |

For existing clients, an omitted scope retains the original combined operation.
Combined restore requires the exact complete package set and refuses snapshots
whose contexts have been retired. New clients always send a scope. Original
version-1 snapshot envelopes remain readable; context retirement marks them
partial without rewriting unknown record fields.

All responses are no-store. A changed campaign/list returns `RECOVERY_CONFLICT`;
incompatible add-on packages, definitions or linked records return `RECOVERY_COMPATIBILITY`. Missing
retained points/groups return 404. After an uncertain network result the UI
requires a fresh list and review before another restore/delete.

Recovery list/action response bodies, including error JSON, stop awaiting when
their initiating component is disconnected. Late results remain observed but
cannot update the replacement view. Reconnect reads the current list; cancellation
does not undo an accepted create/restore/delete or automatically retry it.

Storage regression tests cover failed writes/restores, concurrent reviews,
retention, tombstones, unknown fields, empty datasets, extensions and media.
`scopes_test.go` adds independent values/revisions/media, reused record IDs,
partial deletion and retirement rollback. `latest_retention_test.go` proves
campaign recovery and backup references survive obsolete package removal.
`recovery.browser.mts` covers desktop/phone Settings, English/Czech copy, stale
reviews, uncertain responses, pending navigation, undo and private ZIP download.
`installed-sheets.browser.mts` verifies recovery in a real installed package and
retention of an unsaved add-on draft in another tab.
