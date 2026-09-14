# Character decisions, history and rules explanations

This is the current character workflow across the host, sheets, engine and
content add-ons. It implements F13/F14/F16–F20 from the
[feature audit](FEATURE_PARITY_AUDIT.md); F15 old-sheet compatibility is retired.
Future work belongs in [the suite backlog](../BACKLOG.md).

## Product decision

A character is a record of decisions, possessions, play state and DM grants.
The sheet shows their calculated result under an identified rules revision.
Changing an earlier decision recalculates the affected values and identifies
later choices that need repair. Saving retains both the inputs and their
accepted result, so history remains readable without running an old engine.

There is one mechanical model across the **Compact** and **Classic** layouts.
Names, appearance and notes remain authored text. Current counters and recorded
rolls are inputs with rules-defined bounds; there is no unrestricted final-stat
editor or parallel manual mode.

Reusable homebrew belongs in a compatible, versioned source add-on. A DM can
also give one character a feat, reward, item or typed exception, with an
attributed reason and a visible **DM given** marker.

## Using the character workspace

| View | What it is for |
| --- | --- |
| **Sheet** | Compact/Classic ability cards, vitals, worn equipment and split backpack |
| **Combat** | HP, temporary HP, attacks, resources, rests and feature actions |
| **Spells** | Search, casting, preparation, copying and recorded replacements |
| **Notes** | Authored character notes, including when rules are unavailable |
| **Builder** | Progress rail, origin, abilities, class-level choices, spells and DM grants |
| **History** | Inspecting, comparing and restoring retained revisions |
| **Tools** | Layout, rules status, import, export and printing |

The restored presentation uses the same worker-authorized character model.
Calculated ability cards are read-only and expose saved explanations. **Edit
sheet** enables authored inventory and counter edits; the equipment picker
collects a quantity tray before adding a draft. Review and save still append
an exact revision.

To change a build, edit the decision, review the affected choices and values,
resolve blockers, then save a new revision. For example, replacing an early
feat can lower an ability and maximum HP or invalidate a later prerequisite.
Still-valid choices remain selected; invalid choices remain visible for repair.

Drafts survive ordinary reloads and failed saves in the same browser and editor
scope. Another editor's save does not silently replace a draft or change its
opening revision. Compare and explicitly rebase before trying again. A local
draft is separate from campaign history and is excluded from saved exports,
prints and installation backups.

English and Czech catalogs cover the controls. Authored names, source prose
and notes retain their original language. Build, Play, comparisons and print
share projection and formatting code; UI components do not implement rule math.

## Character model

Stable IDs connect these parts:

| Part | Stored meaning | Authority |
| --- | --- | --- |
| Build decisions | Creation method, recorded rolls, abilities, origin, ordered levels and choices | Authorized character commands |
| Acquisitions and grants | Item instances, paid spell acquisitions, extra feats and typed DM effects | Ordinary play permissions; authenticated DM for exceptions |
| Play state | Current/temporary HP, spent uses, currency, quantities, equipment, attunement and preparations | Bounded play commands |
| Rules context | Ruleset, engine/package identity, source policy and contributing record hashes | Explicit review and adoption |
| Projection and evidence | Calculated values, constraints, issues, source facts and explanations | Engine output saved with its inputs |

A choice's effective character/class level differs from its transaction time.
Correcting a level-2 choice today does not pretend it was edited in the past.
Recorded rolls are retained inputs: recalculation and restoration never reroll.

Possession and use are separate from the source that granted an item.
Recalculating a build does not recreate a consumed scroll, refund a paid copy,
erase item notes or heal a character. A review accounts for required changes to
play state instead of silently normalizing it.

### Revisions and reversibility

The host retains an append-only journal for each character lifetime. A saved
operation includes an operation ID, server actor/time, summary, input snapshot,
accepted projection and evidence. History is paginated; immutable payloads are
shared by hash rather than appended to an ever-growing character document.

- **Undo last change** reviews a complete restoration of the previous revision.
- **Change a decision** edits today's build and recalculates its dependencies.
- **Restore revision** compares with a saved revision and appends a new one.
  Build-only restoration is the default; play-only and complete restoration are
  explicit alternatives.

