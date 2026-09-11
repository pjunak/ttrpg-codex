# Rewrite feature-parity audit and product assessment

Audited September 10–11, 2026; product recommendations revised September 11, 2026. This compares preserved source revisions with the audited local source, not a production-site inspection.

**Audited baseline: 21 confirmed missing or reduced capabilities, six documented transition/design differences, and four verification gaps.** Every item below includes an assessment of its usefulness and a recommended direction. Missing does not automatically mean worth restoring in its old form. The original audit made no runtime or deployment changes; subsequent implementation is recorded below. These proposals do not create new deployment gates.

**September 11 implementation update:** F01–F05 are now implemented in the host through [shared Markdown recovery and collection browsing](EDITOR_BROWSING.md) and [quick search, activity summaries and focused map editing](SEARCH_ACTIVITY_MAP.md). The other 16 baseline findings retain their assessments or conditional decisions; they are not all approved implementation work. The owner directs new work entirely within the current architecture, with no new legacy handlers or retained legacy features. Report concrete data-loss risks before an affected operation; otherwise proceed within the requested scope. In particular, F15's original converter recommendation is superseded by the narrower data-preservation decision below. No production changes are part of this implementation.

The strongest remaining priorities are protecting manual character values, reviewing sheet replacements, and controlling campaign rules sources. Markdown recovery is implemented; old exported sheets warrant a data-risk report if encountered, rather than default compatibility work. Several smaller reading and play controls merit early delivery. Provider selection matters when a campaign actually has competing providers; a general graph framework and web-triggered server restart have less immediate value. The GitHub installation/update/private-repository workflow reported immediately before this audit was restored in host commit `8711085`; it is **not counted as still missing**.

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
| F07 | Effective sourcebook selection | High | Redesign as campaign rules policy | Large |
| F08 | Service-provider selection | High when selection is required | Expose conflict resolution; keep automatic defaults | Medium |
| F09 | Add-on uninstall | High for operator control | Separate package removal from data purge | Large |
| F10 | Contributed settings destination | Medium; extension contract gap | Complete a minimal role-aware outlet | Medium |
| F11 | Editor and map-panel contributions | Conditional on a real consumer | Split read context from transactional editing | Medium / large |
| F12 | Graph kinds and reusable facade | Conditional; bundled planner already works | Defer facade; add narrow metadata only on demand | Large for facade |
| F13 | Clean sheet printing/PDF | High for physical tables and fallback | Restore a dedicated print view | Medium |
| F14 | Reviewed sheet import and undo | High | Redesign as exact replacement review | Medium |
| F15 | Old sheet export compatibility | Conditional data-preservation risk | Report affected originals; no default compatibility code | Case-dependent |
| F16 | Attunement capacity feedback | High, focused play aid | Restore advisory counts and warnings | Small |
| F17 | Manual mode and reconciliation | Highest correctness priority | Gate every calculation; review changed rules | Medium–large |
| F18 | Rule links and stat explanations | High at the table | Restore navigation first; add structured explanations | Medium / large |
| F19 | Senses display | High, focused play aid | Restore from existing saved values | Small |
| F20 | HP range behavior | High, focused correctness fix | Restore consistent normal limits with explicit exceptions | Small–medium |
| F21 | Encounter/puzzle reader | High when running sessions | Restore a shared planning reader | Medium |

Across these recommendations, campaign policy belongs in shared campaign state; personal browsing preferences belong in the browser. Preserve hand-filled data, optional-provider behavior, and optimistic revisions. Prefer existing host services and small shared components over new frameworks. Do not import legacy raw-HTML or live-object extension boundaries to recover a useful screen.

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

#### F07 — Campaign sourcebook enable/disable is missing · P1

