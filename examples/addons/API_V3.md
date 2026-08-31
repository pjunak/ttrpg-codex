# Add-on API v3

> Target contract for the Go/TypeScript rewrite. This API is normative for new
> implementation work on `rewrite/go-typescript`, but is not implemented by the
> current Node.js host. `AUTHORING.md` remains the v2 runtime manual until
> cutover.

Add-on API v3 is a package, browser, worker, service, and lifecycle contract.
It is deliberately not a general-purpose plugin escape hatch. Add-ons receive
only declared host surfaces and capability-scoped handles, so the host can
explain, cancel, update, and recover their work.

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe compatibility
requirements. Machine-readable definitions live in
[`contracts/addons/v3`](../../contracts/addons/v3/README.md).

## Design principles

1. **Inspect before executing.** A package's requested authority and occupied
   surfaces are visible before any of its code runs.
2. **Stable IDs over implementation knowledge.** Host code addresses public
   contracts, contribution IDs, and collection IDs, never provider add-on IDs.
3. **Host-mediated effects.** Data, services, imports, blobs, outbound HTTP,
   and events pass through host authorization and tracing.
4. **Generation-scoped lifetime.** Every handle, request, subscription, and UI
   contribution belongs to one activation generation and expires with it.
5. **Reviewable mutation.** Imports, migrations, and generated suggestions are
   plans until a user or explicit policy commits them.
6. **Honest isolation.** A process boundary contains crashes; only a sandboxed
   profile is described as a security boundary.
7. **Schema at every durable boundary.** Manifests, service payloads,
   collections, protocol envelopes, and HTTP models are machine validated.

## Package format

An add-on release is an immutable archive. Paths use `/`, are relative to the
archive root, and MUST NOT contain `..`, drive letters, symlinks escaping the
root, or case-colliding names. Install limits apply to compressed size,
expanded size, file count, individual file size, and manifest size.

The archive contains:

```text
addon.json                    required v3 manifest
checksums.json                required hashes of packaged files
web/                          optional prebuilt browser assets
worker/                       optional native or WASI artifacts
contracts/                    service and collection JSON Schemas
content/                      immutable content sets
locales/                      localization catalogs
```

Production installation MUST NOT invoke npm, Go, Python, a shell, or any other
build tool. The release pipeline builds target artifacts before packaging.

### Manifest concepts

The strict manifest schema is
[`manifest.schema.json`](../../contracts/addons/v3/manifest.schema.json), with a
complete [reference package](../../contracts/addons/v3/examples/reference-addon.json).

The top-level declarations have distinct meanings:

| Declaration | Meaning |
|---|---|
| `compatibility` | Versions of the host, Add-on API, and worker protocol this package understands |
| `capabilities` | Host features that must or may exist; capabilities do not grant authority |
| `permissions` | Reviewed authority over resources or effects |
| `runtime` | Prebuilt TypeScript UI and optional worker artifacts |
| `contributions` | Stable UI or HTTP surfaces the package may occupy |
| `collections` | Add-on-owned durable document collections and their schemas |
| `recordExtensions` | Add-on-owned state attached to records in a core collection |
| `services` | Versioned contracts provided or consumed |
| `content` | Immutable host-indexed datasets |
| `dependencies` | Identity-specific collaboration that cannot be expressed as a service |

Unknown required capabilities prevent activation. Unknown optional
capabilities are reported and ignored. A permission is never inferred from a
capability, contribution, or dependency.

### Stable namespaces

The following IDs become durable once released:

- add-on ID;
- contribution ID within the add-on;
- collection ID within the add-on;
- content-set ID within the add-on;
- service contract ID and major version.

Renaming display text is harmless. Reusing a durable ID for different semantics
is a breaking change. Add-on storage is namespaced by stable ID, never by an
installation path or display name.

## Trust and runtime profiles

### Integrated TypeScript UI

Reviewed UI code is loaded as ESM into the application realm. It can render
custom elements and use the scoped SDK. This is a lifecycle boundary, not a
security sandbox. Integrated packages MUST be treated as trusted browser code.

