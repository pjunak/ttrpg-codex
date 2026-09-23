# Character building and play

The host owns profiles, portraits and campaign relationships. Character Sheets
adds a rules-calculated workspace with a vertical left rail: Sheet, Combat,
Spells, Builder and Tools. Tools sits at the bottom, with Builder just above it.
The workspace is capped at 1,120 px; Compact uses denser ability cards and keeps
currency next to inventory. The host character heading is not repeated. When
space is too narrow relative to text size, the vertical navigation stacks above
the sheet so enlarged text and recovery controls remain readable.

<a id="character-model"></a>
<a id="f16-f19-and-f20-first-complete-play-slice"></a>
<a id="f18-rules-details-everywhere"></a>

## Building a character over a campaign

The Builder is the character's ordered progression. Character contains origin,
base abilities and origin choices. Levels shows overall progression. Each class
has its own tab for its levels and granted choices; the + tab offers additional
classes allowed by the rules. Earlier decisions can be changed later. DM given
has its own Builder tab. Progress starts expanded on the left; narrow screens
stack it above the form to preserve usable control widths.

All legal changes save automatically, including an unfinished build. Completion
is a separate rules gate for dependent play actions. Point-buy and granted
ability budgets show used and remaining points immediately; steppers enforce
bounds. Searchable dropdowns offer rule-eligible choices, exclude duplicate
selections and show nonblocking descriptions while browsing.

Changing an origin or level recalculates dependent results. Previously granted
choices withdrawn by that edit are removed; illegal new selections are rejected.
Reducing maximum HP clamps current HP; raising it does not heal. Other authored
play state is preserved. Inventory, equipment, currency, HP, spells, resources
remain editable in their ordinary tabs, without an edit-mode toggle. Character
notes belong to the host profile and have no sheet tab or printed sheet section.
Existing saved notes remain in the compatible stored schema and transfers.

<a id="transfer-and-printing"></a>
<a id="authoritative-mutation-path"></a>

## Saving and transfer

There are no character history, undo, restore, draft, or manual save controls.
The native worker provides `dnd5e.character` 2.0.0 and writes only current
schema-4 state. The host's `workerOnly` extension policy keeps browsers from
bypassing authenticated commands without retaining snapshots.

The engine remains stateless. `guidance.canSave` distinguishes a legal incomplete
build from an illegal value; `guidance.saveIssues` explains actual save blockers
without listing every unfinished choice. `ready` requires completion for play. Source
identity, saved projections and evidence remain explicit. DM grants require the
current DM's authority, and amendments/revocations replace/remove the current
grant instead of accumulating superseded entries.

Autosave coalesces input and serializes writes. Disjoint concurrent fields can
merge; overlapping edits stay pending with a visible conflict. Rejected values
stay editable with their save blockers. Retry reuses the exact uncertain request
before submitting newer edits, and Reload asks before discarding pending input.
Network failures never claim a successful save. Pending input stays in the open
page and the host navigation guard remains active until it is saved or explicitly
discarded. No device draft is written.

If a play action, DM grant or approved import loses its reply, further changes
pause and the same navigation guard stays active. Retry sends the exact action
again without duplicating its saved effect; imports keep their original approved
review. **Check saved character** asks before ending the retry, then reloads the
saved result without undoing any action. A failed check keeps recovery available.
When another editor has already changed the character, check that result before
deciding whether to repeat the action; commands do not merge automatically.

Empty inventory cannot remain equipped or attuned. Setting quantity to zero in
Sheets moves equipped items to carried and clears attunement in the same save.
The Engine owns eligibility, including active DM mechanics and grant expiry.

Tools contains the only export option, plus reviewed import, printing, layout,
and rules status. A transfer contains the current character only. Import
requires exact replacement confirmation and reauthorization of imported DM
grants; file and paste use the same limits. Print uses the saved projection.

Without compatible rules, saved values, printing and export remain usable.
Changed rules require explicit adoption in Tools before mechanical edits. When
an autosave discovers the change, **Review changed rules** opens that action
without discarding the pending input. **Adopt rules and save pending changes**
saves both deliberately, using the opening revision; another editor's changes
still produce a conflict. A successful acknowledgment re-enables editing, and
a lost acknowledgment retries the exact adoption rather than a fresh save.

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
permissions, play, transfer and responsive layouts. The
[command recovery cases](../../frontend/test/browser/installed-character-command-fixture.mts)
cover failed delivery, lost acknowledgments, repeated grants/imports, delayed
reads, concurrent edits and enlarged English/Czech phone recovery. The
[rules adoption cases](../../frontend/test/browser/installed-character-rules-recovery-fixture.mts)
cover a real worker rejection before a delayed lifecycle event, explicit pending-
input adoption, conflict protection and a lost reply. Forced generation replacement
remains separate from recovery in a mounted view. The
[conditional feat cases](../../frontend/test/browser/installed-character-conditional-feat-fixture.mts)
check repeated source choices, rejected duplicates, keyboard correction, dependent
withdrawal, independent ability increases and bounded DM grants through the same
Builder controls in English/Czech at 390 px and 200% text. The
[multiclass and attunement cases](../../frontend/test/browser/installed-character-multiclass-fixture.mts)
cover deeper progression, separate Pact/Spellcasting pools, per-class preparation,
source prerequisites, explicit DM waiver withdrawal and keyboard repair without
losing the current item. Future work belongs in the [suite backlog](../BACKLOG.md).

## Retirement and data implications

The [offline retirement procedure](CHARACTER_SHEET_CUTOVER.md) applies only to
retired pre-schema-4 data. It does not remove current characters or archived
snapshots. The [legacy converter](LEGACY_CONVERSION.md) preserves its input
backup and omits retired sheets while keeping core character profiles.
