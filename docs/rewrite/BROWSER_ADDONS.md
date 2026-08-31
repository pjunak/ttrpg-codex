# Browser add-on generations

The TypeScript browser owns presentation resources for one
server-authoritative add-on graph. It does not decide which package generation
or dependency version should run. The Go host will publish an opaque graph
revision and an already-authorized descriptor for each browser contribution.

## Graph contract

Each descriptor contains:

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

## Host projection

`packagemanager.BrowserGraph` builds the deterministic projection from durable
active state and recovered package reports. Only the exact selected generation
of a recovered add-on may contribute UI. Entry and stylesheet paths are
converted to generation-addressed, same-origin asset URLs; clients never
construct filesystem paths.

The opaque revision is a SHA-256 digest over every durable active add-on ID,
generation, and state revision plus the projected UI descriptors. Including
worker-only state is intentional: a provider reload or cold backend cohort can
force all browser SDK handles to rebuild even when UI assets did not change.
Stopping a runtime removes its descriptor and changes the digest; recovery of
the same exact durable graph restores the deterministic projection.

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

- Expose and runtime-validate the graph through authorized HTTP/SSE transport.
- Serve the projected immutable generation assets with authorization and cache
  rules.
- Build the capability-scoped browser SDK and stable contribution slots.
- Surface activation and disposal diagnostics in the Add-on Inspector.
- Add Playwright coverage once real contribution modules are wired.
