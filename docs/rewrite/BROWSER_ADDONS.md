# Browser add-on generations

The TypeScript browser owns presentation resources for one
server-authoritative add-on graph. It does not decide which package generation
or dependency version should run. The Go host will publish an opaque graph
revision and an already-authorized descriptor for each browser contribution.

## Graph contract

The graph envelope declares browser graph contract version `1`. Each
descriptor contains:

- a stable add-on ID;
- the add-on version;
- an immutable package generation ID;
- the integrated or isolated UI mode;
- a same-origin module entry URL;
- same-origin style URLs and isolated-frame sandbox grants;
- required browser add-on dependencies.

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
asset-path validation. The rewrite executable deliberately leaves these
routes unregistered until its authentication composition exists.

| Method and path | Cache contract |
|---|---|
| `GET /api/addons/browser-graph` | `private, no-cache` with the graph revision as a strong ETag |
| `GET /api/addons/{addonId}/generations/{generationId}/assets/{webPath}` | `private, max-age=31536000, immutable` with the inspected file digest as a strong ETag |

Both responses vary on cookie and authorization credentials and use
`nosniff`. Assets also require same-origin resource use and deterministic MIME
types. Conditional GET and HEAD are supported. A corrupt expected asset is a
generic 503 rather than a cached or partially trusted response; inactive,
stale, non-web, and unlisted paths share one 404 classification.

Graph change notification will use the shared role-scoped event stream once
authentication and SSE replay are composed. There is deliberately no second
add-on-only SSE connection or reconnect policy.

## TypeScript transport

`BrowserGraphClient` serializes refreshes and owns the strong ETag for the last
accepted graph. It sends same-origin credentials and `If-None-Match`, returns
the cached immutable value for a 304, and never interprets an HTTP error body.
`reset()` invalidates both the cache and any in-flight response so a role or
session transition cannot repopulate stale authority.

A 200 response is accepted only when it is JSON below 512 KiB, uses contract
version 1, has exact object fields, lowercase SHA-256 revisions and generation
IDs, and contains only generation-bound asset URLs. The generation manager's
canonical validator then enforces URL, sandbox, duplicate, dependency, and
cycle semantics before the client replaces its last good graph. Reusing one
revision for different content is a boundary failure.

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

`BrowserGenerationManager` receives an injected activator. The supplied module
adapter imports the server-provided immutable entry URL, requires an
`activate(context)` export, passes only the generation context and scope, and
adapts the v3 `{ dispose() }` result into scope-owned cleanup. It refuses an
isolated descriptor; iframe activation remains a separate adapter. Dynamic
import policy and the actual browser SDK remain composition concerns; add-on
modules do not receive host globals or private DOM access.

## Remaining integration

- Compose rewrite authentication with the implemented browser routes.
- Signal graph changes through the shared role-scoped SSE stream.
- Wire the implemented graph client and generation manager into the shell.
- Build the capability-scoped browser SDK and stable contribution slots.
- Surface activation and disposal diagnostics in the Add-on Inspector.
- Add Playwright coverage once real contribution modules are wired.
