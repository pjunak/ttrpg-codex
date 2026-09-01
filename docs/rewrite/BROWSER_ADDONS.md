# Browser add-on generations

The TypeScript browser owns presentation resources for one
server-authoritative add-on graph. It does not decide which package generation
or dependency version should run. The Go host will publish an opaque graph
revision and an already-authorized descriptor for each browser contribution.

## Graph contract

The graph envelope declares browser graph contract version `2`. Each
descriptor contains:

- a stable add-on ID;
- the add-on version;
- an immutable package generation ID;
- the integrated or isolated UI mode;
- a same-origin module entry URL;
- same-origin style URLs and isolated-frame sandbox grants;
- required browser add-on dependencies;
- negotiated host capabilities;
- only approved permission IDs with their bounded resource grants;
- only UI contribution declarations whose required capabilities are active.

The graph revision is opaque. The server must change it whenever browser
contributions or their host SDK/service handles must be rebuilt, including a
cold backend cohort, reload, disable, or package update. The browser does not
infer authority from timestamps, URLs, or its previous state.

The coordinator validates the complete graph before touching live UI. It
rejects duplicate or malformed IDs, missing dependencies, self-dependencies,
cycles, unsafe entry URLs, oversized values, and more than 100 active browser
generations.

The contract version is independent of the opaque graph revision and Add-on
API version. An unsupported contract version fails before browser lifecycle
state changes.

## Host projection

`packagemanager.BrowserGraph` builds the deterministic projection from durable
active state and recovered package reports. Only the exact selected generation
of a recovered add-on may contribute UI. Entry and stylesheet paths are
converted to generation-addressed, same-origin asset URLs; clients never
construct filesystem paths.

The projection is also the browser's authority description. Required and
available optional capabilities are normalized, permission reasons and
unapproved requests are omitted, and unavailable capability-gated
contributions are filtered out. Pure manifest kinds and worker HTTP endpoints
never enter the browser graph. Contribution roles, order, requirements, and
opaque configuration are copied into detached deterministic values; the
browser still validates every field before activation.

Browser files are confined to the package `web/` subtree by the v3 manifest
schema. The asset reader additionally requires an exact recovered generation,
an inspected inventory entry, and the original SHA-256 bytes before returning
an open handle. Manifests, worker executables, contracts, content, and locale
files cannot be requested through the browser asset route.

The opaque revision is a SHA-256 digest over every durable active add-on ID,
generation, and state revision plus the projected UI descriptors. Including
worker-only state is intentional: a provider reload or cold backend cohort can
force all browser SDK handles to rebuild even when UI assets did not change.
Stopping a runtime removes its descriptor and changes the digest; recovery of
the same exact durable graph restores the deterministic projection.

## HTTP delivery

The transport registers browser add-on routes only when both a
`BrowserAddonSource` and `BrowserAuthorizer` are supplied. Partial
configuration fails at startup, and authorization runs before query, ID, or
asset-path validation. The implemented session authorizer accepts either
authenticated effective role, and the rewrite executable composes it with the
recovered package manager.

| Method and path | Cache contract |
|---|---|
| `GET /api/addons/browser-graph` | `private, no-cache` with the graph revision as a strong ETag |
| `GET /api/addons/{addonId}/generations/{generationId}/assets/{webPath}` | `private, max-age=31536000, immutable` with the inspected file digest as a strong ETag |

Both responses vary on cookie and authorization credentials and use
`nosniff`. Assets also require same-origin resource use and deterministic MIME
types. Conditional GET and HEAD are supported. A corrupt expected asset is a
generic 503 rather than a cached or partially trusted response; inactive,
stale, non-web, and unlisted paths share one 404 classification.

Graph change notification uses the implemented shared role-scoped event stream
and its durable replay contract. Successful package activation, rollback,
reviewed cohort activation, reload, disable, and startup recovery publish the
exact resulting graph revision. `SharedEventStream` validates `hello`, `reset`,
and `browser-addons-changed` payloads from one native EventSource and lets its
built-in reconnect behavior own `Last-Event-ID`. There is deliberately no
second add-on-only SSE connection or reconnect policy.

## TypeScript transport

`BrowserGraphClient` serializes refreshes and owns the strong ETag for the last
accepted graph. It sends same-origin credentials and `If-None-Match`, returns
the cached immutable value for a 304, and never interprets an HTTP error body.
`reset()` invalidates both the cache and any in-flight response so a role or
session transition cannot repopulate stale authority.

