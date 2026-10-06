# Markdown recovery and collection browsing

Campaign browsing and Markdown recovery share the host's editor descriptors,
role projections, localization, design tokens and record mutation path.

## Core URLs

Each list, article, party, settings, timeline (`#/timeline`), map (`#/map/...`)
and Mind Palace view (`#/graph/...`) has exactly one route. Unknown or malformed
paths reach the not-found view. Leaving an open editor passes the normal
dirty/saving guard first. IDs are decoded once, preserving encoded slashes,
percent signs and exact twin identity.

`#/create/<collection-page>` opens the record form. Anonymous visitors can sign
in and continue at that destination; Cancel returns to its collection and
creates no record. The record route `#/characters/new` addresses a record whose
key is `new`. Route unit tests and real-host record-workflow tests cover
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

## Contextual creation and direct editing

Location articles offer **Character here**, **Event here** and **Sub-location**;
faction articles offer **New faction member**. These typed creation routes carry
an exact source key through sign-in. The current form preselects the canonical
location, locations list, parent or faction field and inherits the source's
opening public/DM visibility. Fields remain editable. Event presets begin at
session 1, which can be changed before saving.

Creation retains the opening campaign snapshot. Save rechecks source availability
and uses the ordinary field/reference validation and transaction path. A deleted
or newly unavailable source blocks saving while retaining the draft. Cancel
creates no placeholder; it returns to the source when available or the source
collection otherwise. A confirmed save returns to the source and its derived
context shows the created record. Creation does not add a separate data store or
copy source text into the new entry.