### Sandboxed iframe UI

Less-trusted visual code runs in a sandboxed iframe with a separate document.
The host supplies the same logical SDK over a versioned `postMessage` channel.
The manifest selects explicit sandbox features; same-origin access is not
granted by default.

### WASI worker

A WASI worker is preferred for portable deterministic computation, parsers,
and providers that need only host capabilities. The host runtime exposes no
ambient directory or network access. CPU, memory, calls, and wall time are
bounded. The package MUST still be trusted according to the guarantees of the
chosen WASI runtime and imported capabilities.

### Native Go worker

A native worker is a normal target-specific executable supervised by the host.
It provides crash isolation, deadlines, resource monitoring, and a narrow API.
It is not a security sandbox by itself. Packages requiring untrusted native
execution need an additional operating-system sandbox that is outside the v3
minimum contract.

Go `plugin` modules are not an add-on profile.

## Installation and lifecycle

The host uses immutable generations. Exactly one generation of an add-on is
active for new work.

```text
discovered
    |
    v
inspected -> awaiting approval -> staged -> resolved -> migrating
                                                   |          |
                                                   |          v
                                                   |       starting
                                                   |          |
                                                   |          v
                                                   +------> healthy
                                                              |
                                                              v
                                                            active
                                                              |
                                            disabling/updating/uninstalling
                                                              |
                                                              v
                                                            stopped
```

The important transition rules are:

1. **Inspect.** Validate archive safety, hashes, signature/provenance when
   configured, manifest schema, compatibility, and target artifacts without
   execution.
2. **Approve.** Show new or expanded permissions, contributions, dependencies,
   exclusive services, migrations, and network domains. Preserve unchanged
   grants; never silently grant new authority during bulk update.
3. **Stage.** Extract to an immutable generation directory not reachable by the
   active loader.
4. **Resolve.** Check required capabilities, dependencies, service versions,
   exclusive providers, and operator bindings.
5. **Migrate.** Produce and record a migration plan against an exact snapshot.
   Apply it through a host transaction. Keep the previous data/package
   generation recoverable.
6. **Start.** Initialize the worker, load browser code, and bind only declared
   contributions.
7. **Health.** Require protocol readiness and declared self-checks within
   bounded time.
8. **Switch.** Atomically route new work to the healthy generation. Cancel and
   dispose the old generation in dependency-safe order.

If migration, start, or health fails, the staged generation is quarantined and
the previous generation stays active. If failure occurs after the switch, the
host records whether rollback is automatic or requires review; it never mixes
files or handles from two generations.

Disable and uninstall revoke new calls first, abort outstanding SDK scopes,
wait for bounded cooperative shutdown, force-stop the worker if necessary,
release service bindings, and invalidate handles. Uninstalling code and
deleting user data are separate reviewed operations.

## Browser SDK

An integrated entry module exports one activation function:

```ts
export async function activate(context: AddonContext): Promise<void | Disposable> {
  // Define custom elements, bind declared contributions, and acquire handles.
}
```

The host supplies a fresh context for every generation:

```ts
interface AddonContext {
  readonly addon: {
    readonly id: string;
    readonly version: string;
    readonly generation: string;
  };
  readonly signal: AbortSignal;
  readonly ui: UiApi;
  readonly data: DataApi;
  readonly services: ServiceApi;
  readonly imports: ImportApi;
  readonly graphs: GraphApi;
  readonly events: EventApi;
  readonly settings: SettingsApi;
  readonly navigation: NavigationApi;
  readonly log: Logger;
}

interface Disposable {
  dispose(): void | Promise<void>;
}
```

The actual SDK is generated and versioned; these excerpts define its shape,
not a hand-copied source file.

### Contribution binding

The manifest declares a contribution before activation. Runtime code binds a
custom element or handler to that declared ID:

```ts
context.ui.bind("planner.route", {
  element: "dm-tools-planner-page",
});
```

The host rejects undeclared IDs or surfaces. Contributions receive documented
properties and emit documented `CustomEvent` payloads. They MUST NOT depend on
private host selectors, global variables, string action names, or raw HTML
injection.

