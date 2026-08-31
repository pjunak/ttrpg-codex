# Browser add-on generations

The TypeScript browser owns presentation resources for one
server-authoritative add-on graph. It does not decide which package generation
or dependency version should run. The Go host will publish an opaque graph
revision and an already-authorized descriptor for each browser contribution.

## Graph contract

Each descriptor contains:

- a stable add-on ID;
- an immutable package generation ID;
- a same-origin module entry URL;
- required browser add-on dependencies.

The graph revision is opaque. The server must change it whenever browser
contributions or their host SDK/service handles must be rebuilt, including a
cold backend cohort, reload, disable, or package update. The browser does not
infer authority from timestamps, URLs, or its previous state.

The coordinator validates the complete graph before touching live UI. It
rejects duplicate or malformed IDs, missing dependencies, self-dependencies,
cycles, unsafe entry URLs, oversized values, and more than 100 active browser
generations.

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
registers a returned disposer. Dynamic import policy and the actual browser
SDK remain composition concerns; add-on modules do not receive host globals or
private DOM access.

## Remaining integration

- Define and runtime-validate the Go HTTP/SSE graph projection.
- Serve immutable generation entry modules with authorization and cache rules.
- Build the capability-scoped browser SDK and stable contribution slots.
- Surface activation and disposal diagnostics in the Add-on Inspector.
- Add Playwright coverage once real contribution modules are wired.
