# Cross-repository preflight and DM Tools implementation order

Date: 2026-07-23

Repositories reviewed:

- `ttrpg-codex`
- `dnd-character-sheets`
- `dnd55e-compendium`

Target addon checkout:

- `C:\Users\junak\Documents\GitHub\dm-tools` — newly initialized repository
  for the addon implemented by this program. It contained no implementation to
  audit at the time of this review. Host and addon-facing feature batches may
  modify it alongside the three reviewed repositories.

Related design plans:

- `01-dm-only-addon-collections.md`
- `02-atomic-multicollection-transactions.md`
- `03-extensible-content-import-center.md`
- `04-addon-graph-library-facade.md`
- `05-addon-localization-packages.md`
- `06-dm-dashboard-extraction.md`
- `07-english-source-normalization.md`

## Executive decision

The three repositories are in good condition and the existing addon split is
sound. Do not redesign the rules engine, merge the addons, introduce a build
step, or attempt a broad rewrite of the host's large modules.

Do not begin DM-only addon collections yet. First close the security and
correctness gaps at the addon/storage boundaries, introduce an explicit addon
API v2 compatibility contract, and add a real addon lifecycle/invalidation
mechanism. After that, implement the numbered design plans in this execution
order:

1. Plan 01 — DM-only addon collections
2. Plan 02 — atomic multi-collection transactions
3. Plan 05 — addon localization packages
4. Plan 03 — extensible content import center
5. Plan 04 — addon graph-library facade
6. Plan 06 — DM dashboard extraction
7. Plan 07 — English-source gap audit

The filenames remain topic identifiers, not their execution order. Plan 05 is
intentionally moved ahead of the UI-heavy import, graph, and dashboard work so
new DM Tools surfaces do not first acquire local translation machinery that
must immediately be migrated.

## Audit evidence

All worktrees were clean on `main` when reviewed.

| Repository | Verification | Result |
|---|---|---|
| `ttrpg-codex` | `npm test` | 380 passed, 0 failed, 1 intentional skip |
| `dnd-character-sheets` | `node --test tests/smoke.mjs tests/rules.mjs` | 132 passed, 0 failed |
| `dnd55e-compendium` | `node --test tests/smoke.mjs tests/data-integrity.mjs` | 44 passed, 0 failed |

`npm audit --omit=dev` reported five high-severity findings in two production
dependency paths:

- `adm-zip@0.5.17`: crafted ZIP input can cause an excessive allocation. It
  is used to open uploaded addon archives before the host's expanded-size and
  file-count guards can protect the process. No patched `adm-zip` release is
  currently offered by the installed dependency range.
- `archiver@8.0.0 -> readdir-glob -> minimatch@10.2.5 ->
  brace-expansion@5.0.6`: brace-expansion denial of service. The practical
  backup-path exposure is lower because the application controls the archive
  patterns, but a production audit should still be made clean through a tested
  override, upstream update, or replacement.

Approximate non-generated source/documentation size reviewed:

- host: 48,887 lines in 125 files; largest modules are `server.js` (3,506),
  `web/js/store.js` (2,885), `web/js/cloudmap.js` (2,825), `web/js/wiki.js`
  (2,638), and `web/js/settings.js` (2,470)
- sheets: 8,582 lines; `entry.js` is 995 lines and registers 86 actions
- compendium: 2,957 code/documentation lines plus 1,884 JSON records

Large files are a maintenance signal, not an instruction to split everything.
Only extractions that establish a needed boundary are included below.

## Prioritization method

Each item is scored from 1 to 5 for impact, risk, and implementation effort.
Priority score is `(impact + risk) * (6 - effort)`. Security/correctness gates
override the numeric order when dependencies require it.

- 27 or more: do before feature work
- 20–26: next or alongside the dependent feature
- 19 or less: opportunistic polish; do not delay DM Tools for it

## Ranked findings

