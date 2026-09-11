# Package-owned add-on data

Add-on collections and record extensions are host-owned durable data. A
package declares their identity and JSON Schema, but package code never picks
a table, validator, visibility, or namespace at request time. The exact active
package generation supplies those authorities.

This boundary replaces both v2 `data/addon-data/<addon>/<collection>.json`
files and JSON embedded below a core record's `addonData` property. It is not a
general compatibility layer for either format.

## Requirements and decisions

Extensions with `retained: true` add immutable, actor-attributed snapshots and
require a native worker mutation boundary. See [retained history](RETAINED_ADDON_HISTORY.md)
for transaction authority, pagination, core-record lifetime and backup rules.
Ordinary extension writes retain their existing semantics.

| Need | Decision |
|---|---|
| Preserve campaign data if an add-on is disabled or removed | Installed code and active authority may disappear; documents remain in SQLite until a reviewed migration or explicit operator deletion. |
| Detect unsafe upgrades before code runs | Each materialized data set retains schema version, the SHA-256 of the complete referenced schema closure, key mode, and record target. A changed or removed declaration blocks activation while data exists, including an intentionally empty collection. |
| Prevent stale code from writing | Every call carries the add-on ID and archive-hash generation. Only the exact active generation registry is accepted. |
| Switch without an old/new write race | A lifecycle transition briefly quiesces all calls for the add-on while the package manager changes its durable active-generation pointer. Commit selects the new registry; rollback retains the old registry. |
| Keep writes understandable | A transaction contains at most 256 operations, 256 KiB per document, and 2 MiB total JSON. Optimistic document revisions fail the whole transaction on conflict. |
| Preserve meaningful ordering | First insertion receives a stable position. Updates retain it; a delete followed by recreation appends as a new item. |
| Keep browsing bounded | Queries return at most 200 documents, scan at most 10,000 candidates, and stop before their JSON values exceed 1.5 MiB. Opaque cursors use monotonically allocated positions that are never reused after deletion. Predicates are exact matches on declared JSON-pointer indexes only. |
| Retain delete history | Document-version tombstones keep revisions monotonic, so a stale writer cannot recreate deleted data at revision zero. |
| Avoid leaking record contents through events | Durable `addon-data-changed` events contain only scope and revision. Public, DM, and system audiences are derived by the host. |
| Keep `private` truly internal | Public data is visible to all authenticated roles, DM data to DM/system, and private data only to system/worker authority. |
| Keep list collection identity stable | A non-keyed collection document must be a JSON object whose `id` exactly equals its outer document key. Keyed collections may use any value accepted by their schema. |
| Support declared uniqueness | Unique JSON-pointer indexes are checked against the prospective collection while application writes are serialized. Non-unique indexes currently describe allowed future query paths rather than creating physical SQLite indexes. |

## Ownership and data flow

```text
verified package ZIP
  addon.json declarations + contracts/*.json
                 |
                 v
package inspector compiles immutable schema registry
                 |
       activation review compares
                 |
                 v
stored set identity ---- mismatch/removal ----> migration blocker
                 |
         generation transition
                 |
                 v
add-on data service ---- validates role, schema, target, indexes
                 |
                 v
SQLite transaction ---- documents + tombstones + audit + event
                 ^
                 |
generation URL + authenticated role
       /                         \
integrated TypeScript     isolated iframe JSON bridge
```

The inspector compiles schemas offline. Local `$ref` dependencies are included
in a deterministic closure digest; unrelated package schemas do not change a
collection's identity. The runtime registry is memory-only and is rebuilt from
the checksum-verified active archive after every host restart.

SQLite separates four concerns:

- `addon_data_sets` retains materialization, collection revision, and schema
  identity even when no live documents remain;
- `addon_documents` stores current JSON, order, revision, and schema identity;
- `addon_document_versions` retains revisions for deleted keys;
- `addon_data_commits` and `addon_data_commit_records` retain actor, generation,
  operation order, and before/after revisions without duplicating bodies.

## Record extensions

A record extension declaration names one core collection, for example
`characters`. Its document key is the core record key. On every read or write,
the host checks the current core record instead of trusting extension JSON.

