# ADR-0008: TTRPG Companion, a native Android client

**Status:** Accepted

**Date:** 2026-11-09

**Decider:** Project maintainer

## Context

Players keep their character sheets on their phones at the table. The web app
and the Character Sheets add-on are built for desktop: Compact narrows into
stacked panels and wrapped tabs, but has no phone layout, and the site cannot
be installed as an app. The owner wants a native Android app that gives the
best possible experience with a campaign site. The character sheet has to be
optional, because a site may run without the add-on (Tiamat has none).

What is true today:

- The host's HTTP API already works for a native client. `POST /api/login`
  with a site password sets the `edit_session` cookie; `GET /api/auth` returns
  the role and the CSRF token that mutations send as `X-Codex-CSRF`. No route
  checks `Origin`, and Caddy serves the campaign sites directly, without
  single sign-on.
- `GET /api/campaign` returns the whole role-projected campaign (about 64 KB
  gzipped in the [performance fixture](../reference/PERFORMANCE.md)).
  `GET /api/events` streams changes with `Last-Event-ID` replay. Media and map
  tiles are under `/api/media`.
- Only the host's own frontend uses that API, and no document describes it as
  a contract.
- Character Sheets provides the `dnd5e.character` 4.0.0 service (`load`,
  `evaluate`, `preview`, `commit`, with commands such as `damage`, `heal`,
  `cast-spell` and `rest`) described by published JSON schemas. The worker and
  the Engine compute every rule; the browser only presents results and runs
  the autosave session.
- Service connections exist only for add-on generations
  (`/api/addons/{addonID}/generations/{generationID}/services/connect` and
  `.../call`). A client that is not an add-on would have to name Character
  Sheets by its ID, which the host forbids.

## Decision

- **A new repository, `ttrpg-companion`** (app name **TTRPG Companion**),
  beside the other TTRPG repositories: Android only, with its own `AGENTS.md`,
  CI and releases. It follows the stack and module layout of the workspace's
  other Android app, Baton (Kotlin, Compose Material 3, Hilt, coroutines and
  Flow, OkHttp with an encrypted cookie jar, a version catalog, GitHub release
  updates), with a minimum SDK low enough for the players' phones. Its tasks
  live in the host's [backlog](../BACKLOG.md) like those of every other TTRPG
  repository.
- **One app, many sites.** The user adds a site's address and signs in with
  that site's DM or player password. Each site keeps its own session on the
  device.
- **Core, always available:** campaign reading from a cached copy of the
  role-projected campaign (readable offline), search, articles, images, maps
  from the tile pyramid, and live updates from the event stream. Native
  editing of core records is out of scope.
- **Optional modules, found by contract.** The app connects to services by
  contract and version range, never by add-on ID. The character module appears
  only when a `dnd5e.character` provider in its supported range answers. It is
  built for play: hit points with a damage, healing and temporary HP keypad,
  conditions and concentration, spell slots and casting, limited uses, rests,
  attacks, abilities and skills, quick-use items and inspiration. Which
  character is "mine" on each site is a device preference. The screen stays
  awake while a sheet is open.
- **Web fallback for the rest.** The Builder, DM administration and add-on
  pages without a native screen open the site's own page in an in-app web view
  that shares the app's session cookie, so it is already signed in.
- **Sheet changes save online only.** Like the web sheet, every change goes
  through `dnd5e.character` at once, with optimistic revisions and no device
  draft. Without a connection the app shows that the change is not saved and
  retries; a conflict reloads the character as the web sheet does.
- **The host gains client service access:** `POST /api/services/connect` and
  `POST /api/services/call` for a signed-in session that is not an add-on. The
  session is the actor, provider selection follows the operator's selection as
  for add-on consumers, and schemas, deadlines and typed errors match the
  add-on service routes. Any active provider's contract can be connected;
  workers already enforce each method's actor rules.
- **The host documents its client API.** A new
  `docs/reference/CLIENT_API.md` lists the routes the app relies on and how
  they may change. The app checks `GET /api/version` against the host range it
  supports.
- **`dnd5e.character` gains an outside consumer.** Breaking changes bump its
  major version. The app generates its Kotlin types from the schemas of a
  pinned contract version and hides the module, asking for an app update, when
  a site's provider is outside its range.
- **Distribution through GitHub releases.** CI builds and signs the APK on
  `main` and publishes it as a release. Players sideload it once; the app
  checks the repository's releases for updates. The signing key lives in CI
  secrets, never in the repository. The repository is public so players can
  download releases without a GitHub account.

## Consequences

- The routes in `CLIENT_API.md` and the client service routes become a
  contract between two repositories: changing them needs the app's gate as
  well as the host's tests.
- Changes to `dnd5e.character` need the app checked against the new schemas.
- Sheet presentation exists twice, as the web Compact layout and the native
  play screens. Rules stay in the Engine, so only presentation and the
  autosave session are duplicated. Character building stays on the web.
- The TTRPG and workspace `AGENTS.md` files and this repository's planning docs
  list a seventh repository once it exists.
- No push notifications (they would need Firebase Cloud Messaging and server
  credentials) and no iOS app.

## Alternatives considered

- **Installable web app** (manifest, icons and a phone layout in the add-on):
  the least work, and every add-on UI keeps working, but the owner wants a
  native app. A phone layout for the web sheet stays possible on its own.
- **A wrapper around the whole site** (Capacitor or a Trusted Web Activity):
  native packaging with the web UI everywhere; little gain over the web app.
- **Calling the Character Sheets generation routes from the app:** names a
  provider by add-on ID and breaks with every new add-on generation.
- **Offline sheet edits:** need device drafts and conflict merging that the
  sheet deliberately does not have.
- **Google Play:** a developer account, store listing and review of every
  release, for a handful of players.