Initial surfaces cover existing suite needs:

| Surface | Purpose |
|---|---|
| `route` | Application page under an add-on route namespace |
| `sidebar` | DM or player navigation item |
| `settings` | Add-on settings page or section |
| `article-action` | Contextual action for a visible record |
| `article-section` | Additive schema-backed section on a record page |
| `editor-panel` | Structured editor extension |
| `slot` | Named host composition point |
| `record-renderer` | Renderer selected through a versioned renderer contract |
| `wiki-kind` | Schema-backed wiki/content kind |
| `kind` | Pure-data enum kind in a declared domain |
| `graph-node-kind` | Visual and accessible definition for a graph node type |
| `graph-view` | Named graph view with a bounded model provider |
| `graph-contributor` | Additive nodes and edges for an existing graph view |
| `http-endpoint` | Namespaced HTTP operation forwarded to a worker |

An override is modeled as a replaceable renderer/service contribution with an
explicit selection policy, not unrestricted DOM replacement.

Graph contributions exchange a versioned graph model containing serializable
nodes, edges, labels, positions, and accessible summaries. `context.graphs`
mounts that model through a host component and returns a disposable handle for
selection, movement, update, and destroy operations. It does not expose the
underlying graph library or its objects. Pure enum kinds are manifest data;
runtime graph providers are bounded and generation scoped.

### Data handles

Data APIs are collection and revision aware:

```ts
const notes = context.data.collection<Note>("dm_notes");
const current = await notes.get(noteId, { signal: context.signal });

await notes.transact({
  expectedRevision: current.revision,
  operations: [{ op: "replace", key: noteId, value: nextNote }],
  idempotencyKey,
});
```

Core collections are addressed by public contract IDs and separately granted
permissions. Add-on-owned collection names are automatically scoped to the
caller. Queries are structured, bounded, and schema checked; the SDK does not
accept raw SQL or host filesystem paths.

Per-record add-on state uses a separately declared extension handle rather than
being merged into the core record body:

```ts
const sheetState = context.data.recordExtension<SheetState>(
  "characters",
  "sheet_state",
);

await sheetState.patch(characterId, expectedRevision, nextState, {
  idempotencyKey,
});
```

The host stores this value under `(target collection, record ID, add-on ID,
extension ID)`. The add-on can write only its own extension. Reading other core
fields or another add-on's extension remains separately permissioned. This
preserves the useful v2 `addonData` ownership rule without letting add-on JSON
change the core entity schema.

Subscriptions deliver revisioned change events and accept an `AbortSignal`.
Consumers recover a gap by querying from a cursor or refreshing the affected
collection. Events are invalidation evidence, not an alternative source of
truth.

### Services

Services exchange serializable schema-validated requests and responses:

```ts
const engine = await context.services.connect("dnd5e.rules-engine", {
  range: "^3.0.0",
  cardinality: "one",
  signal: context.signal,
});

const result = await engine.call("evaluate-character", request, {
  deadlineMs: 2_000,
  signal: context.signal,
});
```

No provider object or function reference crosses the broker. A handle records
the selected provider, contract version, binding revision, and generation.
When any of those becomes stale, calls fail explicitly with `STALE_BINDING`;
the host does not silently select a different single provider.

Installed provider declarations and operator bindings survive a host restart;
live generations and callable transports do not. A provider is unavailable
until the matching package generation completes activation again. This avoids
advertising a dead pre-restart worker from durable state.

Each `services.provides[].schema` path points to a service document rather than
directly to one payload schema:

```json
{
  "$schema": "https://junak.eu/ttrpg-codex/contracts/addons/v3/service-document.schema.json",
  "contract": "dnd5e.rules-engine",
  "version": "3.0.0",
  "allowsExclusive": false,
  "methods": {
    "evaluate-character": {
      "requestSchema": "contracts/evaluate-character.request.schema.json",
      "responseSchema": "contracts/evaluate-character.response.schema.json",
      "maxDeadlineMs": 2000,
      "idempotency": "optional",
      "errors": ["INVALID_INPUT", "UNAVAILABLE"]
    }
  }
}
```

