# Native worker supervision

This milestone turns the framed worker protocol into a real process boundary.
The supervisor owns one immutable add-on generation and fails that generation
closed when launch, negotiation, health, or shutdown violates its contract.

After readiness, it hands the channel to the shared RPC peer and host-only
dispatcher for generation-scoped package data and brokered service calls.

## Responsibility split

| Component | Owns |
|---|---|
| Package inspector | Verifying and extracting a content-addressed package generation |
| Package manager | Activation, durable generation selection, grants, dependency ordering, rollback, and recovery |
| Supervisor factory | Selecting the exact native executable for the current target and constructing one supervisor |
| Package-manager monitor | Periodic health, runtime failure detection, affected-consumer invalidation, bounded retries and stability accounting |
| Native worker supervisor | Exact process launch, lifecycle negotiation, health, bounded diagnostics, deadlines, and termination |
| Worker RPC codec | Framing, UTF-8 and JSON-RPC envelope validation, and bounded I/O |
| Worker RPC peer | Continuous reads, correlated calls, concurrency, cancellation, and transport counters |
| Host dispatcher | Context resolution, schemas, authorization, handlers, and sanitized failures |
| Service broker | Provider discovery, operator bindings, generation-safe handles, and contract routing |

This keeps the reusable transport in `sdk/go/workerrpc` while host policy stays
under `internal/addons`. A worker can use the public codec and peer without
gaining access to supervisor or broker internals. The dispatcher design is in
[`WORKER_BROKER.md`](WORKER_BROKER.md).

## Process and environment contract

The supervisor accepts an already reviewed executable path and working
directory. Both are resolved to absolute paths and must exist; it does not
search `PATH`, invoke a shell, or execute package source.

The supervisor owns the parent pipe ends directly instead of relying on
`exec.Cmd` convenience pipes. Process waiting therefore cannot close stdout
while the peer is still draining a final response frame.

The child receives only the explicit environment map supplied by the host.
The parent process environment is not inherited. The package manager's
supervisor factory supplies that reviewed environment, the normalized
permission grants, and exact generation-bound service handles; it does not
leak host secrets or machine configuration by default.

Stderr is retained only as a bounded newest-byte tail inside the supervisor.
Stdout is protocol-only. Administrative snapshots deliberately omit this raw
tail, negotiated worker text and free-form exception/transition messages.
Stable failure categories replace raw errors; pattern-based redaction is not
assumed to remove arbitrary secrets or campaign content.

Settings → Add-ons exposes observed health and time, start/exit times, process
exit code where available, and the latest 32 worker requests with method, outcome,
duration and hashed request/correlation references. References correlate related
calls without retaining raw identifiers. Parameter/result bodies and health
detail objects are never captured. The monitor retains a detached sanitized
snapshot when a failed worker is withdrawn, so its evidence remains available
during backoff or after retry exhaustion. Browser failures use a separate bounded
tab-local history, cleared on authority changes.

Native workers provide crash isolation, not a security sandbox. CPU and
memory enforcement and any operating-system sandbox remain follow-up work.

## Lifecycle

```text
created --start--> spawning -> initializing -> starting -> checking -> ready
created --shutdown-------------------------------------------------> stopped
spawning | initializing | starting | checking | ready --failure----> failed
ready --shutdown--> stopping --zero exit---------------------------> stopped
stopping --failure-------------------------------------------------> failed
```

The actual transition graph is stricter than the compact diagram: no state
may skip directly to `ready`, and a stopped or failed process instance cannot
be reused. A restart always creates a new supervisor instance for the same
immutable generation.

Startup uses one overall deadline and performs these calls in order:

1. `codex/initialize` supplies identity, host information, grants, bound
   services, protocol version, and negotiated limits. Framing is enforced by
   the codec and domain concurrency by the peer.
2. The worker returns the exact protocol version, unique optional
   capabilities, non-empty method versions, and required health support.
3. `codex/start` must return `{ "ready": true }`.
4. The first `codex/health` must return `{ "status": "ok" }`.

A runtime health call accepts `ok` or `degraded`. A malformed result,
transport failure, or health deadline failure marks the generation failed and
terminates the process. Readiness policy above the supervisor may decide how a
reported `degraded` state affects routing.

Graceful shutdown sends `codex/shutdown` and waits for a zero exit within the
shutdown deadline. A remote error, non-zero exit, or timeout marks the
generation failed; timeout also forces termination. Shutdown before launch is
a clean stop. Shutdown of an already stopped or failed instance is idempotent.

## Diagnostics and stable failures

Snapshots contain generation identity, lifecycle state and transitions, PID,
start and exit timestamps, negotiated features, process exit detail, the last
lifecycle error, the bounded stderr tail, and RPC activity counters. They copy
mutable negotiated data so Inspector callers cannot alter live state.

