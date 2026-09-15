# Rewrite feature-parity audit and product assessment

Initial audit September 10–11, 2026; continuation audit September 14, 2026. This compares preserved source revisions with current local source and synthetic/installed browser evidence, not a production-site inspection.

**Latest continuation:** 12 additional confirmed workflow/presentation findings and four design concerns are documented below. The current execution plan is [the repository fixup sections in the backlog](../BACKLOG.md).

**Original September 10–11 baseline: 21 confirmed missing or reduced capabilities, six documented transition/design differences, and four verification gaps.** Every item below includes an assessment of its usefulness and a recommended direction. Missing does not automatically mean worth restoring in its old form. The original audit made no runtime or deployment changes; subsequent implementation is recorded below. These proposals do not create new deployment gates.

**September 11 implementation update:** F01–F05 are implemented through [shared Markdown recovery and collection browsing](EDITOR_BROWSING.md) and [quick search, activity summaries and focused map editing](SEARCH_ACTIVITY_MAP.md). F07–F08 are implemented through [instance rules, sourcebooks and providers](RULES_SOURCES.md), following the owner's decision to use one ruleset per website with compatible books from multiple add-ons. F09 is implemented through [reviewed uninstall with retained data](PACKAGE_LIFECYCLE.md#reviewed-uninstall). F10 is implemented through [settings disclosures inside each add-on card](BROWSER_ADDONS.md#add-on-settings). F11 is implemented as [read-only map context and independently saved editor panels](BROWSER_ADDONS.md#record-panels-and-planning-prose); F21 adds the shared DM Tools reader. F13/F14/F16–F20 are implemented through [character decisions, retained history and shared rules details](CHARACTER_BUILD_HISTORY.md). F15 compatibility is removed with a documented offline retirement boundary; F06/F12 remain deferred. New work uses the current architecture, with no new legacy handlers or retained legacy features. Report concrete data-loss risks before an affected operation; otherwise proceed within scope. The owner confirmed that no valuable old sheet data needs preservation; no old-sheet compatibility is planned. No production changes are part of this implementation.

