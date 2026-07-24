# AGENTS.md — O Barvách Draků

AI-session reference. Read before exploring. **This file is the canonical,
committed agent contract** — the gitignored root `CLAUDE.md` is only a thin
local pointer here for tools that auto-load CLAUDE.md. Never maintain a
duplicated copy in either direction.

## Approach

Think before acting. Read existing files before writing code.
Be concise in output but thorough in reasoning.
Prefer editing over rewriting whole files.
Do not re-read files you have already read unless the file may have changed.
Skip files over 100KB unless explicitly required.
Recommend starting a new session when switching to an unrelated task.
No sycophantic openers or closing fluff.
Keep solutions simple, well-structured, documented, and maintainable.
Follow established best practices and prefer clear designs over clever ones.
Write self-documenting code. Do not add comments that narrate changes, restate
the code, or preserve implementation history. Add a comment only when it is
needed to explain a non-obvious invariant, constraint, or why the obvious
solution is incorrect or unsafe.
Planning artifacts are local-only. Store them under the gitignored
`docs/plans/` directory and never commit them.
User instructions always override this file.

## Environment

Node is not in Git Bash PATH, but Windows-native Node 26 **is** available via
the PowerShell tool — `npm test` (and `node --test test/<file>.test.*js`) run
the full suite there. Use PowerShell (not the Bash tool) for node/npm. The Bash
tool's node calls fail, and `preview_start` / Docker aren't available — the app
itself is still launched/exercised manually by the user.

## Project

Collaborative D&D wiki. **All code/admin in English; the UI ships
English source strings with per-user translations** (defaults to the
viewer's browser language — Czech for Czech browsers — and falls back to
English). See [docs/reference/i18n.md](docs/reference/i18n.md).
Players and DM view and edit characters, locations, events, mysteries, factions.
Changes propagate to all clients in under 1 s via SSE on `/api/events`.

## Deep reference — read on demand