Collection rows and party/companion cards share an accessible pencil link in
the top-right corner through the [shared card-action pattern](UI_FOUNDATIONS.md#entity-card-actions).
The shared record form supports all record collections, keeps the starting
collection's filter/sort URL or party/overview destination, and returns there
after Save or Cancel. Cancelling also clears the abandoned form’s save warning.
An opening-revision conflict keeps the form and its draft. The same localized
guidance applies whether live refresh detects the change before Save or the
server rejects the transaction afterward: copy any needed notes, cancel and
reopen to review the current record. A delayed campaign refresh never permits
overwriting the remotely saved record or silently rebasing the draft.
Direct edit links select the host profile even when an
add-on article was previously selected. Anonymous edit bookmarks retain their
destination through sign-in. Return destinations are a finite set of internal
overview/party/timeline/collection routes; external and nested edit destinations
are rejected. Dirty and pending-save navigation guards remain shared.

Route/preset tests cover exact encoded keys, visibility defaults, missing sources
and bounded return destinations. Real-host tests cover every preset, sign-in,
Save/Cancel/Back, source deletion, private factions, keyboard card editing, stale
edits, preserved collection views, desktop/phone and translated actions.

## Investigations

Mystery cards, article facts and the Solved facet derive the same effective
status: the manual flag is true, or a nonempty question set has nonblank answers
for every question. An empty mystery stays open. Whitespace answers stay open,
and reading never rewrites the stored manual flag. The editor continues to edit
that manual override independently of derived status.

The Mysteries collection also contains a combined unanswered-question queue from
mysteries and character unknowns. Its separate, accent-insensitive search matches
source names, questions and answers; collection filters apply to the mystery
cards. Answer history expands the currently recorded answers, not a revision
history. Open/total counts describe the matching questions. A manually solved
mystery's unanswered questions remain visible in the queue.

Sources link to exact records and signed-in editors can return from the normal
record form to Mysteries. The queue groups available reciprocal DM/player twins
using the same representatives as collection cards. It uses only the authorized
dataset, applies character knowledge reading, and keeps private or unrevealed
questions out of the player view. Live dataset replacement refreshes the queue
without replacing its search input.

Pure tests cover derived/manual/empty status, whitespace and historical question
shapes, source immutability, effective facet counts, Czech search, knowledge and
twin links. Real-host desktop/phone tests cover articles, cards, source editing
and Cancel, manual overrides, answers, role filtering and Czech labels.

## Record context menus

Right-clicking any link to a record (cards, related chips, wiki links, search
results, the questions list) or a record page's header opens a menu for that
record. The keyboard menu key and Shift+F10 open it on the focused link, and a
touch long-press does the same. Shift+right-click and text fields keep the
browser's own menu.

Everyone gets Open, Open in new tab, Copy link and Copy wiki link (`[[Name]]`).
Editors also get Edit and actions that use the same field rules as the editor:

| Record | Actions |
| --- | --- |
| Character | Status, faction, current location, attitudes, add to an event, link to a mystery |
| Location | Add a character, event or sub-location here; show or place on map; contained in; connected locations; attitudes; add to an event |
| Faction | Add or remove members, new member |
| Event | Characters, locations, show or place on map |
| Mystery, history | Characters, locations |

Long lists are searchable submenus; current values show as check marks or a
trailing detail. Writes go through the in-place patch path (one field, current
revision, conflicts reported) and confirm with a short notice. While another
edit is open or saving, write actions are disabled with the reason. The menu
leaves clues, knowledge and questions alone while that model is
[undecided](../design/knowledge-and-investigation.md).

## Compact reading and save feedback

Missing artwork uses a compact identity mark in article mastheads. Character
cards keep their 3:4 portrait area whether or not an image loads. Other records
with artwork use an image card; records that never had artwork are compact
tiles with their emblem beside the text (locations use their map-marker icon,
factions their colour and member count). Character cards show status and
visible party identity.

Facts edit in place on every record page. A value reads as text and shows a
pencil on hover or focus; activating it turns it into a control with the same
typography. Text and numbers confirm with Enter or ✓ and cancel with Escape or
✕; choices save when picked, and lists of twelve or more become a searchable
combobox. Multi-value references (connections, event characters and locations)
and attitudes use the shared chip picker and save with Enter or ✓. Linked values keep their link with a separate pencil. Missing facts
are grouped under **Add details and connections**. Long text and structured
fields still open the full editor. Edits keep their
opening snapshots, report conflicts beside the field and return focus to the
value after Save or Escape.

The character collection intentionally defaults to **All characters**. Explicit
**NPCs** and **Party members** controls use the same saved filter state as the
other facets. Unrevealed character membership is not used by either restricted
roster filter; those entries remain available under All characters. Source
records and the dedicated Party page are unchanged.

Search, sort, direction, grouping and the **Filters** menu share one toolbar
line, and every change applies immediately while keeping focus and open record
drafts. Mysteries also has a keyboard-accessible shortcut to the combined
question queue.

Host forms label unsaved changes, pending saves and failures near Save/Cancel;
a confirmed record transaction shows a campaign-save confirmation at its return
destination. It clears on subsequent editing or navigation. Profile feedback
prioritizes any pending write, failed write or unsaved text over an older success
message. Local Markdown recovery continues to describe a device copy separately.
Cancelling a failed field, panel or wiki edit clears its abandoned error state;
a cancelled wiki conflict no longer prevents a fresh edit from saving.

Core record, field, twin, enum, map, timeline and campaign-settings writes capture
the initiating application's signal and CSRF token. Disconnect cancels their
waits; old saves cannot complete a replacement editor, clear its dirty/busy
state, display feedback or navigate it. Character and twin response callbacks
still settle once on interruption. A cancelled active write releases the shared
queue, while a cancelled queued write retains the ordering of any live
predecessor. Cancellation does not prove a server rollback: reconnect reads the
current records, and writes are never automatically replayed.

Real-host tests compare sparse/rich articles and collection cards at 390px and
desktop in Classic/Moonlit and English/Czech, with valid uploaded artwork,
keyboard disclosures, retained views, focus, and reflow at 720 and 320 CSS pixels
with both bundled and unavailable web fonts. Existing
navigation/stale/pending/uncertain-response editor suites remain required.
The new save-feedback cases cover delayed writes, stale failure, retained drafts
and Cancel; fixture regressions cover cancelling a wiki conflict and saving a
fresh draft.

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
all accessible entries, name ascending, with no filters; characters are grouped
by faction and locations by kind until a view is saved, as in the original
codex. One toolbar line holds the search field, sort and direction, grouping
and a **Filters** menu where users pick a category and add or remove its values
in a searchable chip field. Collections with a natural quick choice (character roster,
location attitudes, priorities, pantheon alignment) show it as one-click chips
above the toolbar. Every change applies immediately and preserves keyboard focus
and an open new-entry form. **Clear filters** removes query and filters while
keeping the chosen sort and grouping. Grouped tile collections flow their groups
into columns; the group of entries without a value comes last.

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
