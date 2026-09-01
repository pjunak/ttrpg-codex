# Service broker and request lineage

This milestone adds the host-owned service selection layer above worker and
immutable-content transports. It keeps three kinds of state separate because
they have different recovery and trust rules:

| State | Owner | Durable |
|---|---|---|
| Installed provider declarations | SQLite provider catalog | Yes |
| Operator selections and binding revisions | SQLite binding store | Yes |
| Callable add-on generation and request contexts | In-memory runtime registries | No |

A host restart therefore remembers what is installed and what the operator
selected, but does not claim that an old process is still callable. A
generation becomes available only after the lifecycle manager publishes the
new live runtime.

## Provider catalog

`Store.ReplaceProviders` atomically replaces every service declaration for one
installed add-on. Each provider records the add-on and contract versions,
transport, schema path, exclusivity, catalog revision, and update time. It
never stores a live process handle.

Contract versions and consumer ranges use npm/Cargo-style semantic-version
constraints, including caret and tilde ranges. Provider versions are parsed as
strict semantic versions. If either an existing or incoming provider is
exclusive, another add-on cannot provide the same contract major. The check
includes installed providers regardless of whether they currently have a live
generation.

Replacing a package increments one monotonic catalog epoch for that add-on;
every provider row carries that epoch. Uninstall retains a small catalog
tombstone and increments it, so reinstall cannot reset to an epoch that an old
runtime once used. Runtime activation snapshots the current epoch. This closes
the handoff window where a new declaration is durable but the previous process
has not stopped yet: the old runtime snapshot no longer matches and the
provider remains unavailable until the replacement generation is explicitly
activated.

## Bindings and resolution

An operator binding is keyed by consumer add-on, contract, and scope. Its
targets are stored separately so `many` consumers can select a stable subset.
Every update uses an expected revision:

- revision `0` creates only when no binding exists;
- a positive revision updates only that exact version;
- successful creates start at `1`; successful updates increment once;
- stale concurrent updates fail with `ErrBindingConflict`.

Bindings deliberately do not foreign-key targets to provider rows. Uninstalling
or replacing a selected provider must leave the operator's choice visible as a
stale binding instead of deleting history or silently choosing another add-on.

Resolution is deterministic:

| Requirement | No explicit binding |
|---|---|
| `one` with no live compatible provider | unavailable |
| `one` with exactly one live compatible provider | automatic handle, binding revision `0` |
| `one` with several live compatible providers | ambiguous until operator selection |
| `many` + `all-compatible` | all live compatible providers, sorted by add-on ID |
| `many` + `operator` | unbound until the operator stores a target set |

An explicit binding always wins over automatic resolution. If any selected
target is missing, inactive, or incompatible, the resolution is `stale` and
reports the exact target IDs. It never falls through to another provider.

## Generation-safe handles and calls

A resolved handle captures the consumer, contract and range, cardinality,
selection policy, scope, provider, exact contract version, transport,
generation, and binding revision. Every call re-resolves and compares all of
those facts. A changed binding, catalog, version, provider set, or generation
returns `ErrStaleBinding` before routing.

Calls validate and prepare under a broker read lease, then execute the provider
without holding the broker lock. This lets a worker provider call one of its own
bound services without recursively entering a writer-preferring read lock.
After response validation, the broker takes a final read lease and revalidates
the exact handle and runtime before accepting the result. A catalog, binding,
or runtime change can therefore proceed during provider work, but invalidates
that in-flight result with `ErrStaleBinding`. Request contexts still enforce the
configured deadline.

`Broker.ActivateRuntime` publishes a generation against an exact snapshot of
the installed catalog and an immutable compiled service registry. Every
registry contract must match the catalog's ID, exact version, document path,
and exclusivity rule. Replacing a generation invalidates host-issued request
contexts for the old generation. `Broker.DeactivateRuntime` removes and
invalidates only an exact generation, so delayed teardown cannot affect its
replacement.

Worker service calls use `service/<contract>/<method>`. The broker requires
the method to exist in the generation's host-compiled registry, accepts only
JSON objects or arrays as params, validates both payload directions, enforces
the declared idempotency-key policy, and clamps the call to the method's
maximum deadline. A caller cannot inject or bypass validators. Package schema
references resolve only from inspected `contracts/**/*.json` resources; the
compiler has no filesystem or network fallback. The native supervisor exposes
the active peer as a generation-checked caller but does not select contracts
or validate domain schemas itself.

Immutable-content providers use a host-owned adapter instead of a worker. The
adapter exposes only `catalog`, `get`, and `query`, reads the already inspected
generation index, and applies the same bounded ordering and cursor rules as the
browser API. Package-owned service schemas still validate both payload
directions through the broker. Consumers therefore resolve a contract and
never read a provider's package files or depend on its add-on ID.

## Host-issued request contexts

The bounded `requestcontext.Registry` creates random request IDs and stores the
authoritative actor, correlation ID, deadline, idempotency key, and trace
context for one target add-on generation. A worker callback may present that
lineage while the lease is active. Resolution requires the immutable wire
fields to match exactly and returns the stored actor; a forged wire `actor`
field is ignored.

Leases are removed on call completion, expiry, explicit close, or generation
replacement. The registry has a fixed active-context limit and no payload
storage. Its snapshot exposes only active, issued, resolved, rejected, expired,
and invalidated counts.

## Lifecycle integration and next boundary

The package manager now owns catalog publication and exact runtime activation
for initial activation, updates, rollback, reviewed cold-graph rebinding, and
restart recovery. Its ordering and failure contract is in
[`PACKAGE_LIFECYCLE.md`](PACKAGE_LIFECYCLE.md).

The remaining broker integrations are:

- expose activation diagnostics and binding editors through HTTP and the
  Add-on Inspector;
- implement the UI service transport adapter;
- implement the concrete data, event, import, migration, and HTTP host methods.

Those integrations must use this broker rather than holding provider objects,
choosing official add-on IDs, or reconstructing actor authority from wire
metadata.
