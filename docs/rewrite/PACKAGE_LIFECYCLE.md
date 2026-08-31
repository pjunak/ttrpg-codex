# Add-on package lifecycle

This milestone connects verified v3 packages to durable generation state, the
service broker, native worker supervision, and an authorization-gated HTTP
application boundary. The current executable does not register the
administrative routes until the rewrite authentication service is available;
the Add-on Inspector UI is still to be built on top of them.

## State ownership

| State | Owner | Durable |
|---|---|---|
| Package archive and extracted generation | Host package directory | Yes |
| Installed generations, reviews, active pointer, grants, revision, events | SQLite | Yes |
| Provider declarations and operator bindings | Service broker store | Yes |
| Worker processes, callable providers, resolved service handles | Package manager and broker memory | No |

The archive SHA-256 is the generation ID. One installed generation lives at:

```text
<package-dir>/<addon-id>/generations/<archive-sha256>/
  package.zip
  root/
```

The host copies an input archive into a private staging directory, inspects it,
verifies its complete checksum inventory, and extracts only regular files. A
rename publishes the generation directory. Staging is idempotent and creates
no grant, provider, worker, or active-generation authority.

Every activation and recovery reopens the content-addressed archive and
revalidates the extracted tree against it. Missing, changed, linked, special,
or injected files fail closed before execution. This guards accidental or
same-account package-directory drift; a native worker is still crash isolation,
not an operating-system security sandbox.

## Reviewed activation contract

The package manager now exposes a three-step application contract:

1. `PrepareActivationReview` stores an exact manifest comparison and blockers.
2. `ApproveActivationReview` validates and records the complete grant set.
3. `ActivateReviewed` revalidates the proposal and consumes it during switch.

The stored proposal includes both manifests, current and target generations,
the expected state revision, retained and required permissions, directly
affected add-ons, the complete restart set, blockers, and stable
added/changed/removed summaries for runtime, capabilities, contributions,
dependencies, services, collections, record extensions, content, and locales.
The full proposal is SHA-256 hashed.

Approval hashes that proposal together with the normalized grant set. A
package, state, dependency, service, recovery, or dependent-set change makes
the review stale or blocked; client input cannot silently revise an existing
approval.

The resulting `ActivationPlan` identifies all authority consumed by one activation:

- exact add-on ID and archive-hash generation;
- expected durable state revision;
- complete set of granted permission IDs.

The manager rejects stale revisions, unrequested grants, missing required
grants, unsupported required capabilities, incompatible host/API/worker
versions, inactive identity dependencies, and unresolved required services.
It passes only the normalized grants and generation-bound service handles to
the new worker.

The active-generation update and transition from `approved` to `consumed`
share one SQLite transaction. A crash therefore cannot leave activated code
with a reusable approval. Direct activation remains an internal test and
coordinator primitive; future administrative transports must use review IDs.

## Switch and failure ordering

For an activation, update, or rollback the manager performs:

1. Revalidate the package and exact extracted generation.
2. Check compatibility, dependencies, grants, and service resolution.
3. Create and fully start the new worker while the previous runtime remains
   callable.
4. Publish the new provider catalog and exact generation caller.
5. Commit the active-generation pointer, grants, revision, and lifecycle event
   in one SQLite transaction.
6. Make the new runtime manager-owned, then stop the previous runtime.

If worker start, catalog publication, or the durable commit fails, new routing
is withdrawn, the previous catalog/runtime is restored, the new worker is
stopped, and the durable active pointer is unchanged. A failure to stop the old
worker after a successful switch is diagnostic cleanup failure; generation-
exact broker teardown prevents it from withdrawing the replacement.

Rollback deliberately uses the same path as forward activation. It never
changes a filesystem pointer or starts an older generation without current
compatibility, grant, dependency, service, and content checks.

Provider generation changes make existing consumer handles stale by design.
Direct internal activation therefore still refuses an update or rollback when
a live add-on has an identity dependency or resolved service handle to the
target. Reviewed activation uses the cold cohort below instead of attempting a
partial live upgrade.

## Coordinated cold activation

This personal deployment values a small, legible recovery model over seamless
add-on availability. When a reviewed provider change affects a live consumer,
the proposal records both the direct dependents and every active add-on that
will restart. Required dependents are checked against the target add-on
version and service-contract ranges before approval; incompatible targets are
hard blockers.

After approval, the manager:

1. withdraws routing and stops the complete add-on graph, consumers first;
2. atomically changes only the reviewed target generation, grants, state
   revision, event, and review status;
3. invokes the normal recovery algorithm, which republishes catalogs and
   starts providers before consumers with new generation-bound handles.

Unrelated add-ons also restart. With the suite's small fixed add-on count this
is intentionally simpler than maintaining a shadow provider catalog and two
simultaneous runtime graphs. Core HTTP and campaign storage remain outside the
cohort, so add-on downtime cannot partially commit campaign files.

