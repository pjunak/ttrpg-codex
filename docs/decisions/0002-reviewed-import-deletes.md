# ADR-0002: Reviewed import deletes

**Status:** Accepted

**Date:** 2026-08-27

**Decider:** Project maintainer

**Implementation status, September 14, 2026:** The current planning adapter v2 supports reviewed deletes through host SQLite transactions. The file-journal and bundle-coordinator mechanisms below describe the old implementation, not current APIs. See [planning imports](../../../addon-dm-tools/docs/IMPORTING.md) and T19 in [the backlog](../BACKLOG.md).

## Context

Import provider API v1 originally accepted only `put` operations. That made
incremental imports safe, but it left no supported recovery path when a newer
schema intentionally superseded invalid records in an addon's collections.
Deleting files or calling the transaction API from a browser console bypassed
the Import Center's review contract and was too easy to apply to the wrong
campaign.

The collection transaction service already supports bounded atomic deletes,
revision conflicts, journaled publication, and crash recovery. The missing
piece was a reviewed import-plan representation for the same operation.

## Decision

Provider API v1 plans may contain `put` and `delete` operations. Both target
only collections declared in the provider's write set and share the existing
per-record duplicate-write, operation-count, plan-size, provider-revision, and
collection-revision checks. A delete carries only `target`, `op`, and `id`;
supplying `value` is rejected.

Commit continues to accept only the opaque preview token. The host applies the
stored operations through the existing addon transaction manager, or through
the campaign journal when a host-owned campaign bundle includes addon
contributions. There is no reset endpoint and no client-authored commit plan.

Adapters that expose destructive plans must label every delete in preview and
require explicit confirmation. Addon-owned document formats decide when delete
intent is valid; the host does not infer replacement from schema mismatch or
an empty input.

## Consequences

- Addons can implement bounded, reviewable replacement and cleanup workflows
  without gaining new collection authority.
- Puts and deletes publish atomically and are invalidated together by any stale
  participating collection revision.
- Existing put-only providers remain compatible without changes.
- Provider authors must distinguish omitted records from explicit delete or
  replacement intent; omission alone does not delete data.
- The existing 256-operation transaction bound includes both puts and deletes.