Previously the manager displayed a checkbox for each declared content group/book. Disabling a group removed its records from effective content and rules hydration, respecting alternate source membership. The current compendium has browse filters by book, but those only filter the displayed list. The host content index has no source enable/disable policy; all packaged records remain eligible. A DM cannot restrict the campaign's rules sources through the UI, and old disabled-group choices have no effective-policy replacement.

Evidence: [old manager controls and mutation](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/settings.js#L1912), current [content boundary explicitly deferring this policy](CONTENT.md#current-boundary-and-next-layers), current [compendium browse filters](../../../addon-dnd-2024-compendium/src/browse.ts). This is a documented deferral, not an implemented replacement.

**Assessment — redesign as campaign rules policy.** This is essential for a DM choosing which books a campaign permits. Store shared selections in the host and expose one effective revision to browsing and rules consumers. Show declared dependencies and alternate book membership; do not hard-code book IDs or allow an unexplained invalid base profile. Review initial selections explicitly, preserve them across updates, and require a decision for newly added books. Disabling a source should remove new eligible choices while preserving existing character selections/snapshots and flagging them for review under F17. Avoid silently rebuilding characters or erasing their choices. **Acceptance:** changing policy invalidates stale content/results and reviewed plans; alternate allowed sources remain usable; existing characters retain their authored state. This requires host, compendium, engine, and sheet coordination.

#### F08 — No operator UI/API to select a service provider · P1

The old manager let the DM select or clear a provider for a single-provider service, including ambiguous and stale selections. The current broker implements revisioned `SetBinding`, but its calls are confined to tests; no application/admin endpoint or manager control exposes it. A sole compatible provider can still bind automatically. When operator selection is required, the missing end-to-end path prevents resolving it through the product.

Evidence: [old selector and save action](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/settings.js#L1992), current [broker](../../internal/addons/servicebroker/broker.go), [admin routes](../../internal/transport/httpapi/addons.go), and [manager](../../frontend/src/app/codex-addon-manager.ts).

**Assessment — expose conflict resolution, with automatic defaults.** This is a central operator control when multiple compatible providers require a choice, but not a setting every campaign should have to understand. Keep sole-provider automatic binding. In add-on diagnostics, show the current provider and offer selection only for ambiguity or an advanced override, plus “Use automatic selection.” Candidates and stale-selection reasons must come from the broker. Selection cannot bypass exclusive-provider installation rules. Use revision checks and the established dependent lifecycle when changing bindings. **Acceptance:** a DM can resolve ambiguity and clear a missing selection; a campaign with one provider needs no extra setup.

#### F09 — Installed add-ons cannot be removed · P2

The old manager had Remove and a DELETE endpoint. The current product exposes staging, review, activation, reload, disable, and rollback, but no uninstall operation. Disabling leaves the installed package/generations registered; it does not complete the old removal workflow. The backlog explicitly defers separately reviewed uninstall/data deletion.

Evidence: [old Remove action](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/settings.js#L2052), current [lifecycle interface/routes](../../internal/transport/httpapi/addons.go), [manager](../../frontend/src/app/codex-addon-manager.ts), and [follow-ups](../BACKLOG.md#feature-parity-audit-follow-up-2026-09-11).

**Assessment — restore removal with separate retention choices.** Users need to remove experiments, retire providers, and manage installed code. Default uninstall should stop and unregister the package while retaining its campaign data. Present affected consumers and allow cancellation before any transition. Make permanent data deletion a separate reviewed action with a namespace inventory, rather than a preselected checkbox. Retain generation artifacts still required by supported recovery references; garbage collection needs its own eligibility rules. Reinstallation must validate retained data against the package schema. **Acceptance:** uninstall leaves dependent add-ons in a clear supported state, preserves retained data, and does not mistake a failed update for a request to delete it.

#### F10 — Add-on settings contributions have no Settings destination · P2

Old `registerSettingsTab` contributions appeared under Settings → Add-ons, including role-appropriate player tabs. V3 accepts and binds a `settings` surface, but the application does not mount a settings outlet. Current Settings → Add-ons renders only the host manager. A valid contributed settings element therefore has no normal user destination.

Evidence: [old settings registration](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addons.js#L255), current [surface declarations](../../frontend/src/addons/generation-manager.ts), [settings component](../../frontend/src/app/codex-settings.ts), and [remaining integration](BROWSER_ADDONS.md#remaining-integration). This affects the public extension capability; it does not establish that a bundled add-on currently requires such a tab.

**Assessment — complete the small public integration.** A declared settings surface with no destination misleads add-on authors. Provide named contributed sections under Settings → Add-ons, with direct navigation, role filtering, dirty-state handling, and correct disposal on replacement. Hide the contributed area when empty. Distinguish personal preferences from shared campaign settings, and leave repository secrets with the host credential manager. No generic form designer is needed. Schedule this after current data-protection issues; meanwhile document the unavailable outlet explicitly. **Acceptance:** a fixture contribution mounts and saves in integrated and isolated modes for its allowed role, and disappears cleanly when disabled.

#### F11 — Add-on editor fields and map-pin panel slots lost their host integration · P2

V1 mounted additional character editor fields and collected their values on save; it also rendered `map:pin:panel` contributions. V3 can bind `editor-panel` elements and generic slots, but current core editors and map panels contain no corresponding outlets/collection path. A separate add-on article or route is possible, but cannot substitute for these inline integrations without extra work by the add-on author.

Evidence: [old editor-field registration](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addons.js#L337), [old map outlet](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/map.js#L1443), current [record editor](../../frontend/src/app/codex-record-page.ts), [map](../../frontend/src/app/codex-map.ts), and [remaining integration](BROWSER_ADDONS.md#remaining-integration).

**Assessment — split this into two decisions.** A read-only map context slot can add useful local information with a narrow, role-filtered record contract. Restore it when a real contribution is defined. Editable extensions are harder: a single Save implying that core and add-on writes are atomic must actually coordinate those transactions. Start with a clearly owned extension panel and its own save/discard boundary if that meets the consumer's need; add combined save only with server-supported conflict and failure semantics. Defer speculative arbitrary field injection. **Acceptance:** map contributions cannot see hidden fields; an editor contribution cannot report full success after only part of a combined save succeeded.

#### F12 — Custom graph kinds and the reusable graph facade remain unavailable · P2

V1 provided custom node-kind rendering, registered connection kinds consumed by the host, and a bounded `host.graphs` facade for add-on-owned graphs. V3 restores graph views and contributors with host-owned cards, but explicitly leaves custom node-kind renderers and the general graph facade unimplemented; there is also no equivalent live add-on connection-kind registration in the current campaign type resolver. An add-on can ship its own DOM/SVG graph, as DM Tools does, but cannot use these former host services.

Evidence: [old graph registrations](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addons.js#L395), [old bounded graph API](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addon-graph.js), current [graph contract](../../examples/addons/API_V3.md#mind-palace-graph-providers) and [remaining integration](BROWSER_ADDONS.md#remaining-integration).

**Assessment — defer the general facade.** The host graph and DM planner already have working paths; maintaining a reusable rendering framework has a high cost without an identified consumer. If a real use case needs custom connection labels or node appearance, first extend serializable kind metadata and bounded host-owned presentation presets. Preserve unknown kinds and saved edges when a contributor is disabled. A full facade should follow evidence that multiple consumers need the same interaction model, not parity alone. **Acceptance for a narrow extension:** custom kinds render with a safe fallback after removal and require neither raw HTML nor access to a graph-library instance.

### Character Sheets

#### F13 — Dedicated sheet printing / PDF export is absent · P2

The old Settings tab produced a self-contained printable sheet, opened a print window, and invoked the browser's print dialog. The new tools panel supports JSON export/import but has no print action or dedicated print document. Printing the host page is not the former clean character-sheet/PDF workflow.

Evidence: [old print action](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.transfer.js#L31), current [tools panel](../../../addon-dnd-character-sheets/src/sheet-element.ts).

**Assessment — restore a dedicated print view.** This supports physical-table use, sharing a character, and a fallback when the app is unavailable. Render one consistent saved sheet snapshot with a paper-friendly layout and optional long sections such as spells and notes. Reuse display formatting, remove editing chrome, and invoke the browser's print dialog after preview; a separate server PDF renderer is unnecessary for this scope. It must work from materialized data without an engine provider and include only the viewer's authorized fields. **Acceptance:** A4/Letter previews have readable page breaks and no clipped essential values, including in manual mode and with long spell lists.

#### F14 — Sheet import lost preview, explicit confirmation, immediate undo, and paste input · P1

Previously a file or pasted JSON opened a read-only preview; Confirm applied it and Undo restored the previous sheet. The current file input calls `#importFile`, parses the file, and immediately saves a replacement of the entire sheet. There is no import preview, second confirmation, paste option, or operation-specific undo. Syntax/size/tree validation remains, and server recovery points are separate; neither provides the missing review workflow.

Evidence: [old transfer actions](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.transfer.js#L58), current [`#importFile`, file input, and `replaceState`](../../../addon-dnd-character-sheets/src/sheet-element.ts), [parser](../../../addon-dnd-character-sheets/src/sheet-transfer.ts).

**Assessment — redesign as deliberate replacement.** Replacing an authored character is consequential enough to warrant one clear review step. File and paste input should share parsing and a section-level preview showing changed and removed content. Bind confirmation to the exact reviewed payload and opening sheet revision, preserve unknown supported fields, and save the previous state for bounded undo. An undo must check that no later edit would be overwritten; otherwise retain a comparison/export recovery path. Avoid silently merging two characters or adding a large import wizard. **Acceptance:** selecting a file never writes; stale confirmation fails without losing the draft; undo cannot erase somebody's subsequent change.

#### F15 — Existing versioned character-sheet export files are rejected · P1

V1 exported `{format:"dnd-sheets.character", version:1, sheet:...}`. The current importer recognizes `{format:"ttrpg-codex.dnd-sheet", version:1, sheet:...}` and raw unwrapped objects, but rejects the actual old versioned envelope. A synthetic old-format file reproduced **“This sheet export format is not supported.”** The current-format control succeeded. Whole-campaign conversion does not provide a UI path for somebody holding one previously exported character file.

Evidence: [old transfer format](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/sheet-transfer.js#L1), current [format check](../../../addon-dnd-character-sheets/src/sheet-transfer.ts).

**Revised decision — preserve data without adding default compatibility.** The owner's direction supersedes the original suggestion to add a per-sheet converter and legacy-marker handler. Existing exports may contain authored work that is inaccessible to the current importer, but rejecting a file does not delete it. Keep current-format imports strict. If a requested operation encounters old exported data, identify the affected files and report the preservation risk before changing or removing them. Any concrete recovery action must preserve originals and produce reviewed current-format data; there is no standing task to add a legacy reader, importer, or converter. Changing only a format string is not evidence of compatibility. **Acceptance:** ordinary current-format work proceeds, unsupported inputs remain untouched, and actual data-loss risks are disclosed.

#### F16 — Attunement capacity and over-limit feedback disappeared · P2

The old equipment band displayed occupied/available attunement slots, the computed limit, and an over-limit indicator; its slot picker appeared only while room remained. Current equipment displays attuned items and an Add control without consuming the computed `attunement.limit`/`over` values. The engine still calculates and stores this information, but the sheet no longer presents the capacity guidance. This is not a claim that every old inventory action enforced the limit: the loss is the dedicated slot/count/over-limit UI.

Evidence: [old equipment band](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.header.js#L113), current [vitals/equipment rendering](../../../addon-dnd-character-sheets/src/play-view.ts) and [equipment actions](../../../addon-dnd-character-sheets/src/equipment-state.ts).

**Assessment — restore guidance, not an inflexible gate.** Used/available attunement slots answer a common play question with little UI cost. Consume the existing computed limit and show a clear over-limit warning beside the items. Keep imported or house-rule equipment intact and allow a deliberate exception; do not silently drop an item or duplicate edition rules in the sheet. Without a known limit, display that limitation rather than inventing a default. **Acceptance:** normal, full, over-limit, and unavailable-provider states are understandable; a warning does not make a hand-filled character unusable.

#### F17 — Manual mode and provider-change reconciliation no longer guard calculations · P1

V1 withheld its engine from sheet actions when the sheet was manual, its provider identity/edition changed, or materialized values had been manually altered. It offered Keep manual / Resume builder. Current provider diagnostics report identity differences, but offer only rechecking; calculations are gated by engine availability rather than `rulesMode` or reconciliation. For example, `#saveEquipment` can hydrate a manual sheet, and `materializeHydration` writes calculated values and sets `rulesMode = "auto"`.

A synthetic transform changed a manual sheet's AC from 19 to a supplied calculated 12 and changed its mode to auto. The equipment call path was traced statically; no live campaign was changed. This does **not** claim that simply opening the page writes new values.

Evidence: [old provider-state gate](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/model.js#L193), [old choices](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.settings.js#L58), current [provider diagnostics](../../../addon-dnd-character-sheets/src/provider-view.ts), [`#saveEquipment`](../../../addon-dnd-character-sheets/src/sheet-element.ts), and [materialization](../../../addon-dnd-character-sheets/src/engine-client.ts).

**Assessment — fix the guard first, then improve reconciliation.** Manual means calculations cannot take control because a provider happens to be present. Centralize that policy across equipment, builder, and other materialization entry points while allowing ordinary authored play edits. For a changed provider, rules revision, or future source policy, offer “Keep manual” or a review showing affected calculated values and unresolved selections before resuming automation. Bind approval to the current sheet and rules revisions and preserve HP, inventory, currency, and other authored play state. Do not repeatedly prompt on unchanged state. When someone edits a calculated value, offer switching to manual mode so their entry is retained; field-specific automatic-mode overrides require defined precedence and are later design work, not a proven lost legacy UI. **Acceptance:** editing equipment on a manual AC-19 sheet preserves its AC and mode; manually entered calculated values remain protected; accepting recalculation changes only reviewed values.

#### F18 — Rule-entry links and explanatory stat popovers are missing from sheets · P2

Old spell, feat, feature, and equipment labels linked to provider-owned details when resolvable, with hover/focus explanations. Vitals also explained formulas and their component values. The current sheet renders these labels and numbers as plain elements; the only direct anchor it creates is its download link. The compendium itself and host wiki-reference resolution work, but sheets no longer connect to them. The numerical passive-perception, initiative, and caster DC/attack readouts do survive: compact mode places them in the ability rail, while classic mode uses the vitals area.

Evidence: [old link/tooltip primitive](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/ui.js#L350), [old vitals](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.header.js), current [play view](../../../addon-dnd-character-sheets/src/play-view.ts), [spell tools](../../../addon-dnd-character-sheets/src/spell-tools.ts), and [workflow view](../../../addon-dnd-character-sheets/src/workflow-view.ts).

**Assessment — restore navigation first, explanations second.** Looking up an equipped item or spell directly from the sheet saves table time. Resolve stable record references through the host/provider contract, with readable text when no provider can resolve them. Use explicit details controls that work with touch and keyboard, not hover alone. Calculation breakdowns are also useful, but should come from optional structured engine explanations rather than reimplementing formulas in the sheet; this is a separate contract increment. **Acceptance:** links follow the selected provider, preserve navigation guards, and degrade cleanly when it disappears; displayed breakdowns match the revision that produced the visible value.

#### F19 — Senses such as darkvision are retained but not displayed · P2

V1's trait summary rendered the senses object with distances. The current trait summary renders languages, resistances, immunities, and proficiencies but omits senses. `traitSnapshot.senses` and materialized computed senses are retained, so the information can exist without being visible on the sheet.

Evidence: [old trait rows](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.sheet.js#L239), current [`combatDetails`](../../../addon-dnd-character-sheets/src/play-view.ts), retained [state](../../../addon-dnd-character-sheets/src/sheet-state.ts) and [materialized snapshot fields](../../../addon-dnd-character-sheets/src/engine-client.ts).

**Assessment — restore early.** Darkvision and other senses affect ordinary exploration; the values already exist, so a concise trait row has a strong benefit for a small change. Share formatting between compact/classic layouts and the print view. Render meaningful names and distances using the source contract's units, with saved fallback values when the provider is absent. Distinguish missing information from an explicit absence of a sense. **Acceptance:** a saved sense remains visible in both layouts and manual/provider-absent states without a new rules calculation.

#### F20 — HP editing lost the maximum-HP clamp · P2

Old direct HP editing clamped against effective maximum HP, and lowering maximum HP also clamped current HP. The current plus button increments without a ceiling; direct HP and maximum edits only clamp at zero, and normalization does not enforce `hp <= maxHp`. At 20/20, plus can save 21/20; lowering maximum HP can leave current HP above it. Later engine materialization may clamp it, but ordinary manual editing does not. This is a concrete behavior regression, independent of any damage automation.

Evidence: [old `setField`](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.base.js#L48), current [HP controls](../../../addon-dnd-character-sheets/src/play-view.ts) and [normalization](../../../addon-dnd-character-sheets/src/sheet-state.ts).

**Assessment — restore consistent normal limits, with explicit exceptions.** Ordinary healing, plus/minus, and direct edits should use the same effective maximum and keep temporary HP separate. When the user lowers maximum HP, show any proposed current-HP adjustment and save the accepted change together. Resolve the current zero-default ambiguity before treating an unfilled maximum as a known ceiling. Retain an explicit house-rule override rather than silently permitting accidental over-healing. Do not rewrite existing sheets merely on load to normalize historical values. **Acceptance:** normal 20/20 cannot accidentally become 21/20, lowering a known maximum is coherent, and an incomplete manual sheet remains editable.

### DM Tools

#### F21 — Encounter/puzzle reading pages and rendered planning prose are missing · P2

V1 offered dedicated encounter and puzzle detail pages with readable Markdown sections for objective/body, environment or clues, and outcome or solution, alongside references, consequences, and notes. The current planner opens these items in the generic editing modal; its event/branch navigation path selects/edits the item instead of opening a detail reader. The fields survive as textareas, but their formatted at-table reading surface is gone. Canvas navigation, CRUD, annotations, and Import Center remain available.

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

Built-in compact/classic sheets remain, but the live-object/raw-HTML v2 renderer service and arbitrary fragment replace/hide/wrap operations were deliberately retired. The [sheet guidance](../../../addon-dnd-character-sheets/AGENTS.md) requires any future renderer to use a reviewed serializable contract. V3 record-renderer declarations are not proof of a working replacement UI.

**Assessment — keep the retirement; solve concrete presentation needs.** Alternative layouts can be useful, but unrestricted replacement makes ownership, accessibility, and upgrades harder to maintain. Improve compact/classic and F13 printing first. Consider bounded presentation options or a typed renderer contract only when an actual consumer cannot fit those surfaces. Separate that from F10/F11 additive contributions. Until a destination exists, describe renderer declarations as unavailable rather than implying support. **Acceptance for a future renderer:** it consumes versioned serializable data, supports provider absence, and cannot silently take over core editing or bypass its save semantics.

#### D05 — Atlas creation and zoom gestures changed

Atlas now opens an unsaved form, with Save/Cancel and four top-level kinds; encounter/puzzle/branch subtypes are selected within it. There is no palette drag-to-create. Zoom now uses Ctrl/Command+wheel; ordinary scroll is retained. These changes are explicitly described in the [current planner README](../../../addon-dm-tools/README.md). They reduce rapid canvas sketching and change familiar gestures, even though creation and zoom exist.

**Assessment — keep the deliberate default; consider an explicit sketching mode.** Creating a complete item through a form avoids accidental placeholder clutter, while rapid placement is useful for outlining. A small optional “Place cards” tool could expose common subtypes directly, create clearly marked minimal cards at the chosen position, offer immediate undo, and stop on Escape. Show when a card is saved and prevent duplicate placement during a pending write. Keep ordinary scroll and explicit zoom controls by default; a browser preference for wheel-to-zoom should apply only while interacting with the canvas. **Acceptance:** normal clicks do not create records, rapid placement is reversible, and touch/keyboard users have equivalent controls. This is an optional enhancement after F21, not a required reversion.

#### D06 — Legacy state requires explicit offline conversion and reconfiguration

[Offline conversion](LEGACY_CONVERSION.md) imports the supported campaign and first-party data into a fresh directory. Credentials and packages are reconfigured; unknown add-on namespaces are inventoried/deferred. Older cross-scope planning flow is converted into references, with consequences reanchored. These are stated conversion boundaries; actual effects on a particular site's data require its conversion report.

**Assessment — keep the conversion boundary; improve accounting and targeted recovery.** A fresh destination and unchanged backup make conversion reviewable. The useful improvement is an actionable inventory of converted, deferred, and unmapped items, with reasons and stable identifiers, plus targeted converters such as F15 when real data requires them. Explain semantic transformations such as a former flow becoming a reference, so preservation of bytes is not mistaken for identical behavior. Do not add startup legacy readers or repeat a completed conversion without a reason. **Acceptance:** every input namespace is accounted for, authored input remains untouched, and deferred data has a documented recovery route or explicit unresolved status.

## Verified retained areas and exclusions

The following checks prevent an inflated list of losses:

| Area | Finding |
| --- | --- |
| Compendium source records | **All 3,061 JSON files under `data/` are unchanged** between the pinned old and current revisions. `git diff` identifies only `COVERAGE.md` and `SCHEMA.md` changes there. This proves no authored JSON loss in that tree, not that every record has been visually inspected. |
| Compendium browsing | Topic/book tree, kind selectors, book and kind-specific facets, sort choices, ranked search, paging/expanded results, Markdown details, class/subclass composition, wiki references and old bookmarks have current implementations. The missing effective sourcebook policy is F07, distinct from browse filtering. |
| Rules engine | Ran `go test ./internal/rules -run '^TestPreservedV1Parity$' -count=1`: passed. Its **144 preserved cases** comprise 119 hydrate, 16 builder-plan, eight apply, and one reconcile case. Universal derivation and generic catalog operations have current equivalents. No additional missing engine computation feature was established in this audit. |
| Host campaign data/editing | The typed record families, party, character knowledge/relationships/rank/portraits, mystery questions, faction rank chains, location links, and historical events have current editor/projection paths. Unknown-field preservation and optimistic revisions remain explicit contracts. This is source coverage, not a fresh visual test of every editor. |
| Maps/timeline/Mind Palace | World/local map media and placement, saved views, marker types/icons/glow/zoom scaling, event-only pins and paths, timeline session columns/reordering, and Mind Palace drag/filter/focus/layout persistence have implementations. F05 and F12 identify narrower losses. |
| Settings and access | English/Czech language, appearance, branding, sidebar configuration, party settings, enums, credentials, login/logout and player preview remain. Some role boundaries deliberately changed; see D03. |
| Recovery | Downloadable current backups, manual and automatic recovery points, reviewed point restore/delete, and revert-last-N remain. No loss of those whole workflows was established. |
| Add-on lifecycle | Upload, inspection, permission/compatibility review, activate, disable, reload, generation history/rollback, integrated/isolated UI and native workers remain. GitHub updates/private sources were just restored. Removal, selection, and some extension outlets are the separate findings above. |
| DM Tools planning/import | Nested scopes, same-parent flows, group/rectangle selection, group drag, grid movement, zoom ladder, fullscreen, subtree deletion/undo, links/consequences/shared notes, live refresh, and reviewed format-routed imports remain. Field preservation does not substitute for the missing reader in F21. |
| Sheet builder/play | Standalone editing, compact/classic selection, builder foundations/progression, equipment selection/batch save, spell learning/copying/swaps/grant casts, resources, rests and saved fallback data have current implementations. F13–F20 identify omissions inside these otherwise present workflows. |
| Earlier retirements | Location-status/artifact-state categories, zoom-priority pin hiding, and an unrouted CloudMap timeline mode were already retired or unreachable in the chosen legacy baseline. Do not call them rewrite losses. |
| Unused old helpers | The old `applyHpChange` temporary-HP absorption helper was referenced only by tests, not the actual UI. Likewise, `overrideControls` was exported but had no rendering call site in the pinned old sheet. Their absence from today's UI does not prove a newly lost usable feature; neither is counted. Current lack of override editing may still merit separate product work. |

## Verification gaps and documentation findings

#### V01 — Broad completion checks do not establish action-level parity

All release-gate checkboxes are closed, while the same repository still explicitly defers source-selection policy, uninstall, settings/editor outlets and graph capabilities. The [release-check script](../../scripts/check-release-readiness.mts) checks checkbox/marker state, not whether every legacy action has a working replacement.

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

1. **Protect authored work.** F01's durable drafts are implemented. Fix the calculation guard in F17 and add exact import review/undo in F14. Report actual old-export preservation risks under F15 without adding compatibility code by default. Broader provider-change comparison can follow the immediate guard; it must precede accepting changed rules automatically.
2. **Recover inexpensive play value and readable sessions.** Deliver senses (F19), coherent HP edits (F20), and attunement guidance (F16) early. Add the planning reader (F21), clean printing (F13), and rule navigation from F18. These do not need to wait for a general extension framework. Structured formula explanations are a later increment of F18.
3. **Restore campaign and operator choices.** Design sourcebook policy (F07) across the host/provider/consumer boundary, including revision identity and F17 reconciliation. Expose provider selection (F08) when needed and implement package uninstall with retained data (F09). Source policy cannot be delivered as a browse-only checkbox; provider selection cannot bypass exclusive installation rules. A data-purge action can follow safe code removal separately.
4. **Improve navigation and complete bounded integration.** Shared collection browsing (F02), quick search (F03), concise activity (F04) and map quick edits (F05) are implemented. Complete the settings outlet (F10). These can be scheduled independently as their benefit warrants; the groups express priorities and dependencies, not a requirement to finish every earlier item first.
5. **Keep conditional work conditional.** Require a real consumer for F11's map/editor integration and narrow F12 graph metadata; defer F12's general facade and F06's restart button. Keep D01–D04/D06's underlying boundaries while improving guidance and presentation. Treat D05's rapid placement and optional gesture preference as enhancements after the reader, rather than undoing the new defaults. Do not call these proposals approved retirements.

The initial implementation scope should avoid a generic form designer, a new graph framework, server-side PDF infrastructure, live legacy compatibility, and cross-package atomic bulk updates. Each would add substantial maintenance beyond the workflow that motivated the finding. Reassess them only against a concrete need that the smaller designs cannot meet.

The suite's actionable tracking remains in [BACKLOG.md](../BACKLOG.md#feature-parity-audit-follow-up-2026-09-11); this report records the evidence and baseline, rather than creating a second backlog.
