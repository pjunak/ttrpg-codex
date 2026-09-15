# Markdown recovery and collection browsing

Implemented September 11, 2026 in the current Go/TypeScript application. These
workflows address F01 and F02 in the [feature audit](FEATURE_PARITY_AUDIT.md).
They share the current editor descriptors, role projections, localization,
design tokens, and record mutation path. They introduce no dependencies,
legacy handlers, campaign schema changes, or add-on contract changes.

## Saved core URLs

Preserved Czech list/article routes normalize to the current route before
rendering, including party and settings. The former event-list URL opens the
timeline. The finite aliases come from the preserved routing inventory; map,
graph, timeline and provider-owned Compendium aliases keep their existing
handlers. Unknown or malformed paths still reach the not-found view.

Normalization replaces the current history entry. Back does not acquire an
extra redirect stop, and aliases for the current article do not remount an open
editor. All other destinations pass the normal dirty/saving guard first. IDs
are decoded once, preserving encoded slashes, percent signs and exact twin
identity.

Old singular `/new` routes open `#/create/<collection-page>` through the current
record form. Anonymous visitors can sign in and continue at that destination;
Cancel returns to its collection and creates no record. The current record
route `#/characters/new` still addresses a record whose key is `new`.
Route unit tests and real-host record-workflow tests cover the alias inventory,
malformed paths, Back, sign-in, cancellation and retained dirty values.

## Campaign links and article outlines

Markdown articles can link to visible campaign records:

| Syntax | Result |
| --- | --- |
| `[[Lantern Watch]]` | Resolve a visible record by name |
| `[[Lantern Watch|factions]]` | Search only the faction collection |
| `[[The Watch|factions:watch]]` | Link to the exact faction key `watch` with a custom label |

Name lookup follows campaign order and prefers the current article's visibility
when several records in a collection match. Use the explicit collection/key
form when identity matters. Resolution uses the viewer's current dataset;
unavailable targets remain visibly unresolved.

Article headings build a contents outline. Outline controls scroll within the
article without replacing its route. Markdown is rendered through typed,
sanitized presentation: unsafe links are inert and arbitrary HTML is shown as
text. Supported semantic formatting remains bounded.

Explicit rule references such as `[[Shield|spell:shield]]` use the participating
provider's public reference contract and [shared rule details](RULE_DETAILS.md).
A source's display name is not a reliable record identity.

## Connected article context

Scalar and multi-record facts, relationship endpoints, additional location roles,
rank members and companion owners are semantic links with separate edit actions.
Targets resolve against the current authorized campaign snapshot. Unknown or
deleted targets show an unavailable label without a guessed URL or retained
identity; character names use the knowledge reading projection.

Location articles derive bounded ancestor navigation, direct sublocations,
connected places, present characters and event mentions. Cycles terminate with
an explicit hierarchy notice. Character articles add event mentions and owned
companions. Faction rosters include every matching member, including missing,
unassigned or unmatched rank/chain assignments, alongside faction-owned companions.

Context includes references to either side of an available reciprocal twin pair.
Matching records group only when both counterpart records qualify; direct links
continue to address the exact referenced identity. These are read projections,
not copied lists, new ownership or additional authorization rules. Existing
visibility filtering remains authoritative. Profile knowledge still controls
when its associated sections appear.

Live context refresh does not replace opening editor snapshots or inline drafts.
Projection tests cover missing targets, cycles, knowledge labels, complete
membership and grouping. Real-host desktop/phone tests cover player/DM visibility,
connected navigation, ownership, relationships, English/Czech and an unrelated
live update while a name draft remains open.

## Local Markdown recovery

Every host record Markdown field, including the character profile wiki and
new-entry forms, keeps a recovery copy in this browser's IndexedDB. The editor
writes after a 250 ms pause and checkpoints at least once per second while
typing continues, subject to browser scheduling and storage availability. It
also attempts a flush on hiding the page or unmounting the editor. A successful
local transaction produces the visible “Recovery copy saved on this device”
message; this is separate from saving the record to the campaign.

