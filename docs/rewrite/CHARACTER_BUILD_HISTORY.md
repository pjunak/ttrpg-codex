# Character building and play

The host owns profiles, portraits and campaign relationships. Character Sheets
adds a rules-calculated workspace with six tabs: Sheet, Combat, Spells, Notes,
Builder and Tools. Compact and Classic layouts use the same inputs and results.

<a id="character-model"></a>
<a id="f16-f19-and-f20-first-complete-play-slice"></a>
<a id="f18-rules-details-everywhere"></a>

## Building a character over a campaign

The Builder is the character's ordered progression. Character contains origin,
base abilities and origin choices. Levels shows overall progression. Each class
has its own tab for its levels and granted choices; the + tab offers additional
classes allowed by the rules. Earlier decisions can be changed later.

All legal changes save automatically, including an unfinished build. Completion
is a separate rules gate for dependent play actions. Point-buy and granted
ability budgets show used and remaining points immediately; steppers enforce
bounds. Searchable dropdowns offer rule-eligible choices, exclude duplicate
selections and show nonblocking descriptions while browsing.

Changing an origin or level recalculates dependent results. Previously granted
choices withdrawn by that edit are removed; illegal new selections are rejected.
Reducing maximum HP clamps current HP; raising it does not heal. Other authored
play state is preserved. Inventory, equipment, currency, HP, spells, resources
and notes remain editable in their ordinary tabs, without an edit-mode toggle.

<a id="transfer-and-printing"></a>
<a id="authoritative-mutation-path"></a>

## Saving and transfer

There are no character history, undo, restore, draft, or manual save controls.
The native worker provides `dnd5e.character` 2.0.0 and writes only current
schema-4 state. The host's `workerOnly` extension policy keeps browsers from
bypassing authenticated commands without retaining snapshots.

The engine remains stateless. `guidance.canSave` distinguishes a legal incomplete
build from an illegal value; `ready` requires completion for play. Source
identity, saved projections and evidence remain explicit. DM grants require the
current DM's authority, and amendments/revocations replace/remove the current
grant instead of accumulating superseded entries.

Autosave coalesces input and serializes writes. Disjoint concurrent fields can
merge; overlapping edits stay pending with a visible conflict. Network failures
never claim a successful save. Pending input stays in the open page and the host
navigation guard remains active until it is saved. No device draft is written.

Tools contains the only export option, plus reviewed import, printing, layout,
and rules status. A transfer contains the current character only. Import
requires exact replacement confirmation and reauthorization of imported DM
grants; file and paste use the same limits. Print uses the saved projection.

Without compatible rules, saved values, notes, printing and export remain usable.
Changed rules require explicit adoption in Tools before mechanical edits.

<a id="implementation-sequence-and-ownership"></a>
<a id="verification-result"></a>

## Installation and validation

Install the host with worker-only extension support before the updated sheet
ZIP, then use the ordinary package review and activation lifecycle. The stored
schema and permanent namespace remain unchanged. Existing archived snapshots
and prior installation backups are not erased, exposed by the new character
service, or extended by new character saves.

See the [sheet save contract](../../../addon-dnd-character-sheets/docs/RULES_EDGE_CASES.md)
and [engine contract](../../../addon-dnd-engine/contract/README.md). The
[installed character suite](../../frontend/test/browser/installed-character.browser.mts)
checks real package installation, incremental saves, bounded controls,
permissions, play, transfer and responsive layouts. Future work belongs in the
[suite backlog](../BACKLOG.md).

## Retirement and data implications

The [offline retirement procedure](CHARACTER_SHEET_CUTOVER.md) applies only to
retired pre-schema-4 data. It does not remove current characters or archived
snapshots. The [legacy converter](LEGACY_CONVERSION.md) preserves its input
backup and omits retired sheets while keeping core character profiles.
