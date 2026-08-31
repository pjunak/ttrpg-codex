# Worker RPC peer and host dispatcher

This milestone makes the post-start worker channel bidirectional without
mixing host authority into the public transport SDK. It supplies the bounded
RPC machinery and the fail-closed host-call policy boundary needed before
service bindings, data implementations, or imports can use workers.

## Boundary and data flow

```text
native worker
    |
    | framed JSON-RPC
    v
public workerrpc.Peer       one reader, correlated calls, cancellation,
    |                       generation/deadline checks, concurrency limits
    v
host workerbroker.Dispatcher
    |
    +-> request schema validator
    +-> host context resolver ----> authoritative actor/deadline/correlation
    +-> resource authorizer
    +-> method handler
    +-> response schema validator
```

The peer in `sdk/go/workerrpc` is reusable by the host and Go workers. It knows
message mechanics but no permissions, collections, service contracts, or
storage. The dispatcher in `internal/addons/workerbroker` is host-only and
cannot be imported by an add-on worker.

The supervisor gives the peer ownership of stdout after the initial
initialize/start/health exchange. Runtime health, shutdown, and worker-to-host
requests then share the same continuous reader safely.

## Trust and authorization

A worker cannot authorize itself by writing `actor: { "role": "dm" }`. Wire
metadata identifies the request lineage it claims to continue. Before
authorization, the required host context resolver maps that lineage to a
host-owned authority containing the authoritative request ID, correlation ID,
actor, deadline, idempotency key, and trace context.

The dispatcher applies the shorter authoritative deadline to the handler.
Missing, stale, expired, or unverifiable lineage fails closed. Approved
background jobs resolve to an explicit host-created `system` authority; a
worker cannot create that authority merely by labelling its own request.

Dispatch order is fixed:

1. resolve the exact registered `host/*` method;
2. validate request JSON against that method's contract;
3. resolve authoritative host context;
4. authorize the exact permission and resource-bearing request;
5. invoke the handler with cancellation and the authoritative deadline;
6. encode and validate the response;
7. send the exact validated JSON bytes.

Every method requires request validation, response validation, a permission,
and a handler at dispatcher construction. Duplicate or malformed method
registrations prevent construction. Generic handler errors and panics become
sanitized `INTERNAL` failures while the detailed cause goes only to the
host-owned diagnostic hook.

## Concurrency, cancellation, and backpressure

Each peer has one reader and a write-serialized codec. Responses are routed by
their JSON-RPC message ID, so requests may be active in both directions at the
same time. Message IDs and `meta.requestId` are separate: the former correlates
one JSON-RPC exchange; the latter identifies the logical operation in host
diagnostics.

Incoming and outgoing concurrency have independent fixed capacities. There is
currently no waiting queue. A peer at capacity returns `RATE_LIMITED` rather
than allocating unbounded work or goroutines.

When an outgoing caller's context or metadata deadline ends, its pending entry
is removed and the peer sends `$/cancelRequest` with the JSON-RPC message ID.
The receiving peer cancels the matching handler context. A handler must still
cooperate; Go cannot safely terminate an arbitrary goroutine. Any later
response is discarded and counted. Supervisor shutdown cancels every active
worker-to-host handler before asking the worker to exit.

## Failures and diagnostics

Unknown application error kinds normalize to `INTERNAL` for logic while the
reported kind remains available for diagnostics. Protocol or transport
failure stops the peer, fails all pending calls, cancels inbound handlers, and
causes the supervisor to terminate the generation. A clean EOF remains process
lifecycle evidence and is classified by the supervisor.

Peer snapshots expose active and pending calls, total calls in each direction,
cancellations, rejected work, ignored notifications, late responses, and the
terminal transport error. Dispatcher snapshots expose calls, in-flight work,
successes, and stable error-kind counts. Payloads are deliberately absent.

## Request contexts and service routing

The next host layer is now implemented in
[`SERVICE_BROKER.md`](SERVICE_BROKER.md). It provides bounded host-issued
request contexts, persisted provider declarations and operator selections,
deterministic resolution, generation-safe handles, and validated worker
service routing. The dispatcher uses that request-context contract directly;
wire actor values remain untrusted claims.

Package-owned service documents and real method request/response validators
are now compiled by the host and pinned to the exact live generation. The
following remain later milestones:

- connect data, blob, event, HTTP, import, and migration handlers;
- wire approved background jobs and package lifecycle orchestration;
- add redacted traces and latency/queue metrics to the Inspector;
- decide whether measured workloads need a small bounded fair queue. The
  default remains no queue.

Revisit the peer abstraction if a future WASI runtime cannot present equivalent
ordered byte streams, or if measurements show a single framed connection is a
bottleneck. Neither condition is currently demonstrated.