| ID | Area | Verified finding | I/R/E | Score | Disposition |
|---|---|---|---:|---:|---|
| C-DOC-1 | Compendium/docs | `data/GAPS.md` claims several structures are missing although class, armor, feat, and Pact Magic support now exists. It is a canonical planning input and can cause duplicate or contradictory work. | 3/4/1 | 35 | Fix before feature implementation. |
| H-ADD-1 | Host/addons | Content-group toggles update server state and broadcast events, but the client reloads an addon only when its entry URL changes. The compendium caches content once, so disabled content can remain visible until a page reload. | 4/5/2 | 36 | Blocking correctness fix; solve generically with content revision/invalidation. |
| H-SEC-1 | Host/addon tests | Child-process environment scrubbing is a duplicated denylist and misses common secrets such as `AWS_ACCESS_KEY_ID`, `DATABASE_URL`, and `SSH_*`. Addon-controlled tests can inspect inherited variables. | 5/4/2 | 36 | Replace with one explicit environment allowlist and test it. |
| H-ADD-2 | Host/addons | `hostVersion` is declarative only; `apiVersion` accepts only exact v1; future security fields can be silently ignored by an older host. In particular, an old host could accept `access: "dm"` but normalize it away and publish the collection. | 5/5/3 | 30 | Add Plan 00: API v2/capability negotiation before Plan 01. |
| H-SEC-2 | Host/dependencies | Production addon installation opens untrusted ZIPs with vulnerable `adm-zip` before bounded extraction checks. The backup dependency path also has a high advisory. | 5/5/3 | 30 | Replace addon extraction with bounded streaming extraction; resolve backup chain separately. |
| H-ADD-3 | Host/dependencies | The client semver helper accepts invalid installed versions and unknown range syntax. Manifest dependency shapes/ranges are not fully validated. | 4/4/2 | 32 | Introduce one strict, fail-closed compatibility parser used by validation and loading. |
| H-ADD-4 | Host/harness | The published mock `host.use()` returns `undefined` where the live host throws; registration validation also differs. Addons can pass smoke tests and fail only after installation. | 3/4/2 | 28 | Add host/harness contract tests and make the mock behavior identical. |
| H-VIS-1 | Host/visibility | Collections are filtered independently. Public records can retain references to hidden characters, factions, locations, or other DM-only records, leaking identifiers and creating dangling relationships. | 5/4/3 | 27 | Build visible-ID sets first, then scrub/filter cross-record references; assert raw response bytes. |
| S-DOC-1 | Sheets/docs | `ROADMAP.md` contains copied compendium work and closed/stale claims; `RULES_EDGE_CASES.md` mixes current contracts, historical proposals, and retired core-rules terminology. | 3/4/2 | 28 | Rewrite the active contract narrowly and archive history. |
| H-ADD-5 | Host/addons | Unload reverses host registrations but cannot ask addon code to clear timers, listeners, or caches. This also prevents clean content invalidation. | 4/4/3 | 24 | Add disposer/`onDispose` and content-change lifecycle before graph/dashboard work. |
| H-SYNC-1 | Host/client store | Remote events can start overlapping full loads whose responses settle out of order. Cascade writes trigger redundant fetch/render cycles. `Store.load()` also treats a valid payload without `characters` as empty. | 4/4/3 | 24 | Add single-flight/latest-generation loading and validate the payload as an object. |
| H-STOR-1 | Host/storage | The core write queue has no timeout, and backup streams the live data directory outside the lock, allowing hangs or inconsistent archives. | 5/3/3 | 24 | Extract a small storage primitive with timeout and point-in-time backup staging before transactions. |
| H-MAP-1 | Host/map/timeline | Map initialization has no generation token; legacy image selection still writes a base64 URL to local storage; timeline drag can persist `sitting: 0` as `1`. | 3/3/2 | 24 | Fix in a bounded legacy-correctness batch; use a one-time timeline migration. |
| C-API-1 | Compendium/runtime | `getItem`/`getItemByName` scan arrays and `listKind` remaps records per call. Sheet hydration repeats these operations. Failed initial loads retry on every unrelated render. | 3/3/2 | 24 | Build revision/locale-scoped indices and cached slim lists; use bounded retry. |
| H-ARCH-1 | Host/architecture | Four collection-to-route maps have already drifted into `app.js`, `wiki.js`, `edit_templates.js`, and `editmode.js`. New addon/import routes would multiply this. | 3/4/3 | 21 | Introduce one collection descriptor registry before new collection UI. |
| S-ARCH-1 | Sheets/architecture | Render code is modular, but the 995-line action/controller entry remains a single 86-action closure. Several private actions have no UI callers (`copySpell`, `invAdd`, `builderBgAsi`, `statBox`; `hp` is effectively a test seam). | 3/3/3 | 18 | Split registrars by domain and remove only verified dead actions; preserve dynamically named actions. |
| S-UI-1 | Sheets/UI | Scoped CSS claims token-only styling but contains literal spacing/sizes and noncanonical 640/720 breakpoints. | 2/2/2 | 16 | Correct during the sheets controller/UI cleanup, not as a rewrite. |
| H-UI-1 | Host/UI | Remote-change banner uses inline literal colors, spacing, and z-index; obsolete dashboard title selectors remain in CSS. | 2/2/1 | 16 | Small design-system/dead-CSS cleanup. |
| H-TOOL-1 | Cross-repo/tooling | There is no linter/formatter and several test files are large. | 2/3/3 | 15 | Add a lightweight check only after hotspot cleanup; avoid a repo-wide formatting diff. |
| H-GOD-1 | Host/architecture | `server.js`, `store.js`, and `settings.js` are god files; entity editors repeat similar structures. | 3/3/4 | 12 | Extract seams as features require them; no big-bang rewrite. |

