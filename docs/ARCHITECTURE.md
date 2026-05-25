# Architecture

A technical overview of how TTRPG Codex is put together. Aimed at
contributors and people forking the project to extend it. For day-to-
day operations see [`SELF_HOSTING.md`](SELF_HOSTING.md); for the dev
loop see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Tech stack

| Layer | Technology |
|---|---|
| HTTP server | Node.js 20 + Express 4 ([`server.js`](../server.js)) |
| Frontend | Vanilla ES6 modules — no bundler, no framework |
| Storage | One JSON file per collection in `data/` |
| Sync | Server-Sent Events (`/api/events`) |
| Mind maps | Cytoscape.js + Dagre ([`web/js/cloudmap.js`](../web/js/cloudmap.js)) |
| World map | Leaflet 1.9.4 + on-disk tile pyramid ([`web/js/map.js`](../web/js/map.js), [`tiler.js`](../tiler.js)) |
| Markdown | marked + DOMPurify, edited via EasyMDE |
| Auth | SHA-256 cookie (`edit_session`), single shared password |
| Uploads | multer, capped at 20 MB / file (40 MB for the world map) |
| Backups | archiver (ZIP) + adm-zip (restore) |
| Tests | Node built-in `node --test` runner |
| Deploy | Docker Compose |

## Why no build step?

The codebase is intentionally bundler-free. Every JS file under
`web/js/` is a real ES module loaded directly by the browser; CSS uses
native `@import` chained from a single root file. This means:

- The dev loop is **edit → reload** — no watcher, no compile lag.
- Anyone forking the project can read the source as it ships.
- The deployment artefact is the source plus `node_modules`.

The constraint is that browser support is modern-only (the codebase
uses `?.`, `??`, `for…of`, etc.) and that you can't easily TypeScript
the code without introducing a build step. The author considers that
trade worth it for a hobby-scale codebase; a contributor who wants
TypeScript would need to introduce the build step deliberately.

## Module map

```
web/js/
  app.js            Router, navigation, SSE live-sync, action dispatcher
  store.js          In-memory state, server sync, secondary indices, trash
  data.js           Default seeds (FACTIONS, REL_TYPES, SETTINGS_DEFAULTS, …)
  constants.js      PARTY_FACTION_ID, ROUTE map, SIDEBAR_PAGES, czPlural
  utils.js          esc, escapeRe, norm, debounce, slugify, extractOutline,
                    humanTime, renderMarkdown, expandWikiLinks, dataAction/On

  wiki.js           Article + list renderers (one entrypoint: renderPage)
  cloudmap.js       Mind maps (Cytoscape + custom physics + crossing reduction)
  timeline.js       Kanban board for events
  map.js            Leaflet world map + sub-maps + pin types + zoom scaling
  editmode.js       Edit toggle, auth, EasyMDE mount, draft recovery, dirty guard
  edit_templates.js HTML form templates for every edit overlay
  search.js         Ctrl+K global search palette
  settings.js       /nastaveni page (enums + maps + sidebar + backup tabs)
  boot.js           Pre-boot script (CSP-compatible, restores Kompendium state)

  widgets/
    widgets.js      Self-mounting Combobox + MultiSelect placeholders
    tagfilter.js    TagFilter primitive (search input + chip filters)
```

Every module is an IIFE returning its public API:

```js
export const Store = (() => {
  let _data = null;
  function getCharacters() { return _data.characters; }
  // …
  return { getCharacters, /* … */ };
})();
```

This keeps internals genuinely private and lets each module own its
event listeners without leaking them across reloads.

## Data model

Each collection lives in its own JSON file under `data/`. Defaults
seed empty collections on first load via `Store._mergeDefaults()`,
with deletion tombstones (in `deletedDefaults`) preventing
re-seeding of removed entries.

