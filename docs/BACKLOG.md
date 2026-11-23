# Backlog

The only task list for the host and the five first-party add-ons. Reference
docs describe what exists; this file says what to do next. Delete an entry when
it is done (Git keeps the history) and update the reference it changes.

Development work only. Campaign content (characters, homebrew imports, session
prep) and installing or updating add-ons on the sites are the owner's and are
never tracked here or in `docs/plans/`.

**Entry format.** A bold title, the affected repositories in backticks, then
what and why in one or two sentences. Add **Done when** if the finish line is
not obvious. Move an entry between sections instead of duplicating it.

| Section | Meaning |
| --- | --- |
| [Next](#next) | Agreed development work, ready to start |
| [Quality pass](#quality-pass) | Agreed fixes and cleanup from the full review, worked stage by stage |
| [Undecided](#undecided) | The owner is still deciding; do not start |
| [Later](#later) | Worth doing when the area is next touched |
| [Ideas](#ideas) | Only with a concrete need |
| [Watch for](#watch-for) | Failures seen once; reopen with a fresh log |

## Next

- **Source-text book spot-check** `addon-dnd-2024-compendium` — Needs the
  printed PHB. Check glamour Mantle of Majesty's "…cast Command as a Bonus
  Action without expending a spell slot." (the stray comma became a full stop;
  confirm nothing was cut), the lightly/moderately-armored Shields swap, Shield
  Master's Strength-only increase, Weapon Master's removed Martial-proficiency
  grant, and the soulknife Rend Mind "use you[r]" and ritual-caster
  "spelicasting" typos. Five rules tables (`dmg-guide-awarding-magic-items`,
  `dmg-guide-mobs` twice, `dmg-guide-traps`, `phb-guide-exploration`) have
  group headings spanning columns that Markdown cannot show; rebuild them from
  the book.
- **Compendium translation overlay size** `addon-dnd-2024-compendium` —
  `data/i18n/` overlays load and apply in the browse UI, and rules-data
  consumers can query `kind: "i18n"`. One overlay is one record, capped at
  2 MiB, while all English `text` is about 3.1 MB, so a full translation does
  not fit; allow several records per language (or raise the cap for them).
  `excerpt` is not translatable yet. Language packs already store `content`
  overlays but apply nothing; lend a pack's content to its add-on so the
  Compendium can ship translations as packs.
- **Character sheet refinement** `addon-dnd-character-sheets` — Compact has
  per-tab context bars, pips and floating windows; the owner keeps refining it.
- **Powerful Build carrying grant** `addon-dnd-2024-compendium` — Engine 6.5.0
  scales carrying capacity by size and reads `grants.carryingSizeSteps`. After
  the Engine is pushed and released: bump the Engine pin in
  `tools/engine-grants.mts`, run `npm run sync:engine-grants`, add
  `"grants": {"carryingSizeSteps": 1}` to `data/phb/species/goliath.json`,
  document the grant in `data/SCHEMA.md`, and optionally declare
  `constants.carrying.sizeMultipliers` in the 2024 ruleset (the Engine
  defaults to ×½/×1/×1/×2/×4/×8).
- **Companion map on a device** `ttrpg-companion` — The native map viewer
  (host tiles, location pins, event paths, offline tiles) builds and passes
  its unit tests but has not run on a phone. Check gestures, tile loading,
  pins and labels, offline viewing and TalkBack against a real site, then
  delete this entry.
- **Companion character sheet on a phone** `ttrpg-companion` — The native
  sheet over `dnd5e.character` (header, five tabs, the phone's copy, "My
  character") is built and passed an emulator check against a throwaway host.
  Check it on a phone against a site with host 2.2.0 and Character Sheets 6.x,
  then delete this entry. Known rough edges: the fixed header takes most of a
  small or landscape screen; opening a sheet loads it twice (the event
  stream's `hello` reloads it); a rules policy change reaches an open sheet
  only when its screen returns.
- **Companion campaign copy and roles** `ttrpg-companion` — The campaign copy
  on the phone is kept without the role it was read under, so a site whose
  session ended or changed role can still show the earlier role's copy while
  offline. Keep the role with the copy as the sheet copies do.
- **Long rest and Exhaustion** `addon-dnd-engine` — A long rest restores hit
  points, temporary hit points and active features but leaves conditions as
  they are, so Exhaustion keeps its level; the 2024 rules lower it by one.
- **Czech "History"** `addon-dnd-character-sheets` — `locales/cs.json` has
  every skill name but History, so the Czech sheet shows it in English (the
  companion says "Historie").

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

- **Split the remaining large UI files** `ttrpg-codex`, `addon-dm-tools` —
  Split `campaign-record-editor.ts` (field descriptors, parsing, relationship
  planning), the article and collection views out of `codex-record-page.ts`,
  `codex-map.ts` (one panel state, layers, search), the vocabulary editor out
  of `codex-settings.ts`, and DM Tools' `planner-element.ts` (canvas, forms,
  commands, draft session).

## Undecided

> **The owner is still figuring out what to do with these.** Leave their UI and
> data model as they are: no redesigns, migrations or "quick fixes" until a
> decision is recorded here or as an [ADR](decisions/). Bug fixes that keep
> current behaviour are fine.

- **Knowledge and investigation model** `ttrpg-codex` — Mystery clues (many
  are bare event keys) and characters' *open questions* / *what is known* (also
  shown in Mind Palace and the unanswered-questions list). Current behaviour,
  known problems and the questions to answer are in the
  [design note](design/knowledge-and-investigation.md).
- **Previous add-on build after updates** `ttrpg-codex` — Cleanup removes the
  old build and its recovery data right after an update, so only a full backup
  can undo damage done by the new version. Decide whether to keep one previous
  build one update longer.
- **Reordering twin records on the timeline** `ttrpg-codex` — Moving an event
  moves only the DM side of a twin pair, so players keep the public twin in its
  old session. Decide whether both should move.

## Later

- **Spell duration wording** `addon-dnd-2024-compendium` — Durations are
  worded unevenly: Bless reads "Concentration, up to 1 minute-" with a stray
  dash, others "Concentration up to 10 minutes" without the comma. Clean the
  data when the spells are next touched.
- **Language pack gaps** `ttrpg-codex` — Packs translate browser catalogs
  only: pack-translated manifest texts (names, labels) do not reach the add-on
  manager, and add-ons uploaded as ZIPs without a GitHub link get no packs.
  First-party add-ons publish packs only once they need a third language
  ([how](../examples/addons/AUTHORING.md#language-packs)).
- **Theme Mind Palace** `ttrpg-codex` — Mind Palace keeps Classic colours in
  `relationship-graph.css` (exempt from the style check) and in
  `campaign-graph*.ts`, so Moonlit shows it brown. Move them to tokens once its
  design is decided.
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
- **Markdown reference links for add-ons** `ttrpg-codex` — The Compendium ships
  its own Markdown renderer because the host's Markdown component shows add-on
  references only as rule-detail popovers, never as in-place links. Lend a
  reference-resolver hook through the SDK.

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
- **Context menu for add-ons** `ttrpg-codex` — Lend the record context menu
  to add-ons through the SDK so they can add actions (a public contract
  change).
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
