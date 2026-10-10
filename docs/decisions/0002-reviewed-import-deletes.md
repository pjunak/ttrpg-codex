# ADR-0002: Reviewed import deletes

**Status:** Accepted

**Date:** 2026-08-27

**Decider:** Project maintainer

## Context

An import that can only create and update records can add to a dataset but
cannot replace it: records that a newer document intentionally drops would
linger, and invalid stored records would have no supported cleanup path.
Deleting them by hand bypasses the Import Center's review and is easy to apply
to the wrong campaign.

## Decision

A reviewed import plan may contain both put and delete mutations. Both target
only collections the provider declares for its own add-on and share the same
duplicate-target, operation-count, plan-size and revision checks. A delete
names only its collection and key; it carries no value.

The provider retains the exact plan behind the preview token. Commit accepts
only that token and applies the retained mutations in one host SQLite
transaction (together with the core records when the plan is part of a
[campaign bundle](0001-campaign-bundle-imports.md)). There is no reset endpoint
and no client-authored commit plan.

Providers that produce deletes must count and label them in the preview and
require explicit confirmation. The document format decides when delete intent
is valid: omission alone deletes nothing unless the format declares a complete
replacement, as DM Tools' `replace` mode does. The host never infers deletion
from a schema mismatch or an empty input.

## Consequences

- Add-ons can offer bounded, reviewable replacement and cleanup without
  gaining new collection authority.
- Puts and deletes publish atomically and any stale participating revision
  invalidates them together.
- The 256-operation transaction bound counts puts and deletes alike.
- Provider authors must distinguish omitted records from explicit delete or
  replacement intent.

See [planning imports](../../../addon-dm-tools/docs/IMPORTING.md) for the
DM Tools behaviour.
