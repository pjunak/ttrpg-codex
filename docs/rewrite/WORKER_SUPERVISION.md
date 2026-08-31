# Native worker supervision

This milestone turns the framed worker protocol into a real process boundary.
The supervisor owns one immutable add-on generation and fails that generation
closed when launch, negotiation, health, or shutdown violates its contract.

It deliberately does not dispatch domain calls yet. The next broker milestone
will own concurrent request routing, worker-to-host calls, cancellation, and
capability enforcement without mixing those policies into process lifecycle.

## Responsibility split

| Component | Owns |
|---|---|
| Package installer | Verifying the package and selecting an exact executable for the current target |
| Generation manager | Activation, consecutive-failure accounting, restart decisions, and replacement generations |
| Native worker supervisor | Exact process launch, lifecycle negotiation, health, bounded diagnostics, deadlines, and termination |
| Worker RPC codec | Framing, UTF-8 and JSON-RPC envelope validation, and bounded I/O |
| Service broker | Authorized domain calls, concurrency, cancellation, request metadata, and worker-to-host routing |

This keeps the reusable transport in `sdk/go/workerrpc` while host policy stays
under `internal/addons`. A worker can use the public codec without gaining
access to supervisor or broker internals.

## Process and environment contract

The supervisor accepts an already reviewed executable path and working
directory. Both are resolved to absolute paths and must exist; it does not
search `PATH`, invoke a shell, or execute package source.

The child receives only the explicit environment map supplied by the host.
The parent process environment is not inherited. The generation manager will
eventually populate the small portable subset workers need, such as an
explicit temporary directory, rather than leaking host secrets or machine
configuration by default.

Stderr is retained as a bounded newest-byte tail for the Inspector. Stdout is
protocol-only. The tail is raw process output at this layer; structured-log
parsing and secret redaction belong in the future diagnostic pipeline before
output is persisted or exposed outside trusted administration.

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
   services, protocol version, and negotiated limits. Framing is enforced in
   this layer; domain concurrency is enforced by the later broker.
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
lifecycle error, and the bounded stderr tail. They copy mutable negotiated
data so Inspector callers cannot alter live state.

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

Codec failures keep their more precise framing code as the wrapped cause.

## Restart policy

The supervisor reports unexpected completion through `Wait`; it never
restarts itself. The generation manager applies deterministic bounded
exponential backoff. The default permits three restart attempts at one, two,
and four seconds, capped at 30 seconds. Consecutive failures and the
five-minute stability reset are manager-owned state, so replacing a supervisor
cannot accidentally reset a crash loop.

Automatic restart wiring is not part of this milestone. Exposing the decision
as a pure function makes the later manager testable without sleeping.

## Current scale and revisit points

Lifecycle and health exchanges are intentionally serialized. This is correct
for one in-flight control request, prevents health/shutdown races, and also
rejects unexpected worker-to-host requests during startup. Waiting for another
control operation still honors the caller's context. Before domain methods are
enabled, the broker must add a continuous reader, response correlation,
bounded concurrency, cancellation, and fair queues.

Revisit the boundary when one of these becomes real rather than speculative:

- a trusted native worker requires sustained parallel domain calls;
- a worker must make authorized callbacks during initialization;
- measured stderr volume requires structured streaming instead of a tail;
- supported platforms gain a common enforceable CPU or memory primitive;
- restart data must survive host restarts rather than only generation-manager
  lifetime.
