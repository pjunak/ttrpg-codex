# Homebrew content beyond items

**Status:** Undecided. The owner answers the questions below before the
expansion to subclasses and other kinds starts; the answers become an
[ADR](../decisions/) and the phases move to the [backlog](../BACKLOG.md). The
item editor itself is not blocked: its work is in the backlog's Next section.

**Last reviewed:** 2026-10-21

## Goal

One add-on for the DM's own D&D content: items first, then subclasses, then
feats, spells and the rest. Content is created in the add-on or imported in
bulk (the add-on page or the DM Tools Import Center), the editors should make
complete content easy, and the content is campaign data, never part of a
repository.

## What exists today

- `addon-dnd-homebrew` (D&D Homebrew Items 1.0.0): item classes and items as
  DM-only drafts; **Publish** flattens each item with its class into an
  `hb.<item id>` `magic-item` record; the worker serves the records as
  `dnd5e.rules-data` 3.0.0, which the Engine merges with the Compendium. See
  its [README](../../../addon-dnd-homebrew/README.md) and
  [design notes](../../../addon-dnd-homebrew/docs/DESIGN.md).
- Import format `dnd-homebrew-items` v1 (merge or replace) through the
  add-on's own adapter, so the Import Center accepts it too;
  `cmd/check-homebrew` checks a file offline before import.
- Content lives in the add-on's collections in the site database, so site
  backups include it and each campaign has its own. The repository holds only a
  neutral sample; the owner's Asurai card pack is in `homebrew-imports/` beside
  the repositories, like `character-imports/`.

## How more kinds fit

The Engine already loads `armor`, `background`, `class`, `feat`, `feature`,
`gear`, `magic-item`, `monster`, `skill`, `species`, `spell`, `subclass`,
`tool` and `weapon` records from every compatible provider
(`engineKinds` in `addon-dnd-engine/internal/provider/client.go`), and the
Builder lists subclasses by `classId` across providers. A homebrew subclass
therefore needs no Engine or Sheets change when it is served as:

- one `subclass` record: `classId` of a Compendium class, `subclassLevel`,
  `features` (`level`, `id`, `name`), optional `spells`, `grants`,
  `activations`, `text`;
- one `feature` record per feature: `classId`, `subclassId`, `level`,
  `localId`, `text`, optional `excerpt` and `grants`;

in the Compendium's record shapes
([SCHEMA.md](../../../addon-dnd-2024-compendium/data/SCHEMA.md)), with `hb.`
ids so they never collide with another provider.

Each kind would follow the item pattern: a DM-only draft collection, an editor,
publishing into `homebrew_published` (generalized from `magic-item` to any
kind), a section of the import format, and validators in Go and TypeScript
sharing fixtures. What differs from items:

- Feature grants use the whole feature vocabulary (choices, always-prepared
  spells, AC formulas, attack modifiers, activations that spend resources),
  far more than the item allowlist. The Engine applies what it knows and leaves
  the rest inactive, so Homebrew must decide what it validates and edits.
- A subclass editor needs the Compendium's classes, and good spell and feat
  pickers need its records: the add-on's browser code must read
  `dnd5e.rules-data` as well as provide it (planned for items in the backlog).

## Questions for the owner

1. **"Item class" next to D&D classes.** Homebrew groups items in *classes*
   (`homebrew_classes`, `classes` and `classId` in the file). Subclass records
   use `classId` for a D&D class, so the word would mean two things. Rename the
   grouping (for example *item set*: `homebrew_sets`, `sets`, `setId`) before
   the add-on is first installed, when it costs only code, or keep the stored
   names and rename it only in the interface? After an install, renaming stored
   names means Export, **Remove data and update**, and import again.
   *Recommendation:* rename now, before the Asurai install.
2. **One add-on or several.** One "D&D Homebrew" add-on (id `dnd-homebrew`
   unchanged) with one Publish and one import format with a section per kind,
   or a separate add-on per kind? *Recommendation:* one add-on; the provider,
   publish revision, gallery and import adapter are shared, and the add-on
   stays optional as a whole.
3. **How far the subclass editor goes.** (a) Start with subclasses whose
   features are text, plus the common structured grants (proficiencies,
   resistances, limited uses, always-prepared spells, advantages, senses and
   speed), and let a file carry anything else the Compendium schema allows;
   or (b) build an editor for the whole feature vocabulary first.
   *Recommendation:* (a), adding editor sections when a real subclass needs
   them.
4. **Magic weapons and armor.** "+1 longsword" needs the Engine to know that a
   magic item is a weapon or armor of a base type and to add its attack,
   damage or Armor Class bonus. Neither the Compendium nor the Engine
   automates this today; it is Engine work first (contract, Compendium data,
   sheet display), then a Homebrew field. Do it, and before or after
   subclasses?

## Phases once decided

1. **Item editor** (backlog Next): pickers from the rules data, and the item
   fields the Engine already reads (weight, cost, attunement prerequisites,
   containers).
2. **Several kinds in one publish:** published records keyed by kind, the
   provider's catalog counting each kind, the format at version 2 with the
   rename from question 1, and the checker and Import Center following.
3. **Subclasses:** draft collection with features nested, editor (class
   picker, subclass level, features by level with text, excerpt and the grants
   chosen in question 3), flattening into `subclass` and `feature` records
   checked against the Compendium schema and the Engine's subclass rules, and
   an installed test that picks a homebrew subclass in the Builder.
4. **Feats and spells:** simpler records; homebrew spells join class lists
   through `classes`.
5. **Species and backgrounds:** origin choices and ability rules; later.
6. **Campaign bundles:** a `codex.campaign-bundle-contributor` so a bundle can
   carry homebrew drafts with the rest of a campaign.
