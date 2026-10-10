# P9 compendium responsibility inventory

## Current `entry.js` ownership

- Registration/composition: sidebar pages, `/compendium` and `/bestiary`
  routes, wiki kinds, actions, and the provider object.
- Content loading: lazy aggregate fetch, one in-flight promise, abort
  controller, generation guard, loaded/error flags, and rerender on completion.
- Content invalidation: instance disposal clears loaded records and prevents
  stale responses; host `contentRevision` reconciliation replaces the entire
  instance on content-group changes.
- Provider API: slim list projections and optional filters, full record
  access, ruleset access, kinds, and the compatibility `loadDetail()` method.
- Lookup: repeated per-kind linear scans by ID and English lowercased name.
- Localization: content-carried catalog registration, record overlays,
  locale-aware localized-record memoization, and catalog cleanup.
- Browse state: per-kind/global query, facet and sort values, pagination flag,
  a shared search debounce timer, focus restoration, and result announcements.
- Browse search: normalized search blobs cached by localized record identity.
- Browse rendering: index, global results, kind filters/sorts/counts, list rows,
  skeleton/error states, detail metadata/prose/stat blocks/related records.
- Routing state: route callbacks interpret index, kind, and `<kind>:<id>`
  detail parameters; `/bestiary` aliases the monster list/detail renderer.
- Failure behavior: a failed fetch sets a visible error, but every subsequent
  accessor/render retries immediately.
- Lifecycle cleanup: fetch abort, generation invalidation, browse timer,
  records, localization/search caches, overlays, registered catalogs, and
  provider-visible state.

## Cohesive target ownership

### `content-api.js`

- Own the single load state machine and accepted generation.
- Fetch and parse the aggregate into candidate records.
- Build per-kind first-record-wins ID maps and ordered normalized-name
  candidate lists before atomic publication.
- Own records, indices, content localization overlays/catalog registrations,
  localized records, slim projections, provider methods, explicit retry, and
  disposal.
- Keep cached projections internal and return caller-owned array/object copies
  so one consumer cannot corrupt later list results.

### `browse-state.js`

- Own per-kind/global query, facets, sort, pagination, state transitions, and
  debounce/focus timer handles.
- Expose state operations without generating HTML.
- Clear every timer and state slot on disposal.

### `browse-renderer.js`

- Own route interpretation, browse action wiring, search/filter/sort
  definitions, search-blob caching, and all list/detail/loading/error HTML.
- Read canonical records and load state only through `content-api.js`.
- Read and mutate browse choices only through `browse-state.js`.
- Own no canonical content records, indices, overlays, or provider logic.

### `entry.js`

- Remain the composition root: create the content API and browse state,
  register the provider, create the renderer, register routes/sidebar/wiki
  kinds, and dispose renderer/state/content in order.

## Compatibility decisions

- `getItem()`/`getItemByName()` keep returning the full localized record or
  `null`; the first record in wire order remains canonical for duplicate IDs
  or normalized names.
- Name normalization remains the current trimmed, case-insensitive English
  comparison. Browse search keeps its separate diacritics-insensitive
  normalization.
- Provider list methods keep returning fresh mutable arrays and records.
  Internal immutable-ish cached projections are copied on each public call.
- `getRecords()` keeps a fresh array whose full-record objects retain the
  existing stable identity/mutability behavior.
- Failure recovery uses an explicit localized Retry action. A failed state
  never starts another request until that action or a replacement addon
  instance with a new `contentRevision`.
