# Rewrite feature-parity audit

Audited September 10–11, 2026. This is a comparison of preserved source revisions with the current local source, not a production-site inspection.

**Result: 21 confirmed missing or reduced capabilities, six documented transition/design differences, and four remaining verification gaps.** Some omissions were explicitly deferred in subsystem documents; they are still unavailable to users. Priorities below express restoration value, not new deployment gates. No runtime fixes or deployment changes were made for this audit.

The most consequential findings are lost Markdown draft recovery, sourcebook selection, service-provider selection, character-sheet import review/undo, rejection of old sheet exports, and the missing manual-mode reconciliation guard. The GitHub installation/update/private-repository workflow reported immediately before this audit was restored in host commit `8711085`; it is **not counted as still missing**.

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

Historical evidence links pin the old commit. Current file links refer to the revisions above; their implementation may change after this report. P1 means data protection, workflow correctness, or an unavailable central operator action; P2 means a meaningful missing workflow or extension capability.

## Confirmed missing or reduced capabilities

### Host campaign workflows

#### F01 — Markdown drafts no longer recover after reload or a crash · P1

Previously each Markdown editor saved a local draft after 500 ms, flushed it on page hide, and offered Restore/Discard for up to 30 days. The current editor retains its document in memory; the application has dirty-navigation and before-unload guards, but no durable Markdown draft store or recovery banner. Dismissing a reload prompt, closing after a failure, or a browser crash loses unsaved prose. This does not mean saved campaign records are lost.

Evidence: [old recovery implementation and contract](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/edit-drafts.js), current [Markdown editor](../../frontend/src/app/codex-markdown-editor.ts) and [unsaved-edit guard](../../frontend/src/app/unsaved-edit.ts). Restore bounded, record-scoped recovery alongside the existing guards.

#### F02 — Collection browsing lost grouping, sort choices, filter chips, and saved filters · P2

Character, location, and faction lists previously had persistent per-list state, AND-combined filter chips, accent-insensitive matching, and collection-specific sorting. Characters could group/sort by faction, name, status, or knowledge; factions supported member-count sorting. The replacement collection page has one transient substring input and no sort/group controls. It searches projected name/title/excerpt/tags, rather than the old complete kind-specific search text; it also lacks accent folding. Existing records remain accessible, but navigating a large campaign is substantially less capable.