A 200 response is accepted only when it is JSON below 512 KiB, uses contract
version 2, has exact object fields, lowercase SHA-256 revisions and generation
IDs, and contains only generation-bound asset URLs. The generation manager's
canonical validator then enforces URL, sandbox, capability, permission,
contribution, duplicate, dependency, and cycle semantics before the client
replaces its last good graph. Contribution configuration is bounded JSON with
deterministic object ordering and prototype-sensitive keys rejected. Reusing
one revision for different content is a boundary failure.

## Runtime composition

`BrowserAddonRuntime` is the single browser owner of the complete refresh
operation. It serializes graph transport through generation reconciliation so
a later fetch cannot overtake activation from an earlier response. Every
accepted response, including an unchanged 304, reaches the generation manager;
this lets a previously failed activation retry without inventing a new server
revision.

Transport or boundary-validation failures do not call reconciliation, so the
last successfully activated generation set keeps running. `reset()` first
advances the coordinator's authority epoch and invalidates the graph client's
cache, so queued work and fetched-but-unapplied responses cannot continue. It
then queues ordered disposal of active generations. Role, session, and
permission changes use the explicit `authority-changed` stop reason. This
prevents an old credential context from restoring browser authority while its
resources are being torn down.

`BrowserAddonSession` now instantiates the coordinator behind the authenticated
application shell. It opens the shared stream before its initial graph refresh,
coalesces every graph signal through the serialized runtime, and preserves live
generations across transient transport errors. A 401/403 closes the stream,
aborts the authority scope, clears cached graph authority, tears down active
generations, and returns the shell to anonymous state.

## Cold graph switch

Any changed graph revision deliberately rebuilds the complete contribution
graph:

1. Abort and dispose current consumers before their providers.
2. Continue teardown after individual disposer failures and retain labeled
   diagnostics.
3. Activate target providers before consumers.
4. If activation fails, abort and dispose that partial generation.
5. Skip required dependents of a failed generation while allowing independent
   add-ons to activate.
6. Publish the successful active subset and structured failure list.

Operations are serialized, so rapid server updates cannot interleave scopes.
An identical revision and descriptor set is an idempotent no-op. A partial
activation is not treated as a no-op on retry because the active set differs
from the target.

This trades a brief full contribution refresh for one small, deterministic
lifecycle. That is appropriate for the current personal deployment and small
first-party add-on set. Per-generation rolling UI replacement can be added
later if restart cost or availability becomes important; it must preserve the
same dependency and disposal ordering.

## Module boundary

`GenerationScope` remains the sole owner of listeners, subscriptions,
requests, observers, object URLs, and returned module cleanup. It aborts first,
then runs cleanup once in LIFO order with failure isolation.

`BrowserGenerationManager` receives an injected activator selected by the
server-projected UI mode. The integrated adapter loads every declared
stylesheet into the generation scope, imports the server-provided immutable
entry URL, requires an `activate(context)` export, and adapts the v3
`{ dispose() }` result into scope-owned cleanup. Cleanup unpublishes
contributions, invokes module cleanup, and then removes generation styles;
partial activation retains fallback cleanup for every acquired resource.

Integrated modules receive a public `BrowserAddonContext`, never the internal
generation scope or graph descriptor. The context exposes immutable add-on
identity, the generation abort signal, effective capability and permission
queries, and the UI binding API. Those queries support conditional UI only;
server endpoints must independently enforce every permission and resource.
Closed sessions report no authority and reject new contribution work.

`BrowserContributionRegistry` owns every live implementation by add-on,
contribution ID, and generation. It rejects undeclared IDs, duplicate binding,
replacement-generation theft, invalid custom-element names, and an
implementation shape that does not match the declared surface. Visual surfaces
bind custom elements, article actions bind action functions, and graph views or
contributors bind model providers. Sidebar entries are declarative and cannot
bind code. Both activation adapters publish reviewed sidebar metadata directly
into the registry; a feature-owned navigation surface can consume it without
loading another renderer or accepting a route callback. No binding accepts raw
HTML or a string action dispatcher.

Registry queries apply declared roles and deterministic order without exposing
private host DOM. Action and model callbacks are wrapped with the generation
signal so a stale registry snapshot cannot execute after revocation. A partial
activation is held by a fallback SDK disposer; successful activation transfers
cleanup into one composite that unpublishes contributions before calling the
module's own disposer.