If recovery fails after the durable switch, the activation result reports a
per-add-on recovery outcome and leaves the exact reviewed generation selected.
The operator may fix the package and restart the host; startup recovery uses
the same state and never silently falls back. A process crash after the commit
has the same recovery behavior. This choice should be revisited only if add-on
count, restart cost, or availability requirements materially increase.

## Restart recovery

The durable active generation is the only recovery authority. Startup never
falls back to another installed generation automatically.

Recovery first validates every selected package and republishes durable
provider catalogs without claiming that a process is live. It then repeatedly
starts candidates whose required identity dependencies and service providers
are already live. This yields provider-before-consumer order without depending
on add-on IDs. Available optional dependencies are preferred before consumers;
if they fail or form only an optional cycle, recovery proceeds with the
consumer's declared standalone behavior. Cycles, missing required providers,
corrupt generations, invalid grants, or startup failures remain failed with
lifecycle diagnostics.

Normal shutdown reverses the live dependency graph: consumers lose routing and
stop before providers. Durable active pointers remain intact for the next
recovery.

## Reload and disable

Reload revalidates the exact active archive and extracted tree, resolves its
current dependencies, grants, and service bindings, then starts a replacement
runtime. It swaps only the live caller against the existing provider catalog;
the add-on generation and catalog revisions do not change, so already-issued
consumer handles remain valid. The state revision and `reloaded` event still
advance, invalidating any review prepared against the older operational state.

Disable deactivates generation routing before clearing the durable active
pointer. Installed generations, provider declarations, bindings, grants, and
add-on data remain preserved. A failed or unrecovered generation can therefore
be disabled without starting its code. Live dependents block disable until a
coordinated transition is available. Successful disable increments the state
revision, records `disabled`, and then performs bounded worker cleanup.

## Administrative HTTP boundary

The transport registers add-on administration only when both the lifecycle
service and an `AdminAuthorizer` are supplied. Supplying only one is a startup
configuration error. Authorization runs before path or body parsing, and a
denial returns a generic response without exposing session details. The future
cookie-backed authorizer must own administrator-role and anti-CSRF checks.

| Method and path | Operation |
|---|---|
| `GET /api/admin/addons/{addonId}` | Read durable and live lifecycle diagnostics; optional `eventLimit` is bounded to 0-500 |
| `POST /api/admin/addons/{addonId}/activation-reviews` | Prepare and persist an exact generation review |
| `GET /api/admin/addon-activation-reviews/{reviewId}` | Re-read a durable review |
| `POST /api/admin/addon-activation-reviews/{reviewId}/approval` | Approve an exact complete grant set |
| `POST /api/admin/addon-activation-reviews/{reviewId}/activation` | Consume an approved review and switch generation |
| `POST /api/admin/addons/{addonId}/reload` | Reload the active generation at an expected state revision |
| `POST /api/admin/addons/{addonId}/disable` | Disable at an expected state revision without deleting files or data |

Mutation bodies require `application/json`, reject unknown fields and multiple
JSON values, and are capped at 64 KiB before lifecycle code is invoked. Path
identifiers and diagnostic limits are bounded. Public errors expose stable
categories and safe messages; full joined errors remain in administrator logs.
State/review conflicts use HTTP 409, rejected lifecycle inputs use 422, worker
activation failure uses 503, and unclassified failures use a generic 500.

Browser delivery is a separate read-only authorization surface. It exposes the
versioned private revalidated graph at `GET /api/addons/browser-graph` and exact
generation assets below
`GET /api/addons/{addonId}/generations/{generationId}/assets/web/...`.
Generation assets are served only while that exact package is recovered,
remain confined to inspected `web/` inventory entries, and are rehashed before
each response. Their archive generation and file digest make the URL and ETag
immutable without revealing filesystem layout.

## Durable diagnostics

Migrations `0003_addon_package_lifecycle.sql` and
`0004_addon_activation_reviews.sql` store:

- every content-addressed generation and inspected manifest;
- the active generation, grants, and optimistic state revision;
- separate last-attempt and last-successful-activation times;
- the last bounded failure message;
- ordered staged, activated, rolled-back, recovered, activation-failed,
  recovery-failed, and cleanup-failed events.
- prepared, approved, and consumed review records with proposal and approval
  hashes and separate timestamps.

`Snapshot` combines that history with the live supervisor snapshot when a
worker exists. Package bytes, process handles, service registries, and request
payloads are not stored in the event log.

## Remaining lifecycle work

- Planned generation bindings for add-ons that consume their own service.
- Coordinated dependent disable and uninstall transitions.
- Uninstall, quarantine, and separate reviewed data deletion.
- Authentication composition, shared SSE invalidation, and shell wiring over
  the implemented runtime-validated browser HTTP client, authority projection,
  switch coordinator, and contribution SDK core.
- Add-on data migration planning and recoverable commit.
- WASI runtime factory, restart/backoff wiring, OS resource enforcement, and
  redacted support-bundle diagnostics.
- Rewrite authentication composition for the protected administrative routes,
  followed by the Add-on Inspector UI over the review application contract.

These must extend this coordinator rather than bypass exact generations,
optimistic revisions, broker bindings, or host-owned approval state.
