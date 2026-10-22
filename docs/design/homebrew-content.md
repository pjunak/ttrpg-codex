# Homebrew content beyond items

**Status:** Undecided. Items and subclasses are built; the question below
(magic weapons and armor) is open, and the answers become an
[ADR](../decisions/) with the remaining phases in the [backlog](../BACKLOG.md).

**Last reviewed:** 2026-10-22

## Goal

One add-on for the DM's own D&D content: items first, then subclasses, then
feats, spells and the rest. Content is created in the add-on or imported in
bulk (the add-on page or the DM Tools Import Center), the editors should make
complete content easy, and the content is campaign data, never part of a
repository.

## What exists today

- `addon-dnd-homebrew` (D&D Homebrew 1.0.0): item sets and items as
  DM-only drafts; **Publish** flattens each item with its set into an
  `hb.<item id>` `magic-item` record; the worker serves the records as
  `dnd5e.rules-data` 3.0.0, which the Engine merges with the Compendium. See
  its [README](../../../addon-dnd-homebrew/README.md) and
  [design notes](../../../addon-dnd-homebrew/docs/DESIGN.md).
- Items carry weight, containers and who may attune, and the editor picks
  spells and classes from the Compendium.
- Subclasses: one DM-only draft per subclass with its features nested.
  **Publish** writes a `subclass` record (`hb.<id>`) and one `feature`
  record per feature (`hb.<id>.<feature id>`) in one document of
  `homebrew_published_subclasses`, served next to the items. Features and
  the subclass itself use the Engine's whole grants vocabulary, edited through
  forms rendered from the grants schema and checked against it in the browser
  and the worker. The installed test picks the sample subclass for a fighter
  and checks its skill, Hit Points, uses and toggle on the sheet.
- Import format `dnd-homebrew` v1 (merge or replace), with `sets`,
  `items` and optional `subclasses`, through the add-on's own adapter, so the
  Import Center accepts it too;
  `cmd/check-homebrew` checks a file offline before import.
- Content lives in the add-on's collections in the site database, so site
  backups include it and each campaign has its own. The repository holds only a
  neutral sample; the owner's Asurai card pack is in `homebrew-imports/` beside
  the repositories, like `character-imports/`.

## How more kinds fit

The Engine loads `armor`, `background`, `class`, `feat`, `feature`,
`gear`, `magic-item`, `monster`, `skill`, `species`, `spell`, `subclass`,
`tool` and `weapon` records from every compatible provider
(`engineKinds` in `addon-dnd-engine/internal/provider/client.go`), and the
Builder lists subclasses by `classId` across providers, so subclasses needed
no Engine or Sheets change. Each further kind follows the subclass pattern: a
DM-only draft collection, an editor, a published collection the worker serves
in the Compendium's record shapes
([SCHEMA.md](../../../addon-dnd-2024-compendium/data/SCHEMA.md)) with `hb.`
ids, a section of the import format, and validators in Go and TypeScript
sharing fixtures. Grants reuse the schema-driven form; spell and feat pickers
extend the optional `dnd5e.rules-data` reader (`src/references.ts`).

## Decided

- 2026-10-21, before the first install: a group of items is an *item set*
  (`homebrew_sets`, `sets` and `setId` in the file), so `classId` in
  homebrew records only ever means a D&D class.
- 2026-10-22: one add-on, "D&D Homebrew" (id `dnd-homebrew`), holds every
  kind of homebrew with one Publish and one import format, `dnd-homebrew`,
  that gains a section per kind. The provider, publish revision, gallery and
  import adapter are shared, and the add-on stays optional as a whole.
- 2026-10-22: the subclass editor covers the whole feature grants vocabulary
  from the start. Its forms are rendered from the Engine's grants schema with
  labels and hints from a word list, so a new Engine field is editable without
  editor code; grants are checked for shape, and the Engine judges meaning on
  the character.

## Questions for the owner

1. **Magic weapons and armor.** "+1 longsword" needs the Engine to know that a
   magic item is a weapon or armor of a base type and to add its attack,
   damage or Armor Class bonus. Neither the Compendium nor the Engine
   automates this today; it is Engine work first (contract, Compendium data,
   sheet display), then a Homebrew field. Do it, and before or after feats
   and spells?

## Remaining phases

1. **Feats and spells:** simpler records; homebrew spells join class lists
   through `classes`.
2. **Species and backgrounds:** origin choices and ability rules; later.
3. **Campaign bundles:** a `codex.campaign-bundle-contributor` so a bundle can
   carry homebrew drafts with the rest of a campaign.
