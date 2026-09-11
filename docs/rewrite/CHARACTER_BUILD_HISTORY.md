# Character decisions, history and rules explanations

Updated September 11, 2026. **Design and implementation plan; not implemented.**
This specification revises F13–F20 in the [feature audit](FEATURE_PARITY_AUDIT.md)
according to the owner's new character-sheet direction. Execution status lives
only in [BACKLOG.md](../BACKLOG.md#feature-parity-audit-follow-up-2026-09-11).

## Product decision

The character is an editable record of decisions, acquisitions and DM grants.
The playable sheet is the calculated result of those inputs under an identified
rules revision. Changing an earlier decision recalculates all affected results
and exposes any later choices that need attention. Every committed change can
be inspected, compared and reversed without erasing what happened.

This replaces the previous hand-filled-sheet/optional-Builder product model.
There will be no parallel manual mode, arbitrary final-stat editing, or legacy
sheet compatibility. The owner explicitly confirmed that old sheet data has no
preservation requirement. Descriptive names, appearance and notes remain authored
text; current counters and recorded rolls are inputs with rules-defined bounds.
“Calculated” does not mean inventing a formula for narrative information.

The engine remains an optional installed service: saved characters remain
readable, printable and exportable without it. Validated creation, build changes
and rules-dependent play actions require compatible rules. Provider absence
does not switch a character into an unrestricted manual rules model.

Homebrew content belongs in compatible, versioned source add-ons. A DM can also
grant a particular character an item, feat, boon or explicit mechanical
exception. These are identifiable contributions, with the granting actor and
reason, and participate in the same calculations and history.

## Revised F13–F20 decisions

| Finding | Revised outcome | Dependency |
| --- | --- | --- |
| F13 — Printing/PDF | Print a selected saved character revision, with optional spells, equipment, notes and build/provenance appendix. Browser print provides PDF output. | Shared projection and presentation model |
| F14 — Import review/undo | File and paste share strict current-format validation and exact replacement review. Replacement creates a revision; restore uses the same history workflow. | Revision storage, authority and change review |
| F15 — Old sheet compatibility | Explicitly retire it. No old envelope reader, raw-object guessing, converter, old renderer or dual storage model in the new sheet. | Targeted cutover accounting, not a compatibility implementation |
| F16 — Attunement | Derive eligibility, occupied slots and capacity; enforce normal rules through one operation path. Extra capacity or waived prerequisites require an explicit DM grant. | Typed effects, inventory identity and bounded play commands |
| F17 — Manual/reconciliation guard | Replace the old proposal with reversible build decisions, derived projections, DM adjustments and reviewed rules revisions. | Foundational work across host, sheets, engine and content |
| F18 — Rule links/explanations | Shared contextual details wherever rules appear, including all affected suite surfaces. Every computed value has a structured explanation. | Source references and calculation explanations designed from the start |
| F19 — Senses | Render derived senses, distances, units, conditions and source explanations consistently in Play, comparisons and print. | Shared trait projection |
| F20 — HP bounds | Separate current HP, effective maximum and temporary HP. Apply one rules-owned bounds policy to every edit; preview consequences of maximum changes. | Derived limits and revisioned play state |

F17 and the explanation contract in F18 are now foundations, rather than patches
after restoring isolated controls. F16, F19 and F20 provide the first complete
vertical slice. F13 and F14 then consume the same revision/projection model.
F06, F12 and the other deferred extensions stay outside this session.

## Current foundations and confirmed gaps

The inspected source already provides useful boundaries:

- [SheetRepository](../../../addon-dnd-character-sheets/src/sheet-repository.ts)
  owns optimistic extension writes; the editor retains failed drafts. Reuse its
  sequencing and conflict UX, while replacing unrestricted whole-state writes.
- [Sheet state](../../../addon-dnd-character-sheets/src/sheet-state.ts) currently
  mixes decisions, manual values, play state and snapshots. The new schema must
  separate those responsibilities instead of adding more override flags.
- [Engine materialization](../../../addon-dnd-character-sheets/src/engine-client.ts)
  already saves fallback results and source identity. It is not a history store
  or a complete explanation model.
- [Engine contracts](../../../addon-dnd-engine/contract/README.md) provide pure
  calculations, Builder guidance and detached play operations. Guidance is
  explicitly advisory, not a complete legality validator. Current
  [reconciliation](../../../addon-dnd-engine/internal/rules/builder.go) removes
  choices that no longer fit; the new change plan must account for them visibly.
- [Content fields](../../../addon-dnd-2024-compendium/data/SCHEMA.md) already
  describe generic grants, choices, modifiers, senses and attunement. Some
  prerequisites/mechanics remain prose, as recorded in
  [GAPS.md](../../../addon-dnd-2024-compendium/data/GAPS.md). They cannot be
  presented as automatically checked.
- [Host add-on data](ADDON_DATA.md) supplies schema validation, transactions,
  revisions and actor audit metadata. Its audit records retain revision numbers,
  not past document bodies. Public data access also does not distinguish an
  ordinary player edit from creating a DM grant. Both require explicit new
  server-enforced contracts.
- [Source policy](RULES_SOURCES.md), [package lifecycle](PACKAGE_LIFECYCLE.md)
  and [wiki references](../../examples/addons/API_V3.md#wiki-references-and-library-search)
  already own eligibility, version identity and safe route resolution. Extend
  these public boundaries; do not probe companion IDs, package paths or host DOM.

These are source-level findings. No live campaign or installed site was inspected
for this plan. Existing source contracts remain current until implementation;
their hand-editing guarantees are deliberately superseded by this target design,
not silently changed by publishing this document.

## Character model

Use five explicit parts, with stable identifiers connecting them:

| Part | Contents | Who changes it |
| --- | --- | --- |
| Build decisions | Creation method and recorded rolls, base abilities, origin/species/lineage, background, ordered class levels, subclass, choices, feats and learned abilities | An authorized editor through validated commands |
| Acquisitions and DM grants | Item instances and acquisition source; extra feats, rewards, bounded adjustments and prerequisite waivers | Ordinary acquisitions follow play permissions; only a server-authorized DM grants exceptions |
| Play state | Current HP, temporary HP, spent resources, currency, quantities, equipped/attuned instances, preparations and explicit self-condition toggles | Authorized play commands |
| Rules context | Ruleset, engine/package versions and hashes, effective source policy, contributing records and their revisions | Explicit adoption of a reviewed rules context |
| Projection and explanations | Effective statistics, available features, constraints, calculations, source chains and validation status | Engine output, committed with the inputs that produced it |

A choice has its own ID and granting source, plus its effective character/class
level. Transaction time and effective level are different: a correction made
today to level 2 must not pretend it was made in the past. Ordered multiclass
levels retain the context in which prerequisites and gains applied.

Record actual rolled results and generation method as inputs. Recalculation or
restoration never rolls again. A deliberate replacement roll is another recorded
decision. Starting defaults are visible proposals or explicit rule-mandated
results; blank choices must not silently become invented selections.

Separate grants from possession and use. Removing a build-granted item does not
rewind gold spent, recreate a sold item or erase annotations. Stable item/resource
identities allow the impact review to explain those consequences. Duplicate
grants retain all sources even when stacking rules yield only one effect.

### Revisions and reversibility

Use a character-scoped, append-only revision journal alongside the current head.
Each committed operation retains its parent revision, stable operation ID,
server actor/time, operation type, effective level if relevant, reason/source,
before/after references, input snapshot and the corresponding projection and
explanations. Build, grant and play changes share an ordered history but can be
filtered independently. A completed UI action is one entry; keystrokes are not.

Prefer retained immutable snapshots with structural sharing and semantic change
summaries. Historical reconstruction must not require running old engine code or
replaying obsolete commands. The saved revision is authoritative evidence of
what the app accepted then; reevaluation with a corrected engine is a new,
reviewed result. This is a bounded character feature, not a rewrite of the host
around event sourcing or an asynchronous projection service.

Keep large immutable payloads separate from the small current-head record;
history must not grow an unbounded array inside the existing 256 KiB document
limit. Reuse host transactions and immutable payload facilities with explicit
reachability, size limits and access checks. Paginate history and load comparison
details on demand. Never silently truncate committed history. If a configured
storage limit prevents a safe append, preserve the draft and explain the failure.
History queries must page by character/revision without scanning unrelated
characters or becoming inaccessible beyond the current generic query scan limit.

The host must enforce append-only writes, actor attribution, parent/core-record
identity and atomic head advancement. Reusing a deleted core character ID cannot
attach another character's history. History inherits current record visibility;
plain add-on collections or guessable blob URLs must not expose hidden revisions.
Current backups must include all revision payloads and referenced character
evidence. Removal and future garbage collection must respect these references.

Provide three distinct actions:

1. **Undo last change:** append a reversal against the acknowledged current
   revision. An uncertain network result is resolved by operation ID; a retry
   must not duplicate a grant or spend.
2. **Change this decision:** edit an earlier choice within today's build and
   review the new dependent results. This is a respec, not a rewind of play.
3. **Restore revision:** compare a saved revision with the current one, then
   append a new revision referencing it. Never move the head backward or remove
   intervening history. Offer build restoration by default; restoration of play
   state or the complete sheet is separately and clearly scoped in the review.

A build-only restore preserves current play state except for explicitly reviewed
constraint corrections. Restoring old play state never reverses external campaign
events or another character's inventory. Selective reversal cannot be a blind
inverse patch when later changes depend on it; it uses the same impact planner.
DM-only effects remain protected during import and restore as well as direct edits.

An exact old snapshot always remains viewable. If its rules context is unavailable
or no longer eligible, it can be recovered as a visibly frozen historical state;
it cannot claim current rules validation or enable rules changes. Returning it to
active play requires a valid preview under currently available, approved rules.
No historical executable is silently installed or run to satisfy restoration.

### Authoritative mutation path

The sheet owns domain commands and persistence orchestration; the engine remains
stateless and owns computation. Implement the authoritative sheet coordinator in
a package-owned Go worker, using host-issued actor metadata and the brokered
engine. Browser input proposes a change, never its trusted actor, permission,
validation result or final computed projection.

This requires a narrow host extension for command-authorized, retained-revision
writes. Existing generic browser `put` must not bypass validation, replace the
projection, edit history or mint DM grants. Reuse the current worker broker,
transaction and record-access infrastructure; do not elevate a player request to
system authority merely because a worker made it. Keep the mechanism generic,
with all D&D policy in the engine/sheets packages. Read access can remain public
where the character is public without granting the same authority to write.

A review binds the exact candidate, current head and play revision, actor scope,
rules/content identity, source-policy revision and active generations. Apply
rechecks those dependencies before one atomic append/head update. Concurrent
edits or a provider replacement invalidate the review and retain the draft.
There is no success state where inputs, outputs and history describe different
revisions. F14 replacement, rest/cast operations and DM grants use this same path.

## Rules, dependencies and DM contributions

### Swapping a build decision

The engine returns a detached change plan containing valid options, constraints,
affected decisions, downstream effects, blockers and numerical before/after
results. Evaluate prerequisites at the correct acquisition level and process
dependencies in deterministic order. Detect cyclic or unsupported content and
report the responsible reference; never loop or guess a result.

For example, replacing an early feat can change an ability, a later prerequisite,
spell choices and maximum HP. Show all affected choices and values together.
Retain still-valid selections by stable identity. Explain invalid selections,
offer eligible replacements and retain removed selections in the draft/history.
Do not silently delete them, turn them into DM rewards or auto-pick substitutes.

Incomplete creation and respec work can be saved as a separate durable draft.
It does not replace the active playable revision until its blockers are resolved.
The review shows changed/removed mechanics and any required play adjustment,
with direct links back to each decision. Normal low-impact play edits can commit
directly with undo; build changes, imports, rules adoption and DM exceptions get
one proportionate review, not a stack of confirmation dialogs.

Draft recovery is character-specific, schema-versioned and revision-aware. It
must survive an ordinary reload and the accepted whole-browser-graph restart
limitation. Reuse host edit guards and draft recovery patterns; do not reinterpret
a saved draft as applied history or automatically overwrite newer server state.
Scope drafts to the authenticated editor and character, enforce current access
on recovery, and keep separate editors' drafts from replacing each other.

### What the engine must know

Expand the existing typed grants and modifiers only for concrete character
mechanics. A single deterministic evaluation produces both results and their
explanations: base inputs, applied/suppressed effects, stacking/alternative rules,
rounding, caps, conditions and final values. Selection of an AC formula is not
equivalent to summing all AC-looking fields.

Use structured predicates for supported prerequisites and typed effects for
numeric changes, proficiencies, senses, resources, spells and grants. No arbitrary
JavaScript, formula strings executed by the UI, feature-name recognition or
per-book branches. Unsupported mechanics stay visibly unsupported; prose is not
parsed into an authoritative rule. A rules-coverage inventory must distinguish
implemented character effects, narrative-only reference content and deliberate
combat/encounter exclusions.

Derived values carry a known value or explicit unknown state, units where
applicable, and constraints such as min/max, available counts or eligible sets.
An unfilled maximum is not zero. Display “Needs a choice” or “Rule not supported”
with a reason instead of a plausible default. Draft completion, machine-validated
rules, unresolved narrative prerequisites and DM-approved exceptions have
different statuses; never advertise “valid character” from a completion count.

All mechanical outputs exposed by the sheet must be covered before this redesign
is declared complete. Narrative prerequisites require a recorded DM adjudication
when they affect eligibility. Unsupported numeric effects need an explicit typed
DM adjustment or a content/engine implementation before affecting an active
result. Attack resolution against other creatures remains outside this scope.

### DM grants and homebrew modules

A DM grant records its stable ID, authenticated granting actor/time, reason,
effective level/date, optional expiry/condition, rule reference or local item
instance, and the typed effect or specifically waived constraint. Amendment and
revocation append new entries. History and affected values show **DM given**;
an ordinary rule choice cannot acquire that label from client-supplied JSON.
Time-dependent evaluation uses explicit recorded time/context inputs. Expiry or
activation changes create recorded transitions; replay never consults today's
clock and silently changes an old result.

Distinguish awarding an existing feat outside the normal choice budget from
waiving that feat's prerequisites: the first does not imply the second. Granting
a narrative trophy with no mechanics is allowed. A custom magical property must
use a supported typed effect, with a visible explanation. Competing absolute
overrides or incompatible effects require resolution; there is no hidden last
writer wins rule. DM adjustments participate at a defined evaluation stage and
respect caps unless a separate explicit exception changes the cap.

One-off adjudications do not require publishing an add-on. Reusable homebrew
definitions do: package them as additional sources declaring the instance's
ruleset support, with stable record IDs, versioned mechanics and provenance.
Reuse [rules/source policy](RULES_SOURCES.md), including pending-book review and
duplicate `(kind, id)` rejection. Do not shadow official records by install order.
Homebrew uses the same grants, prerequisites and explanations as official content.
The existing package workflow supplies version tracking; an in-sheet module
authoring platform is outside this scope.

### Rules version changes

Automatic propagation applies to decisions under the accepted rules context.
Installing a package or changing source selection does not silently recalculate
saved characters. Offer an explicit comparison, unresolved choices and **Apply
rules update**. The accepted update is a history entry even when only provenance
changes. Dismissed/unchanged notifications do not repeatedly interrupt play.

Durable provenance contains engine version/archive hash, service/schema versions,
ruleset identity/profile version, contributing packages and record identities,
content hashes/revisions and effective source choices. Generation and binding
revisions guard live requests; they are not substitutes for durable version IDs.
Historical explanations use their saved facts. A link to newer content is labeled
as newer, never presented as the source of an old calculation.

Store the bounded rule facts and explanation evidence needed for that character,
not entire rulebooks in every revision. Missing sources retain those saved facts
but do not authorize browsing a disabled book or making new selections from it.
Content deduplication and backup retention must preserve referenced evidence.

When rules disappear, retain the last projection, its evidence and pending drafts.
Allow notes and explicitly supported counter updates within saved known bounds;
mark them as using the saved rules snapshot. Do not refresh derived results from
a partial engine response. Complex actions needing unavailable rules remain
unavailable with a reason. Reconnection discovers a compatible provider and
reviews changed provenance instead of changing providers invisibly.

## Play, Build and History UX

Use three views of one character: **Play**, **Build** and **History**. Keep the
host character identity/profile and its navigation. Play prioritizes common
session actions; Build shows foundations and level progression with editable
decision summaries; History shows what changed, who changed it and why. Rules
status and DM-given indicators are shared, not duplicated into separate tools.

Reuse one decision editor, option picker, impact comparison, bounded counter,
source label, trait formatter and explanation renderer across layouts. Render
from typed descriptors with deliberate component types; avoid a generic form
designer or a separate hard-coded panel for each class/book. Compact and Classic
remain presentation preferences over the same semantics and commands.

Use labeled native controls, visible focus, keyboard-operable navigation,
non-color status cues, responsive reading order and English/Czech catalogs.
Show validation beside the affected choice and an actionable summary; preserve
input and focus when a preview refreshes. Announce concise save/change statuses
without reading the entire recalculated sheet on every update. The validation
and review approach adapts [GOV.UK validation](https://design-system.service.gov.uk/patterns/validation/)
and [check answers](https://design-system.service.gov.uk/patterns/check-answers/);
live feedback follows [WCAG status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

Offer eligible choices first, with an accessible way to inspect unavailable
options and their unmet requirements. A disabled picker item must not be the
only place its reason can be found. Preserve search/filter context when opening
rule details or returning from a review.

### F18: rules details everywhere

Use one shared **rule details** interaction for rule references and calculated
values. On a sheet, activating the labeled rule term or adjacent explanation
button opens a floating panel; it does not navigate. **Open full entry** lives
inside the panel. Existing intentional navigation links in a library remain
links, with a distinct details trigger; never nest a button inside another
interactive control.

The panel presents, in order: a short definition or rule summary, its relevance
to this character, the calculation/conditions when applicable, applied and
suppressed contributions including DM grants, and source/version plus full-entry
navigation. Explanations are structured engine output from the displayed
revision. Formatting is shared; formulas are never rebuilt in UI code.

Click/tap and Enter/Space open a persistent panel. Desktop hover/focus may offer
the same preview without moving focus; activation pins it and provides a
predictable focus path into its controls. Moving onto the panel keeps it open.
Escape and a visible close control dismiss it; closing an explicitly opened
panel restores focus when appropriate. Hover must not reopen a dismissed panel
until the pointer leaves and re-enters. Opening details never saves, selects a
build option or abandons a draft.

Because it contains links, this is an accessible non-modal details dialog, not a
`role="tooltip"` containing interactive elements. Use the native Popover API
where supported for presentation and dismissal, with explicit naming and focus
behavior. On a narrow screen, the same content can use a modal details sheet with
contained focus and an explicit close action. Keep one details surface open;
follow related references within it rather than stacking popovers.

This applies the [WCAG hover/focus requirements](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).
The [APG tooltip guidance](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)
distinguishes non-focusable tooltips from interactive dialogs; that APG pattern
is advisory and marked work in progress. Native popover behavior is described
by [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using).
Use comfortable touch controls and satisfy the 24 CSS-pixel minimum or applicable
spacing exceptions in [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

F18 includes Play, Build option/choice previews, equipment and spell pickers,
rest/resource reviews, History comparisons, compendium/bestiary rule content,
and rule references in host-rendered articles or other participating add-ons.
Print converts this information to readable source notes/optional explanations.
Generic UI help need not masquerade as a rules reference.
Provider prose uses explicit structured references for rule terms and related
content; do not auto-link arbitrary matching names. The F18 surface inventory
must include missing content references as well as missing UI controls.

Extend the public typed reference/resolution contract to carry stable rule
identity, bounded summaries and revision-aware provenance. Reuse host-validated
route descriptors, role/source filtering, cancellation and generation caches.
The host owns the reusable details presentation and safe Markdown rendering;
providers supply content, the engine supplies character explanations. Add-ons
receive a public capability, not a private resolver import. Integrated and
isolated supported consumers must have equivalent behavior through their public
boundaries. Missing, ambiguous, disabled or restricted references show a clear
status and saved authorized evidence; never guess a URL or a similarly named rule.

### F16, F19 and F20: first complete play slice

- **Attunement:** show occupied/effective capacity beside the item list, including
  why an item is ineligible and the source of the limit. All attune/unattune paths
  use the same rules command. If a build change reduces capacity, keep the items
  and review which attunements end, or a DM capacity adjustment. Extra ownership
  does not automatically mean extra attunement.
- **Senses:** share names, distances, units and conditional/suppressed effects
  across both layouts, history and print. Show the granting source and distinguish
  no special sense from an unknown calculation. Do not sum ranges when rules
  specify taking the greatest one.
- **HP:** current HP is bounded play state; effective maximum is derived;
  temporary HP is separate. Healing, plus/minus, direct entry, rest, import and
  restore share the rules-owned validator. At a known 20/20, ordinary healing
  cannot save 21/20. A build change to maximum 15 previews 20 → 15 current HP and
  records both changes atomically. Increasing the maximum does not silently heal
  unless the rule/operation explicitly does. Damage/healing commands can apply
  rule-defined clamping; invalid direct input shows the correction before save.
  Unknown limits disable dependent actions with an explanation. Exceptions must
  appear as specific DM effects, not an unrestricted numeric bypass.

## Transfer and printing

F14 supports only the new documented versioned export. File and paste share
bounded parsing, schema validation and one section-level comparison. Preview
identifies the target character, removed/replaced sections, rules availability,
DM effects and history handling. Neither selecting a file nor viewing the preview
writes. Apply is bound to the exact reviewed bytes and current revisions.

An export contains decisions, play state, saved projection/evidence and an
optional bounded archive of its history. It does not contain credentials,
executable packages or unrelated book contents. Imported history is labeled
external provenance; its claimed actors/DM grants are not local authorization.
A DM must approve imported DM effects. Recalculate imported mechanical inputs
under approved available rules before activating them; unavailable rules permit
a labeled frozen import/draft, not trusted live calculations. Oversized histories
use a bounded archive format, not a larger unrestricted JSON text box.

Replacing a sheet retains its previous revision and makes the import a new local
entry. Imported external history cannot splice into or rewrite local audit
history. Export/import fidelity and current-backup round trips are separate
acceptance checks. There is no silent character merge or promise that JSON export
substitutes for a complete installation backup.

F13 offers **Print / Save as PDF** from a selected saved revision with a preview.
Use the same projection, formatting and source labels as Play. Include revision,
rules status and DM-given markers; optional long sections and a build/history
appendix are explicit choices. Respect current viewer access. Unsaved changes
are clearly excluded until saved. Verify A4 and Letter, readable page breaks,
long names/spell lists and grayscale output. Browser print is sufficient; no
server PDF service or new renderer plug-in framework is needed.

## Implementation sequence and ownership

Each stage is a coherent contract/product increment. These are dependencies,
not separate implementations of the old and new models. Breaking service/data
changes receive appropriate version increments and compatible host requirements;
stable add-on/service identities remain stable. Do not overload v3 request
meanings or keep a parallel legacy engine bridge. Introduce the replacement
contract before its consumer and remove superseded paths at the cutover.

| Stage | Deliverable and owners | Exit evidence |
| --- | --- | --- |
| 1. Define and retain character revisions | Host: narrow authoritative history/write/access capability and backup references. Sheets: new schema and command worker. Engine/content: typed decisions, grants, predicates, explanations and coverage inventory. | Atomic revision/head writes, immutable history, role enforcement, stale/uncertain-write tests, bounded storage and backup reconstruction. No UI-only DM enforcement. |
| 2. Deliver one complete character flow | Sheets + engine + compendium: create a character, change an early choice, review dependencies, commit, compare and restore. Include HP, attunement and senses plus source/calculation details. | A concrete character demonstrates propagation and exact saved history without legacy fields or duplicated formulas. Unsupported choices are explicit. |
| 3. Complete build and play coverage | Engine/content: every currently exposed creation/progression choice, multiclass ordering, grants, items, spell choices, resources and relevant prerequisites. Sheets: common Play/Build/History controls, durable drafts and DM grant workflow. | Every mechanical output has one rule path and explanation; rules updates, absent providers and DM revocation preserve authored state and traceability. |
| 4. Apply F18 throughout the suite | Host: public reference/details capability. Compendium and all affected rule-consuming views/add-ons: use the shared interaction, summaries and safe links. | Surface inventory complete; keyboard, touch, source filtering and stale-generation checks pass in installed packages. No sheet-only F18 completion claim. |
| 5. Finish transfer, print and retirement | Sheets: F14 reviewed current imports/history undo and F13 print. Host/sheets: remove old sheet compatibility references/paths and account for obsolete stored schema. | Current export/import and backup recovery, A4/Letter output, legacy rejection, targeted cutover tests and end-to-end acceptance. |

Host mechanics stay in the host; character commands/history presentation stay in
sheets; mathematics and eligibility stay in the stateless engine; rule facts and
source identity stay in content providers. DM Tools' Import Center changes only
if it consumes the new transfer contract; it does not become the sheet writer.

The stage-1 vertical prototype should prove storage growth, dependency review and
the explanation contract before broad UI work. Snapshot-based history is a design
choice informed by the complexity and schema-evolution costs documented in
[Microsoft's event-sourcing guidance](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing).
It does not require a message bus, a graph editor or permanent old-engine runtimes.

## Completion checks

Runtime implementation must supply action-level evidence, not just schema or
pure-math tests:

- Replacing an early choice changes all dependent statistics, exposes invalid
  later selections, and preserves unaffected decisions, inventory and play state.
- Duplicate/conditional/non-stacking grants, level-specific prerequisites,
  retained rolls and deterministic repeated evaluation behave consistently.
  Removing a DM feat after a rest/cast removes its effect without leaving a
  materialized duplicate; revocation and reversal remain visible.
- Forged DM labels, actor IDs, projections, direct raw writes and imported
  history cannot bypass server authority. Hidden/deleted/recreated core records
  cannot expose or inherit another record's history.
- Concurrent build/play edits, repeated clicks, lost responses, failed commits,
  provider replacement and stale reviews neither lose data nor duplicate effects.
- Every revision can be viewed after restart; full restoration reproduces its
  captured sheet, while build-only restoration preserves current play state
  except reviewed corrections. A backup restored to a disposable directory
  retains the complete reachable history and explanation evidence.
- Official and synthetic homebrew providers share behavior. Source disable,
  update, removal, ambiguous references and duplicate record IDs have explicit
  outcomes; frozen snapshots do not masquerade as current validation.
- HP bounds, attunement capacity and senses agree across Play, Build review,
  History, both layouts, imports and print. All displayed mechanical values have
  reachable explanations showing the same calculation revision.
- F18 is exercised across its surface inventory with keyboard only, desktop
  pointer, phone touch, zoom/reflow, long localized text and screen-reader focus
  checks. Navigation inside details preserves draft guards and return context.
- Selecting/pasting import data does not write; cancellation preserves the
  original; stale apply/undo retains recoverable work. Print works with missing
  providers and excludes unauthorized or unsaved fields.

Run each affected repository's documented full gates, rebuild changed packages,
inspect them with the host and exercise the real staged/reviewed activation
lifecycle in disposable data. Use synthetic redistributable rule fixtures.
Existing arithmetic regression vectors can remain useful expected-result data;
new product completion is judged against this specification, not old UI parity.
Update owner/public schemas and guidance together when those contracts actually
change. Site deployment and live-data operations remain separate work.

## Retirement and data implications

F15 is an approved retirement, not an unresolved compatibility task. No valuable
old sheet data needs to be carried forward. Remove legacy sheet envelopes,
unwrapped-object guessing, manual/auto fallback branches, old override fields
and the sheet-specific legacy conversion target when replacing the model.
Do not remove the unrelated campaign/DM Tools conversion workflow.

The existing host deliberately blocks a changed extension schema while its old
data set is materialized, including an empty set. Therefore cutover needs a
targeted, reviewed reset of the retired sheet namespace and its schema metadata,
not a startup bypass or an invented compatibility reader. Keep the permanent
sheet identity. Before any such operation, report exactly which old sheet data
would be removed and ensure unrelated character profiles, portraits, notes in
core records, campaign records and source backups are outside the target. The
owner's retirement decision removes the need to design a converter; this plan
does not itself perform a reset or production operation.

After the new model is in use, pruning history or its referenced evidence would
break reversibility and is not authorized by the old-data decision. History
retention, reachable-payload cleanup and import replacement must never silently
discard that new work. Unsupported future schema versions fail clearly instead
of being normalized into partial characters.

No runtime, schema, package, campaign data or legacy export has been changed by
this planning task. The next implementation starts with stage 1.
