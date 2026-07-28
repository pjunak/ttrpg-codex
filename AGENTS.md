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
The durable suite backlog lives only in [`docs/BACKLOG.md`](docs/BACKLOG.md).
Temporary implementation plans are local-only: store them under the gitignored
`docs/plans/` directory, delete them when the task closes, and never commit
them. Do not create additional TODO or roadmap files.
User instructions always override this file.

## Environment

Node is not in Git Bash PATH, but Windows-native Node 26 **is** available via
the PowerShell tool — `npm test` (and `node --test test/<file>.test.*js`) run
the full suite there. `npm run lint` is the zero-warning static correctness
gate; `npm run check` runs lint followed by the full suite. Use PowerShell (not
the Bash tool) for node/npm. The Bash tool's node calls fail, and
`preview_start` / Docker aren't available — the app itself is still
launched/exercised manually by the user.

## Project

Collaborative D&D wiki. **All code/admin in English; the UI ships
English source strings with a per-browser Czech translation** (defaults to
English; Czech is selected under Settings → Language).
See [docs/reference/i18n.md](docs/reference/i18n.md).
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
| [settings.md](docs/reference/settings.md) | /nastaveni — enum categories, special tabs, attitudes contract, marker icons |
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
| Auth | HttpOnly `edit_session` cookie verified with a credential-derived SHA-256 token. Passwords in `data/auth.json` (Settings → Account) with env `DM_PASSWORD` / `PLAYER_PASSWORD` fallback (`EDIT_PASSWORD` = legacy DM alias). See docs/reference/routing-navigation.md → Auth flow. |
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
                           campaign-shape-migration.cjs (pure legacy-data transform) ·
                           auth.cjs (credentials, sessions, role gates/routes) ·
                           live-sync.cjs (role-scoped SSE clients/broadcasts) ·
                           snapshot-service.cjs + snapshot-routes.cjs ·
                           addons.cjs (broker) · addon-testing.cjs (test
                           green-gate) · addon-content.cjs (contentDir) ·
                           zip-reader.cjs (shared bounded lazy ZIP reader) ·
                           durable-files.cjs (fsync/copy/rename primitives) ·
                           core-write-lock.cjs (bounded FIFO mutex) ·
                           publication-barrier.cjs (read isolation) ·
                           collection-transactions.cjs (durable addon commits) ·
                           campaign-restore.cjs (durable restore publication) ·
                           campaign-bundle-contract.cjs (pure core bundle
                           planner/inventory) · campaign-bundle-provider.cjs
                           (host provider + restricted addon contributions) ·
                           campaign-mutations.cjs (core cross-record invariants) ·
                           write-revision.cjs (optimistic record revisions) ·
                           import-contract.cjs (provider/parser/plan guards) ·
                           import-jobs.cjs (preview/commit job lifecycle) ·
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
    addon-registration-contract.js
                           Shared register* argument validation used by the
                           live facade and authoring harness.
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
    import-center.js       Core DM-only campaign bundle review/commit page.
    store.js               In-memory domain state, secondary indices, trash,
                           undelete, and settings API.
    store-transport.js     Validated loads, optimistic revisions, recovery,
                           and the serialized retrying PATCH queue.
    write-revision.js      Browser half of the server/browser revision hash.
    store-admin-client.js  Add-on update/rollback and restart administration.
    api-client.js          Shared JSON/FormData request handling, structured
                           errors, and auth-failure signaling.
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
    pin-types.js           Immutable built-in pin metadata and live-choice
                           fallback helpers; data.js derives settings seeds.
    settings-backup.js     Role-aware snapshot/backup settings controller.
    settings-account.js    Account/password/restart settings controller.
    edit-drafts.js         Markdown draft persistence and dirty-state guard.
    edit-login.js          Password modal and login flow.
    edit-lore-controller.js
                           Pantheon, artifact, and historical-event workflows.
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
    editmode.js            Domain editors, uploads, EasyMDE composition, and
                           toast() with action-button support.
    edit_templates.js      HTML form templates for edit overlays.
    search.js              Global Ctrl+K search palette (GlobalSearch).
    role.js                Client cache of /api/auth: Role.isDM()/isPlayer(),
                           view-as switching, body.is-dm/-player classes.
    dm_dashboard.js        Stable DM-only /dm shell: authorization, addon
                           dashboard slot, diagnostics, and recovery fallback.
    settings.js            /nastaveni composition: enum/map/appearance editors
                           and the DM Addon Manager.
    sidebar.js             Data-driven left nav (Sidebar.render) +
                           DM drag-drop layout editor (renderEditor).
    widgets/
      widgets.js           Self-mounting Combobox + MultiSelect + TagFilter.
      tagfilter.js         Reusable search+chips primitive (AND-match).
