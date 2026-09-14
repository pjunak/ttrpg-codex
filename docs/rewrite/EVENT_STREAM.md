# Shared event stream

The browser uses one authenticated Server-Sent Events connection for live
invalidation and progress. Core data, browser add-ons and imports publish named
topics into the same transport. No subsystem or
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

The HTTP route is registered only with both an event source and an audience
resolver. Anonymous requests receive the public audience. A session maps its
effective role to the public or DM audience before cursor or query parsing.
Responses disable proxy buffering, retain authorization variance, and send
heartbeat comments every 20 seconds. Write deadlines are advanced after
successful output so a stalled client cannot hold a handler forever.
Authenticated streams re-check their session before each live publication and
heartbeat. Password changes, logout, expiry or role rotation close the old
connection; an ordinary reconnect resolves its current authority again.

The broker bounds total subscriptions and each subscriber queue. A slow
subscriber is disconnected rather than blocking publication or accumulating
unbounded memory. Event payloads never contain credentials, session tokens, or
private error details.

Player-preview tabs open the same shared stream with their bounded preview
credential in the `playerPreviewToken` query parameter. Authentication validates
and removes it before the stream's otherwise-closed query check. The preview
always receives the public audience even when the browser also carries a DM
cookie. Preview authority is checked before live publications and heartbeats;
expired or revoked previews close and cannot reconnect using the DM cookie.

## Campaign recovery

Campaign recovery publishes `campaign-restored` in the same transaction as its
data and audit changes. This public invalidation contains only a monotonically
increasing recovery revision and empty metadata, never point IDs, record keys
or private content. The browser validates it, reloads core campaign state, and
restarts clean add-on views to discard cached documents. Open core/add-on drafts
remain visible with a reload notice; their old revisions cannot overwrite the
restored state. Durable replay covers missed notifications as usual.

## Add-on data

`addon-data-changed` publications are validated in the shared browser stream
and dispatched only to the owning add-on's `context.data.subscribe` listeners.
Both integrated modules and isolated frames receive payload-free collection or
extension invalidations. The browser drops the internal data revision; normal
role-projected reads remain the only source of documents. `hello`, `reset` and
`campaign-restored` invalidate each active subscriber's cache. Subscriptions
end with their generation, contribution signal, or explicit disposer.

## Integration status and retention

Package activation, rollback, reviewed cohort activation, reload, disable and
startup recovery publish the resulting exact browser graph revision. A
publication failure is logged without claiming that an already committed
transition failed; every new or reset connection reloads the graph. Campaign
and browser graph payloads are runtime-validated in TypeScript.

Stored-event retention/checkpoint policy is not implemented (T07 in the
[suite backlog](../BACKLOG.md)). Import and background-job progress topics are
conditional extensions (C07); ordinary import writes already publish the
owning data invalidations. Neither gap means existing replay is absent.
