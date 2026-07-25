# Contributing

Thanks for taking a look. This guide covers local development, the
project's conventions, and the typical recipes you'll need.

## Prerequisites

- **Node.js 24+** ([install](https://nodejs.org/en/download)) — 26 recommended
  (the Docker image runs `node:26-slim`) — for running the server and the test
  suite without Docker.
- **Docker + Docker Compose** ([install](https://docs.docker.com/engine/install/),
  [compose docs](https://docs.docker.com/compose/)) for the deployment
  flow and to mirror what production runs.
- A text editor. There's no language server config to install — the
  codebase is plain ES modules, no TypeScript, no build step.

## Local dev setup

```bash
git clone https://github.com/pjunak/ttrpg-codex.git
cd ttrpg-codex
npm ci
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
npm run check
```

This runs the zero-warning ESLint gate and the complete Node test suite.
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
- `*.test.cjs` — server-side CommonJS modules and integration suites.

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

### Module boundaries

Use named ES-module exports. A stateful facade may use an IIFE to keep its
mutable state private:

```js
export const Store = (() => {
  // private state + helpers
  return { /* public API */ };
})();
```

Pure modules should export functions directly; do not add an IIFE when there is
no state to encapsulate. Keep each module focused on one owner or contract.
Imports come from sibling modules; shared helpers live in
[`web/js/utils.js`](web/js/utils.js) — do not redefine `esc`, `norm`,
`slugify`, `debounce`, or similar helpers privately.

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
- Add JSDoc where a public contract, non-obvious shape, or invariant benefits
  from it. Do not add boilerplate documentation to self-explanatory helpers.
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

Design tokens live in `:root` inside [`web/css/main.css`](web/css/main.css) —
e.g. `--accent-gold`, `--bg-deep`/`--bg-base` (dark surfaces),
`--bg-card`, `--bg-raised`, `--text-muted`, `--border-subtle`. The full
token + component-class reference is [`web/css/STYLE.md`](web/css/STYLE.md);
all UI work must build from tokens (that's what makes the theme switcher
work). **Watch out:** `--bg-card` is **parchment** (`#F5EDD8`), not a
dark surface. Use `--bg-raised` for dark panels.

## Extending the data model

Prefer an addon-owned collection when a feature is optional or
campaign-specific. Add a built-in collection only when it is part of the host's
general campaign model and must participate in core search, visibility,
editing, and cross-record invariants.

For a built-in collection, update every applicable contract:

1. Server collection allowlists, keyed/list shape, validation, optimistic
   revision handling, role projection, snapshot/restore behavior, and compound
   mutation rules.
2. Browser defaults and Store accessors in `data.js` / `store.js`.
3. Canonical identity and article routing in
   `collection-descriptors.js`; route/sidebar/search registries stay
   consumer-specific.
4. Wiki rendering, edit templates/controllers, and localized strings in both
   core catalogs.
5. Reference docs and focused unit/integration coverage, including player
   visibility and recovery behavior.

Do not copy an existing editor eight times without first checking whether the
shared identity, transport, or rendering seam should be extended.

### Add a new schema migration

Persistent migrations are server-owned. Add a pure, idempotent transform under
[`server/`](server/) and register it in
[`server/migrations.cjs`](server/migrations.cjs):

```js
function migrateExample(data) {
  // Return whether the isolated campaign tree changed.
  return false;
}
```

Startup and uploaded-restore candidates run the same ordered registry before
publication. The transform must preserve unrelated fields, be idempotent, and
be tested both as a pure transform and through startup/restore integration.
The browser may normalize sparse data for display, but it must never persist a
schema migration from `Store.load()`.

## Pull request flow

1. Fork or branch from `main`.
2. Make your change. Add or update a test if you can.
3. Run `npm run check` — lint and the full suite must stay green.
4. Open a PR against `main`. Describe **why** in the body; the diff
   shows what.
5. On merge to `main`, CI runs the full test suite first; only a green
   suite builds the Docker image and dispatches to the maintainer's
   infra repo (see `.github/workflows/build-and-dispatch.yml`).
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
