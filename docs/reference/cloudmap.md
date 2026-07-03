# CloudMap (mind maps) — deep reference (ttrpg-codex)

> Moved verbatim out of CLAUDE.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as CLAUDE.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## CloudMap architecture

`cloudmap.js` renders four mind-map modes. All share one Cytoscape
instance and an HTML overlay.

| Mode | Nodes | Edges |
|---|---|---|
| `frakce` | faction hubs + characters + locations | hub→member, hub→location, commands, negotiates, ally |
| `vztahy` | characters only | all relationship types |
| `mista` | locations | undirected from `location.connections[]`, deduped |
| `tajemstvi` | mystery nodes + involved characters | mystery→character |
| `casova-osa` | events + involved characters | chronological chain + event→character |

> `CloudMap.render('casova-osa')` exists internally but no route wires it.
> Timeline owns `/casova-osa` (top-level, no `/mapa/` prefix).

Node `type` values used by `_applyFactionFilter` and edge logic:
`'faction'` · `'character'` · `'location'` · `'mystery'` · `'event'`.

**Node kinds + views are data-driven registries** (the contribution refactor).
The 5 built-in node types are `NODE_KINDS` descriptors
(`{id, shape, detailHash, searchText, cardHTML, height}` — built-ins DELEGATE to
the existing `_charCloudHTML`/`_charCloudH`/… so behaviour is unchanged), resolved
via `_nodeKind(type)` (built-ins, then `Addons.nodeKinds()`); the generic per-node
couplings (`_nodeSearchText`, `_nodeIntersect` shape, `_detailHashFor` + tap-nav)
all route through it. The 4 modes are `VIEWS` descriptors (`{id, build}`) dispatched
by `render(mode)` via `_view(mode)` (built-ins, then `Addons.graphViews()`); an
addon view renders generically via `_renderAddonView` (declarative `build()` →
`{nodes, edges}`), reachable at `/mapa/<viewId>` (app.js). Each built-in builder
calls `_graphContrib(viewId)` to merge addon `registerGraphContributor`
nodes/edges (rendered through the node-kind descriptors' cardHTML/height).
Connection-kind edge visuals come from `Store.getKinds('connections')`, rebuilt per
render via `_rebuildEdgeMeta()`. All zero-cost with no addons installed.

Key private state:
- `_cy` Cytoscape instance
- `_cloudMap` `{ nodeId -> wrapper div }` for HTML overlay cards
- `_glowMap` `{ nodeId -> glow div }`
- `_edgeLabels` `{ edgeId -> { div } }`
- `_hiddenFactions` `Set<factionId>` filter state
- `_currentMode` mode string

Layout persistence uses localStorage:
- `cm_pos_<mode>` positions. JSON `{ nodeId: {x,y} }`.
- `cm_filter_<mode>` faction filter. JSON array of hidden IDs.
- `cm_vf_<mode>` visual filter. JSON `{ values[], hiddenEdgeTypes[], focusHops, focusMode }`. Legacy `{ search, statuses[], minKnowledge }` is auto-migrated on load: `search` and each status label become chip values.

Positions and faction filter save together via `savePositions()`.
Both clear via `resetLayout()`. Visual filter autosaves on every change.

Visual filter differs from faction filter. It dims instead of hides.
Driven by a single TagFilter chip row: each chip AND-matches against
an enriched per-node text blob (name/title/species/gender/age/status
label/faction name/knowledge label/tags for characters; region/type
for locations; questions/clues for mysteries; etc.). Also supports
edge-type hiding and BFS focus. State lives in `_filters =
{values, hiddenEdgeTypes, focusId, focusHops}` and `_focusMode`.
`_applyVisualFilter()` toggles `cm-vfilter-dim` on cloud cards and
`faded` on edges. SVG opacity mirrored by `_syncEdgeLabels`.
Tap in focus mode does BFS-N-hop highlight, not navigation.

Initial zoom: after the preset layout runs, `_cy.ready()` calls
`_cy.fit(undefined, 60)` so all nodes are visible without moving them
(fixes saved-position-off-viewport cases like an empty-looking Záhady).

### CloudMap text scaling via CSS variable (`--cm-z` + `calc()`)

`_cloudLayer` holds both `_edgeSvg` (paths) and all cloud cards.
Crisp text at every zoom level is achieved by **driving every
visually-sized property in `.cm-cloud` and descendants through
`calc(<base>px * var(--cm-z, 1))`**, with `--cm-z` set on
`_cloudLayer` per zoom-change frame in `_sync()`. CSS variables
go through the cascade and trigger a real style recomputation, so
the browser is forced to re-render text at the EXACT pixel size
for the current zoom — no GPU-texture-cache + bilinear-resample
path. SVG edges scale via their own transform on `_edgeSvg`
(vector graphics re-rasterise crisply at any scale).

**`_sync()` does:**
1. If `Math.abs(zoom − _lastSyncedZoom) > 0.0005`, write
   `_cloudLayer.style.setProperty('--cm-z', zoom)`. This is the
   only line that triggers a card-subtree style invalidation —
   pan-only and physics-tick frames don't re-flow.
2. Clear any leftover `zoom`/`transform` on `_cloudLayer`
   (defensive — older code paths may have set them).
3. Apply `transform-origin: 0 0; transform: translate(pan.x px,
   pan.y px) scale(zoom)` to `_edgeSvg` directly. Critical that
   transform-origin is `0 0` — SVG defaults to `50% 50%` which
   would offset edges.
4. For each node: `wrapper.style.left = pos.x · zoom + pan.x −
   (w · zoom) / 2`, same for top. Cards positioned in **screen
   coordinates** (not graph coords) because the layer is no
   longer transformed. The card's CSS-driven visual width is
   `calc(--cw * --cm-z)` which equals `w · zoom`, so this
   centres the card on the node's rendered position.
5. Glows: same screen-coord centring; visual size `gs · zoom`
   (CSS handles via `calc(550px * var(--cm-z))` etc.).
6. `_syncEdgeLabels()` for label positioning.

**Edge labels** (HTML divs in `_cloudLayer`, also un-zoomed): set
`div.style.left = labelGraphX · zoom + pan.x` and width
`labelW · zoom`. Font-size scales via `.cm-edge-label`'s
`calc(12px * var(--cm-z))`.

**Per-card width via inline CSS variable.** Card HTML templates
inline `style="--cc:…; --cw:${CW}px"` (or `--cw:${CW_HUB}px` for
faction hubs). The base `.cm-cloud` rule has `width: calc(var(--cw,
168px) * var(--cm-z, 1))`. Default `--cw: 168px` if not specified.

**`_resizeToActual()` measures at scale 1, not the current zoom.**
This is critical: `cloud.offsetHeight` reflects the visually-scaled
height, but `node.data('h')` is graph-coord and feeds edge endpoint
math, parallel-fan, FR repulsion, and hit-testing. The function
temporarily sets `--cm-z = 1`, forces layout flush via
`void _cloudLayer.offsetHeight`, takes measurements, restores the
previous `--cm-z`, and resets `_lastSyncedZoom = NaN` so the next
`_sync()` re-writes the variable.

**`_lastSyncedZoom`** is module-level state (declared right after
`_phys`). `_physResetState()` resets it to `NaN` on `render()` so a
fresh mind-palace session always writes `--cm-z` on first sync.

> **Tried-and-reverted approaches** (do not retry without reason):
> - `transform: scale()` on `_cloudLayer` — texture-blits the
>   whole subtree; worst case for text.
> - `zoom: <currentZoom>` CSS on `_cloudLayer` — better than
>   `scale()` but Chromium's compositor still sometimes promotes
>   the layer (especially when combined with `transform:
>   translate()`) and bilinear-samples. This is what was producing
>   the persistent text smearing.
> - `left`/`top` instead of `transform: translate()` for pan —
>   introduced a one-frame visual jump on the first node grab as
>   the layer flipped between GPU and CPU paint paths. Reverted.
> - `will-change: transform` or `translate3d(0,0,0)` on the layer
>   — re-introduces GPU compositing and undoes the fix.
> - Bbox-aware repulsion + edge-vs-node repulsion in FR — over-
>   corrected and clumped the graph; see "Known limitation"
>   below.

### Edge rendering (quadratic Béziers + rope physics)

Edges render as SVG `<path>` elements (two paths per edge — one
src→gap, one gap→tgt — so the label slot stays in the middle).
Each path is a quadratic Bézier whose control point is supplied by
the physics integrator (see "Physics integrator" below) — at rest
the CP sits exactly at the geometric midpoint, so the curve looks
like a straight line. During fast drags the CP lags behind its
spring target and the curve sags, giving a rope/rubber-band feel.

`_addEdgeLabels()` creates per-edge `path1` + `path2` plus an HTML
label `<div>`. `_syncEdgeLabels()` runs every render frame: it
computes endpoints (with `_nodeIntersect` boundary clipping using
`node.data('w') / 2` as the graph-coord half-extents — both cards
and SVG live in the same `zoom`-scaled layer, so native graph
units are correct), looks up the edge's CP from `_phys.edgeCP`,
derives a parallel-fan target (see below), stashes that target on
the CP record (`cp.tx/cp.ty`) for the integrator's next step, then
writes the SVG `d="M … Q cpx cpy …"` for both segments. The HTML
label `<div>` is positioned in graph coords (it's inside the same
zoomed layer).

**Snap-when-asleep.** When `_phys.raf` is null (initial render,
mid-layout-animation Cytoscape redraws, or post-settle idle) every
sync also snaps each CP directly to its target. That means the at-
rest curve always matches the freshly-computed target, even when
no integrator step has been driving the CP — without this, the
first sync during Cytoscape's animated `cose` layout would freeze
each CP at a mid-animation midpoint and leave every line bowed
out of place. Edge CPs are NOT seeded in `_cy.ready` either; they
spring up lazily inside `_syncEdgeLabels`.

**Labelled-edge geometry uses a proper de Casteljau / blossom
split.** The full edge is one quadratic Bézier through `(srcExit,
cp, tgtEntry)`; the two visible segments are halves of that single
parent curve at parametric cuts `t1 = 0.5 − Δt`, `t2 = 0.5 + Δt`
(where Δt ≈ gapHalfLen / chordLen). Sub-curve 1 has control polygon
`(srcExit, (1−t1)·srcExit + t1·cp, B(t1))`; sub-curve 2 has
`(B(t2), (1−t2)·cp + t2·tgtEntry, tgtEntry)`. The earlier "segment-
midpoint + half-of-global-CP-offset" formula made each segment
bend independently, producing a double-bow overbend; the blossom
form is the algebraically correct way to halve a quadratic and
matches the unlabelled single-path case exactly.

Parallel edges (multiple relations between the same two nodes) fan
out via the **CP target**, not via endpoint perp-shift. Each edge's
`cp.tx/cp.ty` is offset perpendicular to the chord by `(idx −
(count−1)/2) · PARALLEL_FAN`, with sign anchored to the canonical
sorted-pair so swapped source/target siblings don't cancel. Single
edges get zero offset.

Cytoscape's `minZoom` is `0.25`. Cards scale visually with zoom
(via the layer's `zoom` CSS), and text stays crisp at every level
because `zoom` re-rasterises text at the new effective size rather
than scaling a cached texture.

### Physics integrator

`cloudmap.js` runs a single `requestAnimationFrame` loop in `_phys`
that drives every kind of motion. Two modes:

- **`elastic`** (default) — rope CPs spring toward their per-edge
  midpoint targets with `EDGE_SPRING=0.04` and `EDGE_DAMP=0.85`
  (high inertia). When a node is dragged, the chord midpoint moves
  faster than the spring can pull the CP, so the curve sags into
  a rope-bow visible whenever the chord rotates (it can't bow on
  pure translational drag along the chord — geometric constraint
  of single-CP quadratics). Every undragged node is sprung toward
  its saved equilibrium (`_phys.nodeRest`). Node-node overlaps
  inject velocity impulses (no more snap-displace); the loop sleeps
  when total normalised KE < `PHYS_K.ENERGY_SLEEP`. Connected
  non-dragged nodes do NOT get pulled toward the held node
  (`NEIGH_PULL=0` by default) — only collisions move other nodes
  during a drag.
- **`autolayout`** — Fruchterman–Reingold force field (pairwise
  repulsion `k²/d`, edge attraction `d²/k`, gravity toward
  viewport centre at `PHYS_K.GRAVITY = 0.0060`) with temperature-
  cooled max displacement (~3.5 s cooldown). `k` is **card-size
  driven** (`max(140, avgNodeSize · 1.4)`) rather than viewport-
  area driven. Initial temp is `k · 0.5` (max one card-width
  displacement per frame). **Before** FR runs, `_runAutoLayout()`
  scatters all nodes onto a Fibonacci-spiral lattice of radius
  `k · √N · 0.45` with a small random jitter — this avoids "FR
  refines a bad starting layout" outcomes by giving the optimiser
  a fresh, unbiased configuration to explore. On finish,
  `_reduceCrossings()` runs (see below), every node's final
  position becomes its new rest position, the layout is auto-
  saved to localStorage, and the viewport animates via
  `cy.fit({padding: 80})` so the freshly-arranged graph is centred
  and sized to fill the available area.

> **Known limitation:** FR's repulsion only knows about node
> *centers*, so an edge from A to B can sometimes pass through
> the visible bounding box of an unrelated node C even when the
> three are at "fine" center-distances. Tried-and-reverted: a
> bbox-aware repulsion (`k² / max(2, d − bboxSum − 8)`) plus an
> edge-vs-node repulsion force pushing third nodes perpendicular
> off the segment, plus a gravity bump to 0.0090. The combination
> over-corrected and clumped the entire graph; the bbox-aware
> equilibrium shifted distance ~287 (vs original 210) but the
> temperature cap meant close-range pushes were always
> max-displacement, producing instability. If we revisit, the
> edge-vs-node repulsion needs a much weaker constant and a
> correct L1-rectangular `nodeBB` formula (the previous attempt
> had `Math.hypot(hw·uy, hh·ux)` which swaps components).

### Crossing-reduction post-pass (`_reduceCrossings`)

FR alone minimises **stress** (distance-mismatch), not edge
**crossings**. After FR converges, `_reduceCrossings()` does
**greedy hill-climbing on the worst-offender node**:

1. Snapshot all visible node positions and edges into flat
   structures, plus an `incidentEdges` index for fast scoring.
2. For each round (up to `min(2N, 400)`):
   a. Score every node by counting crossings its incident edges
      participate in; pick the unstuck node with the highest
      score (the worst offender).
   b. Try swapping it with EVERY other node — for each candidate,
      compute the local crossing delta from both involved nodes'
      incident-edge crossings.
   c. Commit the swap with the most negative delta (largest
      improvement). If no swap improves, mark the node "stuck"
      and move on; un-stick both nodes after any successful
      swap (their crossing pictures may have changed).
3. Stop when total crossings hit zero or no node can improve.
4. Commit final positions to Cytoscape via `_cy.batch`.

Why this beats random-pair simulated annealing: random pairs waste
attempts on zero-crossing nodes and often pick poor partners.
Worst-offender + best-global-swap concentrates the search where it
matters — 50-node × 100-edge graphs typically clear 70-100 % of
FR's residual crossings in low ms. Crossing test: CCW/orientation
predicate (segments cross iff each one's endpoints straddle the
other's line via 2-D cross products; shared-endpoint pairs don't
count). Finding the global crossing minimum is NP-hard, so this
stays a heuristic — just a much stronger one than random-swap SA.

State map:
- `_phys.nodeVel: Map<id, {vx, vy}>` per-node velocity
- `_phys.nodeRest: Map<id, {x, y}>` saved equilibrium target
- `_phys.edgeCP: Map<id, {x, y, vx, vy, tx, ty}>` rope control point
  with its current spring target (`tx`/`ty` set by `_syncEdgeLabels`)
- `_phys.history: Array<Map<id, {x,y}>>` undo stack (max 5),
  pushed before every `_runAutoLayout`

Drag handlers: `_onDragStart` (interrupts autolayout, wakes loop) ·
`_onDragNode` (rest follows pointer) · `_onDragFreeNode` (rest =
released position, integrator continues settling). Cytoscape moves
the dragged node natively; the integrator never touches it directly.

**Drag event bindings.** The handlers are wired to BOTH event-name
aliases — `grab` + `dragstart` for start, `free` + `dragfree` for
end — because Cytoscape's documented node-drag events are
`grab`/`drag`/`free` while `dragstart`/`dragfree` are partial aliases
that fire in some code paths but not all. Listening to both
guarantees the integrator wakes regardless of which alias actually
fires for a given grab gesture in the current Cytoscape build.

**Snap-when-asleep guard.** `_syncEdgeLabels` will snap each edge
CP directly to its target only when ALL THREE conditions hold:
`_phys.raf === null` AND `_phys.draggedId === null` AND
`_phys.mode !== 'autolayout'`. Earlier the check was just
`!_phys.raf`, which was vulnerable to brief rAF flicker between
tick rescheduling and the next mousemove — that would zero out the
rope-lag mid-drag and make the bow invisible. The combined check is
safe: rope physics only gets snapped away once the user has
actually let go.

Tunables in `PHYS_K`: `EDGE_SPRING` 0.04 · `EDGE_DAMP` 0.85 ·
`NEIGH_PULL` 0.0 · `REST_PULL` 0.055 · `NODE_DAMP` 0.78 ·
`COLLISION_KICK` 0.55 · `PADDING` 14 · `MAX_VEL` 45 · `GRAVITY`
0.0060 · `ENERGY_SLEEP` 0.05 · `AUTOLAYOUT_MS` 3500.

`NEIGH_PULL` is **disabled by default** (0.0). The user wanted
dragging to affect only the held node plus collision impulses;
connected nodes staying put. Set to a small value (e.g. 0.04) to
re-enable a subtle "lean toward the dragged node" effect.

**Geometric note about rope bends:** A quadratic Bézier through
endpoints `(P0, P2)` with control point `P1` only visibly bows
when `P1` is non-collinear with the chord `P0P2`. For pure
translational drag along the chord (the most common case), the
CP-lag stays along the chord and looks like nothing happens — the
curve just gets longer. Rope bends are visible primarily when the
chord ROTATES under drag (which happens any time you drag a node
non-parallel to its existing edges). This is a fundamental
geometric constraint of single-CP quadratics, not a tuning issue.

The legacy `_bounce` (snap-displace), `_onDragFree` (per-node
inertia rAF), `_killInertia`, `_inertiaRaf`, `_prevPos`, `_vel`,
and the `_squish` keyframe helper are all removed — the integrator
subsumes them. `cm-squish-x`/`-y` CSS keyframes are gone too.

Right-click context menu via Cytoscape `cxttap` handler `_onCtxNode`.
Items: "Otevřít detail", "Zaměřit okolí" / "Zrušit fokus", plus
mode-aware shortcuts. Menu is a singleton `.cm-ctx-menu` div on `<body>`.
Dismissed on outside-click, Esc, or blur.

Public API: `render(mode)` · `savePositions()` · `resetLayout()` ·
`runAutoLayout()` · `runDagreLayout()` · `undoLayout()` · `toggleFaction(fid)` ·
`setFilterValues(arr)` · `toggleEdgeType(t)` · `toggleFocusMode()` ·
`setFocusHops(n)` · `clearFilters()`.
(Legacy `setSearch/toggleStatus/setMinKnowledge` removed — chip filter
replaces all three.)

Toolbar buttons (all edit-mode-only via the existing `cm-save-pos`
class): **✨ Auto rozložení** (`runAutoLayout`) · **↶ Zpět rozložení**
(`undoLayout`, disabled when history empty — JS toggles
`opacity` and `pointer-events` via the `cm-undo-layout` class) ·
**⟳ Rozložení** (`resetLayout`, clears localStorage and re-runs the
initial Cytoscape layout) · **💾 Uložit pozice** (`savePositions`).
The **frakce** mode additionally renders **⊞ Hierarchie**
(`runDagreLayout`) — a one-shot dagre top-down layout (dagre is
registered via `cytoscape.use(cytoscapeDagre)` at app.js init and
bundled inside cytoscape-dagre 4; no standalone dagre script). It
ranks on the STRUCTURAL hierarchy only — hub→member (`mbr_`),
hub→location (`loc_`), and command chains (`*-commands`) — passed via
the layout's `eles` option; lateral `ally`/`negotiates` edges still
render but are excluded so faction hubs stay in the top rank. The
resulting node positions are adopted as the physics `nodeRest` and
saved (same persistence path as Auto rozložení), so the integrator
holds the hierarchy until the user drags.

Word-wrap uses a custom canvas engine. `canvas.measureText()` with
a `Map` cache. Call `_wrap(text, font, maxW)` returns `string[]`.
Heights estimated pre-layout. `_resizeToActual()` corrects after
first paint.