| Collection | Shape | Notes |
|---|---|---|
| `characters` | `{ id, name, faction, status, attitudes[], knowledge, title, portrait, location, description, tags[], … }` | `attitudes` is an array of `{id}` references into `settings.attitudes`. |
| `locations` | `{ id, name, region, description, history, x, y, parentId, localMap, pinType, attitudes[], size, … }` | Pin metadata is folded directly into the location record. `parentId` enables sub-maps. |
| `events` | `{ id, name, date, sitting, order, characters[], locations[], priority, … }` | `sitting` groups events into kanban columns; `order` is the within-column position. |
| `relationships` | `{ source, target, type, … }` | Undirected types (`ally`, `mystery`, …) and directed types (`commands`, `mission`). |
| `mysteries` | `{ id, name, questions[], clues[], characters[], locations[], priority, solved }` | |
| `factions` | Keyed object: `{ "<id>": { name, color, badge, attitudes[], rankChains[], … } }` | |
| `species`, `pantheon`, `artifacts` | Standard entity arrays. | Reference / world-building collections. |
| `historicalEvents` | `{ id, name, start, end, summary, body, characters[], locations[], … }` | Separate from campaign `events` so the timeline stays campaign-only. |
| `settings` | Keyed-by-category: `{ relationshipTypes: [], genders: [], pinTypes: [], characterStatuses: [], eventPriorities: [], attitudes: [], mapViews: [], mapConfigs: {}, hiddenSidebarPages: [] }` | User-editable enums. |
| `campaign` | Keyed object with one `main` record: `{ name, tagline }` | Dashboard hero text. |
| `deletedDefaults` | Keyed object `{ "<key>": true }` | Tombstones so removed seed entries don't resurrect. |

Three storage shapes get distinguished server-side:

1. **Entity arrays** — most collections. PATCH matches on `id`.
2. **Keyed-object collections** — `factions`, `settings`, `campaign`,
   `deletedDefaults`. PATCH writes `container[payload.id] = payload.data`.
3. **`relationships`** — special-cased in PATCH; matches on the
   composite `(source, target, type)` key.

Every save stamps `entity.updatedAt = Date.now()`. The dashboard
"Poslední úpravy" feed and global search both read this field.

## Routing

Hash-based SPA routing. All logic in `app.js:navigate()`.

| Hash | Handler |
|---|---|
| `/` or `/dashboard` | `Wiki.renderPage('dashboard')` |
| `/postavy`, `/postava/:id` | Character list + article |
| `/mista`, `/misto/:id` | Location list + article |
| `/udalost/:id` | Event article (timeline owns the list) |
| `/zahady`, `/zahada/:id` | Mystery list + article |
| `/frakce`, `/frakce/:id` | Faction list + article |
| `/druhy`, `/druh/:id` | Species list + article |
| `/panteon`, `/buh/:id` | Pantheon list + article |
| `/artefakty`, `/artefakt/:id` | Artifact list + article |
| `/historie`, `/historicka-udalost/:id` | Historical-event list + article |
| `/mapa/svet` | World map |
| `/mapa/local/:locId` | Sub-map of a location |
| `/mapa/{frakce,vztahy,tajemstvi,palac}` | Mind-map modes |
| `/casova-osa` | Timeline kanban |
| `/nastaveni` | Settings page |

The full list of routes plus the responsible module lives in
[`web/js/constants.js`](../web/js/constants.js) (`ROUTE` and
`SIDEBAR_PAGES`).

## Action dispatcher

Templates emit click and form handlers as `data-action` attributes
instead of inline `onclick`:

```html
<button data-action="EditMode.promptLogin">🔑 Přihlásit</button>
<button data-action="Store.deleteCharacter" data-args='["frulam_a7b3c9"]'>×</button>
```

A single capture-phase listener in `app.js` parses the attribute,
resolves any sentinels in `data-args`, and invokes the function from
the `ACTIONS` registry. There are no `window.*` exports — adding a
new module that handles user clicks means importing it in `app.js`
and adding it to the `ACTIONS` map.

Sentinels resolved at dispatch time:
- `'$el'` → the dispatching element
- `'$ev'` → the original Event
- `'$value'` → `el.value`
- `'$text'` → `el.textContent.trim()`
- `'$checked'` → `el.checked`

This gives templates a clean way to pass live values to handlers
that previously relied on inline `this` / `event` references, and
makes the page CSP-friendly: no inline scripts, no `'unsafe-inline'`
required if you ever turn on a strict Content-Security-Policy.

## Live sync flow (SSE)

