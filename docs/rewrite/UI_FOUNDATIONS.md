# Shared UI foundations

## Design direction

The host and add-ons should compose a small, well-tested set of reusable UI
primitives. Presentation belongs in semantic design tokens and supported variants;
interaction, accessibility, focus, pending/error handling and disposal belong in
the shared implementation. Domain screens supply their data, labels, actions and
specialized layout. They should not duplicate a common interaction merely to
change its appearance.

This remains the intended direction. The rewrite's explicit SDK and generation
boundaries change how an add-on receives shared UI; they do not remove the goal.
A reusable control library is compatible with authored campaign pages, editors
and planners. It does not require flattening those workflows into a generic record
browser or moving rules calculations into presentation.

## Current implementation

| Surface | Implemented boundary | Remaining gap |
| --- | --- | --- |
| Theme and typography | [CSS tokens](../../frontend/src/styles/tokens.css) supply shared colors, fonts, spacing, radii and focus styling. Integrated add-ons can inherit them. | Token coverage is incomplete; screen and add-on styles still contain local decisions. There is no documented, versioned semantic token catalog for every shared control. |
| Campaign appearance | [Appearance settings](../../frontend/src/app/campaign-appearance.ts) select Classic or Moonlit through a revisioned DM-owned campaign setting. | These are two compiled-in themes, not a general external theme registration or style-package system. |
| Contribution framing | The host owns routes, navigation, settings sections, article/editor contribution mounts, edit guards and generation cleanup. [Browser contract](BROWSER_ADDONS.md). | An outlet lends its framing and lifecycle, not a full set of controls for the add-on's interior. |
| Shared reading components | Integrated add-ons can create `codex-addon-markdown`. The rule-details contract supplies a host component and `ui.showRuleDetails` for integrated and isolated callers. [Markdown](../../examples/addons/API_V3.md#markdown-for-integrated-add-ons), [rule details](RULE_DETAILS.md). | These are focused public components; they do not constitute a general forms/cards/dialogs library. DM Tools already uses host Markdown in its [planning reader](../../../addon-dm-tools/src/planning-reader.ts). |
| Public browser UI handle | [`BrowserUIAPI`](../../frontend/src/addons/browser-sdk.ts) exposes declarations, contribution binding and rule details. | No general public field, collection, dialog or loading/error component kit is implemented. Add-ons still author substantial DOM and CSS. |
| Isolated add-ons | Sandboxed documents use the versioned bridge and their packaged styles; specific supported host operations can be invoked through the bridge. | Host DOM, custom elements and inherited document tokens are not automatically available inside an isolated frame. A theme snapshot/notification or additional host-rendered operation needs an explicit contract. |

Consequently, the design goal is only partially realized. Existing host components
and shared tokens are real reuse; local copies of controls and a narrow public UI
surface are implementation gaps, not evidence that reuse is now unwanted.

## Reuse boundaries

The host owns common interaction behavior and its public contract. Host screens
must use the same supported primitives offered to add-ons, so fixes improve both.
Expose small typed properties/events, documented semantic tokens and bounded
variants rather than private imports, host-DOM queries, copied stylesheet
selectors or raw HTML injection. Add-on package compatibility and generation
disposal still apply.

Add-ons own their domain workflows: planning canvases, reference navigation and
character building/play. They should consume shared controls wherever the
behavior matches and retain custom rendering for domain-specific interaction.
The rules engine remains headless. Sharing a field or dialog does not introduce
an edition rule or change data ownership, save policy or worker authorization.

Use concrete repeated interactions to choose the initial primitives: fields with
labels/help/errors, pending and unavailable states, action groups, confirmation
dialogs and collection controls are candidate families. Stable semantic tokens
and variants should allow another visual style without a second implementation
of focus, validation or asynchronous state. A new skin must be checked against
reading surfaces and controls as well as the surrounding chrome.

Public availability must be explicit. Integrated custom elements can be lent by
the host when their capability and property/event contracts are supported.
Isolated callers need a serializable bridge equivalent or an intentionally
documented limitation; they must never reach into host DOM to imitate reuse.

## Acceptance boundary

Shared primitives need keyboard/focus, accessible naming, validation and async
states, English/Czech, narrow viewport, zoom and both current themes tested
through real host and installed add-on consumers. Theme changes and generation
replacement must preserve authored values and dispose old handlers. Candidate
refactors must keep complete domain workflows and avoid adding a framework that
has no real consumers.

The repository-owned implementation work is tracked only as T34 and T34-DM,
T34-COMP and T34-SHEETS in [the suite backlog](../BACKLOG.md). Those tasks remain
open; documenting this direction does not claim a completed component library.
