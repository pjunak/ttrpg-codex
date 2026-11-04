# Backup and restore

There are three layers of recovery, from the finest to the whole server:

- **Recovery points** keep the campaign and each add-on's data in the database
  and restore one part at a time ([below](#campaign-recovery-points)).
- **Backup bundles** are what Settings → Backup & recovery downloads and
  imports: the newest point of every part with the files those points use.
- **Full archives** copy the whole data directory, including passwords and
  installed add-on packages. Only the maintenance command makes and restores
  them.

## Backup bundle

`GET /api/backup` (real and effective DM) first makes every current part's
newest recovery point equal its current state: a part whose state differs
from its newest point gets a `download` point; an unchanged part reuses its
newest point, so repeated downloads add nothing. It then writes
`codex-backup-bundle.v1` to operating-system temporary storage and streams it
with no-store download headers as `codex-backup-YYYYMMDD-HHMMSS.zip`:

```text
manifest.json             format, createdAt, hostVersion, migration, parts, blobs
parts/campaign.json       the campaign point's image
parts/addons/<id>.json    one image per add-on with data, files or an active build
blobs/sha256/<digest>     each file object a part needs, once per content
```

Each manifest part records its scope (and add-on ID), the point ID, date and
reason, the add-on's active generation and release version, and the image's
size and SHA-256. Each blob entry records the handle ID, content digest and
size, owner, purpose, media type, original name, visibility and creation date.
A part's files are exactly those the offline collector keeps for its image
(`recoverystore.ImageBlobs`): live handles plus any blob ID its records,
documents or media bindings mention. `migration` is the newest database
migration of the writing host. Add-on packages, passwords, sessions, GitHub
links and tokens, and older recovery points are not included.

`POST /api/backup/import` (DM session plus CSRF, `Content-Type:
application/zip`, at most 1 GiB) saves the upload to temporary storage and
refuses, with `INVALID_BACKUP` and the reason, a bundle that:

- has entries other than those the manifest declares, or a directory, link or
  duplicate entry, or declared sizes or digests that do not match;
- is another format, or comes from a host with a migration this one has not
  applied;
- has an image that is not a recovery point (all eight keys, `version: 1`), or
  holds another part's data, lists another part's file, or needs a live file
  or media binding whose file is not in the bundle;
- reuses a file ID that this host has with other content or owner.

An accepted bundle changes no current data. Missing file objects are published
through the blob store's digest-checked path; missing handles are recorded
under their original IDs as logically deleted; and each part becomes an
`imported` recovery point dated when the bundle captured it, all in one
transaction. The response is `backup-import.v1` (`createdAt`, `parts`). The DM
then restores parts from their lists with the normal review: the campaign
first, then add-ons, each of which needs the same build installed (the
manifest names its release version). A restore revives exactly the files its
image lists. Other refusals are `PAYLOAD_TOO_LARGE` (413) and
`BACKUP_UNAVAILABLE` (503); both leave everything unchanged.

## Full archive

A full archive is a versioned recovery archive, not a directory copy.
`codex-backup.v2` contains:

- one online SQLite image at `codex.db`, including committed WAL state;
- every published immutable add-on generation under `addons/`;
- every immutable hash-addressed blob object under `blobs/sha256/`;
- an exact manifest with the host version, creation time, and each file's
  path, byte count, SHA-256, and portable permission mode.

Transient add-on and blob `.staging` content is excluded. Blob archive paths
must match their content hash, and verification proves every object referenced
by the restored database exists with the expected size and digest. Browser
device drafts are outside backups.
The database
includes versioned DM/player password hashes, never clear-text passwords.
Restoring an archive restores those credentials. The offline password-reset command can recover access after
restore; see [self-hosting](../SELF_HOSTING.md#password-changes-and-access-recovery).

GitHub repository links and generation provenance are included in `codex.db`.
GitHub access tokens are stored separately in `credentials/github.db`, outside
the backup allowlist, and are never included or restored. Configure GitHub
access again after moving a campaign backup to a new server. Campaign recovery
points do not change repository links or tokens.

Creation, verification and restore share a manifest size limit of 64 MiB by
default, alongside the 100,000-file, 1 GiB archive and 4 GiB expanded-data
limits. Creation refuses to publish an archive whose manifest exceeds that
limit.

### Commands

Create a new archive. The destination must not already exist and must be
outside the live data directory:

```powershell
go run ./cmd/codex-maintenance backup `
  -data-dir data `
  -out C:/backups/codex-2026-09-01.zip
```

The SQLite online-backup API gives one committed database image while the host
is running. Add-on generations and blob objects are safe to collect afterward
because both publish complete immutable files before recording their database
references. The command cannot take the running host's add-on lifecycle lock,
so package cleanup may remove a build the copied database still needs. It
therefore verifies its finished archive as `verify` does and removes one that
fails; create it again. Offline maintenance instead holds the host-process
lock.
The running host never physically collects blob objects; only the offline
`codex-maintenance collect-blobs` command does, under the host-process lock
([how](../SELF_HOSTING.md#reviewed-offline-storage-maintenance)). Existing backup ZIPs own their copies
of package files and do not prevent cleanup of an inactive live generation.
Add-on recovery points retain exact package identities. Default
[latest-only retention](PACKAGE_LIFECYCLE.md#automatic-package-file-retention)
removes only the add-on points that need an obsolete build.

A needed package whose files are missing or changed fails the backup before an
output archive is published; upload the matching ZIP first. Verification and restore also require every active and
recovery-referenced package ZIP and its extracted files to be complete and
correct. A restored full backup can therefore start offline. Default latest-only
retention also runs after healthy startup of a restored directory; to retain
the archive's older add-on builds, set `CODEX_ADDON_AUTO_CLEANUP=false`
before starting it. The input backup ZIP itself is never modified.
An archive may include an approved pending cleanup receipt and remaining files;
the restored host resumes that approved cleanup at startup.

Verify an archive without touching live data:

Docker installations can use the maintenance utility from their exact running
image with a read-only archive mount; see the
[operator procedure](../SELF_HOSTING.md#verify-with-the-running-host-image).
The native source command below requires the matching host revision:

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
  -data-dir data `
  -in C:/backups/codex-2026-09-01.zip
```

The host and restore command contend for the same operating-system file lock,
so a live restore fails closed. The command verifies the archive, then extracts
and migrates a staging copy into `.restore-stage-*` inside the data directory,
so it also works when that directory is a mount point; a missing one is
created. It writes the `.restore-pending.json` journal, moves every current
entry except this server's `credentials/` (its GitHub tokens) into
`.restore-previous-*`, publishes the staged entries, validates the installed
database and only then deletes the previous copy and the journal. The journal
records each phase, so the next restore or host start resumes an interrupted
one before SQLite opens. If the staged files are missing or the installed
database fails validation, startup refuses to continue and leaves the previous
data in place for the operator. Archives contain no sessions, so everyone signs
in again, with the passwords saved in the archive.

Only `codex-backup.v2` archives are accepted. Settings links the
[operator procedure](../SELF_HOSTING.md#verify-and-restore-a-full-backup) in
both English and Czech; campaign recovery points and imported bundles work
without a restart.

## Campaign recovery points

A recovery point holds one **part**: the campaign or one add-on. Settings lists
each part's points separately in English and Czech: manual points, coalesced
automatic points, reviewed restore/delete, and revert of the last N automatic
edit groups of the selected part. Each part keeps its newest 50 points of every
kind (`save`, `manual`, `pre-restore`, `download`, `imported`), so a busy
add-on never pushes campaign history out. A point contains at most 64 MiB of
one part's metadata, not copies of the immutable file bytes. A larger part gets
no automatic point: the edit is still saved, and the host logs a warning and
tries again a minute later. Manual points, downloads and restores of it are
refused instead, because a restore must first save a safety point; use full
backups for such a campaign. Manual points cover every part and do not delay
the next automatic group. After a restore, that part's next edit starts a new
group. Revert counts the part's automatic groups, not individual field changes
or other kinds of point; its review shows the selected date. Campaign recovery
remains available when add-ons or their packages are absent.

A campaign point stores core collection materialization, ordered records with
unknown fields and creation identities, core media bindings and the logical
deletion state of campaign-owned files. An add-on point stores that add-on's
active generation, datasets and documents with their ownership metadata, and
the deletion state of its own files. Every image keeps the same keys, empty
where the part has none. Media files and opaque handles remain in immutable
storage, allowing recovery of a deleted portrait or an older world-map slot.
Passwords, sessions, package installations, permissions, service bindings, and
audit history are excluded. Migration 0029 split the earlier combined points
into parts and dropped repeated automatic points that the combined capture had
saved for unchanged parts.

The host wires `recoverystore.BeforeWrite` into campaign and add-on data
transactions and blob creation/deletion; each store names the part it changes
(a blob's part is its owner). The hook captures that part once before its first
mutation, at most once per minute per part, in the same transaction. A
transaction that changes the campaign and an add-on captures each. A failed
edit rolls back its points. Per-row triggers advance the review revision
without taking intermediate snapshots. Package lifecycle transitions use the
full backup/rollback boundary.

Restore acquires the SQLite write transaction with the exact reviewed revision,
checks that the point belongs to the requested part and its format, and
captures a `pre-restore` safety point of that part only. Campaign restore
changes only core records and core-owned media; it never checks add-on package
compatibility or rewinds current add-on saves. An add-on restore changes only
that owner's datasets, documents and logical file handles. It requires that
owner's exact active generation and compatible dataset definitions, regardless
of other active or missing add-ons. Saved record extensions must match the
current target record's creation identity; restore the campaign first if
necessary. A reused record key is insufficient.

All selected data changes, the payload-free restore audit (including scope
and add-on ID from migration 0022), and the durable
`campaign-restored` publication commit together. A failure rolls back all of
them. Restored live records get fresh revisions; removed keys keep deletion
tombstones, so stale editors and reviewed import plans cannot overwrite the
recovered data. Only the selected part's collection/dataset revisions advance,
including empty collections. Campaign restore preserves saved extensions even
if their targets are temporarily absent; normal ownership checks prevent them
from attaching to a different record. Add-on recovery across different package
or schema identities is refused; campaign recovery is independent. Retiring an
obsolete add-on build deletes that add-on's points which need it.

The HTTP surface requires a real and effective DM, plus CSRF for writes:

| Route | Request / response |
| --- | --- |
| `GET /api/recovery` | `recovery-points.v3`: review revision and `parts` (the campaign first, then add-ons with points by ID), each with newest-first point metadata: reason, size, record/document/file counts, the add-on generation and compatibility; no saved bodies |
| `POST /api/recovery` | Exact `{}` creates a manual point of every part and returns the list |
| `POST /api/recovery/restore` | `scope: "campaign"` or `scope: "addon"` with `addonId`; `expectedRevision` plus either positive `id` or `count` (1–50) |
| `POST /api/recovery/delete` | Same explicit scope, positive `id` and `expectedRevision` |

Every request names exactly one part, and a point is found only in its own
part.

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
deletion and retirement rollback; `migration_test.go` covers the split of
combined points. `latest_retention_test.go` proves
campaign recovery and backup references survive obsolete package removal.
`recovery.browser.mts` covers desktop/phone Settings, English/Czech copy, stale
reviews, uncertain responses, pending navigation, undo, private download, and
importing a downloaded bundle and restoring from it. `internal/backupbundle`
tests a round trip into a fresh host and every refusal above.
`installed-sheets.browser.mts` verifies recovery in a real installed package and
retention of an unsaved add-on draft in another tab.