Build-only restoration preserves current play, notes and paid spell acquisitions,
including their consumed inventory and currency, except for reviewed constraint
corrections. It does not reverse another character's state or external campaign
events. DM grant differences still require DM authorization.

An exact historical projection stays viewable even if current rules would
calculate differently. Restoration evaluates the restored inputs under current
approved rules. It never moves the head backward, deletes intervening revisions
or silently installs a historical executable.

### Authoritative mutation path

The sheets add-on's native coordinator is the only writer of the retained
character extension. It provides `dnd5e.character` 1.0.0 and stores schema 4.0.0.
The engine is stateless: it computes detached results and does not own persistence.

Browser requests propose inputs. The server determines actor, role, accepted
projection and grant authority. Generic browser extension writes cannot bypass
the coordinator. Preview binds the exact candidate, current revision, actor and
rules/package identity; commit rechecks them before atomically saving the head,
history, audit and operation receipt.

Conflicts and stale reviews retain the draft. A completed operation can be
acknowledged after a lost response or worker restart without spending a resource
twice. An intervening saved head requires a fresh review. See
[coordinator semantics](../../../addon-dnd-character-sheets/docs/RULES_EDGE_CASES.md)
for exact limits and retry behavior.

History follows current core-record visibility. Deleting and recreating a core
record does not attach the previous lifetime's history. Backups retain every
reachable history payload; recovery appends retained heads rather than erasing
the journal. The [host history contract](RETAINED_ADDON_HISTORY.md) owns these
guarantees.

## Rules, dependencies and DM contributions

One deterministic evaluation supplies values and their explanations. Typed
prerequisites and effects cover supported mechanics; the UI does not execute
formula strings, infer rules from prose or branch on book names.

An incomplete choice produces an explicit unknown or blocker, not a plausible
zero or guessed selection. A ready character has passed supported machine
checks. It does not mean every sentence in every book is automated.
[Content coverage](../../../addon-dnd-2024-compendium/data/COVERAGE.md) identifies
implemented effects, narrative material and encounter exclusions.

DM grants record a stable ID, authenticated actor/time, reason, effective level,
optional condition/expiry and a typed effect or specifically waived constraint.
Awarding a feat does not automatically waive its prerequisites. Amendments retain
the revoked grant and create an attributed replacement; revocation uses the
same evaluation as granting. Conflicting absolute effects remain blockers.

Imported names, actors, timestamps, rolls and DM labels are external claims.
They cannot create local authority. A current DM must approve imported or restored
DM effects. The coordinator remints local grant identities and preserves their
links to imported items.

Homebrew packages declare the instance's ruleset support and stable record IDs.
They use the same source policy, typed effects and explanation contracts as
other providers. Duplicate `(kind, id)` records are rejected; installation order
cannot shadow another source. See [rules and sources](RULES_SOURCES.md).

## Missing or changed rules

Saved projections, history, notes, printing and export remain usable without a
compatible engine. Notes can create a revision with the frozen projection.
Mechanical creation, edits, play commands and restoration require rules.

A changed engine, content package or book policy needs explicit review and
adoption. Loading a character never adopts new rules. An old snapshot continues
to display its captured evidence; a link to a newer current entry is identified
separately.

## F18: rules details everywhere

A labeled rule term or explanation control opens shared contextual details.
The panel shows the summary, calculation or conditions, contributing sources
and DM effects. **Open full entry** is inside the panel. Intentional library
navigation remains a link with a separate details control.

The host owns the reusable presentation, safe Markdown and reference resolution.
The engine supplies explanations from the displayed revision; providers supply
explicit references and content. Ordinary unannotated prose is not automatically
linked. Missing, ambiguous, disabled and restricted sources have explicit states.

The interaction supports pointer previews, persistent click/tap and keyboard
activation, dismissal and focus return. Opening details does not save a choice
or abandon a draft. Integrated and isolated add-ons use the public contract.
See [rule details](RULE_DETAILS.md) for the interaction, reference types and
complete surface inventory across sheets, pickers, comparisons, compendium and
host articles.

## F16, F19 and F20: first complete play slice