```

## Module boundaries

Use named ES-module exports. Stateful facades commonly use
`export const Store = (() => { ... })()`, while pure modules export functions
directly. Choose the form that makes ownership clearest; do not wrap stateless
helpers in an IIFE just for consistency. Import shared browser helpers from
`utils.js` and never add a private `_esc`.

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

- Read [`web/css/STYLE.md`](web/css/STYLE.md) before UI work. Reuse the
  documented tokens and components; add a token for recurring or semantic
  values. Technical one-off dimensions are allowed when they are not
  theme-dependent.
- `web/index.html` links only `css/bundle.css`; component styles are imported
  through `bundle.css`.
- Theme overrides belong in `themes.css`. New themes add one `THEMES` entry
  and one token-override block, not component-specific rewrites.
- Canonical breakpoints are 768 / 1100 / 1200 px.
- `--bg-card` is parchment. Use `--bg-raised` for dark panels.

## Companion repos — the D&D addon suite

Three sibling repos (expected as sibling checkouts of this repo) hold the
D&D toolkit built on the addon framework. **Each has its own
AGENTS.md / README with full repo-local context — read those before working
there.**

| Repo (sibling dir) | Addon id | What it is |
|---|---|---|
| `dnd-character-sheets` | `dnd-sheets` | Tabbed character sheet (Overview/Character Sheet/Combat/Spellbook/Builder) + a built-in pure rules engine (`rules/engine.js` + `rules/api.js`), edition-parameterized (built-in 2024 constants; a provider's `ruleset` record overrides per constant — `dnd5e-compendium` is the reserved 2014 provider id). Standalone hand-fillable; soft-dep (`optionalDependencies`) on the compendium. Engine mode is per character: a returned provider cannot overwrite manually changed materialized fields until the user explicitly keeps manual mode or resumes the rulebook. `provide()`s the rules API for future consumers. ⚠ The addon id keys `character.addonData` — renaming it orphans sheet data without a key migration. |
| `dnd55e-compendium` | `dnd55e-compendium` | Structured D&D 2024 content — the three core books plus Eberron, Forgotten Realms, Ravenloft, Lorwyn, and Astarion options (over 3,000 records). Canonical `book` provenance and optional `availableIn` reprint membership keep every source toggle-safe without duplicate entities. The host serves the per-record JSON tree through `contentDir`; `/compendium` provides browsing and the pure data API consumed by sheets. The private repository requires `CODEX_GITHUB_TOKEN` for installs and updates. |
| `dm-tools` | `dm-tools` | DM-only campaign planning and world-building: manually editable threads, quests, situations, encounters, notes, folders, stable named sections, and named semantic links to core or optional-addon records. The same contract powers reviewed multi-collection LLM imports and a collapsible planning graph. Legacy `scenarios` are copied non-destructively into keyed planning data; core retains `/dm` authorization, diagnostics, persistence, transactions, and recovery fallback. |

Working loop: edit in the addon repo → `node scripts/dev-install-addon.cjs
<path-to-addon>` (run in THIS repo) → restart the app + refresh. ⚠ **Addon
repo edits are invisible until re-dev-installed.** Tests per repo:
`node --test tests/<file>.mjs` from that repo's root (RELATIVE paths — the
directory form and absolute Windows paths false-fail on Windows).
Production updates go through the Manager wizard; **Update all** keeps existing
grants, so an update that adds a permission must use the per-addon wizard.
The compendium's committed `data/` tree is the rule-content source of truth.
`Living-scroll` is input to one merge-preserving equipment importer, not an
authoritative replacement for curated records.

Addon client lifecycle: API-v2 addons can require `lifecycle.dispose` and
`content.revision`. `register(host)` may return a disposer and can add more via
`host.onDispose(fn)`; the host runs them LIFO exactly once, bounded and
failure-isolated, before reversing registrations. A changed `entryUrl` or
deterministic `contentRevision` unloads the addon and loaded consumers
consumer-first, then reloads provider-first. Content-group toggles therefore
refresh compendium data and sheets live without a browser reload.

## Backlog and planning

[`docs/BACKLOG.md`](docs/BACKLOG.md) is the only durable backlog for the host
and companion addons. It contains current maintenance work, product candidates,
conditional hardening, explicit non-goals, and decisions that need the
maintainer. Reference documents describe shipped contracts and must not grow
independent TODO lists.

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
