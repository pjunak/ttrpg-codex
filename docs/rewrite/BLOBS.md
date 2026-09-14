# Durable blob storage

The blob store is the shared byte boundary for campaign media, import sources,
exports, and add-on attachments. Callers receive an opaque `b_...` handle and
never a host filesystem path.

## Ownership and layout

SQLite owns each handle's content hash, byte count, core/add-on/system owner,
purpose, media type, original name, public-or-DM visibility, revision, and
logical deletion state. The bytes live below:

```text
blobs/
  .staging/
  sha256/<first-two-hex>/<complete-sha256>
```

One immutable object may back several independently owned handles. This
deduplicates identical bytes without making the hash itself an authorization
token. A reader must resolve the opaque handle and enforce its current owner
and visibility before opening the object.

## Write and failure ordering

Creation requires an exact declared byte count and a configured upper bound.
The store writes and hashes a private same-volume stage, syncs it, publishes
the immutable object, verifies its complete hash and size, and only then commits
the object metadata and new handle in SQLite. Therefore the database never
points at a partial file. A crash may leave an unreferenced immutable object,
which is safe and can be reclaimed by a future offline garbage collector.

Deletion is revision-checked and logical. It invalidates that handle without
removing shared bytes or breaking another handle. Physical collection must be
offline and prove that no live or recovery database references an object.

## Deliberate boundaries

The storage package contains no authorization policy and is not a public HTTP
surface. Core media application operations must enforce campaign visibility;
worker methods must additionally enforce the add-on's exact `blob.read` or
`blob.write` grant and owner namespace.

Migration 0006 and the storage tests establish the primitive. Native
`codex-backup.v2` archives the immutable object tree and verifies it against the
restored database. Ordinary verification and restore accept only v2; legacy
website backups go through the separate offline converter. Core media supplies
one application-owned authorization layer and HTTP surface; worker blob methods remain unavailable
until exact add-on grants and owner namespaces are composed. See
[`MEDIA.md`](MEDIA.md).