Evidence: [old list behavior](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/docs/reference/routing-navigation.md#L50), current [`#collection`](../../frontend/src/app/codex-record-page.ts). Restore the collection-specific controls and browser preference persistence.

#### F03 — Global search lost the recent-item command palette · P2

Ctrl/Cmd+K still opens search, and grouped full-text results exist. Previously it toggled an overlay with recent activity when empty, Up/Down selection, Enter to navigate, and Escape to close. It now navigates to a page whose empty state is an instruction; results are ordinary links without the former result-selection keyboard controller. Tab navigation remains available. The lost feature is the quick-jump workflow, not global search itself.

Evidence: [old search controller](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/search.js), current [search page](../../frontend/src/app/codex-search.ts) and [shortcut routing](../../frontend/src/app/codex-app.ts).

#### F04 — Recent activity no longer says what changed · P2

The old dashboard displayed a one-line change summary, including field transitions, creation, or relationship changes. Current activity rows show the record name and time only. The newest-30 list survives, but users cannot scan it to see why an entry changed. Some `lastChange` data still exists in storage/projection; retaining that field does not restore its presentation.

Evidence: [old activity presentation](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/docs/reference/wiki-rendering.md#L92), current [`#recent`](../../frontend/src/app/codex-dashboard.ts). Restore role-filtered summaries without exposing private field values.

#### F05 — Map-side location editing and context are reduced · P2

The old pin panel edited type, attitudes, size, and notes alongside placement and showed resolved type/attitude context. The current panel edits coordinates, with a name field for creation, and displays name/map notes plus article/local-map links. Type, size, and attitudes remain editable in the full location article, so this is an extra-navigation regression rather than missing storage. The old Enter-to-first-search-result action is also absent from the map search input.

Evidence: [old pin panel](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/map.js), current [`#panel` and search input](../../frontend/src/app/codex-map.ts), retained [location editor fields](../../frontend/src/app/campaign-record-editor.ts).

#### F06 — Restart server from Settings is gone · P2

The old account panel exposed a DM-only restart button when a process supervisor was configured, then waited for the restarted instance. There is no equivalent current button or restart endpoint. Add-on reload/activation now handles many cases that used to require a restart, but a general server restart still requires external operator access.

Evidence: [old account control](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/settings-account.js#L170), [old restart endpoint](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/server.js#L1968), current [credential settings](../../frontend/src/app/codex-credential-settings.ts) and [HTTP composition](../../internal/transport/httpapi/server.go). Decide whether this operator convenience should return under the new runtime.

### Add-on and content management

#### F07 — Campaign sourcebook enable/disable is missing · P1

Previously the manager displayed a checkbox for each declared content group/book. Disabling a group removed its records from effective content and rules hydration, respecting alternate source membership. The current compendium has browse filters by book, but those only filter the displayed list. The host content index has no source enable/disable policy; all packaged records remain eligible. A DM cannot restrict the campaign's rules sources through the UI, and old disabled-group choices have no effective-policy replacement.

Evidence: [old manager controls and mutation](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/settings.js#L1912), current [content boundary explicitly deferring this policy](CONTENT.md#current-boundary-and-next-layers), current [compendium browse filters](../../../addon-dnd-2024-compendium/src/browse.ts). This is a documented deferral, not an implemented replacement. Restore host-owned selection and a changing effective content revision shared by browsing and engine consumers.

#### F08 — No operator UI/API to select a service provider · P1

The old manager let the DM select or clear a provider for a single-provider service, including ambiguous and stale selections. The current broker implements revisioned `SetBinding`, but its calls are confined to tests; no application/admin endpoint or manager control exposes it. A sole compatible provider can still bind automatically. When operator selection is required, the missing end-to-end path prevents resolving it through the product.

Evidence: [old selector and save action](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/settings.js#L1992), current [broker](../../internal/addons/servicebroker/broker.go), [admin routes](../../internal/transport/httpapi/addons.go), and [manager](../../frontend/src/app/codex-addon-manager.ts). Restore the broker-backed picker with candidate and stale-binding diagnostics.

#### F09 — Installed add-ons cannot be removed · P2

The old manager had Remove and a DELETE endpoint. The current product exposes staging, review, activation, reload, disable, and rollback, but no uninstall operation. Disabling leaves the installed package/generations registered; it does not complete the old removal workflow. The backlog explicitly defers separately reviewed uninstall/data deletion.

Evidence: [old Remove action](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/settings.js#L2052), current [lifecycle interface/routes](../../internal/transport/httpapi/addons.go), [manager](../../frontend/src/app/codex-addon-manager.ts), and [follow-ups](../BACKLOG.md#feature-parity-audit-follow-up-2026-09-11). Restore code removal with explicit data-retention choices and dependency review; do not equate uninstall with purging campaign data.

#### F10 — Add-on settings contributions have no Settings destination · P2

Old `registerSettingsTab` contributions appeared under Settings → Add-ons, including role-appropriate player tabs. V3 accepts and binds a `settings` surface, but the application does not mount a settings outlet. Current Settings → Add-ons renders only the host manager. A valid contributed settings element therefore has no normal user destination.

Evidence: [old settings registration](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addons.js#L255), current [surface declarations](../../frontend/src/addons/generation-manager.ts), [settings component](../../frontend/src/app/codex-settings.ts), and [remaining integration](BROWSER_ADDONS.md#remaining-integration). This affects the public extension capability; it does not establish that a bundled add-on currently requires such a tab.

#### F11 — Add-on editor fields and map-pin panel slots lost their host integration · P2

V1 mounted additional character editor fields and collected their values on save; it also rendered `map:pin:panel` contributions. V3 can bind `editor-panel` elements and generic slots, but current core editors and map panels contain no corresponding outlets/collection path. A separate add-on article or route is possible, but cannot substitute for these inline integrations without extra work by the add-on author.

Evidence: [old editor-field registration](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addons.js#L337), [old map outlet](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/map.js#L1443), current [record editor](../../frontend/src/app/codex-record-page.ts), [map](../../frontend/src/app/codex-map.ts), and [remaining integration](BROWSER_ADDONS.md#remaining-integration). Preserve v3 transactions and isolated-mode boundaries when designing replacements.

#### F12 — Custom graph kinds and the reusable graph facade remain unavailable · P2

V1 provided custom node-kind rendering, registered connection kinds consumed by the host, and a bounded `host.graphs` facade for add-on-owned graphs. V3 restores graph views and contributors with host-owned cards, but explicitly leaves custom node-kind renderers and the general graph facade unimplemented; there is also no equivalent live add-on connection-kind registration in the current campaign type resolver. An add-on can ship its own DOM/SVG graph, as DM Tools does, but cannot use these former host services.

Evidence: [old graph registrations](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addons.js#L395), [old bounded graph API](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/web/js/addon-graph.js), current [graph contract](../../examples/addons/API_V3.md#mind-palace-graph-providers) and [remaining integration](BROWSER_ADDONS.md#remaining-integration). Restoring these capabilities does not require restoring raw HTML or exposing a graph-library instance.

### Character Sheets

#### F13 — Dedicated sheet printing / PDF export is absent · P2

The old Settings tab produced a self-contained printable sheet, opened a print window, and invoked the browser's print dialog. The new tools panel supports JSON export/import but has no print action or dedicated print document. Printing the host page is not the former clean character-sheet/PDF workflow.

Evidence: [old print action](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.transfer.js#L31), current [tools panel](../../../addon-dnd-character-sheets/src/sheet-element.ts). Restore a standalone printable rendering using current serializable sheet data.

#### F14 — Sheet import lost preview, explicit confirmation, immediate undo, and paste input · P1

Previously a file or pasted JSON opened a read-only preview; Confirm applied it and Undo restored the previous sheet. The current file input calls `#importFile`, parses the file, and immediately saves a replacement of the entire sheet. There is no import preview, second confirmation, paste option, or operation-specific undo. Syntax/size/tree validation remains, and server recovery points are separate; neither provides the missing review workflow.

Evidence: [old transfer actions](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.transfer.js#L58), current [`#importFile`, file input, and `replaceState`](../../../addon-dnd-character-sheets/src/sheet-element.ts), [parser](../../../addon-dnd-character-sheets/src/sheet-transfer.ts). Restore reviewed replacement against the opening sheet revision and a bounded immediate undo.

#### F15 — Existing versioned character-sheet export files are rejected · P1

V1 exported `{format:"dnd-sheets.character", version:1, sheet:...}`. The current importer recognizes `{format:"ttrpg-codex.dnd-sheet", version:1, sheet:...}` and raw unwrapped objects, but rejects the actual old versioned envelope. A synthetic old-format file reproduced **“This sheet export format is not supported.”** The current-format control succeeded. Whole-campaign conversion does not provide a UI path for somebody holding one previously exported character file.

Evidence: [old transfer format](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/sheet-transfer.js#L1), current [format check](../../../addon-dnd-character-sheets/src/sheet-transfer.ts). Provide a deliberate conversion/import path; do not reinterpret an incompatible object silently.

#### F16 — Attunement capacity and over-limit feedback disappeared · P2

The old equipment band displayed occupied/available attunement slots, the computed limit, and an over-limit indicator; its slot picker appeared only while room remained. Current equipment displays attuned items and an Add control without consuming the computed `attunement.limit`/`over` values. The engine still calculates and stores this information, but the sheet no longer presents the capacity guidance. This is not a claim that every old inventory action enforced the limit: the loss is the dedicated slot/count/over-limit UI.

Evidence: [old equipment band](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.header.js#L113), current [vitals/equipment rendering](../../../addon-dnd-character-sheets/src/play-view.ts) and [equipment actions](../../../addon-dnd-character-sheets/src/equipment-state.ts).

#### F17 — Manual mode and provider-change reconciliation no longer guard calculations · P1

V1 withheld its engine from sheet actions when the sheet was manual, its provider identity/edition changed, or materialized values had been manually altered. It offered Keep manual / Resume builder. Current provider diagnostics report identity differences, but offer only rechecking; calculations are gated by engine availability rather than `rulesMode` or reconciliation. For example, `#saveEquipment` can hydrate a manual sheet, and `materializeHydration` writes calculated values and sets `rulesMode = "auto"`.

A synthetic transform changed a manual sheet's AC from 19 to a supplied calculated 12 and changed its mode to auto. The equipment call path was traced statically; no live campaign was changed. This does **not** claim that simply opening the page writes new values.

Evidence: [old provider-state gate](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/model.js#L193), [old choices](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.settings.js#L58), current [provider diagnostics](../../../addon-dnd-character-sheets/src/provider-view.ts), [`#saveEquipment`](../../../addon-dnd-character-sheets/src/sheet-element.ts), and [materialization](../../../addon-dnd-character-sheets/src/engine-client.ts). Restore the explicit per-character decision before applying a changed provider or leaving manual mode.

#### F18 — Rule-entry links and explanatory stat popovers are missing from sheets · P2

Old spell, feat, feature, and equipment labels linked to provider-owned details when resolvable, with hover/focus explanations. Vitals also explained formulas and their component values. The current sheet renders these labels and numbers as plain elements; the only direct anchor it creates is its download link. The compendium itself and host wiki-reference resolution work, but sheets no longer connect to them. The numerical passive-perception, initiative, and caster DC/attack readouts do survive: compact mode places them in the ability rail, while classic mode uses the vitals area.

Evidence: [old link/tooltip primitive](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/ui.js#L350), [old vitals](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.header.js), current [play view](../../../addon-dnd-character-sheets/src/play-view.ts), [spell tools](../../../addon-dnd-character-sheets/src/spell-tools.ts), and [workflow view](../../../addon-dnd-character-sheets/src/workflow-view.ts). Restore provider-neutral navigation and accessible explanations, preserving the unlinked fallback.

#### F19 — Senses such as darkvision are retained but not displayed · P2

V1's trait summary rendered the senses object with distances. The current trait summary renders languages, resistances, immunities, and proficiencies but omits senses. `traitSnapshot.senses` and materialized computed senses are retained, so the information can exist without being visible on the sheet.

Evidence: [old trait rows](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/panel.sheet.js#L239), current [`combatDetails`](../../../addon-dnd-character-sheets/src/play-view.ts), retained [state](../../../addon-dnd-character-sheets/src/sheet-state.ts) and [materialized snapshot fields](../../../addon-dnd-character-sheets/src/engine-client.ts).

#### F20 — HP editing lost the maximum-HP clamp · P2

Old direct HP editing clamped against effective maximum HP, and lowering maximum HP also clamped current HP. The current plus button increments without a ceiling; direct HP and maximum edits only clamp at zero, and normalization does not enforce `hp <= maxHp`. At 20/20, plus can save 21/20; lowering maximum HP can leave current HP above it. Later engine materialization may clamp it, but ordinary manual editing does not. This is a concrete behavior regression, independent of any damage automation.

Evidence: [old `setField`](https://github.com/pjunak/addon-dnd-character-sheets/blob/ab64f76c55f571e1446a6a0ac7842a3357d0da0f/actions.base.js#L48), current [HP controls](../../../addon-dnd-character-sheets/src/play-view.ts) and [normalization](../../../addon-dnd-character-sheets/src/sheet-state.ts). Restore the effective-maximum invariant consistently across edits.

### DM Tools

#### F21 — Encounter/puzzle reading pages and rendered planning prose are missing · P2

V1 offered dedicated encounter and puzzle detail pages with readable Markdown sections for objective/body, environment or clues, and outcome or solution, alongside references, consequences, and notes. The current planner opens these items in the generic editing modal; its event/branch navigation path selects/edits the item instead of opening a detail reader. The fields survive as textareas, but their formatted at-table reading surface is gone. Canvas navigation, CRUD, annotations, and Import Center remain available.

Evidence: [old detail renderer](https://github.com/pjunak/addon-dm-tools/blob/ec89529ed1b3a85d0fb08f30512b6dffb58071b4/story-planner-render.js#L811), current [open callback and editor](../../../addon-dm-tools/src/planner-element.ts), retained [model fields](../../../addon-dm-tools/src/planning-model.ts). Restore a read surface without requiring a change to the planning schema.

## Documented transition/design differences

These are real changes in available workflows, but should not be presented as accidental omissions or automatically reversed.

| ID | Previous capability / behavior | Current boundary and consequence |
| --- | --- | --- |
| D01 | Install/update arbitrary source trees or refs; bulk update legacy add-ons. | V3 installs reviewed prebuilt ZIPs. GitHub release/Actions discovery and private-repository credentials now work, but a changed source repository alone is insufficient without a compatible package. Updates stage a candidate and require exact-package review; there is no old one-click bulk activation. This is the [package lifecycle](PACKAGE_LIFECYCLE.md), not a reason to compile source in production. |
| D02 | Upload a whole ZIP/JSON backup and restore it from Settings. | Full archive restore is now offline maintenance; old archives require one-time conversion. Online recovery points, restore/delete, and revert-last-N survive. The lost browser upload path is an explicit [backup boundary](BACKUP_RESTORE.md#deliberate-boundary). |
| D03 | Signed-in players could list safe snapshot metadata and request a manual snapshot. | Current recovery endpoints and Settings panels are DM-only. This is a narrower [authorization contract](BACKUP_RESTORE.md#campaign-recovery-points), not evidence that players previously downloaded private backups; those downloads were DM-only too. [Old role-filtered snapshot routes](https://github.com/pjunak/ttrpg-codex/blob/3aeeacfe7adec985693f8aeb239df58c177f3da8/server/snapshot-routes.cjs#L14). |
| D04 | Third-party sheet renderers and arbitrary fragment replace/hide/wrap operations. | Built-in compact/classic sheets remain, but the live-object/raw-HTML v2 renderer service and arbitrary fragment overrides were deliberately retired. The [sheet guidance](../../../addon-dnd-character-sheets/AGENTS.md) requires any future renderer to use a reviewed serializable contract. V3 record-renderer declarations are not proof of a working replacement UI. |
| D05 | Atlas click/drag immediately created a placeholder card at the chosen position; ordinary wheel input zoomed. | Atlas now opens an unsaved form, with Save/Cancel and four top-level kinds; encounter/puzzle/branch subtypes are selected within it. There is no palette drag-to-create. Zoom now uses Ctrl/Command+wheel; ordinary scroll is retained. These changes are explicitly described in the [current planner README](../../../addon-dm-tools/README.md). They reduce rapid canvas sketching and change familiar gestures, even though creation and zoom exist. |
| D06 | Existing runtime/add-on configuration and every legacy data shape could remain in place. | [Offline conversion](LEGACY_CONVERSION.md) imports the supported campaign and first-party data into a fresh directory. Credentials and packages are reconfigured; unknown add-on namespaces are inventoried/deferred. Older cross-scope planning flow is converted into references, with consequences reanchored. These are stated conversion boundaries; actual effects on a particular site's data require its conversion report. |

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

1. **The coarse parity checklist did not establish action-level parity.** All release-gate checkboxes are closed, while the same repository still explicitly defers source-selection policy, uninstall, settings/editor outlets and graph capabilities. The [release-check script](../../scripts/check-release-readiness.mts) checks checkbox/marker state, not whether every legacy action has a working replacement. These findings should be tracked by concrete workflow, without inventing a new deployment approval policy.
2. **This was not a new installed-package/browser acceptance run.** The latest host check from the immediately preceding restoration passed its unit/browser/Go gates, but skipped 39 optional companion-package browser cases. That is not proof those features are broken, and it does not validate the missing actions. This audit reran only the focused engine comparison and synthetic probes. No production data, browser sessions, credentials, or live GitHub downloads were used.
3. **Passing preserved engine vectors is bounded evidence.** The 144 cases do not exhaust every combination of class, subclass, feat, spell, resource, equipment and provider transition. In particular, they do not test the UI's manual/reconciliation policy in F17. A future restoration should add regression coverage at the actual UI/service boundary it changes.
4. **Live migration effects remain unverified.** The comparison proves source-level behavior and content-tree preservation, not that every deployed ZIP matches these checkouts, every old bookmark resolves in a real campaign, or every deferred third-party namespace was converted. Use each site's package inventory and existing conversion report for those questions; avoid another conversion merely to repeat completed work.

## Restoration order

Start with F01, F14, F15 and F17 because they concern preserving or deliberately replacing authored work. Next restore F07–F09 for campaign rules selection and operator control. Then address F02–F05 and F13/F16/F18–F21 for everyday campaign and table use. Review the public extension requirements F10–F12 independently of whether today's four bundled add-ons happen to exercise them. F06 and the documented changes D01–D06 need an explicit product decision only if their current design is to be changed.

The suite's actionable tracking remains in [BACKLOG.md](../BACKLOG.md#feature-parity-audit-follow-up-2026-09-11); this report records the evidence and baseline, rather than creating a second backlog.
