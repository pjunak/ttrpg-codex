# Contributing

Thanks for taking a look. This guide covers local development, the
project's conventions, and the typical recipes you'll need.

## Prerequisites

- **Node.js 20+** ([install](https://nodejs.org/en/download)) for
  running the server and the test suite without Docker.
- **Docker + Docker Compose** ([install](https://docs.docker.com/engine/install/),
  [compose docs](https://docs.docker.com/compose/)) for the deployment
  flow and to mirror what production runs.
- A text editor. There's no language server config to install — the
  codebase is plain ES modules, no TypeScript, no build step.

## Local dev setup

```bash
git clone https://github.com/pjunak/ttrpg-codex.git
cd ttrpg-codex
npm install
DM_PASSWORD=test node server.js
```

Open <http://localhost:3000>. The dataset is empty on first run; click
any **✏** edit pencil (or the **🔑 Přihlásit** chip on the dashboard)
and enter `test` to start editing as DM. Set `PLAYER_PASSWORD` too if
you want to exercise the player role.

Changes to JS / CSS / HTML are picked up by reloading the browser tab.
There's no bundler, no transpiler, no hot-reload step — file → reload
is the entire dev loop.

### Running with Docker (matches production)

```bash
echo "DM_PASSWORD=test" > .env
docker compose up --build
```

This rebuilds the image so changes to `server.js` / `tiler.js` /
`server-utils.cjs` and the `web/` directory are picked up. Your local
`./data` and `./data-snapshots` directories are mounted as volumes;
delete them between experiments if you want a fresh state.

## Running tests

```bash
npm test
```

Tests live under `test/` and use Node's built-in `--test` runner.
There are two kinds:

- **Unit tests** exercise pure functions directly (e.g.
  `utils.test.mjs`, `server-utils.test.cjs`, `visibility.test.cjs`).
- **Integration tests** (`integration-*.test.cjs`) boot the real
  Express app in a child process against an isolated tempdir via
  `test/helpers/server-process.cjs`, then drive it over HTTP — so they
  cover auth, role filtering, migrations, and the snapshot/restore
  endpoints exactly as they run in production.

Two file extensions:

- `*.test.mjs` — browser-side modules (`web/js/*`). The `web/js/`
  directory has its own `package.json` declaring `"type": "module"` so
  Node treats those imports as ES modules.
- `*.test.cjs` — server-side modules (`server.js`, `server-utils.cjs`,
  `tiler.js`, and the integration suites).

Run a single file while iterating:

```bash
node --test test/integration-snapshots.test.cjs
```

Add a new test as `test/<name>.test.{mjs|cjs}`. For server-side
helpers worth testing, extract them into a separate CommonJS module
first — `server.js` itself starts the listener at import time and
isn't suitable for direct test imports. The pattern in use:
`server-utils.cjs` exports the side-effect-free helpers, `server.js`
re-binds them under their `_`-prefix legacy names, tests import the
canonical names directly.

## Project conventions

### IIFE module pattern

Every JS module is an IIFE assigned to a named export:

```js
export const Store = (() => {
  // private state + helpers
  return { /* public API */ };
})();
```

This keeps internals genuinely private (no `_`-prefix-by-convention
trick required) and lets a module own its event listeners without
leaking them. Imports come from sibling modules; shared helpers live
in [`web/js/utils.js`](web/js/utils.js) — don't redefine `esc` /
`norm` / `slugify` / `debounce` / etc. in a private scope.

### No `window.*` exports

Click handlers and other DOM events go through a single capture-phase
delegated dispatcher in [`web/js/app.js`](web/js/app.js). Templates
emit `data-action="Module.method"` (plus optional `data-args='[json,…]'`
or `data-on-change="…"`); `app.js` parses the attribute and invokes
the matching function from a registry of imported modules.

This means new modules **must** be imported in `app.js` and added to
the `ACTIONS` map for their methods to be reachable from templates.

Sentinels are resolved at dispatch time:
- `'$el'` — the element carrying the attribute
- `'$ev'` — the original Event
- `'$value'` — `el.value`
- `'$text'` — `el.textContent.trim()`
- `'$checked'` — `el.checked`

Use the `dataAction(method, ...args)` and `dataOn(kind, method, ...args)`
helpers from `utils.js` to build the attribute strings — they handle
JSON-encoding and HTML escaping.

### Comment style

- Default to no comments. A well-named function and well-typed
  arguments do most of the documentation work.
- When you do comment, explain **why**, not what. The code already
  shows what.
- JSDoc on every exported / module-public function (so contributors
  see the contract without reading the implementation).
- Skip changelog-style notes ("X used to live here", "added for
  Y feature") — `git log` / `git blame` cover history. Comments
  must explain the **present**.
- Load-bearing invariants — places where the obvious-looking change
  causes a subtle bug — get a clearly-marked WHY block. There are a
  handful of these; search the codebase for `LOAD-BEARING` to see
  the pattern.

### CSS conventions

`web/index.html` links exactly one stylesheet:
[`web/css/bundle.css`](web/css/bundle.css). Every other CSS file is
`@import`ed from there in dependency order. Don't add a second
`<link>` — the browser-native import keeps the source split for
editing without requiring a bundler.

Key variables live in `:root` inside [`web/css/main.css`](web/css/main.css):
`--accent-gold`, `--bg-dark`, `--bg-card`, `--bg-raised`,
`--text-muted`, `--border`. **Watch out:** `--bg-card` is
**parchment** (`#F5EDD8`), not a dark surface. Use `--bg-raised`
for dark panels.

## Recipes

### Add a new entity collection

Suppose you're adding a `factions` style collection called `npcGroups`.
The minimum touch-list:

1. **[`web/js/data.js`](web/js/data.js)** — declare a default seed:
   ```js
   export const NPC_GROUPS = [];   // empty default
   ```
2. **[`web/js/store.js`](web/js/store.js)** — add to `_defaults()`,
   `_mergeDefaults()`, and the public API: `getNpcGroups()`,
   `getNpcGroup(id)`, `saveNpcGroup(g)`, `deleteNpcGroup(id)`,
   `searchNpcGroups(q)`. Wire those into the returned object.
3. **[`web/js/app.js`](web/js/app.js)** — add the route in `navigate()`
   (e.g. `case 'skupiny': Wiki.renderPage('skupiny'); break;`).
4. **[`web/js/wiki.js`](web/js/wiki.js)** — implement the list page
   and article renderers (`renderNpcGroupsList`, `renderNpcGroupArticle`).
5. **[`web/js/editmode.js`](web/js/editmode.js)** — add `saveNpcGroup`,
   `deleteNpcGroup`, `startNewNpcGroup`, and an editor renderer.
6. **[`web/js/edit_templates.js`](web/js/edit_templates.js)** —
   write the form template.
7. **[`server.js`](server.js)** — add `'npcGroups'` to `ALLOWED_TYPES`
   and `ALL_TYPES`. (Keyed-object collections also go in
   `KEYED_OBJ_TYPES`.)
8. **[`web/js/constants.js`](web/js/constants.js)** — add a route
   constant and a sidebar entry in `SIDEBAR_PAGES`.
9. **[`web/index.html`](web/index.html)** — add the sidebar link.

If the collection should be searchable globally (Ctrl+K), add it to
`Store.searchAll()` and to `web/js/search.js`'s `KIND_META` map.

### Add a new schema migration

Existing data may not match the new shape. Drop a helper in
[`web/js/store.js`](web/js/store.js) following the established pattern:

```js
/**
 * Brief description of what changes and why.
 * @returns {Array} Touched entities (the load() driver syncs each
 *                  one via the per-entity PATCH path).
 */
function _migrateXyz() {
  if (!_data) return [];
  const touched = [];
  // mutate _data, push touched records onto `touched`
  return touched;
}
```

Then call it from `load()` alongside the existing migrations and pipe
the returned array through `_sync` so changes round-trip to disk.

**Idempotency is non-negotiable.** Migrations run on every page load;
re-running on already-migrated data must be a no-op. Look at the
`LOAD-BEARING INVARIANT` block in `_migrateAttitudesToObjectShape` for
a story about what happens when two migrations bounce off each other.

## Pull request flow

1. Fork or branch from `main`.
2. Make your change. Add or update a test if you can.
3. Run `npm test` — the suite must stay green.
4. Open a PR against `main`. Describe **why** in the body; the diff
   shows what.
5. CI builds the Docker image and dispatches to the maintainer's infra
   repo on merge to `main` (see `.github/workflows/build-and-dispatch.yml`).
   You don't need anything from the dispatch step to run locally.

## Reporting bugs

Open an issue at <https://github.com/pjunak/ttrpg-codex/issues>.
Include:

- What you did (steps to reproduce).
- What you expected to happen.
- What actually happened.
- Browser + OS, server logs from `docker compose logs ttrpg-codex`
  if relevant.

For security issues, email the maintainer (see the GitHub profile)
rather than filing a public issue.
