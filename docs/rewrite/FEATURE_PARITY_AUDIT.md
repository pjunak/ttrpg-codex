# Rewrite feature-parity audit and product assessment

Audited September 10–11, 2026; product recommendations revised September 11, 2026. This compares preserved source revisions with the audited local source, not a production-site inspection.

**Audited baseline: 21 confirmed missing or reduced capabilities, six documented transition/design differences, and four verification gaps.** Every item below includes an assessment of its usefulness and a recommended direction. Missing does not automatically mean worth restoring in its old form. The original audit made no runtime or deployment changes; subsequent implementation is recorded below. These proposals do not create new deployment gates.

**September 11 implementation update:** F01–F05 are implemented through [shared Markdown recovery and collection browsing](EDITOR_BROWSING.md) and [quick search, activity summaries and focused map editing](SEARCH_ACTIVITY_MAP.md). F07–F08 are implemented through [instance rules, sourcebooks and providers](RULES_SOURCES.md), following the owner's decision to use one ruleset per website with compatible books from multiple add-ons. F09 is implemented through [reviewed uninstall with retained data](PACKAGE_LIFECYCLE.md#reviewed-uninstall). F10 is implemented through [settings disclosures inside each add-on card](BROWSER_ADDONS.md#add-on-settings). F11 is implemented as [read-only map context and independently saved editor panels](BROWSER_ADDONS.md#record-panels-and-planning-prose); F21 adds the shared DM Tools reader. F13/F14/F16–F20 are implemented through [character decisions, retained history and shared rules details](CHARACTER_BUILD_HISTORY.md). F15 compatibility is removed with a documented offline retirement boundary; F06/F12 remain deferred. New work uses the current architecture, with no new legacy handlers or retained legacy features. Report concrete data-loss risks before an affected operation; otherwise proceed within scope. The owner confirmed that no valuable old sheet data needs preservation; no old-sheet compatibility is planned. No production changes are part of this implementation.

The character implementation replaces the manual/automatic split with reversible decisions, calculated results, authenticated DM grants and reviewed rules updates. F18 uses shared contextual details across the host, compendium and sheet surfaces. Saved revisions remain readable without rules providers. Validation and remaining manual acceptance boundaries are recorded in the [implemented specification](CHARACTER_BUILD_HISTORY.md#verification-result). The GitHub installation/update/private-repository workflow was restored in host commit `8711085`; it is **not counted as still missing**.

## Recommended decisions at a glance

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

**Assessment — keep the architecture; improve update clarity.** Direct GitHub updates and private sources are useful and have already been restored. Show installed versus available version/build, release notes, source identity, and why a candidate is unavailable or incompatible. Clearly distinguish “source changed” from “installable update available.” Keep credentials repository-scoped and outside package data. A future queue could check several sources and present individual reviews in dependency order, without pretending activation across all packages is atomic. **Acceptance:** the user can discover, review, and activate a compatible private or public package from the UI; an unbuilt commit is explained rather than presented as an installable update.

#### D02 — Full archive restore moved out of Settings

Full archive restore is now offline maintenance; old archives require one-time conversion. Online recovery points, restore/delete, and revert-last-N survive. The lost browser upload path is an explicit [backup boundary](BACKUP_RESTORE.md#deliberate-boundary).

**Assessment — keep offline whole-site restore; make the route discoverable.** Recovery points cover ordinary editing mistakes with less disruption than replacing an entire installation. Whole archives also contain configuration and add-on state, so a supervised stopped-host restore remains appropriate. Settings should distinguish “Undo campaign changes” from “Recover an installation,” explain which backup is required, and link to the current verification/restore runbook. Do not build a second live archive replacement path solely for parity. **Acceptance:** an operator can identify the correct recovery method and follow documented verification before replacement; ordinary recovery remains accessible in the UI.

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

## Recommended delivery order and boundaries

1. **Establish the new character foundation.** Follow the [character implementation sequence](CHARACTER_BUILD_HISTORY.md#implementation-sequence-and-ownership): authoritative retained revisions, typed decisions and DM grants, structured constraints and explanations. F17 replaces the old manual-mode proposal; F18 begins in these contracts.
2. **Prove one complete character flow, then expand coverage.** Creation, an early-choice swap, dependency review, commit, history and restoration must work together. Include attunement (F16), senses (F19), HP bounds (F20) and contextual explanations before expanding across all build/play mechanics.
3. **Complete shared reading and transfer.** Apply F18 throughout the suite, then finish current-format reviewed import (F14) and revision-based printing (F13). F15 is an approved retirement; no old-sheet compatibility work remains.
4. **Retain completed work and explicit operational boundaries.** F01–F05, F07–F11 and F21 are implemented. Source/provider selection does not automatically adopt new character rules. Archive garbage collection, permanent data deletion and deployment remain separate decisions.
5. **Keep unrelated work deferred.** F06's restart button, F12's facade and broader combined editor transactions remain deferred. D01–D06 improvements retain their documented boundaries; Atlas rapid placement and gesture preferences are separate enhancements.

The initial implementation scope should avoid a generic form designer, a new graph framework, server-side PDF infrastructure, live legacy compatibility, and cross-package atomic bulk updates. Each would add substantial maintenance beyond the workflow that motivated the finding. Reassess them only against a concrete need that the smaller designs cannot meet.

The suite's actionable tracking remains in [BACKLOG.md](../BACKLOG.md#feature-parity-audit-follow-up-2026-09-11); this report records the evidence and baseline, rather than creating a second backlog.
