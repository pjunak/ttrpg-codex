# ADR-0001: Host-owned campaign bundle imports

**Status:** Accepted; Go implementation restored September 16, 2026.
**Original decision:** July 28, 2026, project maintainer.

## Ownership and scope

The host owns the campaign-bundle importer. DM Tools owns the visible Import
Center and discovers it through the existing `codex.import-adapter` service
handle. Add-ons cannot acquire arbitrary core mutation authority.

The reserved provider ID `codex-core` advertises adapter version 3.0.0 to
authenticated DM browser consumers declaring a compatible, cardinality-many
import-adapter dependency. Packages cannot use this ID. Worker dependency
resolution does not receive a synthetic installed package. Adapter v3 adds full
record views and core keys up to 1024 bytes; v2-only consumers are not offered
this provider. Updated Import Centers consume `>=2.0.0 <4.0.0` to retain existing
planning/third-party adapters while opting into the expanded review.

The preserved input [schema](../../internal/application/campaignimport/campaign-bundle.schema.json)
uses format `ttrpg-codex-campaign-bundle`, schemaVersion 1 and generatedAt.
It permits at most 2 MiB, 128 logical core records and 256 total materialized
writes. Core operations create characters, locations and relationships with
explicit public/DM visibility. Core updates, deletes, settings, credentials,
media, backups, twins and unrelated record types are outside this format.
Ordinary interactive editors retain their existing authority.

Each operation has a unique local `ref`. Declared reference fields accept
`{"$ref":"local-name"}` or
`{"$id":{"collection":"locations","id":"existing-id"}}`.
The host verifies collection identity and existing targets, reserves final IDs
during preview and derives relationship keys using the canonical core identity.

## Review and atomic commit

Preview uses the ordinary core mutation planner and closed player projection.
It lists direct and derived changes, final IDs, complete resulting DM/player
values and expiry. Read the prose: visibility projection cannot detect secrets
embedded in otherwise public text.

The host retains the exact plan for 15 minutes, bound to the session, Import
Center add-on and activation generation. Limits are 128 pending plans, an
8 MiB review and 32 MiB of aggregate retained review size. Preview does not write
campaign records. Cancellation discards a known token; abandoned requests expire.

Commit consumes the token before attempting publication. It checks the current
consumer/contributor generations, all reviewed core collection revisions and
contributor dataset/document revisions. A conflict requires a new preview.
It never reparses source, allocates IDs again or reruns contributor code.

Core and add-on stores join one host-owned SQLite transaction. Records, audit,
normal role-scoped events and the success receipt commit together. Notifications
are published only after the transaction commits. A failure in any participant
rolls everything back; ordinary pre-write recovery-point capture remains active.

Receipt status resolves an ambiguous response without retrying writes.
`status` returns `committing`, `committed`, `failed` or `missing`; missing
does not prove that an in-flight request cannot still arrive. Receipts store
only a token hash and counts/status, not imported prose. Any authenticated DM
with the unguessable token and an authorized active Import Center can reconcile
a receipt, including after a restart. Pending plans expire on restart; an
interrupted noncommitted attempt becomes failed. There is no automatic retry.

## Scoped add-on contributions

Up to eight `addonImports` entries may name an installed add-on, its
`contributorId`, and an owner-defined `document`; only one entry per namespace
is allowed. Exact `{"$ref":"local-name"}` objects in that document resolve to
the reserved core ID. Other document semantics belong to the contributor.

A contributor provides nonexclusive `codex.campaign-bundle-contributor` v1,
worker method `preview` (15 seconds). Its closed request is
`{contractVersion:"campaign-contribution.v1", contributorId, document}`.
Its closed result is `campaign-contribution-plan.v1`, with:

- `expectedDataSets`: collection kind, dataId and exact revision;
- `mutations`: put/delete, collection, key, expectedRevision and optional value.

The host resolves that exact active provider and schema, permits only its own
declared collections, validates document schemas, rejects duplicate targets and
requires dataset guards. It supplies namespace, schema identity, visibility and
actor itself. A contributor cannot return core writes or extension writes.

Preview request authority is read-only and propagates through nested service
calls. The worker dispatcher defaults to denying host callbacks unless their
method explicitly permits reads. It still applies normal actor, permission and
generation checks. This is an RPC authority boundary, not an OS sandbox.

DM Tools contributes as `planning-json`, using its existing schema-3 planning
document and pure semantic validation. Merge/replacement semantics remain owned
by DM Tools; replacement deletions appear in the combined review. The contributor
returns a plan without retaining a second token or publishing its own commit.

## Alternatives and validation

Granting core writes to DM Tools or accepting arbitrary collection paths was
rejected: either creates a second core authority. The old file-journal publisher
has been replaced by the current SQLite transaction boundary while preserving
the original format and review contract.

Backend regression tests cover closed schemas, typed references, exact IDs/views,
session ownership, expiry, cancellation, stale data/generations, concurrent
double commit, durable receipts and injected add-on/receipt failures. Installed
package tests exercise review and scoped planning publication, desktop/phone
layout, safe text rendering, cancel, stale review and lost-response reconciliation.
Full backups remain a separate offline maintenance workflow.
