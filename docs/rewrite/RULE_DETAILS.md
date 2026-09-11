# Shared rule details

`ui.rule-details` is the public capability for contextual rule explanations.
Integrated consumers can render `codex-addon-rule-details` with a typed
`details` property and optional `compact` attribute. Integrated and isolated
consumers can instead `await context.ui.showRuleDetails(details)`. The promise
settles when the panel closes or its generation is disposed; isolated callers
then recover focus in their own document.

The closed `RuleDetails` contract accepts a label, structured reference or wiki
reference, summary, saved sources and a structured explanation. Requests are
bounded to 60,000 bytes. Explanations contain the result, units, bounds and contribution
terms, including suppressed terms, source references and DM grant IDs. The host
formats these facts; it does not calculate rules or execute formula strings.
Arbitrary navigation URLs are not accepted.

Source resolution uses the current viewer, approved source policy and activation
generation. A saved source hash and summary remain evidence for the displayed
revision. A currently installed replacement is identified separately. Missing,
disabled, restricted and ambiguous sources have explicit outcomes; the host does
not guess a matching name or route. Saved evidence does not grant access to a
disabled book.

## Interaction

Hover/focus offers a preview. Click, tap, Enter or Space pins a named non-modal
dialog, with a visible close action and full-entry navigation inside. Escape
closes it and restores the initiating control when appropriate. Moving onto the
panel keeps it open; related references use one panel with a back path. Position
and height follow the available viewport on scroll, resize and content updates.
Disposal closes the panel and cancels generation-owned work. Chrome UI messages
use English/Czech catalogs; source-authored prose retains its source language.

This follows the [WCAG hover/focus requirements](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html),
the [APG distinction between tooltips and interactive dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)
and the [native Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using).

## F18 surface inventory

| Surface | Shared behavior |
| --- | --- |
| Sheet statistics, skills, saves, senses, resources, weapons and casters | Saved calculation terms and source evidence |
| Build options, choices and spells | Eligible catalog records and source details |
| Equipment and DM grants | Item/feat source, grant attribution and effective limits |
| Rest, spell-copy and change reviews | Same source and calculation presentation |
| History comparison and restoration | Explanation from the selected saved revision |
| Compendium list | Intentional navigation link with a separate adjacent details button |
| Compendium metadata and bestiary statistics | Labeled facts with current record context |
| Explicit compendium and host Markdown rule references | Contextual details before full-entry navigation |
| Other participating integrated/isolated add-ons | Public component or SDK capability |
| Printed sheets | Saved source notes and optional provenance appendix |

Ordinary unannotated prose is not automatically linked. Content authors must
provide explicit structured/wiki references for embedded rule terms. This is a
content coverage boundary, not permission to infer references from names.

Installed tests cover both browser modes, keyboard opening/closing and focus
return, dirty-draft preservation, generation cleanup, source policy, saved
evidence, Czech text and a 390-pixel viewport. Physical touch and human screen
reader acceptance remain manual checks.
