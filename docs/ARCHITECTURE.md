# Architecture

TTRPG Codex v2 is one Go process serving a compiled TypeScript application and
a versioned add-on platform. Accepted design decisions live under
[`decisions/`](decisions/); detailed subsystem contracts live under
[`rewrite/`](rewrite/).

## System shape

```text
browser
  |  HTTP + SSE
  v
Go host
  |-- authentication and role projection
  |-- campaign application commands
  |-- add-on package/data/service brokers
  |-- supervised native workers over framed RPC
  |-- SQLite metadata and records
  `-- immutable blobs and add-on generations
```

The campaign runtime is rules-neutral: D&D calculations and character UI live
in add-ons. Offline conversion and sheet retirement are narrowly scoped
maintenance tools. The optional first-party service graph is:

```text
D&D 2024 Compendium --rules-data v3--> D&D Engine
                                              |
                                  rules-engine v4
                                              v
                                    Character Sheets
                                 character v2 / schema 4

DM Tools is independent and owns planning/world-building workflows.
```

## Host composition

`cmd/codex` acquires an exclusive data-directory lock, recovers an interrupted
restore, opens SQLite, verifies migrations, composes services, recovers active
add-on generations in dependency order, then starts HTTP. Shutdown first stops
new requests and then tears workers down in reverse dependency order.

The first start requires `CODEX_DM_PASSWORD`; an optional
`CODEX_PLAYER_PASSWORD` enables player edits. Versioned password hashes then
persist in SQLite and can be changed in Settings → Server access. Later starts
use saved credentials rather than the bootstrap environment. Sessions are random, process-local,
HttpOnly cookies. State-changing requests additionally require a session-bound
`X-Codex-CSRF` token. Restarting invalidates sessions, not campaign data.

## Campaign data

Core collections retain their established list or keyed shapes. SQLite stores
each opaque JSON record with a stable key, order, visibility, revision, and
audit metadata. Application commands plan ordinary mutations, twin operations,
and enum cascades before one transaction commits the complete effect.

Reads return either the authoritative DM dataset or a reference-closed player
projection. Unknown JSON fields survive edits. Optimistic revisions reject
stale writes instead of silently overwriting another browser.

Media bytes are validated and published as immutable content-addressed blobs.
SQLite owns their logical target, visibility, and deletion state; filenames and
filesystem paths are never public identity.

## Live updates

Every committed logical change appends a role-scoped event in the same durable
transaction. `/api/events` provides monotonic Server-Sent Event replay, reset
recovery, heartbeats, bounded queues, and slow-client eviction. The browser
keeps one event connection and refreshes authoritative state after validated
invalidation events.

## Add-on API v3

An add-on is a reviewed ZIP containing `addon.json`, `checksums.json`, declared
schemas, assets, and optional target-specific worker binaries. Production never
builds package source.

The lifecycle is intentionally explicit:

```text
upload -> inspect/stage -> review -> approve exact grants -> activate
                                                  |
                                             reject safely
```

Generations are named by archive SHA-256. Activation resolves dependencies and
services, starts and health-checks the candidate, then switches routing without
mixing generations. Previous generations remain available for reviewed
rollback. Disable stops routing but preserves files, grants, and user data.

Add-on data uses package-declared JSON Schemas. Collections and record
extensions live in host SQLite with revisions, visibility, ownership, and core-
record lifetime binding. Service calls use versioned schema documents and
generation-bound handles; consumers never branch on a provider's add-on ID.

Native Go workers communicate through bounded Content-Length-framed JSON-RPC.
They inherit no host environment, receive host-authoritative actor/deadline
metadata, and can call only granted host methods. A native process boundary
improves failure isolation but is not an OS security sandbox.

Browser add-ons receive a strict TypeScript SDK and generation scope. Integrated
components register only declared surfaces. Isolated contributions run in
opaque, CSP-restricted iframes over transferred message ports. Abort-first,
LIFO, once-only cleanup prevents stale handlers and services after reloads.

## Imports

DM Tools supplies the visible format-routed Import Center and a planning adapter
through `codex.import-adapter` v2. Its worker retains the reviewed plan and
commits guarded add-on mutations through host transactions. A host-owned
campaign-bundle provider for combined core and add-on imports is not currently
implemented; its remaining work is T19 in [the backlog](BACKLOG.md).

## Frontend

The Lit shell validates every API response before accepting it. It owns auth,
campaign refresh, core navigation, generic record editing, media clients, and
browser add-on composition. Add-ons own specialized campaign experiences. The
production Go server serves only `index.html` and fingerprinted `/assets/`
output from Vite; Node.js is absent from the runtime image.

[Markdown recovery and collection browsing](rewrite/EDITOR_BROWSING.md) share
host editor descriptors, current role projections, and existing record saves.
IndexedDB holds local text recovery snapshots; small per-role collection-view
preferences live in localStorage and the route. Neither is campaign authority.

## Backups and conversion

`codex-backup.v2` contains an online SQLite backup plus every referenced blob
and immutable add-on generation, all inventoried by hash. Verification uses an
isolated database copy. Restore requires the host to be stopped and uses a
journaled directory swap that startup can recover.

`codex-convert-v1` is separate. It reads one downloaded v1 UI ZIP, validates the
target DM Tools package, builds a fresh data directory, migrates known
records/media/planning state, verifies the result, and publishes it once. It
counts and omits retired sheet values while preserving core character profiles
and the input archive. The replacement sheet automatically saves schema-4 current state.
It never merges or mutates its input.

## Failure model

- Invalid packages never become active.
- Direct single-package failures preserve the previous runtime. Reviewed cold
  cohort switches can report failed recovery after committing the selected
  generation; they do not promise uninterrupted old workers or automatic fallback.
- Malformed client or add-on payloads fail at their schema boundary.
- Stale revisions fail with conflicts.
- Missing optional providers degrade explicitly.
- Interrupted restores are recovered before the database opens.
- Logs keep correlation and generation identity while public errors omit
  internal paths and secrets.
