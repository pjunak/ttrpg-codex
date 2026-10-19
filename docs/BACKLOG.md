# Backlog

The only task list for the host and the four first-party add-ons. Reference
docs describe what exists; this file says what to do next. Delete an entry when
it is done (Git keeps the history) and update the reference it changes.

**Entry format.** A bold title, the affected repositories in backticks, then
what and why in one or two sentences. Add **Done when** if the finish line is
not obvious. Move an entry between sections instead of duplicating it.

| Section | Meaning |
| --- | --- |
| [Owner checks](#owner-checks) | Live-site tasks only the owner does; each needs an explicit go-ahead |
| [Next](#next) | Agreed development work, ready to start |
| [Quality pass](#quality-pass) | Agreed fixes and cleanup from the full review, worked stage by stage |
| [Undecided](#undecided) | The owner is still deciding; do not start |
| [Later](#later) | Worth doing when the area is next touched |
| [Ideas](#ideas) | Only with a concrete need |
| [Watch for](#watch-for) | Failures seen once; reopen with a fresh log |

## Owner checks

- **Nightly smoke test** `ttrpg-codex` — The **Installed add-on smoke test**
  workflow runs at 02:41 UTC. Confirm it passes and that the
  `ADDON_SUITE_TOKEN` secret still reads the compendium repository.
- **Engine 5 and Sheets 5 on Asurai** `ttrpg-codex` — Download fresh backups
  of both sites into `L:\Backups\ttrpg\`. After the host deploy, Sheets stops
  until updated (its worker-only schema identity changed). In Settings →
  Add-ons install Engine 5.0.0, then Sheets 5.1.0 (it needs this host) and choose **Remove data and
  update**: existing character sheets are cleared. Re-import the characters
  from the `character-imports/` folder beside the repositories. If DM Tools
  reports dangling consequence targets, fix those planner entries by hand (it
  only reports them).
- **Asurai characters** `addon-dnd-character-sheets` — The players are
  rebuilding Bloodvell, Kael Vor, Ines and Talia in the new builder. The
  September reconstructions are archived with the backups for reference.
- **Tiamat** `ttrpg-codex` — Confirm Settings → Add-ons shows nothing
  installed. Tiamat stays without add-ons.

## Next

- **Compendium translation overlays** `addon-dnd-2024-compendium` — The
  `data/i18n/` record overlays are specified in `data/SCHEMA.md` but nothing
  loads or applies them. Implement them (planned for its own session) so the
  browse UI and the rules-data service can show translated record fields.
- **More context-menu targets** `ttrpg-codex` — Record menus exist
  ([editing and browsing](reference/EDITOR_BROWSING.md#record-context-menus)).
  Candidates the owner has not chosen between yet: map pins and empty map
  space, timeline cards and session columns, relationships ("add relationship
  to…"), faction ranks, the wiki writer (insert a campaign link at the cursor),
  and lending the menu to add-ons through the SDK (a contract change).
- **Character sheet refinement** `addon-dnd-character-sheets` — Compact has
  per-tab context bars, pips and floating windows; the owner keeps refining it.
  Known gaps: carrying capacity ignores size and features that change it (such
  as Powerful Build), and Classic shows no carried weight or coin-weight toggle.

## Quality pass

Agreed fixes and cleanup from a full review of all five repositories. Work the
stages in order; entries within a stage are independent, and stages 4–6 can be
reordered. Each fix adds a regression test. File-level findings are in the
local, git-ignored `docs/plans/quality-pass.md`.

### 1. Data safety

- **Campaign data fixes** `ttrpg-codex` — The player view hides a DM-only
  faction but keeps the character's `rank` and `rankChain`; a recovery
  snapshot over 64 MiB makes every later write fail; a campaign recovery
  restore fails for points that lack a collection, so the first new core
  collection would break all of them; records decoded through `float64` lose
  large integers on edit; malformed record values show as an outage instead of
  a validation error.
- **Add-on lifecycle and maintenance fixes** `ttrpg-codex` — Activate, reload
  and disable keep using the browser request, so closing the tab can leave
  workers running untracked and add-ons offline until restart; the CLI backup
  does not verify its own archive; `codex-maintenance restore` is a second
  restore implementation that deletes server credentials; a manifest without
  `runtime` crashes the inspector; bundle contributions to private add-on
  collections pass preview and fail at commit; the offline password reset
  keeps saved sessions. **Done when** the CLI restore runs the staged-restore
  code and the old path is deleted.
- **Lost edits in the record editors** `ttrpg-codex` — The full form stays
  editable during a save and drops what is typed meanwhile; a failed inline
  draft is closed when another field saves; the discard prompt is always
  English; one unreadable local draft hides all others; a full-form save
  rewrites untouched fields, splitting tags that contain commas and multi-line
  list items; the later-overwrite check hides in a call whose result is
  discarded; the dashboard add-on slot gets no locale.
- **Character Sheets data-safety fixes** `addon-dnd-character-sheets`,
  `addon-dnd-engine` — Adopting changed rules does not withdraw saved choices
  the new rules no longer allow, so the sheet stays stuck; grant, amendment and
  import dialogs close and lose their input when the action cannot run; Sheets
  accepts 190 KB requests that the Engine rejects at 180 KB, and both answer
  with generic errors; the unused `inventory` and `spells` operations skip
  repairs. Guard the stored format: a frozen 5.0.0 state fixture must decode,
  and CI fails when the stored schema changes without a version bump. **Done
  when** the guard is in place, before stage 3 changes Engine types.
- **DM Tools planner lockout** `addon-dm-tools` — One invalid stored record
  locks the DM out of the planner, imports and the planning export (the DM's
  own backup), and parallel reads can report a false inconsistency. Read and
  export without validating, offer revision-guarded repair actions, validate
  only before writes and previews, align the schemas with the Go validator,
  and accept any contract-valid receipt token.
- **Compendium validation gaps** `addon-dnd-2024-compendium` — The content
  schema does not describe the ruleset record, so a bad ruleset installs and
  then fails every evaluation; the reference test reads lineage spells in the
  wrong shape and skips most reference kinds; the equipment importer
  overwrites hand-curated fields and its dry run shows no field differences.
- **Docs that contradict the code** `ttrpg-codex`,
  `addon-dnd-2024-compendium` — API_V3 lists a host-to-worker
  `addon/service.call` that does not exist, and the SDK tests use the same
  name; ARCHITECTURE, the `workerOnly` schema description and BACKUP_RESTORE
  are stale; the Compendium `data/SCHEMA.md` documents `getRuleset`,
  `listEquipment`, an alert fallback and a universal `edition` value that do
  not exist, and its i18n README template omits the required `name`.

### 2. One write path per editor

- **One write controller for host editors** `ttrpg-codex` — Editors learn
  that a save finished from app-wide state, and an add-on admin view that
  disconnects mid-request can leave the app-wide `busy` flag stuck until
  reload. Route saves through one controller that answers each editor's own
  request, make `busy` a lease released on disconnect, share one request
  controller across admin views, and test editors against the real app
  instead of the fake save host.
- **One inline field and a record-form element** `ttrpg-codex` — Three
  inline-edit implementations behave differently on conflicts, pending saves
  and keys. Merge them into one component with explicit commit modes, and move
  the full record form into its own element that owns the opening snapshot,
  dirty state and saving lock.
- **Split `codex-app.ts`** `ttrpg-codex` — Cut it into a session controller,
  an add-on outlets controller, the write controller, shell elements and a
  navigation guard; `campaign-controller.ts` already holds campaign loading and
  live refresh.
- **Character Sheets session** `addon-dnd-character-sheets` — Saving depends
  on nine interacting fields in `character-element.ts`, responses are merged
  by spreading so stale fields survive, and no test touches it. Extract a
  session with an injected call function and unit-test lost replies,
  conflicts, refused saves, rule adoption and imports; cancel per-view loads;
  give every field an explicit key instead of one derived from its label.

### 3. Typed rules model

- **Typed Engine vocabulary and outputs** `addon-dnd-engine` — Rules code works
  on untyped maps, and closed sets (play commands, effect targets and modes,
  grant sources, choice kinds, calculation operations) are strings dispatched
  in several places. Give each set a type with one dispatcher checked by the
  `exhaustive` linter, return a typed sheet, plan and guidance, generate
  schemas with enums and consistent nullability, report bad rules data instead
  of coercing it to defaults, move the HP clamp into evaluation and drop the
  unused `derive` method. This is a breaking major version. **Done when** no
  public output is `map[string]any` and no closed set is a string switch.
- **Character Sheets on the typed Engine** `addon-dnd-character-sheets` — Read
  typed results instead of untyped sheet maps, upgrade stored state by
  recomputing the snapshot from saved inputs, and pass old exports through the
  same upgrade chain. Installing it on Asurai is an owner check.
- **Grants vocabulary in the Compendium schema** `addon-dnd-2024-compendium` —
  Enforce the `grants` keys that `data/SCHEMA.md` documents, matching the
  Engine's typed vocabulary, so bad data fails at install instead of at
  evaluation.

### 4. Contracts, SDK and shared tooling

- **SDK as its own module** `ttrpg-codex` and add-ons — The SDK imports host
  internals, so add-ons require the whole host module and keep copies of the
  strict JSON decoder. Publish a small SDK module that exports the decoder and
  ID validators, tag host versions so add-ons pin tags and reference the
  publish action by tag instead of commit SHA, and delete the copies.
- **Shared add-on tooling** `ttrpg-codex` and add-ons — Every add-on copies
  `codex-sdk.mts`, the host `.d.ts` files, `tools/check.go`, a package builder
  and its workflows. Provide them from the host (a sync/check command next to
  `codex-addon-inspect`, one package builder, a reusable CI workflow) and drop
  the copies.
- **One source per contract** `ttrpg-codex`, `addon-dm-tools` — The Go
  manifest struct drops fields the schema accepts; the protocol schema allows a
  null `id` that the peer rejects; DM Tools writes each planning contract three
  times; the frontend reads responses three ways with copied validators.
  Generate the copies or add drift tests (every schema property has a struct
  field), and read every response through one validated reader.

### 5. Host backend structure

- **Package manager lock scope** `ttrpg-codex` — Staging holds the manager
  lock for the whole upload, activation holds it while workers start and stop,
  and the add-on data write lock spans service publication, so slow operations
  stall add-on pages. Stage uploads before locking and narrow both locks.
- **Clearer host packages** `ttrpg-codex` — The HTTP layer reaches the package
  manager through unchecked runtime interface tests and a very large config;
  the mutation planner, package manager and add-on data service each mix
  several jobs; the two stores implement the same revision and tombstone
  protocol twice; storage imports add-on packages; small validators are copied
  across packages. Use one explicit admin interface, split those files, share
  the store protocol, add a layer-direction test and delete test-only code.

### 6. UI styling and structure

- **Complete and publish design tokens** `ttrpg-codex` and add-on UIs — The
  Moonlit theme overrides only some tokens, so timeline, map and Mind Palace
  panels stay Classic brown (theme Mind Palace only once its design is
  decided); display colours live in TypeScript; the theme preview copies the
  palettes; add-ons redefine host tokens with different values, and Sheets uses
  an undefined `--bg-hover`. Theme every surface through tokens, publish the
  host token names, and make add-on source checks reject redefined or unknown
  tokens.
- **Spacing, type and stacking scales, and one button** `ttrpg-codex` and
  add-on UIs — Most padding, gaps and font sizes are literals, z-index and
  durations have no scale, Sheets has text below the 12 px minimum, and several
  feature button styles sit beside the shared variants. Add the missing scales,
  move literals to tokens when touching a file, lint new literals, and use one
  button with variants.
- **Shared controls and accessibility** `ttrpg-codex`,
  `addon-dnd-character-sheets` — The map search lacks listbox roles and arrow
  keys; the inline Markdown writer is announced as a dialog and its full-screen
  mode lets Tab escape; inline value buttons hide the value from their name;
  navigation during a save is refused without a message; Sheets' non-modal
  windows trap Tab.
- **Split the remaining large UI files** `ttrpg-codex`, `addon-dm-tools` —
  Split `campaign-record-editor.ts` (field descriptors, parsing, relationship
  planning), the article and collection views out of `codex-record-page.ts`,
  `codex-map.ts` (one panel state, layers, search), the vocabulary editor out
  of `codex-settings.ts`, the inline catalogs out of `ui-localization.ts`, and
  DM Tools' `planner-element.ts` (canvas, forms, commands, draft session).

## Undecided

> **The owner is still figuring out what to do with these.** Leave their UI and
> data model as they are: no redesigns, migrations or "quick fixes" until a
> decision is recorded here or as an [ADR](decisions/). Bug fixes that keep
> current behaviour are fine.

- **Knowledge and investigation model** `ttrpg-codex` — How much players know
  about characters (the four knowledge levels), mystery clues (many are bare
  event keys), and characters' *open questions* / *what is known* (also shown
  in Mind Palace and the unanswered-questions list). Current behaviour, known
  problems and the questions to answer are in the
  [design note](design/knowledge-and-investigation.md).
- **Previous add-on build after updates** `ttrpg-codex` — Cleanup removes the
  old build and its recovery data right after an update, so only a full backup
  can undo damage done by the new version. Decide whether to keep one previous
  build one update longer.
- **Reordering twin records on the timeline** `ttrpg-codex` — Moving an event
  moves only the DM side of a twin pair, so players keep the public twin in its
  old session. Decide whether both should move.

## Later

- **Align owned-feature filters** `addon-dnd-2024-compendium`,
  `addon-dnd-engine` — The Compendium's owned-feature filter and the Engine's
  ownership rules can disagree; make them match.
- **Collapse add-on confirmation flows when next touched** `ttrpg-codex` —
  Activation, disable, uninstall, cleanup, schema and update reviews each have
  their own review type and SHA-256 confirmation token. Do not add another;
  when one of them changes, move it to a shared plan-and-confirm helper that
  checks expected state revisions. Disable is reversible and could confirm with
  a plain dialog plus the target's state revision.
- **Shared Classic and Compact panels** `addon-dnd-character-sheets` — Both
  layouts implement hit points, combat, equipment and spells separately, with
  different behaviour (Compact parses free-text HP changes, Classic sends play
  commands). Share panel data and commands once the Compact refinement settles.
- **Host locale and Markdown services for add-ons** `ttrpg-codex` — The add-ons
  run three localization systems, and the Compendium ships its own Markdown
  renderer, because the host serves no add-on locales and its Markdown
  component cannot resolve wiki links. Lend a translator over manifest catalogs
  and a reference-resolver hook through the SDK.

## Ideas

Only start one of these for a concrete need, and design the review UI and docs
with it.

- **Cloud backup add-on** — Workers have no network access and cannot read
  backup archives; both would be new, reviewed host capabilities.
- **Value-transforming add-on data migrations** `ttrpg-codex` — Updates can
  keep compatible data or reset it with a backup download, and worker add-ons
  upgrade old formats themselves on read ([how](reference/ADDON_DATA.md#reviewed-compatible-schema-upgrades)).
  The reserved worker methods `addon/migration.plan` and `addon/migration.apply`
  are not implemented; add them only for an add-on without a worker that must
  change its format.
- **More add-on surfaces** `ttrpg-codex` — Record renderers, custom graph node
  kinds, `kind` enum injection, HTTP endpoints, WASI workers, standalone
  `context.imports/events/settings/navigation/log` SDK handles and native
  self-binding during worker start-up. Each needs its runtime, review UI and
  docs.
- **Editor extensions** `ttrpg-codex` — Arbitrary add-on editor fields or
  combined core/add-on saves (panels save independently today).
- **Operations** `ttrpg-codex` — A restart button in the web UI, per-session
  revocation and a session list, request/correlation
  IDs and security-event diagnostics (never recording credentials or tokens),
  add-on resource limits or signatures, add-on data indexes for measured load.
- **DM Tools** `addon-dm-tools` — Faster Atlas placement and mouse-wheel
  preferences, if wanted.
- **Rules data** `addon-dnd-2024-compendium`, `addon-dnd-engine`,
  `addon-dnd-character-sheets` — Per-item magic weapon/shield base forms,
  narrative combat effects, renown/facilities/Circle Magic automation. Add
  source data, Engine support and Sheets UI together for a mechanic someone
  needs ([gaps](../../addon-dnd-2024-compendium/data/GAPS.md)).

## Watch for

These failed once and have not recurred:

- The Timeline page and a phone Settings load timing out at start-up (September).
- The planner canvas timing out before its first action (September).
- The rules service briefly reporting rules unavailable (September).
- The shared-controls and editors browser fixtures timing out at start-up in a
  full `npm run check` (October).