## Required preflight batches

Each batch below is intended to be a separate Codex chat. Complete and verify a
batch before starting the next one. No preliminary branch or commit setup is
required; each chat should inspect and preserve the current working state.
Commits remain useful checkpoints but are optional. A batch must update the
relevant reference documentation in the same change.

### P1 — Untrusted ZIPs and addon-test environment

Scope:

- replace production addon ZIP reading with bounded `yauzl`-style streaming
  extraction, applying entry count, per-entry, total expanded-size, path, and
  compression-ratio checks before allocation/write
- remove `adm-zip` from production dependencies and `HOST_SERVER_LIBS`; use a
  test-only writer or another bounded library for fixture creation if needed
- centralize child environment construction and allow only the minimum Windows
  and POSIX process variables required to launch Node
- resolve the `archiver` advisory with a compatibility-tested override/update;
  replace it only if a safe supported dependency graph cannot be obtained

Acceptance:

- malicious archive/path/size tests pass without large allocation
- secret-shaped and arbitrary environment variables are absent in the child
- addon test runner still launches on Windows and Linux-compatible CI
- `npm audit --omit=dev` has no unresolved high finding, or a narrowly
  documented temporary exception exists for the lower-exposure backup chain
- full host tests pass

### P2 — Visibility closure

Scope:

- define visibility as a closed graph, not independent collection filters
- build surviving entity-ID sets and filter/scrub relationships and reference
  fields against them
- cover characters, factions, locations, events, mysteries, and addon
  collections as their schemas permit
- keep filtering centralized in `server/visibility.cjs`

Acceptance:

- player API responses contain neither hidden records nor their IDs/slugs in
  retained relationship/reference fields
- integration tests inspect raw serialized response bytes in addition to parsed
  structure
- DM payloads remain unchanged

### P3A — Storage durability and backup consistency

Scope:

- give the core write mutex a timeout and deterministic error response
- make backup operate on a point-in-time staged copy/snapshot captured under the
  write lock, then stream outside the lock

Acceptance:

- simulated wedged writer returns a bounded failure instead of hanging
- backup remains consistent while writes race it
- full host tests pass

### P3B — Client synchronization correctness

Scope:

- accept any valid object-shaped `/api/data` payload, including campaigns with
  no characters
- coalesce remote changes, permit one load at a time, ignore superseded
  generations, and render once for the newest server hash

Acceptance:

- out-of-order load tests cannot restore stale state
- an empty-character campaign loads normally
- full host tests pass

### P4 — Plan 00: addon API v2 and strict compatibility

Create a short ADR/plan before implementation. Scope:

- support v1 and v2 during migration; do not break installed v1 addons
- enforce `hostVersion` using one strict semver implementation
- validate dependency IDs and version ranges at install time and fail closed at
  load time
- declare and negotiate capabilities for security-sensitive behavior
- require v2/capability support for `access: "dm"` and any future field whose
  omission would weaken confidentiality or authorization
- reject unknown security semantics rather than normalizing them away
- update the authoring harness, schemas, examples, and docs together

Acceptance:

- old compatible v1 addons still load
- incompatible host/API/range combinations fail with actionable diagnostics
- no old host can install a manifest whose ignored fields would broaden access
- host and harness run a shared contract matrix

### P5 — Addon lifecycle, content revision, and harness parity

Scope:

- let `register()` return a disposer and/or expose `host.onDispose()`
- invoke addon cleanup before reversing host registrations
- expose a generic content revision derived from active package plus enabled
  content groups
- notify loaded addons of content changes or reload them when their content
  revision changes
- invalidate compendium content, indices, and localized caches on that event
- make mock `use()` and registration errors match the live host exactly

Acceptance:

- disabling the compendium Monster Manual group removes its records live,
  without a browser reload; enabling it restores them
