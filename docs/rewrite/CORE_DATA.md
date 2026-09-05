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

Map placement is projected as a unit: hiding/removing a location's `parentId`
or an event's `mapParentId` also hides its corresponding coordinates. Public
clients must not reinterpret those local coordinates as world coordinates.
Full-record player saves preserve the unavailable parent and coordinates,
including absence of a placement, while applying visible field edits.

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

Attitude presentation reads only the role-projected dataset. Explicit entries
retain their order and take precedence over faction inheritance; a character
without entries inherits its visible faction's attitudes or the configured
party color. Unknown IDs do not render, duplicate IDs are collapsed, and
strength comes from the shared definition rather than an entity entry.
Portraits (including placeholders) use the preserved outer border rings;
location/faction glyphs use silhouette filters on the glyph alone. Both use
the original 10px outer and 4px inner glow. The shared glow helper also provides
the size-dependent segmented map rendering described in [MAPS.md](MAPS.md).

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

World/local map viewing and editing now use the same transaction and media
boundaries. Coordinates, map scope, saved views, draft revisions, and image
replacement are described in [`MAPS.md`](MAPS.md).

The session timeline at `#/timeline` uses the role-filtered `events` collection;
historical events remain a separate archive. Preserved `#/casova-osa` and
`#/mapa/casova-osa` hashes open the same board. Columns use stored `sitting`
numbers and stable `order` sorting. Missing, zero, or invalid session numbers
display in session 1 without rewriting the stored value. Empty columns remain
visible through session 200; larger sparse timelines show occupied sessions
and the first session without allocating every intervening number. A reciprocal
DM twin represents its public counterpart only when both are in the current
projection, matching the old board.

Drag, up/down buttons, and session selectors produce a local order draft. The
opening event keys and revisions are captured before the first move (or drag
start); live refresh cannot replace that draft. Save checks the snapshot against
the currently loaded projection, then submits changed records in one existing
optimistic transaction. Only affected sessions are renumbered. Record content,
map placement, references, twin links, and extension fields are retained; the
server continues to enforce hidden-field preservation and write authority.
Per-record revision checks protect writes that race after the browser's check;
this does not add a collection-membership lock. Moves above the existing
500-mutation limit are rejected without splitting the save. Failed or stale
saves keep the draft, and cancellation/navigation use the unsaved-edit guard.

The timeline retains the original column/card styling, stacking, horizontal
scroll slider, and responsive shell. Editing expands stacks to expose the
keyboard and phone move controls. Session-scoped creation and card editing use
the common event form; deleting an event returns to the board. Navigation and
timeline messages use the English/Czech catalogs. Preparation tests live in
`frontend/test/campaign-timeline.test.ts`; production browser scenarios in
`frontend/test/browser/timeline.browser.mjs` cover desktop/phone layout, native
drag, keyboard moves, reload, empty and DM-twin views, creation/edit/deletion,
anonymous access, live conflicts, failed saves, and navigation guards. Add-on
timeline contributions and real-campaign visual acceptance remain part of the
open suite-wide acceptance gates; the public Add-on API is unchanged.

The Relationships view of Mind Palace now opens at `#/graph/relationships` or
the preserved `#/mapa/vztahy` hash. `projectRelationshipGraph` reads characters,
relationship records, shared enum definitions, and faction/party presentation
from the current role projection. Canonical relationship record keys identify
edges, including multiple relationships between the same characters. Missing
endpoints and location-target relationships are excluded from this character
view rather than binding to a different record that happens to share a key.
The graph never loads a second, independently authorized record cache.

Arrangement remains a browser preference under the original `cm_pos_vztahy`
key: values are node centers keyed by permanent character IDs. Pointer and
keyboard moves save local coordinates only; no campaign mutation is sent.
Valid old positions win over the deterministic initial placement of new nodes.
Malformed or extreme coordinates are ignored, and storage failures retain the
in-memory arrangement with an explicit retry. Escape and pointer cancellation
restore the position at drag start. A live projection change cancels an active
drag and removes unavailable endpoints; a concurrent browser-tab preference
change cancels the drag before applying the saved arrangement.

