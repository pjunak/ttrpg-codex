# Shared event stream

The rewrite uses one authenticated Server-Sent Events connection for live
invalidation and progress. Core data, browser add-ons, imports, and future
background jobs publish named topics into the same transport. No subsystem or
add-on gets a private reconnect loop.

## Durable replay

`events.Broker` commits every publication to the SQLite `change_log` before it
wakes live subscribers. Sequence IDs are database-assigned and globally
monotonic. A notification lost between commit and wake-up is recovered by the
next replay; an in-memory wake-up is never the durable authority.

Browser-visible audiences are `public` and `dm`. A player connection receives
public events. A DM connection receives public and DM events. System events
may be retained for diagnostics but are never projected into a browser
subscription. Topic names, revisions, resource IDs, and JSON object metadata
are bounded before insertion.

`Last-Event-ID` resumes strictly after a non-negative sequence. Replay is
bounded to 256 visible events per connection. If the cursor is ahead of the
current database or the replay window is too large, the server emits a
`reset` event at the latest visible sequence; clients must refresh their
authoritative HTTP resources. A new connection receives `hello` at the latest
visible cursor and performs its normal initial HTTP loads instead of replaying
the complete history.

The server subscribes before reading the replay window. Live events that race
with replay therefore enter the bounded subscriber queue, and sequence
deduplication prevents them from being delivered twice.

## Connection behavior

The HTTP route is registered only with both an event source and an authorizer.
Session authorization happens before cursor or query parsing and maps the
effective role to its event audience. Responses disable proxy buffering,
retain private authorization variance, and send heartbeat comments every 20
seconds. Write deadlines are advanced after successful output so a stalled
client cannot hold a handler forever.

The broker bounds total subscriptions and each subscriber queue. A slow
subscriber is disconnected rather than blocking publication or accumulating
unbounded memory. Event payloads never contain credentials, session tokens, or
private error details.

## Remaining event work

- Package activation, rollback, reviewed cohort activation, reload, disable,
  and startup recovery now publish the resulting exact browser graph revision.
  A publication failure is logged but does not claim that an already-committed
  package transition failed; every new or reset connection reloads the graph.
- Compose the broker and session event authorizer in the executable.
- Add the runtime-validated TypeScript event client and reconnect policy.
- Add retention/checkpoint policy once real change volume can be measured.