Each extension document also records the core record's original `created_at`.
If a core key is deleted and later recreated, the old extension remains
preserved for recovery but is treated as detached; it cannot silently appear
on the replacement record. Public extension data on a DM-only core record is
DM-only in practice. A player list filters missing, replaced, or hidden
targets.

Core and add-on tables intentionally do not use a destructive cascade. Losing
a core record should not irreversibly erase add-on-owned campaign state. A
future reviewed cleanup tool may expose detached records explicitly.

## Lifecycle and failure semantics

Activation review reports bounded stable issues:

- `DATA_DEFINITION_REMOVED` when a target generation no longer declares a
  materialized set;
- `DATA_MIGRATION_REQUIRED` when schema identity, key mode, or extension target
  changed;
- `INVALID_STORED_DOCUMENT` when current JSON fails the target registry.

The normal activation path cannot bypass these checks. It starts the candidate
runtime while that generation still has no data authority, then begins a short
data transition before publishing its service routing. Calls made through the
new route wait at the data boundary. The package manager commits its active
pointer and data transition together; a failed durable update rolls both
routing and data authority back to the previous generation.

Startup recovery repeats package verification and schema review before it
grants data authority. Disable and shutdown revoke data authority before
worker cleanup. Data remains durable in all of these cases.

The small personal deployment deliberately serializes add-on data writes and
uses cold cohort restarts. This favors deterministic behavior and debuggable
failures over high write throughput or zero-downtime upgrades. Revisit that
choice only after measured contention justifies a more complex coordinator.

## Browser API

Integrated and isolated browser add-ons receive the same `context.data` API.
`collection(id)` and `recordExtension(target, id)` return immutable handles
with `get`, bounded `query`, optimistic `put`, and `delete` operations. A
top-level `transact` combines up to 256 writes atomically. Every request URL
contains the exact active archive-hash generation; reads use the authenticated
session and writes additionally require its CSRF token.

DM/system queries may opt into `dataRevision` with `includeDataRevision`, or
pin a page to `expectedDataRevision`. The service read lock covers both the
revision and page read. `expectedDataSets` adds up to 256 distinct declared
read dependencies to a transaction, including collections without live
documents. SQLite checks the entire dependency set before any mutations;
document revisions still apply independently. Player requests cannot inspect
these counters. Unrequested query responses retain their original shape.
See the public [data-handle contract](../../examples/addons/API_V3.md#data-handles).

The isolated iframe still has `connect-src 'none'` and no same-origin access.
It sends bounded JSON commands over its private message port; the host owns the
HTTP client, credentials, schema authority, and cancellation. Generation
shutdown aborts both integrated requests and in-flight iframe commands. Safe
HTTP status classes cross the iframe boundary, while server-derived details do
not.

Native workers receive equivalent versioned `host/data.get`,
`host/data.query`, and `host/data.transact` JSON-RPC methods. Their dispatcher
accepts only collection and extension IDs declared by that worker's verified
package, resolves host-issued request lineage instead of trusting wire actor
metadata, and then applies the same generation, role, schema, target, and
revision checks as browser requests. Expected failures use stable RPC kinds;
database and schema internals stay in host diagnostics. The Go worker SDK
provides typed references, query and mutation models, strict response parsing,
and metadata propagation helpers for these methods.

The Go SDK exposes `AddonDataQuery.IncludeDataRevision`,
`AddonDataQuery.ExpectedDataRevision`, and `AddonDataQueryResult.DataRevision`.
`TransactGuarded` accepts the reviewed mutations plus `[]AddonDataSetRevision`;
the existing `Transact` remains available for document-only writes. Both HTTP
and worker transports authorize guard references and preserve revision zero.

## Remaining public surface

The package/storage/application contract, package lifecycle integration, and
the deliberately narrow first-party v1 backup conversion are implemented. The
following still sits above this boundary:

- reviewed `addon/migration.plan` and `addon/migration.apply` orchestration.

The offline converter strips migrated `dnd-sheets` data from core JSON only
after the matching extension write succeeds in the same fresh output build.
It imports the six stable DM Tools collections against the selected package's
compiled schemas and reports everything it does not recognize. Legacy source
ZIPs remain authoritative backups until supervised comparison and live smoke
testing complete.