The manifest and document contract/version must match exactly. The host
compiles method schemas from verified package resources before activation and
binds that immutable registry to the exact live generation; a consumer cannot
supply replacement validators. `maxDeadlineMs` is a hard method limit, so a
shorter caller or parent-context deadline wins. `none` rejects an idempotency
key, `optional` accepts one, and `required` rejects calls without one. Error
kinds are declared contract outcomes; transport and protocol errors remain
separate.

### Settings, navigation, events, and logs

- Settings have JSON Schemas, typed values, scopes, defaults, and revisioned
  writes. Secrets are referenced by opaque credential IDs and never returned
  to browser add-ons.
- Navigation accepts public route IDs and structured parameters, not URLs into
  private host pages.
- Events use versioned names and schemas. Durable state changes are read from
  data APIs; events coordinate refresh and bounded jobs.
- Logs are structured and inherit add-on, version, generation, request, and
  correlation context. Secret-shaped fields and declared sensitive paths are
  redacted by the host.

## Worker protocol

### Transport and framing

Workers use bidirectional JSON-RPC 2.0. Native workers read stdin and write
stdout. WASI workers use equivalent virtual streams. Each UTF-8 JSON message is
framed as:

```text
Content-Length: <decimal byte length>\r\n
\r\n
<JSON bytes>
```

Headers and bodies have independent limits. Duplicate or malformed length
headers, invalid UTF-8, oversized messages, invalid JSON-RPC envelopes, and
output before initialization terminate the generation with a precise protocol
failure. Stdout contains only framed protocol messages. Human or structured
diagnostic output goes to stderr.

Protocol v1 accepts exactly one case-insensitive `Content-Length` header with a
positive decimal byte count. It requires CRLF line endings and rejects every
other header; extending the header block is therefore a negotiated protocol
change rather than something an old host silently ignores.

Framing and envelope failures use stable diagnostic codes:

| Code | Meaning |
|---|---|
| `HEADER_TOO_LARGE` | Header bytes exceeded the negotiated limit |
| `MALFORMED_HEADER` | Header syntax or CRLF framing is invalid |
| `UNSUPPORTED_HEADER` | A v1 frame included a header other than `Content-Length` |
| `MISSING_CONTENT_LENGTH` | No length header was provided |
| `DUPLICATE_CONTENT_LENGTH` | More than one length header was provided |
| `INVALID_CONTENT_LENGTH` | The length is empty, zero, or not decimal |
| `FRAME_TOO_LARGE` | The declared or encoded body exceeds the negotiated limit |
| `TRUNCATED_FRAME` | The stream ended before the declared body length |
| `INVALID_UTF8` | The body is not UTF-8 |
| `INVALID_JSON` | The body is not exactly one JSON value |
| `INVALID_ENVELOPE` | JSON does not match the negotiated JSON-RPC envelope |

The envelope schema is
[`protocol.schema.json`](../../contracts/addons/v3/protocol.schema.json).

### Initialization