- timers/listeners/caches are gone after disable/update/unload
- repeated reconciliation cannot duplicate actions, pages, kinds, or listeners
- cross-repository regression tests cover the live content toggle

### P6A — Cross-repository contract repair

Scope:

- correct compendium `GAPS.md`, `SCHEMA.md`, and remaining-only roadmap
- reduce sheets roadmap to actual remaining work; split current rules contract
  from historical design notes; remove retired addon terminology

Acceptance:

- documentation describes actual tested behavior
- current contracts are clearly separated from historical design records
- host, sheets, and compendium tests remain green

### P6B — Central collection descriptors

Scope:

- introduce one core collection descriptor registry and migrate the four route
  maps to it

Acceptance:

- all route consumers use one descriptor source
- descriptor tests cover every built-in collection
- full host tests pass

## Optional pre-feature polish batches

These are worthwhile but do not block Plan 01 after P1–P6B. Keep each separate
from feature work so review remains clear.

### P7 — Host legacy correctness and UI residue

- delete the legacy map base64/local-storage branch
- add a map initialization generation guard
- migrate timeline `sitting: 0` values once instead of coercing during drag
- remove confirmed dead dashboard CSS
- move the remote-change banner to design tokens and component classes

### P8 — Character sheets controller cleanup

- split action registrars into base, spells, inventory, resources/rest,
  builder, and import/export modules
- use one internal inventory-add helper instead of test-only action variants
- extract pure HP mutation logic if it remains a useful unit-test seam
- remove only actions proven unused after accounting for render helpers that
  pass action names dynamically
- align scoped styles with host tokens and canonical breakpoints
- split tests by the same domains only where this improves navigation

Do not move the rules engine to another addon. Its built-in engine plus optional
content-provider design is intentional and working.

### P9 — Compendium content API cleanup

- split `entry.js` only at the actual seams: content API/cache, browse state,
  and browse rendering
- build ID and normalized-name maps after load
- cache slim/localized lists by content revision and locale
- add bounded backoff or explicit retry after load failure
- defer further localization restructuring until Plan 05

Profile before doing any more ambitious hydration optimization; current tests
do not justify it.

## Feature implementation batches and exact order

Start these only after P1–P6B. P7–P9 may be done before this sequence or
deferred until after it.

Implement generic host capabilities in `ttrpg-codex`; implement DM-specific
pages, providers, graph consumers, and dashboard ownership in the `dm-tools`
repository. Change sheets or compendium only when a shared contract migration
requires them.

### F1 — Revised Plan 01: DM-only addon collections

Prerequisites: P2, P4, P5, P6A, and P6B.

Required revisions to the supplied plan:

- collection identity is `(addonId, collectionName)`, never a global bare name
- `access: "dm"` is an API v2 security capability
- secrecy covers list/detail APIs, search, wiki links, fragments, SSE payloads,
  hashes/revisions, exports/backups exposed to players, and error messages
- player-visible hashes must not reveal changes confined to DM-only data
- test old-host/new-manifest and view-as transitions explicitly

### F2 — Revised Plan 02: atomic multi-collection transactions

Prerequisites: F1 and P3A.

Required revisions:

- specify read isolation and transaction read/write sets
- define rollback/crash recovery and startup cleanup behavior
- make one durable commit produce one revision/event
- preserve the existing write queue as the serialization point instead of
  inventing a parallel locking system
- test failure at every write boundary and restart after an interrupted commit

### F3 — Revised Plan 05: addon localization packages

Prerequisites: P4 and P5; scheduled here so collection/transaction diagnostics
can settle first and UI-heavy work can consume the final API.

Required revisions:

- use declarative translation files in the manifest/package rather than
  imperative bulk registration
- make English the required source catalog and permit partial locale catalogs
- namespace addon keys and define collision/override behavior
- include addon strings in the existing source/placeholder/escaping guards
- migrate sheets and compendium as reference consumers before DM Tools UI grows

### F4 — Revised Plan 03A: import contract and server core

Prerequisites: F1, F2, F3.

- version provider schemas and import job/payload formats
- define protected/immutable fields and allowed collection targets
- declare provider read dependencies and requested write collections
- parse raw input in a way that can detect duplicate JSON keys
- perform preview and commit against the same revision assumptions
- use the transaction API for the final commit
- add per-addon concurrency, token-bucket/rate, timeout, and cancellation limits
- define provider cleanup and server-restart behavior

### F5 — Revised Plan 03B: provider and DM Tools UI

Prerequisite: F4.

