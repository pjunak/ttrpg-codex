# Backlog

The only task list for the host and the five first-party add-ons. Reference
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
  reports dangling consequence targets, remove them with the planner's repair
  buttons once its current build is installed (older builds only report them).
- **Quality-pass add-on builds on Asurai** `ttrpg-codex` — The host with the
  data-safety fixes is deployed to both sites. Download a fresh Asurai backup
  into `L:\Backups\ttrpg\`, then in Settings → Add-ons update the Engine,
  Compendium, Character Sheets and DM Tools to their latest builds, in that
  order: an Engine older than 5.3.0 rejects the Compendium's newer condition
  fields and turns conditions off until it is updated. If Character Sheets
  asks, choose **Heal and update**; existing sheets stay. Then open each
  character and choose **Adopt current rules** before play.
- **Asurai characters** `addon-dnd-character-sheets` — The players are
  rebuilding Bloodvell, Kael Vor, Ines and Talia in the new builder. The
  September reconstructions are archived with the backups for reference.
- **Tiamat** `ttrpg-codex` — Confirm Settings → Add-ons shows nothing
  installed. Tiamat stays without add-ons.
- **Homebrew on Asurai** `addon-dnd-homebrew` — Download a fresh Asurai
  backup into `L:\Backups\ttrpg\`, update the Engine to 6.0.0 and then
  Character Sheets to 6.0.0 (if it asks, choose **Heal and update**; saved
  sheets stay), install the latest Homebrew build, import
  `homebrew-imports/cursed-cards.json` (beside the repositories), set the item
  set's rarity and curse, and publish.

## Next

- **Source-text defects: book spot-check and remaining table cleanup**
  `addon-dnd-2024-compendium` — Follow-ups from fixing the defects the
  2026-10-21 excerpt pass flagged. Restore glamour Mantle of Majesty's
  cut-off sentence ("…cast Command as a Bonus Action without expending a
  spell slot,") from the printed PHB; no checkable source was available.
  Spot-check against the book what was corrected from record prose alone:
  the lightly/moderately-armored Shields swap, Shield Master's Strength-only
  increase, Weapon Master's removed Martial-proficiency grant, and the
  soulknife Rend Mind "use you[r]" and ritual-caster "spelicasting" typos.
  The same broken one-cell table markup remains in 24 records outside the
  flagged feature/feat/subclass scope (classes, species, spells, rules,
  monsters, magic items), and the PHB wizard-subclass table lists
  Bladesinger, which is neither a 2024 PHB subclass nor in the repository.
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
stages in the order listed; entries within a stage are independent, and the
last three stages can be reordered. Each fix adds a regression test.
File-level findings are in the local, git-ignored `docs/plans/quality-pass.md`.

### Contracts, SDK and shared tooling

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

### Host backend structure

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

### UI styling and structure

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

- **Finish typing the rules paths** `addon-dnd-engine`,
  `addon-dnd-character-sheets` — Rules-engine 6 returns typed results, but the
  Engine's internal decisions map still reads records field by field, its
  magic-item `grants` allowlist checks field names as strings, and many Sheets
  panels read through generic `object()` helpers. Type them when the area is
  next touched.
- **Align owned-feature filters** `addon-dnd-2024-compendium`,
  `addon-dnd-engine` — The Compendium's owned-feature filter and the Engine's
  ownership rules can disagree; make them match.
- **Collapse add-on confirmation flows when next touched** `ttrpg-codex` —
  Activation, disable, uninstall, cleanup, schema and update reviews each have
  their own review type and SHA-256 confirmation token. Do not add another;
  when one of them changes, move it to a shared plan-and-confirm helper that
  checks expected state revisions. Disable is reversible and could confirm with
  a plain dialog plus the target's state revision.
- **Recovery size limit in Settings** `ttrpg-codex` — An automatic recovery
  point over 64 MiB is skipped with only a server-log warning, and a manual
  point or restore over the limit answers a generic "could not complete the
  recovery request". Show the skip in Settings and give `ErrTooLarge` its own
  message.
- **Shared Classic and Compact panels** `addon-dnd-character-sheets` — Both
  layouts implement hit points, combat, equipment and spells separately, with
  different behaviour (Compact parses free-text HP changes, Classic sends play
  commands). Share panel data and commands once the Compact refinement settles.
- **Base forms for the named magic weapons and armor** `addon-dnd-2024-compendium`
  — The DMG's +1/+2/+3 weapon, armor and shield declare `baseItem`; the named
  ones (Flame Tongue, Sun Blade, Elven Chain, Dwarven Plate and the rest) do
  not, so even with DM adjudication they get no attack row or armor AC. Declare
  their base, and a bonus only where the item is otherwise complete.
  Ammunition, +1, +2, or +3 waits for ammunition attacks.
- **Homebrew feats, spells, origins and bundles** `addon-dnd-homebrew` — Items,
  magic gear and subclasses are built; next, in this order
  ([ADR-0006](decisions/0006-homebrew-content.md)): feats and spells (homebrew
  spells join class lists through `classes`),
  species and backgrounds, then a `codex.campaign-bundle-contributor` so a
  campaign bundle carries homebrew drafts.
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
  `addon-dnd-character-sheets` — Narrative combat effects, renown/facilities/Circle Magic automation. Add
  source data, Engine support and Sheets UI together for a mechanic someone
  needs ([gaps](../../addon-dnd-2024-compendium/data/GAPS.md)).

## Watch for

These failed once and have not recurred:

- The Timeline page and a phone Settings load timing out at start-up (September).
- The planner canvas timing out before its first action (September).
- The rules service briefly reporting rules unavailable (September).
- The shared-controls and editors browser fixtures timing out at start-up in a
  full `npm run check` (October).
- Local Windows runs of the installed smoke test: Compendium uploads timing out
  and `net::ERR_NO_BUFFER_SPACE` while other heavy gates run, and a fixture
  upload once answering 500 "the add-on lifecycle request failed" (October).
  CI on Linux passed; capture the host log if it recurs.