```
client A       server                   client B
   │              │                         │
   │── PATCH ────▶│                         │
   │              │── _atomicWrite          │
   │              │── _maybeSnapshot        │
   │              │── _broadcastDataChanged ──── data-changed event ────▶│
   │◀── 200 ──────│                         │                            │
                  │                         │── Store.load()
                  │                         │── navigate(getRoute())
```

Every successful PATCH atomically writes the new collection file,
takes a coalesced snapshot, and broadcasts `data-changed` (with the
new dataset hash) to every connected `/api/events` client. The
client compares the hash to its last seen value to dedupe duplicate
events, then refetches the dataset and re-renders the current route.

Two interaction guards:

- **Dirty form guard.** If the user is mid-edit
  (`EditMode.isDirty()`), the SSE handler holds the change in
  `_pendingHash` and shows a banner instead of clobbering the form
  DOM. The change is applied automatically when the user saves
  (which fires `editmode:clean`) or manually if they click "Načíst".
- **Self-commit suppression.** The Settings zoom-scale slider
  debounces commits to 600 ms; once a commit fires, Settings
  exposes `isPendingSelfCommit()` returning `true` for ~1.5 s. The
  SSE handler checks this and skips the wholesale re-render of the
  Settings page during the round-trip window — otherwise the slider
  DOM gets torn out from under the user mid-drag.

The retry / backoff policy on the EventSource side covers transient
network blips; the dispatch loop closes + re-opens on `onerror` with
exponential backoff capped at 30 s.

## Snapshot system

Every successful write atomically appends a point-in-time snapshot of
the entire JSON dataset under `data-snapshots/snapshot-<ISO>.json`
(sibling of `data/`, NOT a subdirectory — keeps the data hash and
backup ZIP clean).

```json
{
  "id":        "snapshot-2026-04-21T12-34-56-789Z.json",
  "createdAt": "2026-04-21T12:34:56.789Z",
  "dataHash":  "abc123…",
  "reason":    "save" | "manual" | "pre-restore",
  "files":    { "characters.json": [...], "locations.json": [...], … }
}
```

**Coalescing.** A snapshot is skipped if the previous one is < 60 s
old. Burst writes from a single logical action (saveLocation's peer
cascade, or a user mashing save) collapse into one snapshot.

**Retention.** The 50 newest snapshots plus the latest snapshot per
UTC-day for the last 14 days are kept; everything else is pruned at
the end of every snapshot creation. The pure retention policy lives
in `pickKeptSnapshots` ([`server-utils.cjs`](../server-utils.cjs))
so it can be unit-tested without touching disk.

**Restore.** Roll-forward an `id`, take a fresh `pre-restore` snapshot
first (so the restore itself is undoable), overwrite every JSON file
in `data/` with the snapshot's contents, broadcast `data-changed` so
every connected client refetches.

**Revert-last-N.** `POST /api/snapshots/revert-last/:n` resolves the
target as `files[files.length - 1 - n]` and calls `_restoreSnapshot`.
n=1 = "undo the last change".

## Wiki article layout

Every entity article uses the shared `_articleShell({...})` helper in
[`wiki.js`](../web/js/wiki.js). Two-column grid:

- **Left side card** (sticky, ~300 px): portrait/visual + title +
  subtitle + chips + facts + auto-generated outline (TOC extracted
  from H1/H2/H3 in the body Markdown).
- **Main column** (capped at 1100 px): structured `.char-section`
  blocks followed by the Markdown body.

The whole grid is centered with `justify-content: center` so wide
screens use the empty space symmetrically. Single-column under
1100 px viewport.

The `_articleShell` signature is documented in `wiki.js` — it takes
`{ visual, title, subtitle, chips, facts, sections, body,
outlineSource }`. New entity types fit into this shell rather than
inventing their own layout.

## Attitude glow system

A unified `attitudes` palette (in user settings) drives the visual
"stance toward the party" indicator on every entity that has one.
Each entity carries `attitudes: [{id}]` referencing the palette;
strength (0..1) lives on the palette item, not the entity.

The renderer composes a CSS `filter: drop-shadow(...)` per active
attitude:

- **Cards / portraits / faction badges** stack the per-attitude
  drop-shadows additively. Two layers per attitude (a wide outer
  halo + a tighter inner glow ≈40% of the outer blur) so 100 %
  strength reads as a confident glow rather than a washed-out haze.
- **Map markers** with two or more active attitudes switch to a
  **striped** renderer: each attitude gets its own copy of the
  marker with a per-attitude drop-shadow filter and a sheared
  diagonal slab clip-path, so colours stripe across the marker
  rather than blending into a muddy halo. Single-attitude markers
  use the additive blend (no clip-path needed).

This decoupling means editing a colour or strength in Settings
updates every glow at once — no per-entity migration needed.

## Map architecture

Two modes share one Leaflet instance:

- **World map.** Backdrop is `data/maps/swordcoast/sword_coast.{jpg,png}`;
  every Location with `x`/`y` coordinates and no `parentId` is a pin
  on this map.
- **Sub-maps.** A Location with a `localMap` image becomes its own
  map; child Locations with matching `parentId` are pins on it.

If `tiler.js` and the `sharp` dep are available, the server builds
a Leaflet-compatible 256 px tile pyramid under
`data/maps/tiles/<mapId>/{z}/{x}/{y}.jpg` (plus a `tiles.json`
manifest). The client loads `L.tileLayer` from those tiles for fast
pan / zoom; if no manifest is found (sharp missing, or pyramid still
building) it falls back to a single `L.imageOverlay` so the map
still works.

Marker scaling is per-map config: `settings.mapConfigs[mapId].zoomScaleRatio`
(0..1) controls how much markers grow / shrink with the map zoom.
0 = constant pixel size; 1 = markers scale at the same rate as the
map. The scale formula is `2^(ratio · leafletZoom)`. The Settings
"Mapy" tab edits this.

## Mind maps (`cloudmap.js`)

Cytoscape handles the graph (nodes + edges + invisible proxy nodes
for layout); HTML "cloud cards" overlay the canvas to show rich
context (portraits, status, key facts).

The CloudMap module owns:

- **Layout persistence** per mode in `localStorage` (`cm_pos_<mode>`,
  `cm_filter_<mode>`, `cm_vf_<mode>`).
- **Visual filter** — TagFilter chips that AND-match against an
  enriched per-node text blob (name + faction + species + tags +
  status + ...).
- **Custom physics integrator** running a single `requestAnimationFrame`
  loop in two regimes:
  - `elastic` — rope-spring control points + per-node spring back
    to a saved equilibrium; sleeps when total kinetic energy
    falls below a threshold.
  - `autolayout` — Fruchterman–Reingold with temperature cooldown
    (~3.5 s), gravity toward the viewport centre to keep
    disconnected components from drifting.
- **Crossing-reduction post-pass** — greedy hill-climbing on the
  worst-offender node. Each round picks the node whose incident
  edges produce the most crossings, tries swapping it with every
  other node, commits the best improvement; stops when no swap
  helps or the attempt budget runs out. For a 50-node graph this
  typically eliminates 70-100 % of FR's residual crossings in a
  few milliseconds. (Finding the optimal crossing-free layout is
  NP-hard, so the post-pass is a heuristic — a much stronger one
  than random-pair simulated annealing, but still a heuristic.)

Edges render as quadratic Béziers whose control points are sprung
to the geometric chord midpoint; during fast drags the control
points lag, giving a rope / rubber-band feel. The `web/js/cloudmap.js`
header has the full physics derivation including a list of approaches
that were tried and reverted (do not retry without reason).

## Security model

- **Auth.** Read access is open (the wiki is public). Editing
  requires the `edit_session` cookie, which is the SHA-256 of
  `EDIT_PASSWORD`. Comparison uses `crypto.timingSafeEqual` to
  avoid leaking length / prefix info via timing.
- **Login rate limiting.** Failed POST `/api/login` attempts
  accumulate per source IP and trigger a 15-minute lockout after
  a burst. Brute force is impractical even with a weak password.
- **Trust proxy.** `app.set('trust proxy', 1)` so `req.ip` reflects
  the real client IP behind a single hop of nginx/Caddy/Traefik;
  without this the rate limiter would lump every client under the
  proxy IP and a single brute-forcer could lock everyone out.
