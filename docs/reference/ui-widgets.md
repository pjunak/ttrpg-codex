# Widgets + action dispatcher — deep reference (ttrpg-codex)

> Moved verbatim out of AGENTS.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as AGENTS.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## Widget mount convention

Combobox and MultiSelect use placeholder divs.
Classes: `cb-mount` or `ms-mount`.

Combobox attributes:
- `data-cb-id` hidden input id
- `data-cb-source` one of `character`, `location`
- `data-cb-value` current value
- `data-cb-placeholder` text
- `data-cb-exclude` comma-joined ids to hide
- `data-cb-allow-empty` allow no-selection
- `data-cb-empty-label` label for empty row
- `data-cb-on-create` one of `character`, `location`

MultiSelect uses `-ms-` equivalents. `data-ms-value` is comma-joined ids.
`data-ms-on-create` enables inline create. Initial ids that don't resolve
into any option (e.g. DM-only entities absent from a player's dataset)
are kept as invisible **passthrough** values — no chip renders, but they
ride the hidden checkboxes and `getValue()`, so a player save can't
silently strip the DM's links from the record.

`Widgets.mountAll(document.body)` runs at top of every `navigate()`.
For dynamic UI added after navigate, call `Widgets.mountAll(scopedRoot)`.
Examples: `_refreshRelSection`, `relTypeChanged`, map pin form.

Combobox creates a hidden `<input type="hidden" id="${data-cb-id}">`.
MultiSelect uses the placeholder div's own id. It writes hidden checked
`<input type="checkbox">` inside. Save code keeps using
`document.getElementById(id).value` and `_checkVals(containerId)`.

## TagFilter widget

Reusable search+chips primitive. Mount via `.tf-mount` placeholder div.
Users type a term, press Enter to commit it as a chip. Multiple chips
AND together. Backspace on empty input removes the last chip.

Mount attributes:
- `data-tf-id` hidden-input mirror id (comma-joined values)
- `data-tf-placeholder` input placeholder
- `data-tf-hint` small hint text below the row
- `data-tf-value` initial comma-joined values

Emits bubbling `tf-change` CustomEvent with `detail.values[]`. Consumer
owns the matching logic and subscribes via delegated listener on a
container. Element exposes `_tagfilter.{getValues, setValues, clear,
focusInput}`.

Auto-mounted by `Widgets.mountAll(root)`. Used by CloudMap filter bar
and by every Wiki list toolbar (Postavy / Místa / Frakce). Wiki wires
a single delegated `tf-change` listener on `document` that routes
chip changes to the right grid refresh via `data-wl-kind`.

## Inline create via on-create

When `data-cb-on-create` or `data-ms-on-create` is set, typing a name
not in the options shows "✦ Vytvořit «typed»" at the dropdown bottom.
Click or Enter calls `Store.saveCharacter` or `Store.saveLocation`
with minimal defaults. Character defaults: `faction:'neutral'`,
`status:'alive'`, `knowledge:3`. Location defaults: empty strings.
Then options refresh and the new entity is selected or added.

Used in: relationship target picker, event/mystery character pickers,
event location picker, world-map pin location picker.

## Action dispatcher (replaces inline `onclick`)

`app.js` installs a single capture-phase document listener that reads
`data-action="Module.method"` (plus optional `data-args='[json,…]'`)
and invokes the matching function from a private registry of imported
modules — `Store`, `EditMode`, `Wiki`, `CloudMap`, `Timeline`,
`WorldMap`, `Settings`, `GlobalSearch`, `Role`, `DmDashboard`, `Sidebar`.
**There are no `window.*` exports anymore**; modules stay private to
`app.js`.

Templates build attribute strings via two helpers in `utils.js`:

- `dataAction(method, ...args)` → click handler
- `dataOn(kind, method, ...args)` → `submit`/`change`/`input`/`blur`/`keydown`/`error`/`dragstart`/`dragover`/`drop`/`dragend` (HTML5 drag-and-drop: a `data-on-drop` element auto-`preventDefault`s `dragover` so drops fire, and `drop` itself is preventDefaulted; a `dragstart` handler typically takes `$ev` to stash the dragged ref + set `ev.dataTransfer`). Distinct from the host's own native DnD (timeline / sidebar editor), which uses bespoke listeners, not these attrs.

Sentinels resolved at dispatch time (so the function gets the live
value, not a stale string):

- `'$el'`     → the element carrying the attribute
- `'$ev'`     → the original Event
- `'$value'`  → `el.value` (replaces `this.value`)
- `'$text'`   → `el.textContent.trim()` (for contenteditable)
- `'$checked'`→ `el.checked` (for checkbox / radio)

Built-in actions for cases that aren't a Module.method call:

- `back` · `reload` · `hashGoto(hash)` · `scrollTo(slug)`
- `removeAncestor(el, selector?)` — removes parent or matching ancestor
- `copyValue(srcId, dstId)` — mirror two inputs (color picker / hex)
- `enterBlurs(ev)` — Enter blurs a contenteditable, no newline
- `hide(el)` — used as `data-on-error="hide"` on `<img>` previews
- `bodyToggleClass(cls)` / `bodyRemoveClass(cls)` — mobile drawer
- `toggleKompendium` — sidebar collapsible state + localStorage
- `deferred(action, ...args)` — `setTimeout(()=>X(),0)` equivalent

preventDefault rule for `<a>`: anchors with `href="#/route"` keep their
default (so action runs AND the hash router fires); anchors with
`href="#"` / `href="#anchor"` and all buttons get preventDefault. A
modifier-click on a real href falls through to the browser entirely
(middle-click / Ctrl-click open in a new tab).

The sidebar nav is rendered by the `Sidebar` module (an external
`app.js` import), so the page stays CSP-clean under `script-src 'self'`
with no inline scripts. (The old `boot.js` pre-boot script — which
restored the Kompendium collapse state before first paint — is retired;
`Sidebar.render` applies per-section collapse state from localStorage on
its first render instead.)

When adding a new module that handles user clicks: import it in
`app.js` and add it to the `ACTIONS` map. No global window assignment.
