# Quick search, activity and map editing

F03–F05 of the [feature assessment](FEATURE_PARITY_AUDIT.md) are implemented
within the current host. These workflows share existing search, field definitions,
validation, role projection and campaign transactions. There are no new legacy
readers, dependencies, data migrations or add-on API changes.

## Quick search (F03)

Ctrl/Cmd+K and the sidebar Search control open a native modal over the current
page. The editor remains mounted. Escape, the close button or the shortcut again
closes search and restores focus. Choosing another destination passes through
the existing unsaved-change guard; cancelling that navigation keeps the overlay
and underlying draft. A result for the current page simply closes the overlay.

The empty query shows up to twelve recently opened accessible records, followed
by recent campaign activity when needed. Recents store only bounded route
identities in tab-local session storage, separately by effective role. Every
display resolves names and access from the current dataset. Hidden/deleted
records disappear; unavailable storage falls back to current activity. This is
convenience state, not campaign data or a cross-device history.

Typing uses the same `CodexSearch`, `searchCampaign` and generation-scoped add-on
provider controller as the full page. The overlay limits core results to 24;
the full page retains its 60-result limit. Provider loading, unavailable results
and Retry retain their existing behavior. Open full search carries the query
into `#/search?q=...`; queries are bounded to 200 characters.

Results remain real links with normal touch, Tab, modified-click and browser
navigation. Up/Down move focus through visible results; Enter in the search
field opens the first result, and Enter on a link follows it. The modal confines
Tab navigation, has an accessible name, and announces concise result status.
It does not introduce a general command framework or a custom listbox.

## Recent activity (F04)

The dashboard keeps one latest row per currently visible record, capped at
thirty. Each row adds a concise Created or updated-fields summary. Reference
and enumeration labels resolve from the current authorized dataset; long prose,
lists and relationship changes use brief descriptions. At most two descriptions
appear, with a count for further changes. No historical field values or names
are copied into the summary.

The server calculates separate DM/public change identities from the before and
after role projections. Private-only edits do not advance the public summary
or its displayed timestamp. Relationship creation, edits and removal update
the source character in the same revision-checked transaction, comparing only
relationships visible to each role. Empty-field normalization and no-op saves
do not displace the last meaningful summary.

The [core data contract](CORE_DATA.md) owns the `activity.v1` metadata. Existing
records without this metadata retain the generic update description and their
existing timestamps. Specific summaries start with new meaningful writes;
the host neither reconstructs historical changes nor adds a history/diff store.
Hidden/deleted records are excluded by the ordinary dataset projection.

## Focused map editor (F05)

Edit location opens marker type, attitudes and map notes alongside the existing
coordinate controls. The optional size override sits under Marker details;
empty size uses the configured marker type. The read panel resolves marker
type and attitude context and retains the full article/local-map links.

Map and article forms use the same `recordFieldControl`, `editorFieldsFor`,
`editorOptionsFor` and field validators. The map selects a small field subset;
it does not copy the full article form. Opening the editor captures the record,
choice dataset, revision and map scope. Only changed detail fields are included
with coordinates in one Save. Unknown, untouched record fields survive.

Native field constraints explain invalid input before submission. Save and
Cancel remain reachable in a scrolling panel, including phone layouts. Failed
or stale saves retain the draft, including after remote deletion. A stale draft
cannot recreate a deleted record. Cancel uses the existing unsaved-work guard.
Successful edits retain the viewport and selected location. Remove from map
clears placement and saves any valid pending details without deleting the record.

Map search uses shared accent folding and all-word matching, with natural name
ordering. Enter follows the first visible result and centers it; searching and
panning never write campaign data. [MAPS.md](MAPS.md) owns placement and media
contracts.

## UX basis

- The [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
  guides initial focus, contained Tab navigation, Escape and focus restoration.
  Native dialog and links keep these interactions small and familiar.
- [GOV.UK validation guidance](https://design-system.service.gov.uk/patterns/validation/)
  supports explicit submission, actionable constraints and retention of entered
  values. Existing shared validators and optimistic revisions provide the same
  save rules across the map and full forms.
- [WCAG status-message guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
  guides concise result announcements without moving focus or announcing the
  entire changing result tree. Activity prose also stays brief and scannable.

## Verification boundaries

Unit coverage exercises projected recents, storage failure, activity parsing and
label resolution, map field validation, atomic patches and revision conflicts.
Go tests exercise private-reference changes, forged metadata, relationship
creation/removal and normalization-only saves. Real-host browser tests verify
live activity summaries and unchanged public summaries after private edits.

Desktop/phone Chromium workflows cover modal focus and keyboard behavior,
unsaved editors, full-search queries, map Save/Cancel, remote conflicts/deletion,
viewport retention and Enter search. Screenshots are reviewed from disposable
fixtures. These checks do not establish physical-device or screen-reader
acceptance. Companion installed-package browser cases require their release
ZIPs; no companion API or package changed in this slice.