- build the import-center page through the stable addon mount lifecycle
- make preview, conflict resolution, validation, commit, and audit results
  distinct steps
- implement one small first-party provider before generalizing further
- add accessibility, localization, and failure-recovery tests

### F6 — Revised Plan 04: graph-library facade

Prerequisites: P5 and F3; preferably after import contracts have stabilized.

- keep the graph implementation registry global, not per addon
- treat browser-side permissions as capability signaling, not a security
  sandbox
- mount/unmount through the generic lifecycle and require graph disposal
- version the facade independently of the bundled Cytoscape implementation
- keep adapters narrow; do not expose raw host internals by convenience

### F7 — Revised Plan 06: DM dashboard extraction

Prerequisites: F1, F3, and P5.

- move planner/workflow content to DM Tools
- consider retaining a minimal core DM landing surface for host/addon health and
  hidden-content counts; do not make addon failure remove all DM diagnostics
- preserve route/navigation behavior while changing ownership
- uninstall/disable tests must leave a coherent fallback route

### F8 — Revised Plan 07: English-source gap audit

Prerequisite: F3 and all migrated/new UI.

Treat this as a final gap audit, not a second i18n migration: core catalogs and
English source strings already exist. Find remaining literal user-facing text,
addon-local exceptions, plural/date formatting gaps, and stale Czech defaults.
Run both i18n guards across host and addon packages.

## Explicitly deferred decisions

These need maintainer policy and should not be smuggled into the cleanup
batches:

- password migration from SHA-256 to `scrypt` and the resulting re-login policy
- enabling a focused `script-src` policy now versus a broader CSP later
- repository license choice
- unscoped addon `data-action` access to core actions, which is acceptable only
  under the current trusted-addon posture and must be revisited before
  third-party/untrusted addons

## Things not to "simplify"

- Do not merge `dnd-character-sheets` and `dnd55e-compendium`; the optional
  provider boundary is useful and tested.
- Do not extract the sheets rules engine into a third addon.
- Do not replace JSON storage, native browser modules, vanilla JS, or the
  no-build workflow as part of this program.
- Do not perform a wholesale split of `server.js`, `store.js`, or
  `settings.js`; extract a seam only when a batch owns and tests that seam.
- Do not remove apparently unreferenced sheet actions using text-counting
  alone; render helpers compose several action names dynamically.
- Do not add a global formatter and reformat the repositories in the same
  change as functional work.

## Suggested chat boundaries

Use one chat per row. The exact recommended sequence is:

| Chat | Work |
|---:|---|
| 1 | P1 — ZIP/dependency and child-environment hardening |
| 2 | P2 — visibility closure |
| 3 | P3A — storage durability and backup consistency |
| 4 | P3B — client synchronization correctness |
| 5 | P4 — Plan 00 addon API v2/compatibility ADR and implementation |
| 6 | P5 — addon lifecycle, content revision, and harness parity |
| 7 | P6A — cross-repository contract repair |
| 8 | P6B — central collection descriptors |
| 9 | P7 — host legacy correctness/UI residue (optional) |
| 10 | P8 — sheets cleanup (optional) |
| 11 | P9 — compendium API cleanup (optional) |
| 12 | F1 — revised Plan 01 |
| 13 | F2 — revised Plan 02 |
| 14 | F3 — revised Plan 05 |
| 15 | F4 — revised Plan 03A |
| 16 | F5 — revised Plan 03B |
| 17 | F6 — revised Plan 04 |
| 18 | F7 — revised Plan 06 |
| 19 | F8 — revised Plan 07 |

Combining chats is safe only for P8 plus P9 if the changes remain entirely
repo-local and make no host API changes. Do not combine P1–P5, F1–F3, or the
two import batches: their boundaries are where security and recovery behavior
need focused review.

Suggested prompt form for each new chat:

> Implement batch `<ID>` from
> `docs/plans/2026-07-23-cross-repo-preflight-and-dm-tools-order.md`.
> Read the relevant AGENTS/reference files in every affected repository, keep
> strictly to this batch, run the specified repository tests, update contracts,
> and report any assumption that would alter the next batch. Inspect and
> preserve existing changes; do not create/switch branches or commit unless I
> explicitly request it. The target addon checkout is
> `C:\Users\junak\Documents\GitHub\dm-tools`.

After each batch, start the next chat only after its acceptance criteria and
tests pass. If a batch changes a public addon contract, dev-install every
affected addon and run the host plus affected addon suites before accepting it.
If changes are left uncommitted, the next chat must review the existing diff
before editing it.