The registry now publishes host-only change notifications after a binding is
added or removed. Observer failures are reported through the shell diagnostic
boundary and cannot turn a valid add-on binding into a partial failure.
`BrowserContributionOutlet` performs a keyed projection for one host-selected
surface and effective role. It preserves an unchanged custom-element instance,
orders panels by the registry contract, and removes stale elements on binding,
generation, or authority teardown. Each mounted element receives a frozen
`codexContribution` property containing its add-on and generation identity,
declaration, configuration, and generation abort signal; it never receives the
registry or private host DOM.

The current shell instantiates the generic outlet for the `slot` surface under
Campaign tools and shows a direct empty state when that role has no panels.
Routes, settings, article/editor locations, renderers, and graph surfaces will
reuse the same registry but remain owned by their corresponding core features.

## Isolated frame bridge

The isolated adapter never imports package code into the host realm and never
navigates the frame to an authenticated package URL. It fetches the immutable
entry module and CSS through the authenticated host, applies explicit 2 MiB
module and stylesheet limits, and transfers their text over a document-owned
message port into a host-generated `srcdoc`. The frame has a unique opaque
origin, a restrictive CSP that blocks ambient connections and external
subresources, and a sandbox that always
allows scripts but maps only the reviewed `downloads`, `forms`, `modals`, and
`popups` grants. It never receives `allow-same-origin`, host cookies, storage,
or usable access to the parent document. This boundary contains DOM and
ambient browser authority; it is not a general-purpose sandbox for actively
malicious computation. Such code belongs behind a narrower worker or WASI
contract.

The generated bootstrap imports the self-contained entry through a frame-local
blob URL and calls the same `activate(context)` shape used by integrated
modules. Current context support covers immutable add-on identity, generation
cancellation, capability and permission queries, the one role-visible
declaration represented by that frame, and surface-compatible element, action,
or model-provider binding. The entry module and declared styles must therefore
be `.js`/`.mjs` and `.css`; isolated entry modules cannot depend on relative
imports or network assets.

Each mounted visual contribution owns one transferred `MessagePort` using
`codex.browser-addon/1`. The initial document receives its private port before
asset loading completes, so a replacement document cannot inherit the module
bundle. Exact, bounded messages cover activation, ready, resize, diagnostic,
revoke, and the current read-only SDK queries. The host accepts no
global-window commands after connection, limits reported height, revokes a
frame that misses its handshake deadline, and closes the port on outlet,
generation, or authority teardown. Only the initial `srcdoc` load receives a
port, so an add-on that navigates its frame cannot reconnect from another
document. Binding disposal or document unload sends an unavailable signal that
withdraws the corresponding host registration instead of leaving a dead
contribution visible.

### Callback ownership and flow

Declarative sidebar entries execute no add-on code and are published directly
from reviewed graph metadata. Each isolated article action, graph view, or
graph contributor instead receives one hidden opaque frame. Activation must
bind the exact declared callback and complete its handshake before the registry
publishes the host proxy.

```text
host feature -> registry proxy -> bounded invoke message -> callback frame
host feature <- validated JSON <- bounded result message <- callback frame
       cancel/deadline -------------------------------> abort signal
generation teardown ---------------------------------> revoke and dispose
```

Requests and results must be bounded JSON inside the existing 64 KiB message
limit. A frame accepts at most 32 concurrent calls; the host applies a ten
second deadline, forwards caller cancellation, rejects late results, and
removes every pending call on generation teardown. Feature owners still
validate their request and result schemas because the bridge provides transport
safety, not domain meaning. Activation, add-on, invalid-result, timeout, busy,
and revoked failures remain distinguishable in diagnostics or typed host
errors.

One frame per executable contribution deliberately favors obvious ownership,
failure isolation, and cleanup over minimum memory. The current deployment has
a small first-party add-on set, so a pooled per-generation callback frame would
add multiplexing complexity without demonstrated benefit. Revisit pooling only
if browser measurements show frame startup or memory is material; preserve the
same per-contribution cancellation and authority rules if that changes.

## Remaining integration

- Add data, service, import, event, settings, navigation, graph, and log handles
  to the implemented capability-scoped SDK as their transports land.
- Connect the remaining host surfaces to their feature-owned registry outlets.
- Surface activation and disposal diagnostics in the Add-on Inspector.
- Add Playwright coverage once real contribution modules are wired.
