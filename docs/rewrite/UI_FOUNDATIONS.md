# Shared UI foundations — ui.controls.v1

The host owns the common controls used by its screens and integrated add-ons.
Native HTML keeps form values, validation, submission and platform behavior;
the shared implementation adds consistent styling, field feedback, search,
comboboxes, tab navigation and modal focus. Domain code owns records, query
semantics, save policy, authorization and specialized layouts.

This preserves the original reusable-UI direction. A new skin overrides semantic
tokens; it does not copy keyboard or lifecycle code. Classic and Moonlit remain
the DM-owned, revisioned campaign themes. External theme-package registration is
a separate feature and is not required to style these controls.

## Researched choices

Reviewed September 16, 2026. These are design decisions derived from the sources,
not a claim that automated tests establish full WCAG conformance.

| Element or combination | Decision and reason | Primary guidance |
| --- | --- | --- |
| Text, number, password, file, range and multiline fields | Keep native input types, names, autocomplete, bounds and required semantics. Associate a visible label separately from help/error text. Do not implement generic numeric bounds in presentation. | [WAI field labels](https://www.w3.org/WAI/tutorials/forms/labels/), [notifications](https://www.w3.org/WAI/tutorials/forms/notifications/) |
| Short single choice | Native select; radios when comparison benefits from seeing every choice. A searchable widget would add unnecessary interaction for a small list. | [GOV.UK select guidance](https://design-system.service.gov.uk/components/select/) |
| Long single choice | Explicitly opted-in editable combobox over a native select. Query text and stored identity are distinct. Arrows navigate enabled matches, Enter commits, Escape/Tab dismiss without changing the value. Text editing keys remain native. | [APG combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/), [USWDS combo box](https://designsystem.digital.gov/components/combo-box/) |
| Choice descriptions and duplicate names | Plain text descriptions belong inside options, without interactive descendants. Duplicate names receive a value identifier if the owner has not supplied a description; meaningful domain descriptions are preferred. | [APG listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) |
| Multiple choice | Native checkboxes grouped by fieldset/legend; existing native multiple selects remain native. Do not disguise a multi-selection workflow as the single-choice combobox. | [WAI grouping](https://www.w3.org/WAI/tutorials/forms/grouping/), [GOV.UK select guidance](https://design-system.service.gov.uk/components/select/) |
| Search | Native search input with a named clear action. Publish settled IME text once. Search produces results, never a stored selection. Owners choose live filtering or an explicit submit. | [USWDS search](https://designsystem.digital.gov/components/search/) |
| Search + filters + sort | Separate labelled controls in a wrapping row, a result count outside the fields, visible applied filters and an explicit reset. Draft/apply behavior stays with the owning workflow. This composition is our application of the search and form guidance. | [USWDS search](https://designsystem.digital.gov/components/search/), [WAI forms](https://www.w3.org/WAI/tutorials/forms/) |
| Actions and pending work | Native buttons and links retain their semantics. Primary/danger/quiet variants only change appearance. A busy or aria-disabled button stays focusable but cannot trigger another action. The owner supplies a meaningful pending label and owns request cancellation. | [APG button](https://www.w3.org/WAI/ARIA/apg/patterns/button/), [status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) |
| Loading, empty, unavailable, success and error | Routine updates use status; urgent errors use alert. Empty/unavailable explanations remain readable without repeatedly interrupting users. A retry is a real button supplied by the owner. Never move focus just to announce a result count. | [WAI notifications](https://www.w3.org/WAI/tutorials/forms/notifications/), [status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) |
| Tabs | One tab stop, orientation-aware arrows and Home/End; activate through the owner's click behavior. Only opt in when switching is immediate. Slow remote navigation should use links or manual activation, not these automatic tabs. | [APG tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) |
| Dialogs and confirmations | Native showModal supplies the top layer, inert background and normal focus return. Shared Tab containment includes visible controls only. Owners supply a title, close action, initial focus and any dirty/pending close guard. An open combo consumes the first Escape. | [APG dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [W3C native dialog technique](https://www.w3.org/WAI/WCAG21/Techniques/html/H102) |
| Skins, focus and responsive layout | Semantic colors, visible focus, wrapping controls and viewport-bounded popups. Default buttons are 40 CSS px high, 44 on coarse pointers; checkbox/radio labels provide the larger target. Support forced colors without animation dependence. | [WCAG contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) |

## Public integration

Declare required capability `ui.controls.v1`. The capability adds no data or
network permission. The checked [TypeScript contract](../../contracts/addons/v3/ui-controls.d.ts)
is:

```ts
interface UIControlsHandle {
  refresh(): void;
  dispose(): void;
}
// Integrated BrowserUIAPI:
enhance(root: HTMLElement): UIControlsHandle;
```

Call `context.ui.enhance(ownRoot)` once for a contribution-owned root. Keep its
handle, call `refresh()` after synchronous DOM/property updates when immediate
focus is needed, and `dispose()` in disconnectedCallback. The host also disposes
handles when their SDK session/generation ends. Do not enhance document.body,
another add-on's subtree or the same root twice. Nested enhanced roots are
independent; parent handles skip them.

The implementation observes child/attribute changes in that root. It does not
replace the owner's original controls or attach data services. Programmatic
`.value` changes need `refresh()`; value properties do not produce DOM mutation
records. Disconnect/reconnect disposes and creates a new handle. Disposal removes
popups, handlers and timers, restores native select/label behavior and retains
native values. It does not provide durable drafts or recover an entire destroyed
domain screen; DM forced-replacement draft recovery remains T30.

A minimal composition (all dynamic strings must use textContent/DOM APIs):

```html
<form>
  <div data-ui-toolbar>
    <div data-ui-field data-ui-key="query">
      <label for="entry-query">Search entries</label>
      <input id="entry-query" type="search" data-ui="search" name="query">
      <small data-ui-help>Search within the selected sources.</small>
    </div>
    <div data-ui-field data-ui-key="source">
      <label for="entry-source">Source</label>
      <select id="entry-source" name="source" data-ui="combobox">
        <option value="">All sources</option>
        <option value="mountains" title="Northern campaign">The mountains</option>
      </select>
    </div>
  </div>
  <div data-ui-actions>
    <button type="submit" data-ui-variant="primary">Apply</button>
    <button type="reset">Reset</button>
  </div>
  <p role="status" aria-atomic="true">Result count supplied by the owner</p>
</form>
```

Use a separate `label for` inside the field container for composite search and
combobox controls. Their clear/toggle buttons must sit outside the label; an
implicit label should contain only its one native control. The clear action uses
an accessible localized name and a compact visible ×. Native validation message
language follows the browser; built-in shared-control messages support English
and Czech.

Listen to `codex-query` on a marked search input for a bubbling/composed
`CustomEvent<{ value: string }>`. It emits only changed, settled user input,
including the clear action. Reset and programmatic updates do not invent a user
query. An owner retaining an applied query must handle its form reset as well.
For a combobox listen to ordinary input/change on the **original select** and
read its value. Filtering never emits a selection event. Tests and assistive
technology should address the visible combobox by role/name; the hidden native
select remains present for FormData and constraints.

### Supported markers

| Marker | Contract |
| --- | --- |
| `data-ui-field` | One labelled native control plus optional help/error elements. Label text, help and errors receive separate accessible associations. Native invalid feedback is shown after validation; do not announce required errors on initial load. |
| `data-ui-help`, `data-ui-error` | Plain text help / owner-provided error. Hidden errors are not active. Owners decide server-error recovery and whether an error blocks submission. |
| `data-ui="combobox"` | Single select only; existing options/optgroups/required/disabled/form/reset are authoritative. Multiple selects are left native. |
| Option `title`, `data-ui-keywords` | Plain-text explanation and additional filter terms. Labels and values stay distinct; disabled options/groups cannot commit. |
| `data-ui-options-state="loading\|error"` and `data-ui-options-message` | Temporarily prevent selection and explain why. Owner handles async fetch, epoch checks, abort and retry; the UI library never fetches. Clear the state after publishing the latest options. |
| `data-ui="search"` | Native search input plus shared clear/query behavior. |
| `data-ui-actions`, `data-ui-toolbar` | Responsive action and field composition; these are layout groups, not ARIA toolbars with a different keyboard model. |
| `data-ui-variant="primary\|danger\|quiet"` | Native button presentation. Default is secondary; ordinary submit/button/link behavior remains native. |
| `data-ui-state="loading\|empty\|unavailable\|info\|success\|error"` | Shared notice presentation and appropriate status/alert/note semantics. Keep content meaningful; the library supplies no domain-specific messages. |
| `data-ui-tabs` | A native button-based role=tablist with correct tab/panel IDs, aria-selected and tabIndex supplied by the owner. Shared automatic keyboard activation, including vertical and RTL layouts. |
| `data-ui-dialog` | Native labelled dialog opened with showModal; shared focus containment/style. Owner supplies cancel/close logic, initial focus and a visible close button. |
| `data-ui-key` | Unique field key inside this root; restores focus to an equivalent field after owner rerender if focus otherwise fell to the document body. It does not steal focus from another control. |
| `data-ui-skip` | Exclude a specialized subtree such as planner canvas ports from generic control enhancement. |

List rendering is bounded to 100 matching options with a localized narrowing
message. Search matches ignore case and combining accents. Query, selected value,
enabled state and active option are separate. Home/End and selection shortcuts
remain text editing; Up/Down navigate, Alt+Up dismisses, Enter selects, Escape
restores the committed label, Tab closes without forcing a selection. Popups use
the browser top layer and recompute viewport placement on scroll/resize.

## Theme contract

[Control CSS](../../frontend/src/ui/controls.css) supplies defaults from the host's
existing theme tokens. A skin overrides these public variables at its container:

| Tokens | Meaning |
| --- | --- |
| `--ui-surface`, `--ui-field` | Notice/popup and editable-control backgrounds |
| `--ui-text`, `--ui-muted` | Main and secondary text |
| `--ui-border`, `--ui-focus` | Visible boundaries and focus indicator |
| `--ui-accent`, `--ui-on-accent`, `--ui-danger` | Selected/primary action, its foreground, and error/destructive emphasis |
| `--ui-font`, `--ui-radius`, `--ui-gap`, `--ui-target` | UI font, corners, composition spacing and minimum control height |

`data-ui-tone="paper"` is a supported reading-surface variant. The dark/default
variant inherits Classic/Moonlit. Typography and spacing use relative units.
Theme changes affect CSS without replacing controls or authored values. Do not
target generated popup/input class names or depend on their DOM structure.
Domain styles may set layout widths, spacing and specialized illustrations.

## Consumers and boundaries

- **Host:** collection search/filter/sort, campaign search, common record fields,
  and existing modal focus helpers use the same implementation.
- **DM Tools:** planner forms, long parent/target lists, actions, tabs, dialog
  containment and notices; Import Center fields/actions/notices. Canvas geometry,
  dirty guards, transactions and Markdown remain DM-owned.
- **Compendium:** search and facet composition, long facet lists and common
  loading/error/empty presentation; source navigation and long-form reading stay local.
- **Character Sheets:** shared fields, searchable choices, actions, tabs,
  dialog containment and pending/conflict feedback; automatic saving, Compact/
  Classic layouts, optional rules and worker authorization remain unchanged.
- **Engine:** headless; no UI dependency.

Integrated add-ons borrow the live host implementation, not a compiled private
copy. Their manifests prevent activation on hosts lacking the capability.
Isolated documents intentionally cannot call enhance: DOM handles and inherited
tokens cannot cross the opaque iframe bridge. They retain their self-contained
controls and supported serializable host operations such as rule details.
No new iframe DOM access, stylesheet injection, theme bridge or permission
exception is implied by ui.controls.v1.

## Validation and limits

[Shared-control browser tests](../../frontend/test/browser/ui-controls.browser.mts)
cover selection/query separation, disabled groups, required focus, reset, IME,
duplicate names, inert text, bounded options, loading, theme changes, forced
colors, text enlargement, narrow touch viewports, contrast, tabs, modal nesting,
live field replacement, touch label targets, abort and SDK session disposal. [SDK authority tests](../../frontend/test/browser-sdk.test.ts)
cover capability/mode/stale-session rejection.
[Host editor tests](../../frontend/test/browser/editors.browser.mts) retain draft,
conflict, localization and collection workflows.

The installed Compendium, Character Sheets and DM suites exercise rebuilt ZIPs
through upload, review and activation, including saved selection, automatic
saving, navigation, provider absence, disposal/replacement, Czech and phone flows.
The installed Compendium suite also compares host/add-on control colors and
text sizing in both skins and languages at 200% text size on a phone viewport,
then checks keyboard selection, clear behavior, focus and retained filters.
Automated Chromium checks and inspected screenshots are the evidence boundary.
Manual NVDA/VoiceOver, physical-touch and full browser/OS zoom combinations have
not been performed; the per-repository T18 acceptance work still owns those checks.

## Reflow verification

Profile and collection acceptance reduces the actual CSS viewport to 720 px
(desktop 1440 px at 200% page zoom) and 320 px (the standard reflow boundary).
It repeats the locale/theme/device matrix with bundled and unavailable web fonts.
CSS `zoom: 2` is not a substitute: it magnifies elements without selecting the
same responsive breakpoints, and an inline setting can be lost on navigation.
The test asserts the viewport width after navigation and reports overflowing
elements on failure. This follows the [W3C reflow viewport guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html);
[CSS zoom](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/zoom)
remains an element magnification property. Actual browser zoom and assistive
technology still belong to manual acceptance.