On reopening an editor, available drafts are offered for review rather than
automatically inserted. Each copy shows its timestamp and compares the original
saved text, saved text at the current editor's opening, and recovered text.
Changed opening revisions or text produce an explicit warning. “Use this
draft” changes only that Markdown field; it does not save the record. If the
editor already contains different unsaved text, that text must first be stored
as a separate copy. Recovery refuses to replace it if this protective write
fails. The normal campaign save still uses the editor's opening revision, so
later concurrent writes fail visibly and retain the draft.

Copies are scoped by site origin, effective role, collection, record key, and
field; an unsaved entry uses a distinct null record key. Independent editor
writers have independent random IDs. A tab never overwrites another tab's
draft. After a confirmed campaign save, cleanup removes only the matching own
copy and reviewed recovery snapshots. Deletion compares the stored snapshot
within a transaction, so newer text from another tab survives. Explicit
confirmed Cancel removes the current editor's recovery copies; ordinary
navigation retains them. Unrelated candidate copies remain available.

The collection's collapsed **Local Markdown drafts** list provides another
recovery route. It can download copies for deleted or unavailable entries and
new entries that were never saved. It does not recreate records. Users can
review and explicitly delete individual copies. No time-based expiry or
automatic deletion of other authored drafts is used to make room.

Storage failures remain visible and offer a Markdown download of the text
still in the editor. Oversized recovery text cannot be inserted into a field
with a smaller limit, but remains downloadable. Only authenticated editing
roles receive these controls; switching role closes the old editor and scopes
the new draft list to the new role. Browser storage is not an authorization
boundary against someone with access to the same browser profile or trusted
code running on the same origin. Signing out retains local copies for the
next session of that role.

### Preservation limits

Browser recovery protects Markdown text, not an entire unsaved form or add-on
editor state. A new entry's other fields must be filled again. Copies stay in
this browser profile and origin; they are neither synchronized between devices
nor included in campaign backups. A cleared profile, site-data removal, storage
eviction, or failed write can lose local drafts. An abrupt crash may lose text
typed since the last completed checkpoint. Unload flushing alone cannot ensure
durability. Campaign Save and independent backups remain the durable campaign
record; Markdown download supplies a separate recovery file.

The current host serves one campaign per origin and has no stable campaign
instance identifier. Replacing the campaign at the same origin can therefore
offer an older local copy for the same record key. The explicit text comparison
and separate campaign Save are required; copies must never be auto-applied.
No existing campaign data is changed by installing these features. Old browser
draft formats are not read or deleted.

## Shared collection views

All nine core record collections use one browsing component. The default is
all accessible entries, name ascending, with no grouping or filters. A native
search input, sort and direction menus, and optional group menu form the common
toolbar. Additional filters are collapsed initially. Users choose a category
and value, add visible removable chips, then **Apply view**. Applying preserves
keyboard focus and an open new-entry form. Removing a chip or clearing filters
applies that change immediately. Clear removes query and filters while keeping
the chosen sort and grouping.

- Search matches every entered word against declared record fields, including
  full Markdown text and resolved reference labels. It shares accent folding
  with campaign search and never indexes arbitrary unknown raw fields.
- Values within the same category are OR-combined; different categories and
  search words are AND-combined. Choice counts respect the other pending
  categories and search, allowing another value within the same category.
- Sorts use locale-aware natural ordering, numeric comparison for numeric
  fields, stable name/key tie-breaks, and missing values last in either
  direction. Factions can also sort by their visible member count.
- Grouping uses the same meaningful facet definitions as filters. Entries with
  multiple values can appear in multiple groups; the main result count counts
  each entry once. The interface explains this behavior.
- Empty collections and zero-result views have distinct messages. Result
  counts announce changes without moving focus. Controls and feedback have
  English/Czech text and responsive desktop/phone layouts.