The first request is `codex/initialize`:

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "method": "codex/initialize",
  "params": {
    "protocolVersion": "1.0.0",
    "addon": {
      "id": "dm-tools",
      "version": "1.0.0",
      "generation": "01J..."
    },
    "host": {
      "version": "2.0.0",
      "locale": "en",
      "timeZone": "Europe/Prague"
    },
    "grants": [],
    "services": [],
    "limits": {
      "maxFrameBytes": 4194304,
      "maxConcurrentRequests": 16,
      "defaultDeadlineMs": 5000
    }
  }
}
```

The worker returns its negotiated protocol version, implemented optional
capabilities, declared method versions, and health-check support:

```json
{
  "protocolVersion": "1.0.0",
  "capabilities": ["worker.health"],
  "methods": {
    "codex/health": "1.0.0"
  },
  "healthCheck": true
}
```

Capabilities must be unique, method names and versions must be non-empty, and
`codex/health` must have an explicit method version.

The host then sends `codex/start`, which returns `{ "ready": true }`, followed
by an initial `codex/health`, which must return `{ "status": "ok" }`. Later
health checks may report `ok` or `degraded` with optional structured `details`.
No domain request is sent until the initial health check succeeds. Graceful
termination uses `codex/shutdown`, after which the worker must exit without new
host calls.

The native supervisor launches the exact executable selected from the
verified package; it does not invoke a shell or search `PATH`. Workers receive
only host-supplied environment entries and do not inherit the host process
environment. The current supervisor serializes lifecycle and health calls.
The service broker adds concurrent domain calls, cancellation, and
worker-to-host routing before those methods become available.

### Message metadata

Every domain request includes:

```ts
interface RpcMeta {
  requestId: string;
  correlationId: string;
  generation: string;
  deadline: string;          // RFC 3339 timestamp
  actor?: { role: "dm" | "player" | "system"; id?: string };
  idempotencyKey?: string;
  traceparent?: string;
}
```

Actor metadata originates from the host and is not a reusable credential. A
worker-to-host call only echoes claimed lineage; the host resolves that lineage
to its own authoritative actor, deadline, and correlation context before
authorization. Writing `actor.role = "dm"` never grants DM authority.

Workers MUST check cancellation and deadlines during long operations. Either
peer sends the standard `$/cancelRequest` notification with the JSON-RPC
message ID in `params.id`; this is distinct from `meta.requestId`. A late
response is discarded and recorded; it cannot resurrect a cancelled
transaction.

### Required protocol methods

| Direction | Method | Purpose |
|---|---|---|
| Host -> worker | `codex/initialize` | Negotiate protocol, grants, limits, and generation |
| Host -> worker | `codex/start` | Finish startup after initialization |
| Host -> worker | `codex/health` | Bounded liveness/readiness detail |
| Host -> worker | `codex/shutdown` | Graceful generation teardown |
| Either | `$/cancelRequest` | Cooperative cancellation by request ID |
| Host -> worker | `addon/service.call` | Invoke a provided service method |
| Host -> worker | `addon/http.handle` | Handle a declared namespaced endpoint |
| Host -> worker | `addon/import.preview` | Build an immutable reviewed import plan |
| Host -> worker | `addon/import.contribute` | Contribute to a campaign bundle plan |
| Host -> worker | `addon/migration.plan` | Describe collection migration effects |
| Host -> worker | `addon/migration.apply` | Compute writes for the exact accepted plan |
| Worker -> host | `host/data.get` | Read a permitted record at a revision |
| Worker -> host | `host/data.query` | Run a bounded structured query |
| Worker -> host | `host/data.transact` | Submit schema-checked atomic operations |
| Worker -> host | `host/blob.create` | Create a bounded opaque blob sink |
| Worker -> host | `host/blob.read` | Read a permitted blob range |
| Worker -> host | `host/service.call` | Call a bound service through the broker |
| Worker -> host | `host/event.publish` | Publish a declared schema-checked event |
| Worker -> host | `host/http.fetch` | Perform reviewed allowlisted outbound HTTP |
| Worker -> host | `host/progress.report` | Report bounded job progress |

Methods are independently versioned in the negotiated capability set. New
optional methods may be added without changing the framing protocol.

### Errors

JSON-RPC `error.code` is stable for protocol-level handling. `error.data`
contains a stable application shape:

```json
{
  "kind": "VALIDATION_FAILED",
  "message": "The import plan did not match its schema.",
  "retryable": false,
  "details": { "issues": [] }
}
```

Initial application error kinds are:

- `INVALID_REQUEST`
- `UNAUTHORIZED`
- `NOT_FOUND`
- `CONFLICT`
- `STALE_BINDING`
- `VALIDATION_FAILED`
- `RATE_LIMITED`
- `UNAVAILABLE`
- `DEADLINE_EXCEEDED`
- `CANCELLED`
- `INTERNAL`

Messages are diagnostic text and may improve. Logic depends on `kind`, not
message text. Unknown error kinds are treated as `INTERNAL` and preserved in
diagnostics.

### Backpressure and resilience

The initialize response establishes frame, concurrency, and deadline limits.
Protocol v1 has no waiting queue: peers reject excess work with `RATE_LIMITED`
rather than growing an unbounded queue. A worker restart does not replay
non-idempotent requests.
Idempotent calls may be retried only within the original deadline and with the
same idempotency key.

Repeated crashes move a generation to `failed` after bounded exponential
backoff. A failed optional provider becomes unavailable; a required provider
blocks dependent activation with an inspectable dependency chain.

## Permissions

Permissions use an ID, bounded resources, a human reason, and whether they are
optional. Broad wildcards are rejected unless the permission definition
explicitly supports them.

Initial permission families are:

| Family | Examples |
|---|---|
| `core.data.read` / `core.data.write` | `characters`, `locations`, selected fields |
| `addon.data` | own declared collections; enabled by collection declaration |
| `core.extension` | own declared record-extension values on selected targets |
| `blob.read` / `blob.write` | import sources, exports, attachments |
| `network.fetch` | exact HTTPS origins and method classes |
| `event.publish` / `event.subscribe` | declared versioned event names |
| `import.provide` | preview and bundle contribution formats |
| `http.expose` | declared endpoint IDs and request limits |
| `secret.use` | named credential scope without secret disclosure |

UI surfaces and services are still independently declared. For example,
permission to read characters does not grant a route, and a declared service
does not grant outbound network access.

## Services and provider binding

A service contract owns:

- a stable namespaced ID;
- a semantic version;
- method names and request/response schema URIs;
- behavioral invariants, errors, deadlines, and idempotency rules;
- whether providers may be exclusive.

Consumers request `one` or `many` compatible providers. A required consumer
must resolve before activation. Optional consumers retain useful standalone
behavior when no provider exists or fails. Operator selection is persisted by
consumer, contract, scope, and binding revision. Removing a selected provider
creates a visible stale binding; it does not silently change campaign behavior.

Without an explicit binding, exactly one live compatible `one` provider may be
used automatically with binding revision `0`. Several compatible providers are
ambiguous and remain unresolved. Adding another compatible provider makes an
existing automatic handle stale; it does not preserve the earlier choice by
install order. `many` consumers either receive every compatible provider in
stable add-on-ID order or an operator-selected target set, according to their
declared selection policy.

Exclusive-provider conflicts are detected during package resolution, before
execution. The host shows the installed providers and the exact contract major
version in conflict.

## Collections, transactions, and migrations

An add-on collection declares its JSON Schema, schema version, key mode,
visibility, and optional bounded indexes. A record extension additionally
declares its core target. The host stores every document with its add-on,
collection or extension identity, key, revision, schema version,
created/updated audit metadata, and JSON value.

Transactions can combine permitted core and add-on operations only through a
host-owned application command. The host validates all preconditions and
schemas before commit. Transactions return one commit revision and an ordered
effect summary.

Migration is a two-phase contract:

1. `addon/migration.plan` reads an exact snapshot and returns counts, warnings,
   schema transitions, destructive effects, and a digest.
2. After approval, `addon/migration.apply` receives that plan ID and snapshot
   digest and returns bounded deterministic operations. The host applies them
   transactionally or rejects the plan as stale.

The host stores a recovery snapshot until the package update is accepted. A
worker never executes DDL or edits package/storage files.

## Imports and campaign bundles

An import provider declares accepted formats and probe metadata. Probing is
bounded and read-only. It returns confidence evidence, not an authoritative
commit decision. The Import Center shows compatible providers and lets the DM
choose when routing is ambiguous.

Preview returns a serializable plan containing source digest, creates,
updates, deletes, conflicts, provenance, warnings, required grants, and provider
version. The host validates and stores the exact plan. Commit applies only that
stored plan in a transaction. Provider code is not re-run to reconstruct a
partial commit during recovery.

Campaign bundle contributors use the same plan model and transaction boundary.
The host supplies generic primitives; DM Tools owns the visible coordination
experience; content and domain add-ons own their preview semantics.

## Content and localization

Content sets are immutable package assets with schemas, stable record IDs,
provenance, source-group metadata, and a package revision. The host indexes
them and exposes a revision-pinned query API. Add-ons never mutate installed
content in place; overlays and user choices live in host or add-on data.

Locale catalogs are declarative package assets. Message IDs are add-on scoped.
The host validates catalogs without executing UI code and reports fallback
behavior in the Inspector.

## Debugging contract

Every add-on must be explainable from the host without attaching a debugger.
The Add-on Inspector shows:

- package identity, origin, hashes, compatibility, and active generation;
- requested versus granted permissions and the last approval diff;
- contributions, dependencies, service providers, consumers, and bindings;
- lifecycle state with timestamps and failure causes;
- worker process/runtime state, negotiated limits, health, restarts, and exit;
- bounded redacted RPC summaries with deadlines and correlation IDs;
- active browser scopes, subscriptions, jobs, and stale handles;
- collection schema and migration history;
- import preview/commit/recovery records;
- content and locale revisions.

Support bundles include schemas and metadata but redact secrets, credentials,
private record bodies, raw imported files, and sensitive log fields by default.

## V2 feature mapping

V3 retains the useful feature rather than the v2 implementation mechanism:

| V2 mechanism | V3 replacement |
|---|---|
| `entry.js` receives a broad facade | Strict TypeScript SDK with generation-scoped handles |
| `server/index.cjs` runs in the host | Native Go or WASI worker over framed RPC |
| Live service objects/functions | Schema-validated broker calls |
| Opaque permission strings | Structured permissions with resource bounds and reasons |
| Route/sidebar/action/slot registrations | Predeclared contribution IDs bound to custom elements |
| Enum kinds, graph node kinds, views, and contributors | Declarative definitions plus bounded graph-model providers |
| Direct graph-library facade | Versioned `GraphApi` returning disposable host handles |
| UI override hooks | Explicit replaceable renderer/service contract and operator policy |
| JSON add-on collections and per-record `addonData` | Schema-versioned collections and record extensions in host SQLite transactions |
| Direct server endpoints | Namespaced declared endpoint forwarded to worker |
| Import provider callbacks | Stored preview plan and transactional commit protocol |
| Lifecycle callback arrays | One supervised generation scope with abort and bounded shutdown |
| Add-on test file list | Package conformance declaration plus external test harness |

## First-party target profiles

These are starting hypotheses that the implementation must validate:

| Add-on | Browser | Worker | Main contracts exercised |
|---|---|---|---|
| D&D 2024 Compendium | Integrated TypeScript | None initially | content sets, locales, exclusive `dnd5e.rules-data` provider |
| D&D Rules Engine | None or diagnostics only | Go compiled to WASI | pure `dnd5e.rules-engine`, optional rules-data consumer |
| D&D Character Sheets | Integrated TypeScript | None initially | optional engine and many-renderer consumers, character add-on data |
| DM Tools | Integrated TypeScript | Native Go where backend work is needed | DM collections, transactions, imports, bundle coordination, routes and slots |

All four remain optional. Character sheets remain hand-fillable without an
engine. The engine remains useful with no hardcoded compendium identity. The
host remains useful without any D&D-specific package.

## Conformance requirements

Before an API v3 release is considered usable, the public harness must verify:

- archive traversal, collision, size, checksum, and manifest failures;
- permission diff and approval persistence;
- missing, incompatible, exclusive, optional, and stale service bindings;
- activation ordering, cancellation, dispose-once, timeout, crash, restart, and
  rollback behavior;
- malformed framing, oversized payloads, invalid schemas, and late responses;
- transaction conflict, migration stale-plan, import stale-plan, and recovery;
- UI contribution cleanup, isolated bridge teardown, and reload without stale
  handlers;
- first-party add-ons against only public SDK and protocol artifacts.

The conformance harness is part of the platform contract. A feature is not
complete merely because a first-party add-on can call an internal host method.
