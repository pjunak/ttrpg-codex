# ADR-0006: Homebrew content in one add-on, magic gear before subclasses

**Status:** Accepted

**Date:** 2026-10-22

**Decider:** Project maintainer

## Context

The DM writes their own D&D content: items first (the Asurai card pack), then
subclasses, feats, spells and more. `addon-dnd-homebrew` (D&D Homebrew)
already handles items: DM-only drafts of item sets and items, a **Publish**
that flattens each item with its set into an `hb.<item id>` `magic-item`
record, and a worker that serves those records as `dnd5e.rules-data` 3.0.0,
which the Engine merges with the Compendium. Content is created in the add-on
or imported in bulk (its own page or the DM Tools Import Center), and it is
campaign data stored in the site database, never part of a repository.

The Engine already loads `armor`, `background`, `class`, `feat`, `feature`,
`gear`, `magic-item`, `monster`, `skill`, `species`, `spell`, `subclass`,
`tool` and `weapon` records from every compatible provider (`engineKinds` in
`addon-dnd-engine/internal/provider/client.go`), and the Builder lists
subclasses by `classId` across providers. A homebrew subclass therefore needs
no Engine or Sheets change when it is served as one `subclass` record plus one
`feature` record per feature, in the Compendium's record shapes
(`addon-dnd-2024-compendium/data/SCHEMA.md`) with `hb.` ids.

Two things were open: how much of the feature vocabulary the first subclass
editor covers, and whether magic weapons and armor ("+1 longsword") come
first. Neither the Compendium nor the Engine automates those today: the Engine
would need to know that a magic item is a weapon or armor of a base type and
add its attack, damage or Armor Class bonus.

## Decision

- One add-on, D&D Homebrew (id `dnd-homebrew`), holds every kind of homebrew,
  with one Publish, one provider, one publish revision, one gallery and one
  import format, `dnd-homebrew`, that gains a section per kind. It stays
  optional as a whole. A group of items is an *item set* (`homebrew_sets`,
  `sets` and `setId` in the file), so `classId` in homebrew records only ever
  means a D&D class.
- Each kind follows the item pattern: a DM-only draft collection, an editor,
  a public published collection that the one Publish writes under the same
  publish revision (`homebrew_published` for items;
  `homebrew_published_subclasses` holds each subclass with its features in one
  document, so a subclass is never served without them), a section of the
  import format, and Go and TypeScript validators that share fixtures. Served
  records use the Engine's record shapes with `hb.` ids.
- **Magic weapons and armor come first**, before any new kind. The Engine
  learns that a magic item is a weapon or armor of a base type with an
  attack, damage or Armor Class bonus; then the Compendium's data uses it,
  Character Sheets shows it, and Homebrew items gain the field.
- **The subclass editor covers the whole feature vocabulary** (choices,
  always-prepared spells, AC formulas, attack modifiers, activations that spend
  resources, and the rest the Engine applies), not just the common grants. Its
  forms are rendered from the Engine's grants schema with words from a word
  list, so a new Engine field is editable without editor code; grants are
  checked for shape, and the Engine judges meaning on the character. An
  import file still carries anything the schema allows.
- Order after magic gear: several kinds in one publish, then subclasses, then
  feats and spells, then species and backgrounds, then campaign bundles
  (`codex.campaign-bundle-contributor`) carrying homebrew drafts.

## Consequences

- One provider and one Publish serve every kind, so the publish revision and
  rules adoption on sheets stay one step for the DM.
- Magic gear is Engine contract work across four repositories before Homebrew
  can use it; it also automates the Compendium's own +1/+2/+3 items.
- A full-vocabulary subclass editor is a large editor. It has to mirror the
  Engine's feature grants exactly, in Go and TypeScript, and grow when the
  Engine's vocabulary does.
- Published records become keyed by kind, and the provider's catalog counts
  each kind; the `dnd-homebrew` format gains sections without breaking
  existing files.

The phases are in the [backlog](../BACKLOG.md).

## Alternatives considered

- Separate add-ons per kind: more providers, publishes and imports for the DM
  to manage, for no gain in isolation.
- Subclasses with only the common grants first, adding editor sections when a
  real subclass needs them: faster to a first subclass, but the owner wants
  complete subclasses editable without hand-written files.
- Subclasses before magic gear, or magic gear left as text: the owner wants
  +N weapons and armor applied on sheets first.
