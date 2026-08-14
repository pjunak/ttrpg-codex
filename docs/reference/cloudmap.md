# CloudMap (mind maps) — deep reference (ttrpg-codex)

> Canonical contract for core mind maps and their layout/physics invariants.
> The tried-and-rejected notes are retained where they prevent regressions.

## CloudMap architecture

`cloudmap.js` renders four mind-map modes. All share one Cytoscape
instance and an HTML overlay.

The API-v2 addon graph facade is deliberately separate. Its host-global
adapter registry and narrow API live in `addon-graph.js` /
`addon-graph-cytoscape.js`; core CloudMap does not route through that facade.
The facade exposes no raw Cytoscape behavior, and every physics, overlay,
layout-persistence, text-scaling, and tried/reverted invariant documented
below remains unchanged.

| Mode | Nodes | Edges |
|---|---|---|
| `frakce` | faction hubs + characters + locations | hub→member, hub→location, commands, negotiates, ally |
| `vztahy` | characters only | all relationship types |
| `tajemstvi` | mystery nodes + involved characters | mystery→character |
| `casova-osa` | events + involved characters | chronological chain + event→character |

> `CloudMap.render('casova-osa')` exists internally but no route wires it.
> Timeline owns `/casova-osa` (top-level, no `/mapa/` prefix).

Node `type` values used by `_applyFactionFilter` and edge logic:
`'faction'` · `'character'` · `'location'` · `'mystery'` · `'event'`.

**Node kinds + views are data-driven registries.**
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

### CloudMap native geometry and stepped typography (`--cm-z` + `--cm-type-z`)

`_cloudLayer` holds both `_edgeSvg` (paths) and all cloud cards. Card geometry
follows `--cm-z` continuously, while text follows `--cm-type-z`: it stays at
its 100% size while zooming out and grows in 25% steps while zooming in. Both
variables change real CSS dimensions, so the browser re-rasterizes glyphs at
the selected font size instead of bilinear-resampling a transformed card
texture. SVG edges retain their vector transform on `_edgeSvg`.

**`_sync()` does:**
1. If `Math.abs(zoom − _lastSyncedZoom) > 0.0005`, write `--cm-z`, derive the
   stepped typography value, and write `--cm-type-z` only if its band changed.
   Pan-only and physics-tick frames do not reflow card text.
2. Clear any leftover `zoom`/`transform` on `_cloudLayer`
   (defensive — older code paths may have set them).
3. Apply `transform-origin: 0 0; transform: translate(pan.x px,
   pan.y px) scale(zoom)` to `_edgeSvg` directly. Critical that
   transform-origin is `0 0` — SVG defaults to `50% 50%` which
   would offset edges.
4. Re-run cached Pretext layouts for marked built-in card fields at their real
   screen width. DOM line spans change only when the returned strings change.
5. Measure the resulting native card boxes once per zoom change, normalize
   their dimensions back into graph coordinates, and update proxy geometry so
   connector clipping, collision physics, and centering match visible cards.
6. Position wrappers in **screen coordinates** using the normalized dimensions.
7. Glows: same screen-coord centring; visual size `gs · zoom`
   (CSS handles via `calc(550px * var(--cm-z))` etc.).
8. `_syncEdgeLabels()` for label positioning.

**Built-in card text and edge labels** use the shared `layoutText` adapter,
backed by vendored Pretext. Each marked field declares its semantic role, base
width, and line cap. CloudMap supplies the band-specific font descriptor and
real screen width, renders returned strings as non-wrapping spans, and adds a
measured ellipsis when the line cap is exceeded. Addon-provided cards keep
their own rendering contract. Edge-label measurement also runs in screen
coordinates; its measured width is converted back to graph coordinates when
cutting the SVG gap. Font completion and locale changes invalidate shared
measurements, card lines, normalized card geometry, and edge-label results.

**Semantic detail levels** are derived by `cloudMapDetailLevel(zoom)` and
written only when the level changes. Below `1`, condensed hides facts, statuses,
and edge labels. Below `0.75`, compact also hides the strip and divider while
retaining the readable name. Below `0.45`, overview hides the name so only the
colored graph silhouette remains. CSS uses `visibility: hidden`; normalized
rendered bounds keep proxy geometry and edge endpoints aligned.

**Per-card width via inline CSS variable.** Card HTML templates
inline `style="--cc:…; --cw:${CW}px"` (or `--cw:${CW_HUB}px` for
faction hubs). The base `.cm-cloud` rule has `width: calc(var(--cw,
168px) * var(--cm-z, 1))`. Default `--cw: 168px` if not specified.

**`_resizeToActual()` measures the current native layout.** It refreshes
Pretext lines when requested, reads the rendered box after stepped typography
and wrapping, divides by the current geometry zoom, and updates Cytoscape node
dimensions. It never temporarily changes zoom and therefore cannot measure a
different wrapping state from the one users see.

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

Cytoscape's `minZoom` is `0.25`. Cards scale visually through native-sized
properties driven by `--cm-z`; semantic detail levels suppress text that is
too small to read while retaining the full card geometry.

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

Word-wrap uses the shared Pretext-backed `layoutText` adapter and its bounded
prepared-text/result caches. `_wrap(text, font, maxW)` materializes the exact
line strings used for pre-layout height estimates. `_resizeToActual()` still
corrects any residual browser-layout difference after first paint.
