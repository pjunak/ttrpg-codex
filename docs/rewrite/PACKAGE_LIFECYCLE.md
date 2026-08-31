# Add-on package lifecycle

This milestone connects verified v3 packages to durable generation state, the
service broker, and native worker supervision. It is an internal application
boundary; HTTP review endpoints and the Add-on Inspector UI are still to be
built on top of it.

## State ownership

| State | Owner | Durable |
|---|---|---|
| Package archive and extracted generation | Host package directory | Yes |
| Installed generations, active pointer, grants, revision, events | SQLite | Yes |
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

`ActivationPlan` identifies all authority consumed by one activation:

- exact add-on ID and archive-hash generation;
- expected durable state revision;
- complete set of granted permission IDs.

The manager rejects stale revisions, unrequested grants, missing required
grants, unsupported required capabilities, incompatible host/API/worker
versions, inactive identity dependencies, and unresolved required services.
It passes only the normalized grants and generation-bound service handles to
the new worker.

The current internal API expects its caller to construct this plan from a
reviewed proposal. The next HTTP/application milestone must persist and hash
that proposal, including contribution, dependency, service, migration, and
permission diffs; a client-supplied activation request must not become its own
approval proof.

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
Until a multi-add-on activation cohort is implemented, the manager refuses an
update or rollback when a live add-on has an identity dependency or resolved
service handle to the target. This is an explicit safe stop, not a silent
partial upgrade.

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

## Durable diagnostics

Migration `0003_addon_package_lifecycle.sql` stores:

- every content-addressed generation and inspected manifest;
- the active generation, grants, and optimistic state revision;
- separate last-attempt and last-successful-activation times;
- the last bounded failure message;
- ordered staged, activated, rolled-back, recovered, activation-failed,
  recovery-failed, and cleanup-failed events.

`Snapshot` combines that history with the live supervisor snapshot when a
worker exists. Package bytes, process handles, service registries, and request
payloads are not stored in the event log.

## Remaining lifecycle work

- Persisted review proposals and permission/contribution diff APIs.
- Coordinated multi-add-on update cohorts and dependent runtime rebinding.
- Planned generation bindings for add-ons that consume their own service.
- Disable, reload, uninstall, quarantine, and separate reviewed data deletion.
- Browser generation scopes and UI contribution switching.
- Add-on data migration planning and recoverable commit.
- WASI runtime factory, restart/backoff wiring, OS resource enforcement, and
  redacted support-bundle diagnostics.

These must extend this coordinator rather than bypass exact generations,
optimistic revisions, broker bindings, or host-owned approval state.