The view retains the original 168px cloud cards, typography and edge palette,
parallel edge routing, full wrapped/rotated labels, fixed zoom ladder with a
100% step, zoom-dependent detail,
chip filters, relationship-type dimming, faction visibility, neighborhood focus,
and detail/context navigation. Text uses native CSS dimensions at each zoom
instead of scaling a rendered canvas texture. Filter preferences retain the
`cm_vf_vztahy` and `cm_filter_vztahy` keys. Faction and mystery graph modes,
elastic layout motion, and add-on graph contributions remain open in the
backlog; no public Add-on API or persistence schema changes are introduced.

`frontend/test/campaign-graph.test.ts` covers projection, identity, layout input,
filters, focus, zoom, and edge geometry. Production browser scenarios in
`frontend/test/browser/relationship-graph.browser.mjs` cover desktop/phone
geometry, pointer and keyboard arrangement, wheel/pan behavior, detail links,
context actions, filtering, reload, live removal, cross-tab interruption,
storage failure/retry, and anonymous Czech use. These synthetic cases do not
replace the open real-campaign and installed-add-on acceptance checks.

`settings/playerParty` owns the shared party name, icon, badge, color, and text
color. Membership remains `character.faction === "party"`; settings never store
a second roster or create a faction record. The DM panel edits the original
four fields and mirrors the submitted icon into `badge`, preserving unknown
fields. Saves use the opening record revision, reject malformed record shapes,
and keep drafts on failed or stale writes. Clean forms follow live refresh;
cancel reloads the current values. Colors are validated hex values before use
in CSS. The identity is shared by roster headings, character placeholders and
badges, inherited party glows, faction options, article facts, and companion
ownership labels. The linked member list uses only the current role projection.
`frontend/test/campaign-party.test.ts` and
`frontend/test/browser/party-settings.browser.mjs` cover preparation and these
production UI paths, including desktop/phone layout and English/Czech copy.

`settings/branding` now provides the shared sidebar wordmark, tab title, and
logo/favicon. The Appearance panel retains the original branding section and
84px preview. A selected logo remains in the draft until Save; the normal
`branding-logo/main` media upload precedes the optimistic settings transaction.
An upload or settings failure keeps both text and the file for retry. Resetting
the logo clears only its reference, preserving immutable old media and unrelated
fields. Raw or external image URLs never enter the shell. Theme and branding
forms cannot save over each other's pending drafts.

`settings/sidebarLayout` stores ordered sections and their page routes plus a
hidden-page list. Section names, icons, collapse/default-open flags, DM-only
visibility, moves, hiding, add/delete, reset, and drag ordering are editable.
Section IDs and unknown fields survive ordinary edits. Preserved core routes
resolve through the implemented page registry; unavailable routes stay in the
editor without becoming broken links. New registry pages start hidden in a
curated layout. Invalid stored layouts are reported, never overwritten by the
fallback navigation. Collapse choices use the original per-browser
`sidebar_section_open:<id>` keys.

`settings/addonSidebarVisibility` holds `everyone`, `dm`, or `hidden` per
`<addonId>:<route>` key. Installed v3 pages default to hidden; the DM opts them
into the sidebar. An optional host navigation filter runs after the existing
generation and role checks, so settings cannot grant access. Layout and changed
visibility preferences save atomically with separate opening revisions, keeping
inactive route keys. Changing a package's route identity requires reviewing its
new opt-in entry. Offline v1 conversion materializes the original default groups
and retired `hiddenSidebarPages` preferences into `sidebarLayout` when no saved
layout exists, retaining the old setting for inspection. Existing layouts win;
see [`LEGACY_CONVERSION.md`](LEGACY_CONVERSION.md). No startup compatibility
reader is added.

The production browser scenarios in `chrome-settings.browser.mjs` and the unit
checks in `campaign-chrome.test.ts` cover the controls, extensions, stale/deleted
revisions, upload retry, safe URL projection, role-filtered navigation, collapse
persistence, page/section drag, and mobile layout. The public Add-on API and
package descriptors are unchanged.

The rewrite does not yet implement:

- recovery/account settings and other specialized workflows;
- initial import publication or add-on collection migration;
- typed relational projections and indexes for search, maps, timelines, and
  other domain queries.

Those policies belong in domain/application services above this lossless
record foundation. They must not be implemented as ad hoc SQL in transport
handlers.

Native whole-host recovery archives and offline journaled restore are
documented in [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md). Legacy website backups
are input only to the separate one-time converter.