- **Path safety.** `_safeJoinIn(dir, rel)` resolves caller-supplied
  path fragments against a base directory and rejects traversal
  (`..`), absolute paths, null bytes, AND symlink escapes (via
  realpath on every existing prefix). Used by the portrait migration
  inside PATCH `/api/data` and by the restore-ZIP entry validator.
- **Write serialisation.** Every disk-mutating route runs inside
  `withWriteLock(fn)` — a Promise-chain mutex — so two PATCHes can't
  interleave read-modify-write cycles on the same JSON file.
- **Atomic writes.** `_atomicWrite` writes to a sibling `.tmp` file
  and `rename()`s into place (atomic on POSIX, retried with backoff
  on Windows EBUSY). A killed server can't corrupt a JSON file mid-
  write.
- **Prototype pollution guard.** Keyed-object collections
  (`factions`, `settings`, `campaign`, `deletedDefaults`) write via
  `container[payload.id] = …`. The PATCH handler calls
  `_isForbiddenKey(payload.id)` first and rejects `__proto__` /
  `constructor` / `prototype`.
- **CSP posture.** `helmet` is wired with sensible defaults but CSP
  is currently OFF — the UI uses inline `style="…"` attributes for
  several dynamic effects (attitude glow filters, marker scaling,
  etc.) that strict CSP would block. Inline scripts have already
  been moved into `boot.js` so re-enabling `script-src 'self'` is a
  small change away when style attributes are eliminated.
- **CDN script integrity.** Every `<script>` and `<link>` pointing at
  a CDN in `web/index.html` carries a pinned `integrity="sha384-…"`
  hash. A CDN compromise can't silently inject code; the browser
  refuses to execute / apply a script whose hash doesn't match.

## API reference

Detailed endpoint reference is in the JSDoc comments above each
handler in [`server.js`](../server.js). Summary:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/data` | — | Full campaign JSON |
| PATCH | `/api/data` | ✓ | Save or delete a single entity |
| GET | `/api/events` | — | SSE stream of `data-changed` events |
| GET | `/api/version` | — | Current dataset hash (health check) |
| POST | `/api/login` | — | Validate password, set `edit_session` cookie |
| GET | `/api/auth` | — | Probe whether the cookie is valid |
| POST | `/api/portrait/:charId` | ✓ | Upload character portrait |
| DELETE | `/api/portrait/:identifier` | ✓ | Delete portrait file or folder |
| POST | `/api/localmap/:locId` | ✓ | Upload a location's sub-map image |
| POST | `/api/worldmap` | ✓ | Replace the world-map backdrop |
| POST | `/api/icons/:pinTypeId` | ✓ | Upload up to 16 marker variants |
| DELETE | `/api/icons/:pinTypeId/:filename` | ✓ | Remove one variant |
| DELETE | `/api/icons/:pinTypeId` | ✓ | Remove the whole folder |
| GET | `/api/backup` | ✓ | Stream `data/` as a ZIP |
| POST | `/api/restore` | ✓ | Replace `data/` from a ZIP or JSON upload |
| GET | `/api/snapshots` | ✓ | List snapshots, newest first |
| POST | `/api/snapshots` | ✓ | Take a manual snapshot |
| POST | `/api/snapshots/:id/restore` | ✓ | Roll back to a specific snapshot |
| POST | `/api/snapshots/revert-last/:n` | ✓ | Undo the last N changes |
| DELETE | `/api/snapshots/:id` | ✓ | Delete one snapshot file |

## Where to start reading

If you want to understand the codebase, read in this order:

1. [`web/js/constants.js`](../web/js/constants.js) — the route map
   gives you the surface area at a glance.
2. [`web/js/store.js`](../web/js/store.js) — every collection's
   shape, public getters, and the sync contract live here.
3. [`web/js/app.js`](../web/js/app.js) — router, action dispatcher,
   SSE wiring.
4. [`server.js`](../server.js) — the API surface and every disk
   mutation.
5. Whatever feature module you're touching — `wiki.js` for articles,
   `map.js` for the world map, `cloudmap.js` for mind maps,
   `editmode.js` for forms, `settings.js` for the enum editor.

Each module's IIFE returns its public API at the bottom; that's the
contract. Functions outside the returned object are private.
