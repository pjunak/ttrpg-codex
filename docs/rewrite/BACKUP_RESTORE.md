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
by the restored database exists with the expected size and digest. Credentials
currently come from the process environment, so the archive intentionally
contains no DM or player password.

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

The Settings download control and restore-upload workflow are still pending.
They must reuse this format and service rather than inventing another one.
Uploaded restore candidates should be staged and verified while the host runs,
but publication must still happen through the offline restart boundary.