Editor field definitions supply enum, reference, tag, attitude, ownership, and
boolean facets automatically. A small `browse` descriptor flag enables useful
text/numeric categories such as species or location region. Enum/reference
choices reuse the editor's canonical options and translated labels. All values,
reference names, counts, and results come from the latest role-projected
dataset, even when a separate open editor retains an older save snapshot.

The applied view is encoded in the collection hash query for bookmarking and
return navigation. Applying replaces the current history entry rather than
creating an entry per filter adjustment. Per-role, per-collection localStorage
preferences restore the last view when navigating from an article or sidebar;
an explicit bookmarked view takes precedence. A role switch loads that role's
preferences. Storage failure leaves the view usable and suggests bookmarking
the address. Missing definitions are handled without mutating campaign data;
unavailable filter values can be removed. Input lengths and filter counts are
bounded. These preferences do not change campaign policy or record ordering.

## Reusable owners

| Responsibility | Owner |
| --- | --- |
| Validated draft snapshots and transactional IndexedDB operations | `frontend/src/core/markdown-drafts.ts` |
| Write scheduling, tab identity, recovery, save/discard coordination | `frontend/src/app/markdown-draft-controller.ts` |
| Shared Markdown recovery controls | `frontend/src/app/codex-markdown-editor.ts` |
| Collection-level draft discovery, including unavailable entries | `frontend/src/app/codex-local-drafts.ts` |
| Field definitions and canonical choices | `frontend/src/app/campaign-record-editor.ts` |
| Query, facet counts, sorting and grouping | `frontend/src/app/collection-model.ts` |
| View parsing, serialization and browser preferences | `frontend/src/app/collection-view.ts` |
| Shared controls and existing record-row rendering | `frontend/src/app/codex-collection-browser.ts` |

The record page supplies context and acknowledges only completed campaign
saves. The character profile uses the same Markdown component/controller.
Collection models cache against immutable dataset identity and locale; a live
refresh or locale change rebuilds the derived data. The native-select rendering
helper is shared by browsing and recovery controls. Add-ons retain their own
versioned editor and content contracts; host internals are not a public SDK.

## UX research and decisions

Primary sources reviewed September 11, 2026:

- [W3C: enable undo and preserve work](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o4p02-back-undo/)
  supports recoverable editing. Here recovery is offered for review and existing
  unsaved text is preserved before switching copies.
- [W3C: status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
  supports announcing result updates without forcing focus changes. Normal
  draft keystrokes do not generate repeated live-region announcements; failures
  and deliberate recovery actions have distinct feedback.
- [Scottish Government: search filters](https://designsystem.gov.scot/patterns/search-results/search-filters)
  informs labeled filter categories, removable selections, clearing filters and
  explicit application. This application uses Apply on desktop and phone for a
  consistent interaction and predictable results while choosing several facets.
- [Department for Education: filter component](https://design.education.gov.uk/design-system/components/filter)
  informs placing controls above full-width result content rather than adding
  another permanent sidebar to the campaign shell.
- [MDN: Web Storage](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API),
  [IndexedDB transactions](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB),
  and [browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
  inform asynchronous text storage, small synchronous view preferences,
  transactional cleanup, regular checkpoints, and honest recovery limits.

These are applied design choices, not a claim of formal WCAG conformance or
usability validation with campaign users.

## Verification

`markdown-drafts.test.ts` covers scoping and bounds, write/save ordering,
continuous-typing checkpoints, reverting text, separate-tab retention,
protective recovery writes and explicit discard. `collection-model.test.ts`
covers full-text/accent matching, reference labels, OR/AND composition, groups,
numeric ordering, visibility, locale changes, URL parsing, and facet counts.

The editor Chromium suite exercises reload recovery, two independent tabs,
changed saved text, concurrent save rejection, failed storage and save requests,
new-entry and role boundaries, recovery of deleted-entry text, retained open
forms, bookmarks/breadcrumbs, keyboard focus and Czech phone layouts. The
existing mobile drawer test selects a named character so alphabetical browsing
does not change the identity whose navigation guard it tests. Broader host
checks cover the unchanged editor, session, and server contracts.
