# Character building and play

The host owns profiles, portraits and campaign relationships. Character Sheets
adds a rules-calculated workspace with a vertical left rail: Sheet, Combat,
Spells, Builder and Tools. Tools sits at the bottom, with Builder just above it.
The workspace is capped at 1,120 px; Compact uses denser ability cards and keeps
currency next to inventory. The host character heading is not repeated. When
space is too narrow relative to text size, the vertical navigation stacks above
the sheet so enlarged text and recovery controls remain readable.

The next user-directed workspace design is tracked in
[T63 in the suite backlog](../BACKLOG.md#t63-character-sheet-design), including
Equipment, body/hand placement and revised Sheet/Combat layouts. It is planned
work; the behavior described here remains the current implementation contract
until its owning changes and installed acceptance land.

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
play state is preserved. Sheet and Combat share an authored Inspiration checkbox,
with automatic saving even for legal unfinished builds. Rest and recalculation
preserve it; saved print/export includes its current availability. Quick use
pins owned inventory entries in a shared Sheet/Combat panel. Use one spends the
actual quantity through an atomic worker command, without applying item effects.
Stored/depleted entries and their pins survive; unpinning keeps inventory,
while deleting an entry also removes its pin. Print/export retains those values.
Named storage containers group carried/stored instances, including depleted
entries. The Backpack editor creates, renames and removes groups; inventory and
the existing item picker share destination options. Removing a group keeps its
items, and equipping explicitly clears membership. These groups add no physical
items or carrying-capacity rules. Their names and contents remain readable in
saved output and print without a rules provider. The final Equipment tab and
searchable floating Backpack dialog remain T63 work.
Inventory,
equipment, currency, HP, spells and resources remain editable in their ordinary
tabs, without an edit-mode toggle. Character notes belong to the host profile and have no sheet tab or printed sheet section.
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
New attunement selections require equipped items. Existing carried/stored
allocations stay visible, count toward capacity, and survive ordinary moves.
**Stow & unattune** moves the same instance to Stored and releases its allocation
in one autosave; it preserves quantity, provenance, grants and notes.

Tools contains the only export option, plus reviewed import, printing, layout,
and rules status. A transfer contains the current character only. Import
requires exact replacement confirmation and reauthorization of imported DM
grants; their acquired choices, spells, spent counters and item links retain the
same values under fresh authenticated identities. File and paste use the same
limits, with correctable local errors kept inside the dialog. Print uses the
saved projection and includes origin, class/level and currency by default.

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

Install the host with worker-only extension and compatible schema-review support
before the updated sheet ZIP. The permanent namespace and schema version remain
unchanged, but optional Inspiration changes the closed schema hash. Materialized
installations must disable Sheets, review and apply saved-data compatibility for
the inspected package, then review and activate it. The metadata-only upgrade
preserves existing JSON and character revisions without adding defaults. See the
[owning upgrade contract](../../../addon-dnd-character-sheets/docs/RULES_EDGE_CASES.md#inspiration-and-compatible-schema-upgrades).
Existing archived snapshots and prior installation backups are not erased,
exposed by the character service, or extended by new character saves.

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
losing the current item. The
[session transfer and output cases](../../frontend/test/browser/installed-character-output-fixture.mts)
exercise advancement, equipment, HP, granted casts/rests, reload, real export,
review cancellation/replacement and saved printing as a continuous journey.
They also check player authorization and frozen output after provider removal.
The [multiclass provider sessions](../../frontend/test/browser/installed-character-multiclass-provider-fixture.mts)
combine Fighter/Warlock/Wizard progression, distinct spell pools, amended and
withdrawn grants, selected-source loss, incompatible/stale providers, recovery,
rest and level-up. Both locales retain exact saved inputs and readable print/
export output when providers are unavailable. First-import cases verify complete,
localized review groups and cancellation without writing an empty sheet.
Future work belongs in the [suite backlog](../BACKLOG.md).

## Retirement and data implications

The [offline retirement procedure](CHARACTER_SHEET_CUTOVER.md) applies only to
retired pre-schema-4 data. It does not remove current characters or archived
snapshots. The [legacy converter](LEGACY_CONVERSION.md) preserves its input
backup and omits retired sheets while keeping core character profiles.
