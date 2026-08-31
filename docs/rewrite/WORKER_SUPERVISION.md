# Native worker supervision

This milestone turns the framed worker protocol into a real process boundary.
The supervisor owns one immutable add-on generation and fails that generation
closed when launch, negotiation, health, or shutdown violates its contract.

After readiness, it hands the channel to the shared RPC peer and a host-only
dispatcher. Concrete data methods and persisted service bindings remain later
milestones.

## Responsibility split

| Component | Owns |
|---|---|
| Package inspector | Verifying and extracting a content-addressed package generation |
| Package manager | Activation, durable generation selection, grants, dependency ordering, rollback, and recovery |
| Supervisor factory | Selecting the exact native executable for the current target and constructing one supervisor |
| Generation manager | Consecutive-failure accounting and restart decisions (future lifecycle extension) |
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

The supervisor reports unexpected completion through `Wait`; it never
restarts itself. The generation manager applies deterministic bounded
exponential backoff. The default permits three restart attempts at one, two,
and four seconds, capped at 30 seconds. Consecutive failures and the
five-minute stability reset are manager-owned state, so replacing a supervisor
cannot accidentally reset a crash loop.

The package manager now owns initial start, replacement, rollback, shutdown,
and host-restart recovery. Automatic crash restart wiring is not part of this
milestone. Exposing the decision as a pure function keeps the later policy
testable without sleeping.

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
