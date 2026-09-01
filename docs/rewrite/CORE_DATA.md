# Core campaign data

The rewrite stores campaign records in SQLite without translating their
product-owned JSON fields yet. This is deliberate: the first storage boundary
must preserve existing campaign saves before typed domain projections replace
individual legacy shapes.

## Compatibility contract

| Existing save behavior | Rewrite representation |
|---|---|
| List collections keep meaningful insertion order | Every record has a stable `position`; updates retain it and new records append after the highest surviving position. |
| Keyed collections store values under an outer key | The outer key is stored separately from the JSON value, so settings arrays, campaign `main`, faction records, and boolean tombstones round-trip. |
| Relationships use `(source, target, type)` rather than `id` | The tuple is encoded into a collision-free internal key while the original relationship object remains unchanged. |
| Existing IDs never change on rename | Record keys are accepted as bounded UTF-8 and are not regenerated or slug-normalized during migration. |
| Missing collection files mean “use defaults”; an empty file means “intentionally empty” | `campaign_collections.materialized` distinguishes absent from materialized-empty collections. |
| Record-owned fields, including `addonData`, survive | `body_json` retains the complete validated JSON record; the storage layer does not whitelist current UI fields. |
| Legacy `deletedDefaults` may be an array | The compatibility decoder promotes it to the current keyed `{ id: true }` form. |
| An export may contain add-on collections unknown to core | The decoder returns unknown top-level values as opaque passthrough data for the later package-aware import coordinator. |

The codec accepts the object produced by the v1 `Store.exportJSON()` path and
can produce the same top-level list/keyed collection shapes. It does not yet
publish an HTTP import or export route. Wiring that route before add-on
collection ownership and full visibility closure are composed would risk a
partial restore, so live migration remains a later milestone.

## SQLite ownership

`campaign_collections` owns collection shape, materialization state, and a
monotonic collection revision. `campaign_records` owns the outer key, list
position, opaque JSON value, materialized visibility, record revision, and
timestamps. The fixed v1 core collection set is seeded by migration 0005;
add-on collections remain under the separate v3 collection contract rather
than being smuggled into this table.

Multi-collection snapshots use one read transaction, so a backup or later
export coordinator cannot combine collection states from different moments.

Every write supplies an expected record revision. Revision `0` means the key
has never existed; a positive value must match its live or deleted revision.
Deletion retains a revision-only tombstone, so undo/recreate advances the same
monotonic sequence and a stale pre-delete edit cannot match a new record by
accident. A transaction rejects duplicate targets before opening a write,
validates every record and identity, then applies at most 500 mutations in one
SQLite transaction. A conflict rolls the whole operation back.

The same transaction records a payload-free audit row, advances each touched
collection once, and appends durable `campaign-data-changed` events. Live SSE
subscribers are notified only after commit. If the process stops between
commit and notification, normal event replay remains authoritative.

Public changes emit a public invalidation. DM-only changes emit a DM
invalidation. Moving a formerly public record to DM still emits publicly so a
player client knows to remove it. Event metadata contains collection and count,
never record bodies or private keys.

## Deliberate boundaries

The application layer now publishes `GET /api/campaign` as
`campaign-data.v1`. Anonymous and player requests receive a closed public
projection: DM records are removed, `linkedTwinId` is stripped, references to
hidden identities are removed, and relationship/map settings are filtered so
they cannot disclose hidden records. An effective DM receives the exact stored
snapshot. The transport never accepts a requested role; authority comes only
from the resolved session.

The record store itself still validates storage invariants, not all campaign
rules. The application service owns visibility and mutation policy above it.

`POST /api/campaign/transactions` accepts the exact
`campaign-mutation.v1` contract. Every requested put/delete carries an
expected record revision and the authenticated session identity is supplied by
the host, never the request body. All writes require the session-bound CSRF
token. The response is a payload-free `campaign-commit.v1` receipt containing
only requested record results plus affected collection revisions; derived or
private record keys stay internal.

Before one atomic SQLite transaction, the application service:

- forces player-created/edited visibility to the existing public space,
  preserves server-owned twin links, removes retired `secrets`, and merges
  omitted add-on namespaces;
- treats guessed hidden and missing references alike, and rejects player
  references outside the current public identity graph;
- prevents generic writes from creating, changing, or dropping twin links;
- keeps location connections symmetric while preserving a player's existing
  links to peers that are not visible/editable to that player;
- expands character, location, and faction deletion into reference cleanup,
  including twins, relationships, maps, settings, ownership, and audit marks;
- rechecks every requested and derived expected revision in the storage
  transaction, so a race rolls the complete plan back.

Twin lifecycle is intentionally outside the generic record endpoint.
`POST /api/campaign/twins` accepts the exact `campaign-twin.v1` create, link,
or unlink contract. It requires a real DM who is also currently acting as DM,
plus the session-bound CSRF token. Create uses a server-generated opaque key;
link requires revisions for both existing records; unlink discovers and
revision-checks the reciprocal record from the same snapshot. The application
service enforces supported collections, opposite visibility, and reciprocal
links, then writes both sides in one SQLite transaction. Generic campaign
writes remain unable to edit `linkedTwinId`.

The rewrite does not yet implement:

- enum replacement operations;
- reusable typed collection handles and core editors beyond campaign identity;
- initial import publication, backup/restore, or add-on collection migration;
- typed relational projections and indexes for search, maps, timelines, and
  other domain queries.

Those policies belong in domain/application services above this lossless
record foundation. They must not be implemented as ad hoc SQL in transport
handlers.
