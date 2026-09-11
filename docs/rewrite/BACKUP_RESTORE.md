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
their revision/operation records. Campaign recovery appends a retained head;
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

The verifier and restore command continue to accept `codex-backup.v1` archives
that contain only the database and add-on generations. After applying current
migrations, such an archive is rejected if its database references a blob that
the older format did not carry.

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
references, and neither is physically deleted during an online backup.

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

Settings → Backup & recovery downloads this same full archive. Archive upload
and publication remain an offline maintenance operation; campaign recovery
points below are available without restarting the host.

## Campaign recovery points

The original Settings history workflow is available in English and Czech:
manual points, coalesced automatic points, reviewed restore/delete, and revert
of the last N retained automatic edit groups. The newest 50 points are retained
across all three kinds (`manual`, `save`, `pre-restore`). A point contains at
most 64 MiB of campaign metadata, not copies of the immutable file bytes.
Manual points do not delay the next automatic group. After a restore, the next
edit starts a new group. Revert counts automatic groups, not individual field
changes, manual points or safety points; its review shows the selected date.

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
checks the point's format, active add-on generations and existing dataset
definitions, and first captures a `pre-restore` safety point. All campaign,
add-on and media changes, the payload-free restore audit, and the durable
`campaign-restored` publication commit together. A failure rolls back all of
them. Restored live records get fresh revisions; removed keys keep deletion
tombstones, so stale editors and reviewed import plans cannot overwrite the
recovered data. Collection/dataset revisions also advance, including empty
collections. Immutable record creation identities are restored with their
extensions. Recovery across different active add-on versions or data schemas
is refused; use matching package versions or a full offline backup restore.

The HTTP surface requires a real and effective DM, plus CSRF for writes:

| Route | Request / response |
| --- | --- |
| `GET /api/recovery` | `recovery-points.v1`: review revision and newest-first metadata only |
| `POST /api/recovery` | Exact `{}` creates a manual point and returns the list |
| `POST /api/recovery/restore` | `expectedRevision` plus either positive `id` or `count` (1–50) |
| `POST /api/recovery/delete` | Positive `id` and `expectedRevision` |

All responses are no-store. A changed campaign/list returns `RECOVERY_CONFLICT`;
different add-on versions/definitions return `RECOVERY_COMPATIBILITY`. Missing
retained points/groups return 404. After an uncertain network result the UI
requires a fresh list and review before another restore/delete.

Storage regression tests cover failed writes/restores, concurrent reviews,
retention, tombstones, unknown fields, empty datasets, extensions and media.
`recovery.browser.mts` covers desktop/phone Settings, English/Czech copy, stale
reviews, uncertain responses, pending navigation, undo and private ZIP download.
`installed-sheets.browser.mts` verifies recovery in a real installed package and
retention of an unsaved add-on draft in another tab.