The supervisor exposes stable lifecycle categories:

| Code | Meaning |
|---|---|
| `INVALID_STATE` | The requested lifecycle operation is not valid now |
| `SPAWN_FAILED` | Pipes, codec setup, or native process launch failed |
| `STARTUP_FAILED` | Initialization, negotiation, start, or initial response was invalid |
| `STARTUP_TIMEOUT` | The bounded startup sequence exceeded its deadline |
| `HEALTH_FAILED` | A runtime or initial health result failed its contract |
| `SHUTDOWN_FAILED` | Graceful shutdown failed, timed out, or exited non-zero |
| `PROCESS_EXITED` | A running worker exited without an accepted shutdown |
| `TRANSPORT_FAILED` | Runtime framing, correlation, or transport failed |

Codec failures keep their more precise framing code as the wrapped cause.

## Restart policy

The supervisor reports completion through `Wait` and its snapshot; it never
restarts itself. The production host enables the package manager's
[`MonitoringConfig`](../../internal/addons/packagemanager/monitor.go) and starts
its monitor after composition. Offline/embedded managers can omit monitoring.

The coordinator polls runtime state every second and calls runtime health every
30 seconds, with a five-second health deadline. Probes and lifecycle transitions
are serialized through the package manager. A valid `degraded` result keeps the
runtime available but does not count toward stability. A crash, invalid health
result or timeout withdraws the failed runtime and its affected live consumers.
All affected service/request-context and data handles are withdrawn before
consumer-before-provider shutdown. Unrelated runtimes remain running.

Recovery re-inspects the exact durably selected packages and approved grants.
Required consumers wait for their providers; optional consumers can restart
without them and reconnect when they return. Declared dependencies are considered
as well as existing handles, including optional consumers currently using a
provider-free fallback. Authored data, stored packages, selections and grants are
not disabled, deleted or reverted by this process.

The coordinator owns per-package/generation/revision failure accounting and uses
`RestartPolicy.Decide`: at most three automatic attempts, delayed one, two and
four seconds by default. Failed startup and failed reinspection consume the same
budget. Five uninterrupted healthy minutes reset it. Exhaustion leaves the
generation unavailable with an explicit Reload recovery route; it does not keep
spawning processes. Counters are in memory and reset with a new host process.
A revision-checked operator Reload resets an unavailable worker's budget and
attempts recovery of its affected consumers. Once accepted, this bounded
transition completes even if the browser disconnects; the browser must refresh
the durable outcome instead of automatically repeating the request. Disabling, uninstalling or replacing a generation
cancels its obsolete retry state; other coordinator changes respect backoff.

A boot-scoped runtime revision contributes to the opaque browser graph revision,
so same-package restarts and missed intermediate notifications still invalidate
browser handles. The existing public graph event carries no worker output.
The existing browser graph reconciliation can remount add-on views; recovery of
unsaved DM Tools drafts during forced replacement remains T30. Pending domain
calls fail with their original outcome; monitoring never replays
a domain request, import or save. The coordinator records bounded failure
categories and detached redacted health/exit/request snapshots; Settings shows
these alongside tab-local browser diagnostics.

Automatic cohort transitions have a two-minute deadline. Host shutdown cancels
and joins the monitor before stopping runtimes, including an in-flight health
probe, and leaves durable activation selected for the next host start.

Regression coverage in `monitor_test.go` and `monitor_native_test.go` includes
transitive stop order, optional reconnection, untouched unrelated workers,
same-package browser invalidation, non-replayed writes, startup failure, health
hangs, backoff/exhaustion, stable/degraded periods, corrupt saved packages,
generation replacement, explicit recovery and shutdown cancellation. Native
subprocess tests prove crash/health-timeout termination and fresh-process restart.

Go workers use `workerrpc.RunNativeWorker` rather than reimplementing this
lifecycle. The helper keeps startup reads serialized, switches the same codec
to the concurrent peer only after the initial health response, requires domain
metadata, and waits until the graceful-shutdown response is physically written
before returning from the process composition root. Its handler factory gets a
detached initialization snapshot plus the peer for authorized host callbacks.

## Current scale and revisit points

Startup exchanges and supervisor control operations remain serialized. After
the initial health response, one continuous peer reader handles runtime
control responses and bounded worker-to-host calls. This prevents competing
stdout readers while still permitting concurrent domain handlers. The current
zero-queue policy rejects excess work; a fair queue is justified only by
measurement.

Revisit the boundary when one of these becomes real rather than speculative:

- a trusted native worker requires sustained parallel domain calls;
- a worker must make authorized callbacks during initialization;
- measured stderr volume requires structured streaming instead of a tail;
- supported platforms gain a common enforceable CPU or memory primitive;
- restart data must survive host restarts rather than only generation-manager
  lifetime.