The subsystem encyclopedia lives in [`docs/reference/`](docs/reference/)
(moved out of this file so every session doesn't pay ~50k tokens for it).
**Those files are the same contract as AGENTS.md — read the relevant one
BEFORE working on its area, and keep it updated exactly the same way.**

| File | Read before touching |
|---|---|
| [i18n.md](docs/reference/i18n.md) | Any user-facing string — catalogs, t()/plural(), the two i18n test guards |
| [ui-widgets.md](docs/reference/ui-widgets.md) | Combobox/MultiSelect/TagFilter mounts, inline create, the `data-action` dispatcher + sentinels |
| [routing-navigation.md](docs/reference/routing-navigation.md) | Route table, list toolbars, global search, sidebar layout, mobile nav, per-page edit affordances, auth flow, prefill creation |
| [settings.md](docs/reference/settings.md) | /nastaveni — enum categories, special tabs, attitudes contract (⚠ migration idempotency), marker icons |
| [data-model.md](docs/reference/data-model.md) | Collections + fields, pets, twin visibility model, entity ids, undo/trash, wiki-links, the full Store API, write queue |
| [wiki-rendering.md](docs/reference/wiki-rendering.md) | Attitude glow, dashboard, article shell, split editors, EasyMDE, draft recovery + dirty guard |
| [maps-timeline.md](docs/reference/maps-timeline.md) | WorldMap (pins, tile pyramid, zoom, presets, sub-maps) + the timeline kanban |
| [cloudmap.md](docs/reference/cloudmap.md) | Mind maps — node/view registries, text scaling, edge physics (incl. tried-and-reverted approaches: do NOT retry) |
| [server.md](docs/reference/server.md) | The API table, snapshots, write lock, path safety, proto guard, SRI, test inventory, deploy surface |
| [addons.md](docs/reference/addons.md) | The whole CodexHost framework — manifest, host/serverHost facades, permissions, fragments, contentDir, install pipeline |

Public/human docs are separate: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
(overview), [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) (ops),
[examples/addons/AUTHORING.md](examples/addons/AUTHORING.md) (addon authors).

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 26 + Express 5 (`server.js`) |
| Frontend | Vanilla ES6 modules. No build step. No framework. |
| Storage | JSON files in `data/` |
| Mind maps | Cytoscape.js 3.34 (`cloudmap.js`); dagre layout bundled in cytoscape-dagre 4 |
| World map | Leaflet 1.9.4 (`map.js`) |
| Auth | SHA256 cookie `edit_session`. Passwords in `data/auth.json` (Settings → Účet) with env `DM_PASSWORD` / `PLAYER_PASSWORD` fallback (`EDIT_PASSWORD` = legacy DM alias). See docs/reference/routing-navigation.md → Auth flow. |
| Uploads | Multer. Portraits/local maps 20 MB · world map 40 MB · logo 5 MB · marker icons 2 MB × 16 · restore ZIP 200 MB. |
| Backup | `archiver`. `/api/backup` stages a locked point-in-time copy, then streams the ZIP outside the lock. |
| Deploy | Docker (`docker-compose.yml`) |

## Key Files

```
server.js                  Express server + REST API
server-utils.cjs           Pure server helpers (password hashing, path
                           safety, snapshot-pruning policy) — unit-tested.
tiler.js                   sharp tile-pyramid builder (world + local maps).
server/                    visibility.cjs (role filter) · migrations.cjs ·
                           addons.cjs (broker) · addon-testing.cjs (test
                           green-gate) · addon-content.cjs (contentDir) ·
                           core-write-lock.cjs (bounded FIFO mutex) ·
                           publication-barrier.cjs (read isolation) ·
                           collection-transactions.cjs (durable F2 commits) ·
                           import-contract.cjs (provider/parser/plan guards) ·
                           import-jobs.cjs (F4 preview/commit job lifecycle) ·
                           addon-import-harness.cjs (published server harness).
web/
  index.html               SPA shell. Loads bundle.css + app.js.
  i18n/
    en.json cs.json        UI translation catalogs (flat dotted keys;
                           en = source of truth). See docs/reference/i18n.md.
  css/
    bundle.css             Only <link> in index.html. @imports everything else.
    main.css themes.css wiki.css cloudmap.css edit.css timeline.css
    swordcoast.css factions.css widgets.css search.css settings.css
  js/
    app.js                 Router. Navigation. SSE live-sync. ACTIONS dispatcher.
    addons.js              Addon host (CodexHost). Loads /addons/<id>/<hash>/
                           entry modules, hands each a scoped `host` facade.
                           Consulted by navigate()/sidebar. See docs/reference/addons.md.
    addon-deps.js          Pure dependency resolver: semver `satisfies` +
                           `planLoadOrder` topo-sort (blocked/cycle states).
    addon-fragments.js     Pure fragment-override engine
                           (applyFragmentOps + listConflicts).
    addon-test-harness.mjs Published authoring harness (createMockHost,
                           dryRunRegister, smokeRegistrations).
    addon-lifecycle.js     Shared bounded disposer stack used by the live host
                           and authoring harness.
    addon-graph.js         API-v2 graph facade v1 + host-global implementation
                           registry and shared validation/lifecycle contract.
    addon-graph-cytoscape.js
                           Private adapter for the existing SRI-pinned runtime;
                           raw Cytoscape never crosses the addon boundary.
    addon-host-contract.js Shared host.use + collection-declaration contract.
    addon-transactions.js  Shared buffered transaction facade used by the
                           live host and authoring harness.
    store.js               In-memory state. Server sync. Secondary indices.
                           Trash + undelete. Settings API.
    data.js                Defaults: FACTIONS, collections (CHARACTERS,
                           LOCATIONS, EVENTS, MYSTERIES, PANTHEON,
                           ARTIFACTS, HISTORICAL_EVENTS), REL_TYPES
                           (canonical), SETTINGS_DEFAULTS,
                           SETTINGS_USAGE_MAP.
    constants.js           PARTY_FACTION_ID, SIDEBAR_PAGES (each carries
                           an i18n `key`), SIDEBAR_LAYOUT_DEFAULT, THEMES.
    collection-descriptors.js
                           Immutable built-in collection identity, wiki-kind,
                           alias, and article-route registry.
    i18n.js                I18n: per-user UI language. t()/plural()/dates
                           via native Intl.*. Catalogs in web/i18n/. See
                           docs/reference/i18n.md.
    utils.js               Shared helpers: esc, escapeRe, norm, debounce,
                           slugify, extractOutline, safeColor (the shared
                           colour sanitizer), humanTime (now a thin
                           shim over I18n.relativeTime), renderMarkdown,
                           expandWikiLinks + setWikiLinkResolver,
                           breadcrumbNav (the shared wayfinding row —
                           articles + addon pages via host.h.breadcrumb),
                           iconGlyph (the shared stat-glyph set —
                           host.h.icon; mirrored in the test harness),
                           announce (SR status via the ONE persistent
                           polite live region — host.ui.announce).
    wiki.js                Wiki renderer. _articleShell (head panel + outline).
    cloudmap.js            Cytoscape + HTML cloud cards + canvas word-wrap.
    timeline.js            Timeline kanban at /casova-osa.
    map.js                 Leaflet world map. Exports WorldMap.
    editmode.js            Edit toggle. Auth. Portrait upload. EasyMDE mount.
                           toast() with action-button support.
    edit_templates.js      HTML form templates for edit overlays.
    search.js              Global Ctrl+K search palette (GlobalSearch).
    role.js                Client cache of /api/auth: Role.isDM()/isPlayer(),
                           view-as switching, body.is-dm/-player classes.
    dm_dashboard.js        /dm landing page (DM-only entity counts + stubs).
    settings.js            /nastaveni: enum editors, Vzhled, Účet/Server,
                           and the DM Addon Manager (install wizard,
                           content-group toggles).
    sidebar.js             Data-driven left nav (Sidebar.render) +
                           DM drag-drop layout editor (renderEditor).
    widgets/
      widgets.js           Self-mounting Combobox + MultiSelect + TagFilter.
      tagfilter.js         Reusable search+chips primitive (AND-match).
```

## Module pattern

Every JS module is an IIFE exported as a named const.
Example: `export const Store = (() => { ... })()`.
New code imports shared helpers from `utils.js`.
Do not add a private `_esc` inside a module.

**Escaping discipline (the app builds HTML via template strings, CSP is
off — this is the XSS boundary):** every user-sourced string interpolated
into HTML MUST pass `esc()` (covers `& " ' < >`; the `'` matters because
`dataAction`/`dataOn` emit single-quoted `data-args`). Free-text colours
MUST pass `safeColor` (utils.js — imported by wiki.js / map.js /
edit_templates.js / settings.js; cloudmap.js keeps an equivalent private
`_safeColor`) before landing in a style attribute. "User-sourced" includes entity names/titles/tags, faction
`badge`/`color`, settings enum labels/icons/ids, and `I18n.t()` output
(plain text by contract). `renderMarkdown` output is DOMPurify-sanitized
and safe to inject as-is.

## CSS rules

- **UI work goes through the design system — always.** Any change that
  touches the UI (built-in pages, settings, addons) must use design
  tokens (`var(--…)`) and the documented component classes — never
  hardcoded colours / spacing / sizes. This is what makes the theme
  switcher (Settings → Vzhled) and addon styling work: a literal value
  can't be re-skinned by a `[data-theme]` block and won't match the rest.
  Reach for an existing token; if none fits and the value recurs or is
  semantic, add a token rather than inline it. Full reference:
  **`web/css/STYLE.md`**.
- `index.html` links only `css/bundle.css`. Never add another `<link>`.
- All CSS files are `@import`ed in `bundle.css` in order. `themes.css`
  holds `[data-theme="<id>"]` token-override blocks (`classic` = the bare
  `:root` baseline); adding a style = one `THEMES` entry (constants.js) +
  one themes.css block, no component edits.
- **Design tokens** live on `:root` in `main.css`. Semantic colours
  (`--bg-deep/base/surface/raised`, `--bg-card`, `--text-*`,
  `--accent-gold`, faction/status colours, `--font-*`) plus the scales
  added in the design-system cleanup: spacing (`--space-1..6`, 4px
  rhythm), type (`--text-xs..3xl`), radius (`--radius-sm`, `--radius`,
  `--radius-lg`, `--radius-pill`), elevation (`--shadow-sm/md/lg`),
  z-index (`--z-base/sticky/drawer/dropdown/modal/toast`), motion
  (`--ease-out`, `--dur-fast/base/slow`), **channel tokens** for alpha
  use (`--accent-gold-rgb`, `--gold-muted`, `--status-{alive,dead,
  captured,unknown}-rgb` — `rgba(var(--accent-gold-rgb), 0.25)`), and a
  **semantic feedback palette** (`--color-danger`/`-bright`/`-bd`,
  `--color-success`, `--color-info`, `--color-mystery`, `--text-cream`).
  The bundle's colours were swept onto these in the design-system
  unification; see `STYLE.md` for the full map + the per-pass status.
  Canonical breakpoints (documented in `:root`, can't be CSS vars in
  `@media`): 768 / 1100 / 1200 px.
- A global `:focus-visible { outline: 2px solid var(--accent-gold) }`
  in `main.css` gives keyboard-focused controls an on-brand ring; it
  only fires for keyboard/AT nav and is overridden by component focus
  styles via specificity.
- **Colour gotcha:** `--bg-card` is **parchment** (`#F5EDD8`), not a
  dark surface. Use `--bg-raised` for dark panels. Using `--bg-card`
  for a dark-theme box produces the "bright ugly panel" bug (the
  `.sc-btn:hover` instance — which flashed parchment on the dark map
  toolbar — was fixed to a `rgba(var(--gold-muted), …)` tint).

## Companion repos — the D&D addon suite

Two sibling repos (expected as sibling checkouts of this repo) hold the
D&D toolkit built on the addon framework. **Each has its own
AGENTS.md / README with full repo-local context — read those before working
there.**

| Repo (sibling dir) | Addon id | What it is |
|---|---|---|
| `dnd-character-sheets` | `dnd-sheets` | Tabbed character sheet (Overview/Character Sheet/Combat/Spellbook/Builder) + a built-in pure rules engine (`rules/engine.js` + `rules/api.js`), edition-parameterized (built-in 2024 constants; a provider's `ruleset` record overrides per constant — `dnd5e-compendium` is the reserved 2014 provider id). Standalone hand-fillable; soft-dep (`optionalDependencies`) on the compendium — engine mode lights up when book data is present. `provide()`s the rules API for future consumers. ⚠ The addon id keys `character.addonData` — renaming it orphans sheet data without a key migration. |
| `dnd55e-compendium` | `dnd55e-compendium` | The complete D&D 5.5e (2024) content addon — PHB, DMG material, and the Monster Manual bestiary (~1,880 records) as a per-record JSON tree served by THIS host via manifest `contentDir` (no server code, hot install/update). `/compendium` browse UI (+ `/bestiary` alias) + `[[…|spell]]`-style wiki kinds; `provide()`s the pure data API the sheets engine consumes. The equipment importer reads the sibling `Living-scroll` checkout. ⚠ The GitHub repo is **PRIVATE** (since 2026-07, so owner-owned copyrighted book content can live there — see its `data/COVERAGE.md`); GitHub installs/updates need `CODEX_GITHUB_TOKEN`. |
| `dm-tools` | `dm-tools` | API-v2 reference consumer for host-managed DM-only data, F2 transactions, F4/F5 imports, localization, and the F6 graph facade. It declares only the list-shaped `scenarios` collection with `access:"dm"`; its read-only graph page maps each scenario to one independent node because the schema has no relationships. Planners, dashboard ownership, additional providers, and speculative collections remain out of scope. |

Working loop: edit in the addon repo → `node scripts/dev-install-addon.cjs
<path-to-addon>` (run in THIS repo) → restart the app + refresh. ⚠ **Addon
repo edits are invisible until re-dev-installed.** Tests per repo:
`node --test tests/<file>.mjs` from that repo's root (RELATIVE paths — the
directory form and absolute Windows paths false-fail on Windows).
Production updates go through the Manager wizard; ⬆ "Aktualizovat vše"
keeps existing grants, so an update that ADDS a permission must use the
per-addon wizard. The retired `dnd55e-core-rules` addon merged into sheets;
its GitHub repo should be archived. Port source-of-truth for 2024 rule
content: the sibling `Living-scroll` repo
(`modules/compendium/data/dnd_2024/`).

Addon client lifecycle: API-v2 addons can require `lifecycle.dispose` and
`content.revision`. `register(host)` may return a disposer and can add more via
`host.onDispose(fn)`; the host runs them LIFO exactly once, bounded and
failure-isolated, before reversing registrations. A changed `entryUrl` or
deterministic `contentRevision` unloads the addon and loaded consumers
consumer-first, then reloads provider-first. Content-group toggles therefore
refresh compendium data and sheets live without a browser reload.

## Future ideas / roadmap

These aren't implemented; record here so they survive across
sessions and don't get re-discovered:

- **Per-Pohled marker visibility rules.** The legacy zoom-gated pin
  priority system was retired in favour of letting each `mapViews`
  preset carry rules — e.g. "hide pins of type X", "only show pins
  with attitude Y", "only show pins with size ≥ N". Wire through
  `_pinsForCurrent` / `_resolvePinSize` in `map.js` when building it;
  the toolbar already has the preset switcher to drive context.
- **Striped multi-attitude glow in the wiki.** Map markers already
  do this (see "Striped multi-attitude glow on map markers" above).
  Wiki surfaces still use the additive blend — portraits as the
  `--attitude-ring` box-shadow border ring, location cards / faction
  badges as the inline `style="filter: ${glow}"` drop-shadow (see
  docs/reference/wiki-rendering.md → Attitude glow). Extending the
  stripe approach there means per-segment masking (a stacked-img
  wrapper for icons, a conic-gradient ring for portraits). Defer
  until the additive blend on those surfaces actually feels muddy
  enough to warrant the work.
- **Radial segmentation of the attitude glow.** Vertical-stripe
  segmentation (TF2-style sheared slabs) is what map markers
  ship; wedge / pie-slice radial segmentation was the alternative
  considered. Vertical reads better at small marker sizes; revisit
  radial only if a future use case (large icons, character bust
  portraits) shows that vertical segments don't carry the read.
- **Strength presets** in the Settings attitudes editor (lehce /
  silně / velmi silně shortcuts) as alternatives to the continuous
  slider.
- ~~**PD baseline icon shipping.**~~ Done — see
  `web/icons-defaults/` + `ATTRIBUTIONS.md`. Settled on game-icons.net
  (CC BY 3.0) rather than CC0 because the CC BY pool had a much
  better selection of medieval / settlement-style markers; the
  attribution obligation is documented in the repo root and
  carries through to forks.
- **Bulk zip upload for marker icons.** Accept a zip whose entries
  follow `<pinTypeId>/<filename>.<ext>` as a power-user import path.
  Server should reuse the bounded yauzl-style streaming extraction pattern
  into `data/icons/`, then the user
  manages individual slots through the existing per-marker editor.
- **Per-place icon override.** Let a single Location pick a specific
  icon variant (or a one-off uploaded file) overriding its pin
  type's strategy.

### Known deferred issues (2026-07-03 audit — verified real, consciously postponed)

1. Addon-rendered HTML can invoke ANY core action via
   `data-action="Store.deleteCharacter"` — the dispatcher doesn't scope
   actions inside `[data-addon-id]` subtrees. Accepted under the
   trusted-addon posture; revisit before third-party addons (any fix must
   also cover the `deferred(action,…)` indirection).
2. Missing guard tests: remaining addon permission-facade methods. Collection
   declaration, `data:own`, ownership, effective-role, and keyed/unkeyed CRUD
   guards are covered by the live/mock F1 matrix.
    (The `/api/restore` path-safety and migration-idempotency gaps listed
    here originally are CLOSED; visibility closure is also CLOSED by
    `test/visibility.test.cjs` + `test/integration-visibility.test.cjs`.)
3. Structural: server.js / store.js / settings.js god files; 4 duplicated
    collection→route maps (wiki `_TWIN_LINK_ROUTE`, edit_templates
    `TWIN_ROUTE_PREFIX`, editmode `_TWIN_ROUTE`, app `KIND_ROUTE`); 8
    near-clone entity editors; no linter/formatter.

### Open decisions (need the maintainer)

- Password hashing is a single SHA-256(salt+pwd) (`server-utils.cjs`) —
  switching to `crypto.scrypt` is recommended but invalidates sessions
  (needs a hash-format migration + scheduled re-login).
- CSP is off; enabling `script-src` alone (self + the SRI-pinned CDNs) is
  achievable now — there are no inline scripts.
- No LICENSE file (maintainer intent: permissive/MIT).

### Settled decisions (2026-07-03)

- **Offline/local play is OUT OF SCOPE.** The CDN-served libraries
  (SRI-pinned) stay — do not vendor them; do not build offline support.

## Constraints

- No bundler. No transpiler. Browser-native ES6 modules only.
- No external database. JSON files only.
- No framework. Vanilla JS.
- Any module whose methods are referenced via `data-action="Module.method"`
  must be imported in `app.js` and added to the `ACTIONS` map (no
  `window.*` exports).
- Node 24+ required (`engines: >=24`); the Docker image + local dev run **Node 26**
  (`node:26-slim`, `.nvmrc` 26). Uses `crypto.createHash` built-in.
- `data/` is a Docker volume. Never commit runtime data to git.
- `helmet` middleware is wired in `server.js` with CSP off (the UI
  uses inline `style` attributes that strict CSP would block; there are
  no inline `<script>`s — all JS is external ES modules (the sidebar is
  rendered by the `Sidebar` module, not pre-boot inline JS) — so
  re-enabling `script-src 'self'` is straightforward when ready). All other
  security headers (X-Content-Type-Options, X-Frame-Options,
  Strict-Transport-Security in production, etc.) are on by default.