| Area | Behavior |
| --- | --- |
| Attunement | The engine supplies eligibility, occupied slots and capacity. A reduced capacity retains owned items and blocks use until the attunement choice or an explicit DM exception is reviewed. |
| Senses | Names, ranges, units, conditions and contributing sources share one trait projection in Play, comparison and print. Unknown differs from absent. |
| HP | Current HP, derived maximum and temporary HP are distinct. Damage/healing clamp to known bounds; invalid direct input is rejected. A lower maximum previews any current-HP clamp; a higher maximum does not heal. |

Rests, recorded hit dice, feature activation, casting, copying and spell
replacement share the same engine evaluation and authority path. The
[engine contract](../../../addon-dnd-engine/contract/README.md) describes their
bounds, costs and ledgers.

## Transfer and printing

File and paste accept only `dnd-character.v1` / schema 4.0.0. They share strict
parsing and replacement review. Selecting, pasting or reviewing never writes.
Applying a reviewed import creates a local revision and retains the previous one.

Transfers have a 1 MB envelope and 180 KB input limit. Exports may include up to
five recent snapshots within that envelope; oversized archives require fewer
revisions. External history is displayed separately and never spliced into the
installation's audit trail. Only the main inputs enter the authenticated import.

Without rules, the original transfer can remain a frozen device copy. It stays
exportable until explicitly discarded, including after a reviewed import.
Keep the file when changing browsers or devices: device copies are not included
in installation backups. Full backups preserve the complete server journal.

**Print / Save as PDF** uses a selected saved revision and never calls the engine.
It includes revision/rules status and DM markers, with optional long sections and
build/source details. Unsaved edits are excluded. Browser printing provides
A4 and Letter output. The package owns its presentation; there is no external
renderer service.

## Implementation sequence and ownership

The original five-stage implementation is complete. The current ownership is:

| Owner | Contract |
| --- | --- |
| Host | Record access, atomic retained history, receipts, backups and shared rule details |
| Sheets | Authenticated character commands, drafts, Play/Build/History, transfer and print |
| Engine | Typed decisions, calculation, prerequisites, effects, constraints and explanations |
| Content providers | Complete rules profiles, record facts, stable identity and provenance |

Public Go models generate the schemas and TypeScript types. Changing those
contracts requires compatible producer/consumer updates, their full checks and
rebuilt packages inspected by the host. Source edits reach a running installation
only through reviewed package activation.

Snapshot history avoids depending on obsolete command replay. This choice was
informed by the schema-evolution tradeoffs in
[Microsoft's event-sourcing guidance](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing).
The UI uses [GOV.UK validation](https://design-system.service.gov.uk/patterns/validation/)
and [review patterns](https://design-system.service.gov.uk/patterns/check-answers/)
with concise [status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).
The detailed accessibility basis belongs to the shared rule-details reference.

## Retirement and data implications

F15 is an approved retirement. The old hand-filled formats, raw-object guessing
and old public engine handlers are removed. The unrelated offline campaign and
DM Tools conversion remains supported.

An installation with the old materialized sheet schema needs the
[offline retirement procedure](CHARACTER_SHEET_CUTOVER.md) before activating
schema 4. The procedure documents its exact deletion scope, backup verification
and refusal checks. It is separate from ordinary development or deployment.

The owner's decision about old sheet data does not authorize pruning new
character history, deleting campaign records or discarding source backups.
Unsupported future schemas fail explicitly.

## Verification result

The September 11 implementation acceptance recorded passing full checks in all
four affected repositories, relevant Go race tests, three package inspections,
24 installed companion browser cases and all 33 host release gates. These are
dated acceptance results, not a substitute for validating a later change.

The tests cover creation, dependency changes, review/commit, comparison and
restore, concurrent drafts, lost-response retry, recovery, transfers, DM
authority, source adoption and provider loss. The installed class matrix checks
each supplied class at levels 1, 5 and 20; it does not prove every possible build.
Focused rules tests cover copying, acquisition-level choices, replacement
budgets, recorded rolls and effect stacking.

A4/Letter and long-content Chromium output were visually inspected at acceptance.
Physical touch devices, a human screen-reader pass and actual printer output
remain manual boundaries. No deployment or offline data retirement is performed
by these development checks.
