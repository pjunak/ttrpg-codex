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
can produce the same top-level list/keyed collection shapes. The offline,
fresh-database-only conversion path is documented in
[`LEGACY_CONVERSION.md`](LEGACY_CONVERSION.md). It deliberately does not
publish a legacy HTTP import route.

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

Settings enum deletion is also an explicit DM operation rather than a generic
settings edit. `POST /api/campaign/enums/delete` accepts the exact
`campaign-enum-delete.v1` contract and one of three unambiguous modes:
reject if referenced, replace every reference, or clear every reference.
The application recognizes only the six host-owned enum categories and their
typed usage fields. It verifies the loaded settings revision and replacement,
updates every affected record, removes the definition, and writes its
`deletedDefaults` tombstone in one transaction. This avoids both silent
dangling references and accidental re-seeding after restart.

The TypeScript client now has one canonical route/descriptor registry for the
nine user-facing record collections. Its list, search, detail, create, edit,
and delete surfaces share optimistic-revision preparation. Editors use the
canonical stored shapes for scalar and multi-record references, attitudes,
ownership, tags, string lists, location hierarchy, and event links. Each edit
merges into the current record, so fields not yet represented and add-on
namespaces survive. Navigation, role switching, sign-out, cancellation, and
browser unload protect dirty forms.

An open record, enum, or appearance form retains the campaign snapshot and
revisions it was opened against. Live refresh still updates the shell's
authoritative dataset, but cannot replace form inputs, remove a draft after a
remote deletion, or silently advance the revision used by save/delete.
Character relationship replacement additionally carries the complete reviewed
key/revision set, including removed rows. Preparation rejects a changed set
before constructing deletes, so a relationship added in another tab cannot be
mistaken for a user-requested removal. Unrelated campaign changes remain
saveable. Cancel/reopen or successful save completion releases the old base.
Chromium regressions in `frontend/test/browser/` exercise these component and
preparation boundaries; full host/session/SSE acceptance remains a separate
backlog gate.

The dashboard's campaign name and tagline editor likewise retains its opening
`campaign/main` revision. It prepares only the edited field, preserves the other
identity field and unknown data, and requires the existing DM campaign-write
authority. Live changes cannot advance its revision or replace its text. Save
conflicts keep the draft visible; cancel/reopen reviews the latest version.
The party creation route uses the ordinary character editor and transaction,
with public party defaults and only a currently defined alive status. It does
not write campaign records until the completed form is submitted.

Player writes arrive as full records built from a role-filtered projection. The
mutation planner therefore restores any existing scalar, array, object-array,
or polymorphic-owner reference that points to a DM-only record before commit.
Unavailable values supplied by the player are ignored when that field already
contains a hidden reference, avoiding both accidental deletion and a hidden-ID
oracle. Visible references still use the normal validation and compound
policies. The host also re-applies authorization, visibility, identity, twin,
reference, and revision policy; browser validation is only an earlier usability
boundary.

The TypeScript archive editors now cover the nested campaign shapes that are
not useful as generic text fields: question/answer ledgers, faction rank chains,
character rank assignments and location roles, and character relationships.
Relationship source, target, and type changes are prepared as one compound
delete/put transaction because those three fields form the record identity.
Rank-chain and location-role editors retain existing nested extension fields by
their stable IDs while keeping player-invisible references under the server's
preservation policy.

The DM settings folio manages the six host-owned enumeration categories over
the same optimistic campaign transaction boundary. Definition edits retain
unknown extension fields and permanent IDs; character gender/status and event
priority editors consume the shared definitions. Deletion uses the explicit Go
operation above, shows current usage, and requires an intentional reject,
replacement, or clear policy rather than creating dangling stored IDs.

Language and appearance deliberately have different ownership. Interface
language is a per-browser preference stored outside campaign data, so one
reader cannot change another reader's language. Appearance is a shared
campaign setting changed by the DM through the normal optimistic settings
transaction. The browser caches only the last accepted theme ID to avoid a
flash of the default chrome during startup; the campaign record remains
authoritative and replaces that cache as soon as it loads.

The rewrite does not yet implement:

- collection-specific map fields, timelines, the remaining non-enum settings,
  and other specialized workflows;
- initial import publication or add-on collection migration;
- typed relational projections and indexes for search, maps, timelines, and
  other domain queries.

Those policies belong in domain/application services above this lossless
record foundation. They must not be implemented as ad hoc SQL in transport
handlers.

Native whole-host recovery archives and offline journaled restore are
documented in [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md). Legacy website backups
are input only to the separate one-time converter.