The character implementation replaces the manual/automatic split with reversible decisions, calculated results, authenticated DM grants and reviewed rules updates. F18 uses shared contextual details across the host, compendium and sheet surfaces. Saved revisions remain readable without rules providers. Validation and remaining manual acceptance boundaries are recorded in the [implemented specification](CHARACTER_BUILD_HISTORY.md#verification-result). The GitHub installation/update/private-repository workflow was restored in host commit `8711085`; it is **not counted as still missing**.

**September 14 source audit:** the current list is in [the backlog](../BACKLOG.md).
It also identifies the absent host-owned campaign-bundle import workflow (T19),
which was present in the preserved baseline but omitted from this original
21-item comparison. The completed findings below are historical; neither this
report nor its old test counts represents current production state.

## September 14 continuation: surviving workflow and presentation regressions

This continuation found **12 additional confirmed omissions or reductions**,
plus four UX/design concerns. These are separate from historical F01–F21.
Current implementation work is tracked as **T20–T29 in
[BACKLOG.md](../BACKLOG.md)**, alongside the existing
backend tasks. This is an assessment and plan, not an implementation or a new
cutover gate. A checked historical gate does not close these findings.

### Audited source and evidence boundary

All five worktrees were clean at the start. The preserved legacy revisions in
[Baselines and method](#baselines-and-method) remain the comparison baseline.
This continuation inspected these current revisions:

| Repository | Current revision |
| --- | --- |
| Host | `6b929371e67cffc2938087ca6fe04c05d480f9d9` |
| DM Tools | `40fe45208e389c5bba86146b4507753c9ab3a638` |
| Compendium | `d03af34bc747a8b865213256ed78e9c9344ede75` |
| Rules engine | `2254de66b87f026c1415ccb9816610f03dbbf635` |
| Character sheets | `dd58f16f605abf92c9478774e8cc1bcde4a9bc39` |

Method: trace an actual old control/renderer to its current route, projection,
mutation and rendering path; then exercise relevant current browser fixtures.
Missing source helpers alone are not findings. The current host was rebuilt,
and synthetic campaigns were viewed at 1440 and 390 CSS pixels. The custom
probe recorded 26 route/viewport observations with no browser exceptions or
document-wide horizontal overflow. It reproduced the omissions below; those
negative observations are not passing regression tests for desired behavior.

No production campaign data, site credentials or live conversion was used.
The number of affected real records is unknown. Assertions about missing UI
do not mean stored records have been deleted. Code and tested ZIPs are current
local evidence; the earlier dated production snapshot was not refreshed.

### Confirmed findings

| ID | Finding | Impact | Tracking |
| --- | --- | --- | --- |
| R01 | DM/player twin create, link, unlink and counterpart navigation have no UI | P1: a working backend workflow is inaccessible | T20 |
| R02 | Reciprocal twins appear twice outside the timeline | P2: duplicate identities and misleading totals | T20 |
| R03 | Old core article/list/settings URLs no longer resolve | P2: saved links and pasted references break | T21 |
| R04 | Structured references are labels or edit controls, not navigation | P2: extra searching during play | T22 |
| R05 | Location articles lost residents, sublocations, ancestors and event context | P2: the place no longer works as a campaign hub | T22 |
| R06 | Faction rosters and character/faction companion context are incomplete | P2: existing relationships become hard to discover | T22 |
| R07 | Contextual creation and card-level edit entry points are missing | P2: more steps and manually reconstructed associations | T23 |
| R08 | Mystery aggregation, answer-derived completion and status presentation are reduced | P2: investigations are harder to run accurately | T24 |
| R09 | Combat presentation omits available weapon details and sense units/explanations | P2: users must leave the working sheet for information | T25 |
| R10 | Spell filtering does not include granted-spell rows | P2: filtering gives inconsistent results | T25 |
| R11 | Character knowledge levels no longer control normal card/article presentation | P1: a reveal convention is lost | T26 |
| R12 | Retained location `notes` have no current reader/editor | P1: authored content appears lost | T27 |

#### R01 — Twin operations are stranded behind the API

**R01/R02 resolved September 15 (T20):** management, counterpart navigation and
shared aggregate grouping are implemented in [the core contract](CORE_DATA.md#twin-reading-and-management). The findings below describe the original omission.

The old editor's `_twinHeaderRow` exposed create/link/unlink and the article's
`_twinFactRow` linked the opposite version. Current
[`CampaignMutationClient.mutateTwin`](../../frontend/src/core/campaign-mutations.ts)
and [`POST /api/campaign/twins`](../../internal/transport/httpapi/campaign.go)
still support the operation. There is no production caller of `mutateTwin` in
the browser application; character and common record pages have no twin
controls or counterpart link. A synthetic reciprocal pair confirms the absence.

This is especially confusing when a user tries to change a paired record's
visibility: the backend correctly protects the pair, but the UI provides no
way to resolve that relationship. Reuse the existing revision-checked service
and make the pair visible; do not implement generic edits of `linkedTwinId`.
Old evidence: [editor controls](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/edit_templates.js).

#### R02 — Twin projection is inconsistent between surfaces

The old roster and recent-session views used `Store.dedupeShadowTwins`.
Current [`projectEntities` and `projectDashboard`](../../frontend/src/app/campaign-projection.ts)
map the complete supplied collection, and
[`collectionModel`](../../frontend/src/app/collection-model.ts) counts it.
Only the [timeline](../../frontend/src/app/campaign-timeline.ts) currently
performs reciprocal-twin collapsing. The probe shows both Ryn and its private
counterpart as unrelated roster cards, with no twin indicator.

Use a common, role-aware identity projection for aggregate views and counts.
Keep exact article identities addressable; never collapse a one-way, missing,
inaccessible or invalid counterpart. Test references and search against the
chosen presentation so that deduplication does not make an accessible record
impossible to open. Old evidence: [`wiki.js` roster/session rendering](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/wiki.js).

#### R03 — Familiar core URLs reach the not-found page

**Resolved September 15 (T21):** finite saved-route aliases now use current guarded
navigation and creation. [Contract and tests](EDITOR_BROWSING.md#saved-core-urls). The finding below is historical.

`#/postava/ryn`, `#/misto/gate` and `#/nastaveni` all reach “This page is not in
the index” in the current browser. The
[route parser](../../frontend/src/app/routes.ts) retains map, graph and timeline
aliases, but has no equivalent mapping for the old core article/list routes.
Wiki-kind aliases in [Markdown](../../frontend/src/app/campaign-markdown.ts)
do not translate arbitrary old hash URLs. Old Compendium bookmarks are restored
and passed the installed tests; they are a different path.

Define a finite URL-alias table from the
[preserved route inventory](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/docs/reference/routing-navigation.md),
including old list/article, party, settings and creation URLs. Canonicalize
without adding a second history entry. Preserve encoded IDs, exact target
identity and role/dirty-navigation guards. URL aliases do not require a legacy
runtime or old data schemas.

#### R04 — Reading a reference no longer lets the user follow it

**R04–R06 resolved September 15 (T22):** semantic reference links and derived
location/member/ownership context are restored. [Contract and tests](EDITOR_BROWSING.md#connected-article-context). These findings describe the original omissions.

Old character, event, location and faction articles rendered linked chips.
Current [`articleFacts`, `referenceNames` and `structuredArticleContent`](../../frontend/src/app/codex-record-page.ts)
reduce many references to plain strings. The character profile's
[`#fact` / `#inline`](../../frontend/src/app/codex-character-profile.ts) turns
faction/location values into edit buttons for editors and spans for readers.
The synthetic event names Ryn and Northern Gate but has no link to either;
the character names its faction/location without a navigation target.

Restore semantic links for scalar and multi-record facts, relationship
endpoints, location roles, rank members and companion owners. Provide a
separate, explicit edit affordance. Resolve only against the authorized
snapshot and use unavailable states for missing targets. Authored Markdown
wiki links already work and should continue to use their existing resolver.

#### R05 — Location articles lost their surrounding campaign

The old location renderer displayed ancestor breadcrumbs, direct sublocations,
present characters and events mentioning the place. It also exposed existing
map actions. The current [article renderer](../../frontend/src/app/codex-record-page.ts)
keeps map links and prose but has no location-specific context sections;
connected-location IDs are editable but are not included in its reading facts.
In the probe, Northern Gate has a resident, a child location, a connection and
an event, yet its page shows only its description and map actions.

Build these sections from the canonical references, not copied lists stored
inside the location. Keep hierarchy cycle/missing-target handling bounded.
Old evidence: [location renderer](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/wiki.js),
`Store.getCharactersInLocation`, `getAncestorLocations`, `getSubLocations`.

#### R06 — Faction membership and owned companions disappear from context

Old faction pages showed rank chains, unknown/unassigned ranks, unchained
members and faction-owned pets; character articles showed their own pets and
event mentions. Current `structuredArticleContent` returns no faction section
when there are no rank chains, and otherwise renders names only in exact
matching ranks. Unranked/unmatched members disappear from that presentation.
The [character profile](../../frontend/src/app/codex-character-profile.ts)
has no owned-companion or event-mention section.

The probe's Gate Wardens has members and a hound but displays only prose; Ryn's
raven is absent from its article. Companions still exist in their collection,
and party companions still work on the dashboard. Restore contextual lists
with explicit unassigned groups and links; do not infer new ownership.
Old evidence: [`unchained`, rank rows and `_petsArticleSection`](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/wiki.js).

#### R07 — Creation no longer carries the user's current context

**Resolved September 15 (T23):** typed contextual presets and direct card editing
now retain source/return routes and draft safeguards. [Contract and tests](EDITOR_BROWSING.md#contextual-creation-and-direct-editing). The finding below is historical.

Old location pages offered “Character here”, “Event here” and “Sub-location”;
faction pages offered a new member, and collection cards had edit pencils.
These were bound actions, not unused helpers. Current creation presets in
[routes](../../frontend/src/app/routes.ts) and the
[record editor](../../frontend/src/app/codex-record-page.ts) cover party members
and timeline sessions only. Ordinary creation still works, but users must
navigate away and select the location/faction/parent again. Current cards open
the article and require a second action to edit.

Add typed contextual presets and a discoverable direct-edit action using the
same editor. Keep the parent/source snapshot and back destination, preserve
drafts through sign-in, and revalidate the reference at save. Cancellation must
not leave placeholder records. Old evidence: [creation handlers](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/editmode.js)
and [article/card controls](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/wiki.js).

#### R08 — The investigation view lost its working summary

**Resolved September 15 (T24):** effective status is shared by article facts,
collection cards, facets and search. The combined question queue restores source
navigation and answered history. [Contract and tests](EDITOR_BROWSING.md#investigations).
The finding below is historical.

The old mysteries page combined unanswered mystery questions and character
`unknown` questions, with accent-insensitive filtering, source links and edit
entry points. Cards showed answered/open counts and derived completion.
[`Store.isMysterySolved`](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/store.js)
treated an explicit true flag or a nonempty fully answered set as solved.

The current [collection page](../../frontend/src/app/codex-record-page.ts) has
only the common browser. Its [boolean facet](../../frontend/src/app/collection-model.ts)
and article “Solved” fact read the raw flag. The fixture's fully answered case
with `solved:false` displays “Solved No”, and Ryn's unanswered question is absent
from the mysteries page. This is a confirmed display/aggregation regression,
not an instruction to rewrite stored answers or set the manual flag.

Share an effective-status/read projection across cards, filters and articles;
keep empty mysteries open and retain the manual override. Restore the combined
question queue and answer/source navigation. Do not add a dashboard mystery
section as a claimed restoration: the preserved routing document mentions one,
but the actual baseline `renderDashboard` already omitted it.

#### R09 — The new Combat layout drops details that the backend provides

The latest sheet layout restores the broad visual structure, but
[`combatDetails`](../../../addon-dnd-character-sheets/src/character-sheet.ts)
renders a weapon's name, attack bonus and damage only. Damage type, versatile
damage and mastery information require another surface. Senses go through
generic `human()` formatting without their unit or explanation control.
The previous [Combat panel](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.sheet.js)
was a richer attack/trait reference and explicitly printed sense distances.

A synthetic current projection renders “Test blade +5 1d8+3” and
“Senses: Darkvision: 60”; the existing
[`projectionView`](../../../addon-dnd-character-sheets/src/character-projection.ts)
renders the same sense as “60 ft” and retains the additional weapon values.
Thus the data/calculation survives. Reuse semantic saved-projection renderers
for the working Combat view, History and Print, with compact disclosure and
provider-absent readability. Do not implement mechanics in CSS/TypeScript.

#### R10 — Granted spells bypass search and level filters

[`playActions`](../../../addon-dnd-character-sheets/src/character-play.ts)
filters elements with `data-spell-name` and `data-spell-level`. Class/ritual
rows use `spellRow`; granted rows are constructed separately without those
attributes. In a synthetic Alpha/Beta/Gamma example, filtering to Alpha leaves
the unrelated granted cast action visible. The level selector has the same
structural omission. This is a current reproducible filtering defect; its
exact introducing commit was not bisected.

Use one row/filter projection for every cast source, with empty-result feedback
and spell/source identity preserved. Cover class, ritual and granted spells,
combined name/level filters and a missing catalog record. Casting and resource
validation remain in the engine/coordinator.

#### R11 — Knowledge levels retain storage but lose their reveal behavior

**R11 resolved September 15 (T26):** shared reading projections and explicit DM
inspection restore the thresholds below. [Contract and validation](CORE_DATA.md#character-knowledge-and-dm-inspection). The finding describes the original omission.

The old character [card/article renderer](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/wiki.js)
used unknown identity below level 1 and withheld title, profile details and
description below level 2. Current
[`projectEntityWithContext`](../../frontend/src/app/campaign-projection.ts)
and the [profile](../../frontend/src/app/codex-character-profile.ts) display
those values regardless of the saved knowledge level. The fixture renders a
knowledge-0 visitor's name, title, species and full description. The faction
graph still gates a title on knowledge, making the current UI inconsistent.

Restore a documented, shared presentation policy with an explicit DM inspection
mode. Keep authoring access distinct from what the reading projection reveals.
Test levels 0–4, accessible labels, cards, articles, graph and search behavior.
This audit establishes lost presentation behavior; it does not establish a new
server confidentiality leak. If knowledge is intended as a confidentiality
boundary, specify and implement the server projection as part of T26 rather
than relying on CSS or assuming the old renderer enforced that boundary.

#### R12 — Location notes survive as a field but cannot be read or edited

**Resolved September 15 (T27):** DM article/editor access, public projection and
player-save preservation are implemented in [the core contract](CORE_DATA.md#private-location-notes). The original finding below is historical.

The old location editor read and saved `l.notes` / `lf-notes`, and its article
rendered that Markdown separately from the description. Current
[`articleSections`](../../frontend/src/app/codex-record-page.ts) recognizes
singular `note` and `mapNotes`, not location `notes`; current
[location editor fields](../../frontend/src/app/campaign-record-editor.ts)
also omit it. A fixture with nonempty `notes` renders neither that text nor an
editor for it. [Legacy decoding](../../internal/domain/campaign/legacy.go)
retains record-owned fields, so byte preservation alone does not restore the
workflow. No affected production-record count is claimed.

First establish the field's intended audience: its old editor label was
“secret notes”, so it must not simply be appended to a public article. Audit
the existing conversion report/authorized records when operational review is
requested, retain originals, and provide DM-visible recovery plus an explicit
reviewed mapping to the current note/twin model. Keep ordinary edits lossless;
do not add a startup converter or silently overwrite description/map notes.
Old evidence: [editor](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/edit_templates.js)
and [save handler](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/editmode.js).

### UX/UI concerns requiring design acceptance

These are observed design concerns, not additional confirmed functional losses.

**Host U01–U03 resolved September 15 (T28):** missing artwork and empty facts
are compact, collection view controls disclose secondary options, roster scope
is explicit, and save feedback distinguishes drafts from confirmed writes.
[Implementation and tests](EDITOR_BROWSING.md#compact-reading-and-save-feedback)
cover desktop/phone, both themes/languages, keyboard and 200% CSS zoom. The
observations below record the original review; Sheets' separate saving work
remains T33, and broader human workflow acceptance remains T18-HOST.

| ID | Observation and consequence | Proposed direction and acceptance |
| --- | --- | --- |
| U01 | The 390px character fixture places a large empty portrait and numerous empty/editable facts before prose. A sparse faction has a large emblem card beside an almost empty page. | T28: use a compact identity header for missing artwork and summarize secondary/empty facts. Keep real portraits and the established palette. Review sparse and rich pages so the title, purpose and primary action are easy to reach on a phone. |
| U02 | Generic collection cards and always-visible sort/group controls weaken collection-specific hierarchy. Mystery cards emphasize a large icon while omitting investigation status; party and NPC browsing now share a default roster. | T24/T28: restore meaningful summaries first; disclose advanced browsing controls and retain saved views. Decide the desired NPC/party default explicitly. Do not remove the recently restored filters or force every collection into a new component system. |
| U03 | Saving differs across character inline fields (blur/debounce), wiki Save, whole-record Save, and sheet preview/Save new revision. This increases uncertainty about what is already durable. | T28: label saved, local-draft, reviewing and failed states consistently; keep one obvious action per context, visible cancellation and clear conflict recovery. Preserve authenticated review/retained history; any shortened play interaction needs explicit product acceptance and lost-response tests. |
| U04 | The audited build reports a 1,142.74 kB minified application chunk (338.97 kB gzip), plus a 120.12 kB preload helper. This is a delivery-cost signal, not a measured slowdown or a v1 performance comparison. | T29: measure cold opening, route transitions and large-campaign search/layout on a throttled phone profile. Split editor/map/graph/admin loading only where measurements justify it; record bytes and interaction timing before/after. Keep offline/self-hosted asset behavior and error handling. |

The eight existing visual tests pass their typography, surface, card, drawer,
focus and navigation assertions. Their preserved reference is a limited fixture,
not a full old application or approval of every authored page. The screenshots
support U01/U02; they do not constitute a complete contrast, screen-reader,
physical-touch or aesthetic acceptance review.

### Backend work carried forward, not counted again

The following existing tasks explain relevant ways the UI can fail despite
healthy host endpoints. They remain linked to their authoritative backlog entries.

| Existing task | Current evidence and required relationship to UI work |
| --- | --- |
| T19 campaign-bundle imports | No matching production provider/schema/route in host or DM Tools. Restore the host's exact reviewed transaction and reference allocation, exposed through DM Tools' existing Import Center. Planning-only import success is not campaign-bundle support. |
| T10 worker health/recovery | Production search finds no caller of the supervisor health/restart-policy helpers. Wire coordinator monitoring/backoff and provider invalidation; pair it with T11 diagnostics and truthful retry/reload states. Do not replay uncertain writes. |
| T08 reviewed migrations | When a released schema needs preservation, provide an exact reviewed migration, atomic commit, stale rejection and recovery. Explain incompatible schemas without hiding the preservation boundary. |
| T11 worker/browser diagnostics | Finish actionable worker health/exit and browser activation/disposal information with bounded, redacted output and request correlation. T12 build identity and T13 full-backup guidance are completed in the backlog. |
| T02 release CI; T18 broader acceptance | Local installed tests now pass, but release CI still does not feed all four ZIPs into the host browser suite. Keep session expiry, large campaigns, native targets and real-device checks explicit. |
| T05–T07, T14–T17 | Data/blob/log retention, artifact ownership and per-site rollout/retirement stay in the backlog. They are not evidence of a newly lost screen and must not displace restoring core authoring/reading flows. |

T09 is completed in `9997306` (September 16, 2026). Settings now previews required
and optional dependents, the stop order and every planned restart attempt before
confirming an exact disable review. The coordinator disables the reviewed targets
atomically, preserves packages and campaign data, rejects stale reviews, and
restores the previous graph on pre-commit failure. Post-commit recovery failures
remain visible; a lost response is never automatically replayed. English desktop
and Czech phone installed-package tests cover review/cancel, stale confirmation,
disconnects, retained data and normal reactivation. Backend tests additionally
cover transitive dependencies, alternate providers, failed runtimes and rollback.
The full host check passed (385 frontend tests and 248 browser tests; 22 optional
companion ZIP cases skipped), along with lifecycle/HTTP race tests, all four
companion contract suites and 33 release-check gates. This closes T09, not T02's
complete publication matrix or T18's broader acceptance boundary. The
[lifecycle contract](PACKAGE_LIFECYCLE.md#reload-and-disable) records the details.

### Coverage and validation from this continuation

| Area | Current evidence | Remaining boundary |
| --- | --- | --- |
| Core reading, browsing and contextual editing | Source comparison plus the 26 synthetic route/viewport observations; screenshots inspected for character, faction and mystery pages | R01–R08/R11–R12 need implementation-specific regressions and representative authorized campaign acceptance |
| Shell and visual foundations | Current frontend build; all 8 `visual.browser.mts` tests passed | Sparse/rich content, both themes, 200% zoom and full keyboard/screen-reader review |
| Maps, timeline and relationship graphs | Real Go-host map tests, timeline and relationship-graph suites passed in the selected run | Very large maps/graphs and physical touch; no new confirmed spatial regression in reviewed paths |
| DM planner, imports and add-on management | Installed DM suite passed, including Czech desktop/phone, drafts, conflicts, lost responses, import review, panels, cleanup and player preview | T19 campaign bundles; C01 externally forced planner teardown remains a known draft limitation |
| Compendium | Installed DM/player desktop/phone browse, retry, Czech controls, wiki/bookmark and generation-replacement cases passed | Source content coverage remains bounded by its documented data gaps; no new confirmed browse regression found |
| Engine and sheets | Installed rules/character suites passed; synthetic current-renderer probes reproduced R09/R10 | Content-wide combinations, true device/printer behavior, restored detail rendering and source-identity collisions |
| Core backend | `go test` passed for `internal/application/campaigndata`, `internal/transport/httpapi`, `internal/addons/packagemanager`, `internal/addons/workersupervisor` | Passing existing tests does not implement uncalled lifecycle primitives or missing UI callers |

The selected seven browser suites passed **121 tests, zero failures, zero
skips**, at `--test-concurrency=4`, using disposable Go hosts and all four ZIP
environment variables. Together with the visual suite, **129 existing browser
tests passed**. This was a focused audit run, not a rerun of all host/add-on
gates, all unit tests, Go vet or the full release/publication matrix.

Tested package SHA-256 values:

| Package | SHA-256 |
| --- | --- |
| `dm-tools-3.0.0.zip` | `e53837ab5e3f17c203837674698002eca329aa11c42cabc9d02d6dd81abccdd6` |
| `dnd-engine-4.0.0.zip` | `31a226a71aad96655f92d891e938c57b0e5ccdb1c97b01e32e3056b28936d820` |
| `dnd-sheets-4.0.0.zip` | `21290e013670bccba3b17c88a2aafa3e1cdca333d52a87b69c0ad920daa336be` |
| `dnd-2024-compendium-3.1.0.zip` | `d2a0187c509e8e843c32cefff4b61c0e7d7a66738c74bca07b3d23a73e960a11` |

The installed tests use stage/review/activation, not source folders. An
additional archive comparison found zero mismatches against matching checkout
files: DM Tools 44 entries, Engine 20, Sheets 24, Compendium 3,100. This comparison
excluded generated manifests/checksum files and is not a reproducible-build
claim. Synthetic observations and screenshots remain local ignored artifacts
under `frontend/test-results/rewrite-audit-20260914/`; temporary probe scripts
are removed when this documentation task closes.

Documentation validation: all 140 local links/anchors in the two changed
documents passed; `git diff --check`, `npm run check:source` and the existing
33-gate `npm run release-check` passed. No release gate was changed.

The durable result is this evidence snapshot and the backlog's prioritized
backend/UX plan. No application fixes, package publication, production changes
or data conversion were performed by this continuation.

<a id="recommended-decisions-at-a-glance"></a>

## Historical September 11 decisions at a glance

Value is an assessment of the workflow and consequences, not measured usage. Effort is relative: **small** means a focused component or transformation, **medium** means a complete stateful workflow, and **large** means coordinated contract/lifecycle work. These are scope estimates, not delivery commitments. The detailed assessments explain exceptions and minimum useful outcomes.

| ID | Capability | Value | Recommendation | Relative effort |
| --- | --- | --- | --- | --- |
| F01 | Durable Markdown drafts | High | Implemented: explicit revision-aware recovery | Completed slice |
| F02 | Collection filters, sorting, grouping | High for larger campaigns | Implemented: shared descriptor-driven views | Completed slice |
| F03 | Search quick-jump overlay | High during preparation/play | Implemented: shared modal search with accessible recents | Completed slice |
| F04 | Activity change summaries | Medium | Implemented: concise summaries from server role projections | Completed slice |
| F05 | Map-side editing and context | High for map preparation | Implemented: shared field controls and atomic quick edits | Completed slice |
| F06 | Restart server in Settings | Low with current lifecycle controls | Defer; keep restart in operator tooling | Medium if restored |
| F07 | Effective sourcebook selection | High | Implemented: one instance ruleset and shared source choices | Completed slice |
| F08 | Service-provider selection | High when selection is required | Implemented: reviewed broker selections and automatic defaults | Completed slice |
| F09 | Add-on uninstall | High for operator control | Implemented: reviewed removal with data retained | Completed slice |
| F10 | Contributed settings destination | Medium; extension contract gap | Implemented: role-aware Settings disclosure in each add-on card | Completed slice |
| F11 | Editor and map-panel contributions | Useful with a real consumer | Implemented: read-only map context and separate editor saves | Completed narrow slice |
| F12 | Graph kinds and reusable facade | Conditional; bundled planner already works | Defer facade; add narrow metadata only on demand | Large for facade |
| F13 | Clean sheet printing/PDF | High for physical tables and fallback | Implemented: Print a saved revision through shared presentation | Completed coordinated slice |
| F14 | Reviewed sheet import and undo | High | Implemented: Current-format replacement as a reversible revision | Completed coordinated slice |
| F15 | Old sheet export compatibility | Retired by owner | Drop old formats and sheet compatibility entirely | Targeted retirement |
| F16 | Attunement capacity feedback | High, focused play aid | Implemented: Derived eligibility/capacity with explicit DM exceptions | Completed coordinated slice |
| F17 | Character decisions and reconciliation | Foundational | Implemented: Reversible history, derived results, DM grants and rules adoption | Completed coordinated slice |
| F18 | Rule details and calculation explanations | Foundational and useful at the table | Implemented: Shared details popovers across all rule-related surfaces | Completed coordinated slice |
| F19 | Senses display | High, focused play aid | Implemented: Shared derived traits with units, conditions and provenance | Completed coordinated slice |
| F20 | HP range behavior | High, focused correctness fix | Implemented: One rules-owned bounds policy and reviewed maximum changes | Completed coordinated slice |
| F21 | Encounter/puzzle reader | High when running sessions | Implemented: shared reader with explicit editing | Completed slice |

Across these recommendations, campaign policy belongs in shared campaign state; personal browsing preferences belong in the browser. Retain optimistic revisions and useful saved views when providers are absent. The new character design deliberately replaces hand-filled mechanical fields with decisions, bounded play state and explicit DM effects. Prefer existing host services and small shared components over new frameworks. Do not import legacy raw-HTML or live-object extension boundaries to recover a useful screen.

## Baselines and method

All five worktrees were clean when inspected. The legacy baseline is each repository's preserved `origin/deprecated/pre-rewrite-2026-09-01` revision:

| Repository | Legacy revision | Audited current revision |
| --- | --- | --- |
| Host | `3aeeacfe7adec985693f8aeb239df58c177f3da8` | `8711085f19c2e409ac362f51758a9a4afa8a38ea` |
| DM Tools | `ec89529ed1b3a85d0fb08f30512b6dffb58071b4` | `603c991f6acc9e5998227712c22aead6c8c377ae` |
| Compendium | `b3d895057721ccee0d0b464ad1efe799bdfd3157` | `7af4f6f636e880820243436cad671e6ca39b1733` |
| Rules engine | `b2ba2be2940d63fe6c7d769772773540748a6355` | `64d89a7f8494d0696098db9e3428f0efa9bb34ba` |
| Character Sheets | `ab64f76c55f571e1446a6a0ac7842a3357d0da0f` | `535f35e9b736dfe072aa6f63aca62c37534864dc` |

The comparison covered legacy routes, settings, UI actions, host endpoints, public add-on registrations, planner/import workflows, compendium browse/data, sheet controls, and engine operations. Each finding follows an old implementation to its current replacement or missing integration. A renamed route, different implementation language, retained data without a UI, and a callable UI workflow are distinguished. Unused old helpers do not establish a lost user feature.

Historical evidence links pin the old commit. Current file links refer to the revisions above; their implementation may change after this report. The original P1/P2 labels record audit impact: P1 means data protection, workflow correctness, or an unavailable central operator action; P2 means a meaningful missing workflow or extension capability. Delivery order is reassessed below using usefulness, dependencies, and effort; an audit P1 is not automatically the next implementation task.

## Confirmed missing or reduced capabilities

### Host campaign workflows

#### F01 — Markdown drafts no longer recover after reload or a crash · P1

**Implemented after the audit:** [current recovery contract](EDITOR_BROWSING.md#local-markdown-recovery).
The following describes the audited baseline. The implementation uses independent
writer copies, explicit comparison and no automatic expiry of unsaved text,
superseding the original bounded-retention suggestion below.

Previously each Markdown editor saved a local draft after 500 ms, flushed it on page hide, and offered Restore/Discard for up to 30 days. The current editor retains its document in memory; the application has dirty-navigation and before-unload guards, but no durable Markdown draft store or recovery banner. Dismissing a reload prompt, closing after a failure, or a browser crash loses unsaved prose. This does not mean saved campaign records are lost.

Evidence: [old recovery implementation and contract](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/edit-drafts.js), current [Markdown editor](../../frontend/src/app/codex-markdown-editor.ts) and [unsaved-edit guard](../../frontend/src/app/unsaved-edit.ts).

**Assessment — restore and improve.** Long-form campaign writing makes losing an unsaved draft disproportionately costly. Keep local recovery alongside navigation guards. Scope drafts by campaign, effective role, record, field, and opening revision; show their age and offer Restore, Discard, or comparison when the saved record changed. Clear successfully saved drafts, use bounded retention, and make logout/player-preview handling explicit so DM drafts do not appear in player views. Avoid turning this into full offline synchronization. **Acceptance:** a reload recovers prose; a concurrent edit is never silently replaced; separate records and roles cannot receive each other's drafts.

#### F02 — Collection browsing lost grouping, sort choices, filter chips, and saved filters · P2

**Implemented after the audit:** [current collection-view contract](EDITOR_BROWSING.md#shared-collection-views).
The following describes the audited baseline. The implementation uses OR within
a category and AND across categories, explicit Apply, shared descriptors and
role-scoped URL/browser preferences; it supersedes the blanket AND-chip proposal
below.

Character, location, and faction lists previously had persistent per-list state, AND-combined filter chips, accent-insensitive matching, and collection-specific sorting. Characters could group/sort by faction, name, status, or knowledge; factions supported member-count sorting. The replacement collection page has one transient substring input and no sort/group controls. It searches projected name/title/excerpt/tags, rather than the old complete kind-specific search text; it also lacks accent folding. Existing records remain accessible, but navigating a large campaign is substantially less capable.

Evidence: [old list behavior](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/docs/reference/routing-navigation.md#L50), current [`#collection`](../../frontend/src/app/codex-record-page.ts).

**Assessment — redesign around consistent browsing.** Sorting and compound filters become valuable as a campaign grows; many controls shown at once would burden small campaigns. Use one query model with accent-insensitive text, AND-combined chips, a sort menu, and optional grouping. Offer only fields still meaningful for that collection. Put the current view in the route where practical for Back/bookmarks, with remembered browser defaults. Do not duplicate compendium search or revive retired categories. **Acceptance:** Czech names match without accents, combined filters work across the whole collection, and returning from an article restores the previous view.

#### F03 — Global search lost the recent-item command palette · P2

**Implemented after the audit:** [current quick-search contract](SEARCH_ACTIVITY_MAP.md#quick-search-f03).
The native modal reuses full-page search and add-on providers, resolves recent
identities against current access, supports keyboard/touch navigation and
restores focus. Opening or cancelling search retains the mounted editor;
choosing a different destination retains the unsaved-change guard. The following
describes the audited baseline.

Ctrl/Cmd+K still opens search, and grouped full-text results exist. Previously it toggled an overlay with recent activity when empty, Up/Down selection, Enter to navigate, and Escape to close. It now navigates to a page whose empty state is an instruction; results are ordinary links without the former result-selection keyboard controller. Tab navigation remains available. The lost feature is the quick-jump workflow, not global search itself.

Evidence: [old search controller](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/search.js), current [search page](../../frontend/src/app/codex-search.ts) and [shortcut routing](../../frontend/src/app/codex-app.ts).

**Assessment — restore the fast path.** Jumping between people, places, and rules during a session is a frequent enough workflow to justify an overlay. Reuse the full-page search provider and result rows, retain the page for longer searches, and keep the current editor mounted underneath. Empty search can show recently opened accessible records, with recent activity as a fallback; filter visibility again when displaying them. Support arrows, Enter, Escape, touch, and focus restoration. Do not expand this into an unrelated command framework. **Acceptance:** opening/cancelling search preserves the current draft; choosing a destination still invokes its unsaved-change guard.

#### F04 — Recent activity no longer says what changed · P2

**Implemented after the audit:** [current activity contract](SEARCH_ACTIVITY_MAP.md#recent-activity-f04).
Latest-per-record summaries derive from separate server DM/public projections,
with current reference labels and concise field descriptions. Private-only
changes and no-op saves retain the prior public summary/time; relationship
changes update the source character atomically. Detailed summaries begin with
new meaningful writes, without reconstructing history. The following describes
the audited baseline.

The old dashboard displayed a one-line change summary, including field transitions, creation, or relationship changes. Current activity rows show the record name and time only. The newest-30 list survives, but users cannot scan it to see why an entry changed. Some `lastChange` data still exists in storage/projection; retaining that field does not restore its presentation.

Evidence: [old activity presentation](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/docs/reference/wiki-rendering.md#L92), current [`#recent`](../../frontend/src/app/codex-dashboard.ts).

**Assessment — restore a concise summary, at modest priority.** A short “Moved to…” or “Relationship added” helps the DM resume preparation and players catch up. Summarize meaningful fields rather than every normalization or save; group rapid edits to the same record where that reduces noise. Generate summaries from role-filtered information, including relationship targets, rather than hiding private text only in the browser. Full record history and a diff viewer would be separate work. **Acceptance:** a meaningful edit produces a useful sentence; private changes do not reveal names or values to players.

#### F05 — Map-side location editing and context are reduced · P2

**Implemented after the audit:** [current focused-editor contract](SEARCH_ACTIVITY_MAP.md#focused-map-editor-f05).
Marker type, attitudes and notes share article field controls and validation;
size is disclosed separately. One revision-checked Save includes coordinates
and changed details, retaining other fields, viewport and selection. Conflicts
and remote deletion retain drafts. Enter follows the first visible map search
result. The following describes the audited baseline.

The old pin panel edited type, attitudes, size, and notes alongside placement and showed resolved type/attitude context. The current panel edits coordinates, with a name field for creation, and displays name/map notes plus article/local-map links. Type, size, and attitudes remain editable in the full location article, so this is an extra-navigation regression rather than missing storage. The old Enter-to-first-search-result action is also absent from the map search input.

Evidence: [old pin panel](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/map.js), current [`#panel` and search input](../../frontend/src/app/codex-map.ts), retained [location editor fields](../../frontend/src/app/campaign-record-editor.ts).

**Assessment — restore a focused quick editor.** Type, attitude, and short map notes directly affect map preparation; requiring an article round trip interrupts that work. Reuse core field controls and validation, keep less common size/detail fields behind disclosure, and retain the full article link. Save related changes together against the opening revision, with Cancel and stable viewport/selection. Restore Enter-to-first-result using the same visible search order. Avoid embedding the entire location editor in the map. **Acceptance:** a DM can classify and annotate a pin without losing map position, and conflicts preserve their edits.

#### F06 — Restart server from Settings is gone · P2

The old account panel exposed a DM-only restart button when a process supervisor was configured, then waited for the restarted instance. There is no equivalent current button or restart endpoint. Add-on reload/activation now handles many cases that used to require a restart, but a general server restart still requires external operator access.

Evidence: [old account control](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/settings-account.js#L170), [old restart endpoint](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/server.js#L1968), current [credential settings](../../frontend/src/app/codex-credential-settings.ts) and [HTTP composition](../../internal/transport/httpapi/server.go).

**Assessment — defer restoration.** Reloading or replacing an add-on addresses many former reasons to restart the whole host. Keep general restart in the deployment runbook and prioritize actionable lifecycle diagnostics. Reconsider a DM-only maintenance action if ordinary administration repeatedly requires leaving the UI. It would need an explicitly configured supervisor capability, pending-write handling, confirmation, and reliable reconnection status; it should not become arbitrary shell execution or expose container control. **Acceptance for any future version:** distinguish successful restart from a timeout, and remain unavailable when the deployment cannot support it.

### Add-on and content management

#### F07 — Effective sourcebook selection · Implemented

The audited baseline had browse facets but no shared source eligibility. The replacement establishes one ruleset per website from an installed complete profile. Additional packages declare supported ruleset IDs and can contribute multiple books. Settings → Add-ons exposes source choices grouped by package; new optional books remain pending and disabled until reviewed. The defining profile remains usable, alternate memberships use any enabled source, and inactive package choices remain stored.

Implementation: [specification](RULES_SOURCES.md), [shared content filtering](../../internal/addons/contentcontract/filter.go), [rules/source policy](../../internal/addons/packagemanager/rules_policy.go), [multi-provider engine](../../../addon-dnd-engine/internal/provider/sources.go), and [installed configuration checks](../../frontend/test/browser/installed-configuration-fixture.mts).

**Implemented decision:** shared effective revisions invalidate cursors, caches and reviewed plans; browsing and rules calculations use the same policy. Compatible rules-data services combine instead of being exclusive. Duplicate record identities and conflicting complete profiles fail visibly. Source/provider changes never recalculate characters or erase decisions and fallback snapshots. Equipment refresh requires matching provenance; changed rules need explicit preview/apply. Broader manual-mode and reconciliation work remains under F17.

#### F08 — Service-provider selection · Implemented

The audited broker had revisioned bindings without an operator workflow. DM settings now expose candidates, active and staged consumers, ambiguity and stale selections, explicit overrides and returning to Automatic. A sole compatible active provider still works without setup. Consumers declaring `all-compatible` combine their providers without an operator override.

Implementation: [selection operations](../../internal/addons/packagemanager/service_selection.go), [admin boundary](../../internal/transport/httpapi/addon_configuration.go), and [configuration controls](../../frontend/src/app/codex-addon-configuration.ts).

**Implemented decision:** reviews bind configuration, graph, consumer-generation and binding revisions. Changes reuse consumer-first shutdown and provider-first recovery. Failed restarts retain the accepted choice and report the failure; ambiguous and stale bindings never silently select another provider. Generic service exclusivity remains enforced. Desktop/phone installed checks cover selection, clear, stale reviews and authorization.

#### F09 — Reviewed add-on uninstall · Implemented

The audited baseline had disable but no uninstall. Settings now offers a separate reviewed uninstall for active, disabled, failed and staged-only packages. Removal unregisters code/services and the update link, disables required dependents transitively and recovers optional consumers. It retains authored data, settings, the instance ruleset and recovery archives.

Evidence: [uninstall specification](PACKAGE_LIFECYCLE.md#reviewed-uninstall), [lifecycle implementation](../../internal/addons/packagemanager/uninstall.go), [manager](../../frontend/src/app/codex-addon-manager.ts), and [installed desktop/phone checks](../../frontend/test/browser/installed-uninstall-fixture.mts).

**Implemented decision:** exact reviews reject concurrent changes; cancellation is inert and repeated confirmation after a lost response acknowledges completion. Failed persistence restores the previous graph; failed restarts after commit remain visible. Retained artifacts do not confer activation authority. Reinstallation requires permission and retained-schema review. Permanent namespace deletion and archive garbage collection remain separate scoped decisions; uninstall does not free archive storage or erase authored records.

#### F10 — Add-on settings contributions · Implemented

The baseline gap was an accepted `settings` declaration without a mounted destination. The owner selected a dropdown inside the owning add-on's card. Settings → Add-ons now uses a lazy, accessible disclosure and the existing integrated/isolated contribution outlet. Players see only their role-visible panels, without admin inventory requests or management controls. No current companion manifest declares a settings panel; this completes the public extension capability without inventing add-on preferences.

Evidence: [settings component](../../frontend/src/app/codex-addon-settings.ts), [public contract](../../examples/addons/API_V3.md#add-on-settings), [implementation and test inventory](BROWSER_ADDONS.md#add-on-settings), and [installed-package tests](../../frontend/test/browser/installed-settings-fixture.mts).

**Implemented behavior:** named, ordered and localized panels; direct add-on settings links; preserved collapsed drafts; dirty/saving guards for category navigation and local lifecycle changes; generation/authority cleanup; and content-sized isolated frames. Add-ons own their controls and durable data through existing APIs and must label personal versus shared scope. Repository secrets remain with the host. There is no new form designer, settings store, data migration, or legacy handler. Reviewed fixture ZIPs cover persistence, both UI modes, role filtering, replacement/disable, retry, and desktop/phone interaction. Forced generation or authority changes can still discard unsaved drafts; saved settings are preserved.

#### F11 — Add-on editor fields and map-pin panel slots lost their host integration · P2

**Implemented September 11:** the current host supports role/grant-filtered `map:pin:panel` and `editor-panel` outlets with bounded `record-context.v1` identity. DM Tools supplies the real read-only map consumer. Editor panels save their own data below the core form; core Save retains dirty add-on panels and reports its own success. Integrated and isolated browser tests cover revision refresh, hidden records, separate failure and draft guards. Arbitrary field injection and combined transactional saves remain deferred. No data migration is required.

**Audited baseline:** V1 mounted additional character editor fields and collected their values on save; it also rendered `map:pin:panel` contributions. V3 can bind `editor-panel` elements and generic slots, but current core editors and map panels contain no corresponding outlets/collection path. A separate add-on article or route is possible, but cannot substitute for these inline integrations without extra work by the add-on author.

Evidence: [old editor-field registration](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addons.js#L337), [old map outlet](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/map.js#L1443), current [record editor](../../frontend/src/app/codex-record-page.ts), [map](../../frontend/src/app/codex-map.ts), and [remaining integration](BROWSER_ADDONS.md#remaining-integration).

**Assessment — split this into two decisions.** A read-only map context slot can add useful local information with a narrow, role-filtered record contract. Restore it when a real contribution is defined. Editable extensions are harder: a single Save implying that core and add-on writes are atomic must actually coordinate those transactions. Start with a clearly owned extension panel and its own save/discard boundary if that meets the consumer's need; add combined save only with server-supported conflict and failure semantics. Defer speculative arbitrary field injection. **Acceptance:** map contributions cannot see hidden fields; an editor contribution cannot report full success after only part of a combined save succeeded.

#### F12 — Custom graph kinds and the reusable graph facade remain unavailable · P2

V1 provided custom node-kind rendering, registered connection kinds consumed by the host, and a bounded `host.graphs` facade for add-on-owned graphs. V3 restores graph views and contributors with host-owned cards, but explicitly leaves custom node-kind renderers and the general graph facade unimplemented; there is also no equivalent live add-on connection-kind registration in the current campaign type resolver. An add-on can ship its own DOM/SVG graph, as DM Tools does, but cannot use these former host services.

Evidence: [old graph registrations](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addons.js#L395), [old bounded graph API](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addon-graph.js), current [graph contract](../../examples/addons/API_V3.md#mind-palace-graph-providers) and [remaining integration](BROWSER_ADDONS.md#remaining-integration).

**Assessment — defer the general facade.** The host graph and DM planner already have working paths; maintaining a reusable rendering framework has a high cost without an identified consumer. If a real use case needs custom connection labels or node appearance, first extend serializable kind metadata and bounded host-owned presentation presets. Preserve unknown kinds and saved edges when a contributor is disabled. A full facade should follow evidence that multiple consumers need the same interaction model, not parity alone. **Acceptance for a narrow extension:** custom kinds render with a safe fallback after removal and require neither raw HTML nor access to a graph-library instance.

### Character Sheets

**September 11 owner-directed revision:** the evidence below describes the audited baseline. The [new character specification](CHARACTER_BUILD_HISTORY.md) supersedes earlier manual-mode and compatibility recommendations, expands F18 beyond sheets, and defines the implementation sequence. **Implemented after the audit:** F13/F14/F16–F20 now use the current character model; F15 is explicitly retired. The descriptions and evidence below remain the original audited baseline, not a description of the resulting runtime.

#### F13 — Dedicated sheet printing / PDF export is absent · P2

The old Settings tab produced a self-contained printable sheet, opened a print window, and invoked the browser's print dialog. The new tools panel supports JSON export/import but has no print action or dedicated print document. Printing the host page is not the former clean character-sheet/PDF workflow.

Evidence: [old print action](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.transfer.js#L31), current [tools panel](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/sheet-element.ts).

**Revised assessment — print a selected saved revision.** Use the shared character projection and presentation formatters for Play and print. Preview A4/Letter output, optional long sections and a build/provenance appendix; include rules status and DM-given markers. Browser print supplies PDF output. **Acceptance:** the selected revision prints without a provider, respects viewer access, excludes unsaved edits and has readable page breaks. See [transfer and printing](CHARACTER_BUILD_HISTORY.md#transfer-and-printing).

#### F14 — Sheet import lost preview, explicit confirmation, immediate undo, and paste input · P1

Previously a file or pasted JSON opened a read-only preview; Confirm applied it and Undo restored the previous sheet. The current file input calls `#importFile`, parses the file, and immediately saves a replacement of the entire sheet. There is no import preview, second confirmation, paste option, or operation-specific undo. Syntax/size/tree validation remains, and server recovery points are separate; neither provides the missing review workflow.

Evidence: [old transfer actions](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.transfer.js#L58), current [`#importFile`, file input, and `replaceState`](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/sheet-element.ts), [parser](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/sheet-transfer.ts).

**Revised assessment — replacement is a history operation.** File and paste use one strict current-format parser and exact section-level preview. Applying the reviewed payload appends a revision rather than discarding the current sheet; undo/restore uses the shared conflict-safe history workflow. Imported actors and DM labels are external claims, never local authority. **Acceptance:** selection never writes, stale confirmation retains the draft, imported DM effects require DM approval, and reversal cannot overwrite later work invisibly. See [transfer and printing](CHARACTER_BUILD_HISTORY.md#transfer-and-printing).

#### F15 — Existing versioned character-sheet export files are rejected · P1

V1 exported `{format:"dnd-sheets.character", version:1, sheet:...}`. The current importer recognizes `{format:"ttrpg-codex.dnd-sheet", version:1, sheet:...}` and raw unwrapped objects, but rejects the actual old versioned envelope. A synthetic old-format file reproduced **“This sheet export format is not supported.”** The current-format control succeeded. Whole-campaign conversion does not provide a UI path for somebody holding one previously exported character file.

Evidence: [old transfer format](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/sheet-transfer.js#L1), current [format check](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/sheet-transfer.ts).

**Owner decision — retire completely.** The owner explicitly confirmed no valuable old sheet data needs preservation. Do not add a legacy importer, converter or renderer; retire old envelopes, raw-object guessing and the sheet-specific old conversion target as the new model replaces them. This does not authorize deleting unrelated campaign data or future character history. **Acceptance:** only the new documented sheet format is accepted; a targeted cutover accounts for the existing schema/data set without a startup bypass. Report the exact deletion scope before any affected operation. See [retirement and data implications](CHARACTER_BUILD_HISTORY.md#retirement-and-data-implications).

#### F16 — Attunement capacity and over-limit feedback disappeared · P2

The old equipment band displayed occupied/available attunement slots, the computed limit, and an over-limit indicator; its slot picker appeared only while room remained. Current equipment displays attuned items and an Add control without consuming the computed `attunement.limit`/`over` values. The engine still calculates and stores this information, but the sheet no longer presents the capacity guidance. This is not a claim that every old inventory action enforced the limit: the loss is the dedicated slot/count/over-limit UI.

Evidence: [old equipment band](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.header.js#L113), current [vitals/equipment rendering](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/play-view.ts) and [equipment actions](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/equipment-state.ts).

**Revised assessment — derived capacity with explicit exceptions.** Show occupied/effective capacity, item eligibility and the rule or DM source of each limit. Enforce ordinary attunement through one engine command. A reduced capacity retains owned items and requires a reviewed attunement choice or recorded DM exception, rather than a silent removal or unrestricted manual bypass. **Acceptance:** normal/full/over-limit/unknown states are clear, all mutation paths agree, and the effects appear in history and explanations. See the [first play slice](CHARACTER_BUILD_HISTORY.md#f16-f19-and-f20-first-complete-play-slice).

#### F17 — Manual mode and provider-change reconciliation no longer guard calculations · P1

V1 withheld its engine from sheet actions when the sheet was manual, its provider identity/edition changed, or materialized values had been manually altered. It offered Keep manual / Resume builder. Current provider diagnostics report identity differences, but offer only rechecking; calculations are gated by engine availability rather than `rulesMode` or reconciliation. For example, `#saveEquipment` can hydrate a manual sheet, and `materializeHydration` writes calculated values and sets `rulesMode = "auto"`.

A synthetic transform changed a manual sheet's AC from 19 to a supplied calculated 12 and changed its mode to auto. The equipment call path was traced statically; no live campaign was changed. This does **not** claim that simply opening the page writes new values.

Evidence: [old provider-state gate](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/model.js#L193), [old choices](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.settings.js#L58), current [provider diagnostics](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/provider-view.ts), [`#saveEquipment`](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/sheet-element.ts), and [materialization](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/engine-client.ts).

**Revised assessment — replace the manual/automatic split.** Store build decisions, acquisitions/DM grants and bounded play state separately from calculated projections. Add durable immutable character revisions, impact previews for earlier-choice changes, dependency-aware reversal and explicit adoption of changed rules. DM-given adjustments have typed effects and server-authenticated provenance; they are not edits to unexplained final values. The implemented replacement preserves play state through explicit change reviews. **Acceptance:** swapping an early decision propagates every supported effect, exposes invalid later choices, preserves unrelated play state and records inputs/results atomically; every saved revision remains reconstructable without executing old engine code. See [the new character model](CHARACTER_BUILD_HISTORY.md#character-model).

#### F18 — Rule-entry links and explanatory stat popovers are missing from sheets · P2

Old spell, feat, feature, and equipment labels linked to provider-owned details when resolvable, with hover/focus explanations. Vitals also explained formulas and their component values. The current sheet renders these labels and numbers as plain elements; the only direct anchor it creates is its download link. The compendium itself and host wiki-reference resolution work, but sheets no longer connect to them. The numerical passive-perception, initiative, and caster DC/attack readouts do survive: compact mode places them in the ability rail, while classic mode uses the vitals area.

Evidence: [old link/tooltip primitive](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/ui.js#L350), [old vitals](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.header.js), current [play view](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/play-view.ts), [spell tools](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/spell-tools.ts), and [workflow view](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/workflow-view.ts).

**Revised assessment — shared rules details everywhere.** Provide a reusable interactive details popover across sheets, Builder/pickers, comparisons, compendium and other rule-consuming surfaces. Put full-entry navigation inside it to prevent accidental page hops. A typed reference contract supplies provenance and safe destinations; the engine supplies explanations from the same evaluation as the visible values. Design both contracts with the history foundation. **Acceptance:** keyboard, hover/focus and touch access work; missing or changed sources are explicit; every displayed mechanical value can explain its components, limits and DM effects. See [the suite-wide F18 scope](CHARACTER_BUILD_HISTORY.md#f18-rules-details-everywhere).

#### F19 — Senses such as darkvision are retained but not displayed · P2

V1's trait summary rendered the senses object with distances. The current trait summary renders languages, resistances, immunities, and proficiencies but omits senses. `traitSnapshot.senses` and materialized computed senses are retained, so the information can exist without being visible on the sheet.

Evidence: [old trait rows](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.sheet.js#L239), current [`combatDetails`](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/play-view.ts), retained [state](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/sheet-state.ts) and [materialized snapshot fields](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/engine-client.ts).

**Revised assessment — share derived trait presentation.** Show senses with meaningful names, distances, units, conditions and contributing sources. Use the same trait projection in both layouts, comparison and print, including saved evidence without a provider. **Acceptance:** unknown and absent senses differ; range/stacking behavior comes from the engine, and changes are traceable to their decisions or DM grants. See the [first play slice](CHARACTER_BUILD_HISTORY.md#f16-f19-and-f20-first-complete-play-slice).

#### F20 — HP editing lost the maximum-HP clamp · P2

Old direct HP editing clamped against effective maximum HP, and lowering maximum HP also clamped current HP. The current plus button increments without a ceiling; direct HP and maximum edits only clamp at zero, and normalization does not enforce `hp <= maxHp`. At 20/20, plus can save 21/20; lowering maximum HP can leave current HP above it. Later engine materialization may clamp it, but ordinary manual editing does not. This is a concrete behavior regression, independent of any damage automation.

Evidence: [old `setField`](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.base.js#L48), current [HP controls](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/play-view.ts) and [normalization](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/src/sheet-state.ts).

**Revised assessment — one rules-owned bounds policy.** Current HP, effective maximum and temporary HP are distinct. Ordinary healing, direct input, rests, imports and restoration use the same validation. A maximum change previews any current-HP correction and saves it with the build revision; increased maximum does not implicitly heal. Unknown bounds do not become zero. Exceptions are explicit typed DM effects. **Acceptance:** normal 20/20 cannot become 21/20, reducing maximum to 15 visibly accounts for 20 → 15, and every adjustment is reversible and explained. See the [first play slice](CHARACTER_BUILD_HISTORY.md#f16-f19-and-f20-first-complete-play-slice).

### DM Tools

#### F21 — Encounter/puzzle reading pages and rendered planning prose are missing · P2

**Implemented September 11:** leaf-item deep links now open a shared planning reader; any saved card also has Read selected. The reader renders stored prose through the public host Markdown component and includes references, incident-flow consequences and shared notes. Edit is explicit, closing returns to saved content, and canvas position/focus survive closing the reader. Desktop/phone installed-package checks cover rendering, unsafe content, persisted edits, direct links and the DM-only map list. Plotline/quest deep links retain canvas navigation. No separate storage or combat system was introduced.

**Audited baseline:** V1 offered dedicated encounter and puzzle detail pages with readable Markdown sections for objective/body, environment or clues, and outcome or solution, alongside references, consequences, and notes. The current planner opens these items in the generic editing modal; its event/branch navigation path selects/edits the item instead of opening a detail reader. The fields survive as textareas, but their formatted at-table reading surface is gone. Canvas navigation, CRUD, annotations, and Import Center remain available.

Evidence: [old detail renderer](https://github.com/pjunak/addon-dm-tools/blob/ec89529ed1b3a85d0fb08f30512b6dffb58071b4/story-planner-render.js#L811), current [open callback and editor](../../../addon-dm-tools/src/planner-element.ts), retained [model fields](../../../addon-dm-tools/src/planning-model.ts).

**Assessment — restore a shared planning reader.** Running an encounter or puzzle calls for legible prose and quick references, not a form full of textareas. Use one reader with kind-specific section labels for objectives, environment/clues, outcomes/solutions, consequences, and notes. Render Markdown through a supported public boundary; keep Edit explicit and preserve canvas position when returning. Direct links should reach the reader, with optional expanded reading for longer material. Reuse the stored planning model instead of creating another copy or a new combat subsystem. **Acceptance:** a DM can run an encounter and read a puzzle solution without entering edit mode or losing planner context.

## Documented transition/design differences

These are real changes in available workflows, but should not be presented as accidental omissions or automatically reversed.

#### D01 — Prebuilt packages and reviewed updates replace source-tree installation

V3 installs reviewed prebuilt ZIPs. GitHub release/Actions discovery and private-repository credentials now work, but a changed source repository alone is insufficient without a compatible package. Updates stage a candidate and require exact-package review; there is no old one-click bulk activation. This is the [package lifecycle](PACKAGE_LIFECYCLE.md), not a reason to compile source in production.

**Implemented September 15 — T12, `1905469`.** Installed package fingerprints and candidate source commits, Actions run/attempt, publication time and bounded plain-text release notes now distinguish packages with matching version labels. Missing metadata is explicit; checks still discover only prebuilt packages. The same details appear in the wizard and update cards, and specific compatibility reasons are visible directly in the activation review. Source metadata never grants activation authority. Backend and English/Czech desktop/phone regressions cover same-version updates, missing metadata, inert notes and blocked approval. Live GitHub account/network acceptance remains an operator check; see the [implemented contract](PACKAGE_LIFECYCLE.md#github-package-sources).

#### D02 — Full archive restore moved out of Settings

Full archive restore is now offline maintenance; old archives require one-time conversion. Online recovery points, restore/delete, and revert-last-N survive. The lost browser upload path is an explicit [backup boundary](BACKUP_RESTORE.md#deliberate-boundary).

**Implemented September 15 — T13, `301bd9e`.** English and Czech Recovery Settings link the [full-backup verification and offline restore runbook](../SELF_HOSTING.md#verify-and-restore-a-full-backup), alongside the existing distinction between campaign recovery points and independent ZIP backups. The runbook identifies included passwords/packages, excluded GitHub tokens, verification, stopped-host replacement and post-restore checks. Real-host desktop/phone regressions verify the accessible link and preserve online recovery, stale-review, uncertain-result and role guards. No production restore was performed.

#### D03 — Players no longer create/list recovery points

Current recovery endpoints and Settings panels are DM-only. This is a narrower [authorization contract](BACKUP_RESTORE.md#campaign-recovery-points), not evidence that players previously downloaded private backups; those downloads were DM-only too. The [old role-filtered snapshot routes](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/server/snapshot-routes.cjs#L14) allowed safe metadata and manual snapshot requests.

**Assessment — keep the current role boundary unless a concrete need appears.** Players benefit from recoverable edits, but campaign-wide recovery administration is usually a DM task. Automatic recovery, local draft protection, and operation-specific undo address the underlying need more directly than a second history panel. Prioritize F01/F14 and clear save feedback. If player-created checkpoints prove useful, define a narrow role-filtered request and bounded retention policy without granting restore or backup download. **Acceptance:** verify the actual player-authorized write paths receive their intended recovery behavior; do not infer that guarantee merely from the existence of recovery points.

#### D04 — Raw renderer services and arbitrary fragment overrides were retired

Built-in compact/classic sheets remain, but the live-object/raw-HTML v2 renderer service and arbitrary fragment replace/hide/wrap operations were deliberately retired. The [sheet guidance](https://github.com/pjunak/addon-dnd-character-sheets/blob/535f35e9b736dfe072aa6f63aca62c37534864dc/AGENTS.md) requires any future renderer to use a reviewed serializable contract. V3 record-renderer declarations are not proof of a working replacement UI.

**Assessment — keep the retirement; solve concrete presentation needs.** Alternative layouts can be useful, but unrestricted replacement makes ownership, accessibility, and upgrades harder to maintain. Improve compact/classic and F13 printing first. Consider bounded presentation options or a typed renderer contract only when an actual consumer cannot fit those surfaces. Separate that from F10/F11 additive contributions. Until a destination exists, describe renderer declarations as unavailable rather than implying support. **Acceptance for a future renderer:** it consumes versioned serializable data, supports provider absence, and cannot silently take over core editing or bypass its save semantics.

#### D05 — Atlas creation and zoom gestures changed

Atlas now opens an unsaved form, with Save/Cancel and four top-level kinds; encounter/puzzle/branch subtypes are selected within it. There is no palette drag-to-create. Zoom now uses Ctrl/Command+wheel; ordinary scroll is retained. These changes are explicitly described in the [current planner README](../../../addon-dm-tools/README.md). They reduce rapid canvas sketching and change familiar gestures, even though creation and zoom exist.

**Assessment — keep the deliberate default; consider an explicit sketching mode.** Creating a complete item through a form avoids accidental placeholder clutter, while rapid placement is useful for outlining. A small optional “Place cards” tool could expose common subtypes directly, create clearly marked minimal cards at the chosen position, offer immediate undo, and stop on Escape. Show when a card is saved and prevent duplicate placement during a pending write. Keep ordinary scroll and explicit zoom controls by default; a browser preference for wheel-to-zoom should apply only while interacting with the canvas. **Acceptance:** normal clicks do not create records, rapid placement is reversible, and touch/keyboard users have equivalent controls. This is an optional enhancement after F21, not a required reversion.

#### D06 — Legacy state requires explicit offline conversion and reconfiguration

[Offline conversion](LEGACY_CONVERSION.md) imports the supported campaign and first-party data into a fresh directory. Credentials and packages are reconfigured; unknown add-on namespaces are inventoried/deferred. Older cross-scope planning flow is converted into references, with consequences reanchored. These are stated conversion boundaries; actual effects on a particular site's data require its conversion report.

**Assessment — keep the conversion boundary; improve accounting and targeted recovery.** A fresh destination and unchanged backup make conversion reviewable. The useful improvement is an actionable inventory of converted, deferred, and unmapped items, with reasons and stable identifiers, plus targeted recovery only when real retained data requires it. F15 is explicitly retired under the owner's no-old-sheet-data decision. Explain semantic transformations such as a former flow becoming a reference, so preservation of bytes is not mistaken for identical behavior. Do not add startup legacy readers or repeat a completed conversion without a reason. **Acceptance:** every input namespace is accounted for, authored input remains untouched, and deferred data has a documented recovery route or explicit unresolved status.

## Verified retained areas and exclusions

The following checks prevent an inflated list of losses:

| Area | Finding |
| --- | --- |
| Compendium source records | **All 3,061 JSON files under `data/` are unchanged** between the pinned old and current revisions. `git diff` identifies only `COVERAGE.md` and `SCHEMA.md` changes there. This proves no authored JSON loss in that tree, not that every record has been visually inspected. |
| Compendium browsing | Topic/book tree, kind selectors, book and kind-specific facets, sort choices, ranked search, paging/expanded results, Markdown details, class/subclass composition, wiki references and old bookmarks have current implementations. Shared sourcebook eligibility is now implemented under F07, distinct from browse filtering. |
| Rules engine | Ran `go test ./internal/rules -run '^TestPreservedV1Parity$' -count=1`: passed. Its **144 preserved cases** comprise 119 hydrate, 16 builder-plan, eight apply, and one reconcile case. Universal derivation and generic catalog operations have current equivalents. No additional missing engine computation feature was established in this audit. |
| Host campaign data/editing | The typed record families, party, character knowledge/relationships/rank/portraits, mystery questions, faction rank chains, location links, and historical events have current editor/projection paths. Unknown-field preservation and optimistic revisions remain explicit contracts. This is source coverage, not a fresh visual test of every editor. |
| Maps/timeline/Mind Palace | World/local map media and placement, saved views, marker types/icons/glow/zoom scaling, event-only pins and paths, timeline session columns/reordering, and Mind Palace drag/filter/focus/layout persistence have implementations. F05 and F12 identify narrower losses. |
| Settings and access | English/Czech language, appearance, branding, sidebar configuration, party settings, enums, credentials, login/logout and player preview remain. Some role boundaries deliberately changed; see D03. |
| Recovery | Downloadable current backups, manual and automatic recovery points, reviewed point restore/delete, and revert-last-N remain. No loss of those whole workflows was established. |
| Add-on lifecycle | Upload, inspection, permission/compatibility review, activate, disable, reload, generation history/rollback, integrated/isolated UI and native workers remain. GitHub updates/private sources were just restored. Source/provider selection and uninstall are now implemented; remaining extension outlets are tracked above. |
| DM Tools planning/import | Nested scopes, same-parent flows, group/rectangle selection, group drag, grid movement, zoom ladder, fullscreen, subtree deletion/undo, links/consequences/shared notes, live refresh, and reviewed format-routed imports remain. F21 now supplies the shared saved-content reader and DM-only related-planning map links. |
| Sheet builder/play | Standalone editing, compact/classic selection, builder foundations/progression, equipment selection/batch save, spell learning/copying/swaps/grant casts, resources, rests and saved fallback data have current implementations. F13–F20 identify omissions inside these otherwise present workflows. |
| Earlier retirements | Location-status/artifact-state categories, zoom-priority pin hiding, and an unrouted CloudMap timeline mode were already retired or unreachable in the chosen legacy baseline. Do not call them rewrite losses. |
| Unused old helpers | The old `applyHpChange` temporary-HP absorption helper was referenced only by tests, not the actual UI. Likewise, `overrideControls` was exported but had no rendering call site in the pinned old sheet. Their absence from today's UI does not prove a newly lost usable feature; neither is counted. Current lack of override editing may still merit separate product work. |

## Verification gaps and documentation findings

#### V01 — Broad completion checks do not establish action-level parity

At audit time, release-gate checkboxes were closed while source selection, uninstall, settings/editor outlets and graph capabilities remained deferred. Source selection, uninstall, settings disclosures and the narrow F11 outlets have since been implemented; graph extensions and the other deferred findings remain. The [release-check script](../../scripts/check-release-readiness.mts) checks checkbox/marker state, not whether every legacy action has a working replacement.

**Assessment — improve traceability, not checkbox volume.** Use the existing backlog to associate each accepted workflow decision with its expected user outcome and focused evidence. Distinguish implemented, deliberately redesigned/retired, and deferred after the maintainer adopts the decision; the recommendations here are not that approval. Link unsupported public declarations to their actual status. This prevents infrastructure checks from becoming an accidental product-completeness claim without changing the accepted deployment policy.

#### V02 — Installed-package/browser acceptance remains separate

The latest host check from the immediately preceding restoration passed its unit/browser/Go gates, but skipped 39 optional companion-package browser cases. That is not proof those features are broken, and it does not validate the missing actions. The source audit reran only the focused engine comparison and synthetic probes. No production data, browser sessions, credentials, or live GitHub downloads were used. This recommendation revision changes documentation only.

**Assessment — test complete changed workflows on installed packages.** For each implementation, cover its meaningful success, cancellation, conflict, and provider-loss states through the real package lifecycle, with relevant DM/player, desktop/phone, and English/Czech coverage. Reuse existing gates and representative fixtures; do not require a new exhaustive every-screen matrix for each small fix. Keep skipped companion cases visible in the handoff rather than describing the entire suite as verified.

#### V03 — Preserved engine vectors cover a bounded set

The 144 cases do not exhaust every combination of class, subclass, feat, spell, resource, equipment and provider transition. In particular, they do not test the UI's manual/reconciliation policy in F17.

**Assessment — add cases at the boundaries where failures were found.** Retain the preserved vectors and add meaningful tests for manual equipment edits, changed-provider approval, source-policy revision changes, and stale import/undo decisions as those features are implemented. Test their visible stored outcomes, not just helper return shapes. Expanding every possible rules combination would be expensive and would still not catch a UI that calls the engine when it should not. No additional missing engine computation was established by this audit.

#### V04 — Site-specific migration effects remain unverified

The comparison proves source-level behavior and content-tree preservation, not that every deployed ZIP matches these checkouts, every old bookmark resolves in a real campaign, or every deferred third-party namespace was converted.

**Assessment — reuse existing operational evidence.** When site verification is in scope, start with installed package identities and the existing conversion report, then inspect unresolved entries and a representative set of bookmarks/workflows. Another conversion or deployment is not necessary to complete this report. Keep a site's unresolved data distinct from a confirmed source regression, and record whether an item needs a converter, package update, or manual configuration.

<a id="recommended-delivery-order-and-boundaries"></a>

## Historical September 11 delivery recommendations

1. **Establish the new character foundation.** Follow the [character implementation sequence](CHARACTER_BUILD_HISTORY.md#implementation-sequence-and-ownership): authoritative retained revisions, typed decisions and DM grants, structured constraints and explanations. F17 replaces the old manual-mode proposal; F18 begins in these contracts.
2. **Prove one complete character flow, then expand coverage.** Creation, an early-choice swap, dependency review, commit, history and restoration must work together. Include attunement (F16), senses (F19), HP bounds (F20) and contextual explanations before expanding across all build/play mechanics.
3. **Complete shared reading and transfer.** Apply F18 throughout the suite, then finish current-format reviewed import (F14) and revision-based printing (F13). F15 is an approved retirement; no old-sheet compatibility work remains.
4. **Retain completed work and explicit operational boundaries.** F01–F05, F07–F11 and F21 are implemented. Source/provider selection does not automatically adopt new character rules. Archive garbage collection, permanent data deletion and deployment remain separate decisions.
5. **Keep unrelated work deferred.** F06's restart button, F12's facade and broader combined editor transactions remain deferred. D01–D06 improvements retain their documented boundaries; Atlas rapid placement and gesture preferences are separate enhancements.

The initial implementation scope should avoid a generic form designer, a new graph framework, server-side PDF infrastructure, live legacy compatibility, and cross-package atomic bulk updates. Each would add substantial maintenance beyond the workflow that motivated the finding. Reassess them only against a concrete need that the smaller designs cannot meet.

The suite's actionable tracking remains in [BACKLOG.md](../BACKLOG.md); this report records the evidence and baseline, rather than creating a second backlog.

## Accepted product-parity release gates

These 33 outcomes were accepted for the September 9 personal-site cutover and
moved unchanged from the backlog on September 14. They record faithful ports,
accepted redesigns or explicit retirements; they do not close later findings.
Current open work belongs only in [the repository sections of BACKLOG.md](../BACKLOG.md).
`npm run release-check` reads this block and still rejects incomplete gates or
`frontend/REWRITE_INCOMPLETE`. Relocation changes no accepted outcome.

The owner's policy permits outages, post-launch fixes and rollback. Preserve
original backups and use a short first-start smoke check for an authorized
cutover; do not repeat conversion because planning documents were reorganized.

<!-- product-parity-gates:start -->

### Core campaign experience

- [x] Mount a real responsive application shell with login/logout, DM/player
  projection switching, live refresh, safe core routes, and authenticated
  route, dashboard-slot, sidebar, and record-article add-on outlets.

- [x] Restore the campaign dashboard, party overview, entity cards, portraits,
  badges, and attitude presentation with responsive DM/player behavior.

- [x] Restore dedicated browsing, article viewing, and safe common-field
  create/edit/delete for characters, locations, events, mysteries, factions,
  deities, artifacts, history, and companions without losing unknown or
  add-on-owned fields.

- [x] Restore canonical typed fields for tags and fact lists, scalar and
  multi-record references, attitudes, companion ownership, location hierarchy,
  event links, and role-safe preservation of references hidden from players.

- [x] Restore structured relationship editing with atomic identity changes,
  character ranks and location roles, mystery questions, and stable faction
  rank chains while retaining extension data attached to stable nested IDs.

- [x] Complete collection-specific map fields alongside the rebuilt spatial
  workflows so coordinate and image controls share one authoritative editor.

- [x] Protect dirty record forms across archive navigation, role switching,
  sign-out, cancellation, and browser unload.

- [x] Restore wiki article rendering and editing, sanitized Markdown, headings
  and table of contents, and cross-record wiki links.

- [x] Restore campaign-wide search with useful type grouping and navigation.

- [x] Establish typed bundled English and Czech catalogs, per-browser language
  selection, native plural/date handling, and migrate the shell, dashboard,
  search, and personal settings foundation.

- [x] Complete the English and Czech catalog migration for record pages and
  editors, structured campaign settings, host errors, and first-party add-on
  surfaces.

- [x] Restore campaign-wide appearance selection with classic and moonlit token
  themes, flash-free cached boot, and DM-owned optimistic persistence.

- [x] Audit shared tokens and keyboard/focus behavior on record and add-on
  surfaces.

- [x] Review representative converted campaign pages against the preserved UI
  on desktop and phone.

- [x] Restore the DM dashboard and true player-view preview workflow.

### Spatial, temporal, and relationship workflows

- [x] Restore the world map and location sub-maps, image/tile preparation,
  markers, marker artwork, saved views, zoom behavior, and map editing.

- [x] Restore multi-attitude marker/card glows and event-path overlays.

- [x] Restore the session timeline, drag ordering, and timeline editing.

- [x] Restore faction, relationship, and mystery graph views with position
  persistence and their former navigation/detail behavior.

### Administration and recovery

- [x] Restore DM-facing shared campaign enum management for relationships,
  genders, map markers, character statuses, event priorities, and attitudes,
  including stable IDs, usage counts, and explicit replace-or-clear deletion.

- [x] Finish persisted-settings compatibility for converted campaigns.

- [x] Restore the useful recovery-point workflow: manual points, coalesced write
  snapshots, restore, and revert-last-N, while retaining verified full backup.

- [x] Provide reviewed runtime credential rotation.

- [x] Provide the DM-facing add-on inspector, permission approval, activation,
  update/reload, failure diagnosis, and rollback UI over the implemented APIs.

### First-party add-ons

- [x] Bring DM Tools planner interaction and editing to accepted parity,
  including graph navigation, card/flow authoring, annotations, and browser
  regression coverage; complete the reviewed Import Center workflow.

- [x] Restore standalone compendium browsing and reading: the preserved topic/
  source tree, class/subclass/level nesting, tiles, deep cross-kind search,
  counted filters and sorting, complete Markdown/tables, composed class features,
  monster stat blocks, related records and sourcebook links.

- [x] Restore campaign-article compendium wiki references and external v1
  compendium hashes through the documented `wiki-kind` / `wiki-links.v1`
  provider.

- [x] Differentially validate the Go rules engine against preserved v1 rules and
  builder fixtures, including missing-provider and changed-provider behavior.

- [x] Bring character sheets to accepted presentation and workflow parity,
  including the fate of Compact/Classic layouts, builder progress, equipment,
  spells, resources, and provider-state diagnostics.

### Release evidence

- [x] Build and inspect all four release ZIPs and exercise their basic installed
  workflows.

- [x] Convert each site's backup once into a fresh directory and review its
  report, record counts, representative media, sheets, and planning data.

- [x] Accept the owner's personal-site deployment policy: outages and rollback
  are acceptable.

- [x] Remove `frontend/REWRITE_INCOMPLETE` only after every earlier gate is
  closed and the owner chooses to deploy the replacement.

<!-- product-parity-gates:end -->
