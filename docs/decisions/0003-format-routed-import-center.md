# ADR-0003: Format-routed Import Center

**Status:** Accepted

**Date:** 2026-08-27

**Decider:** Project maintainer

**Implementation status, September 14, 2026:** Format-based routing remains current, but v3 uses serializable import-adapter v2 service methods, not the old 1.1 open(File) object contract below. See [current planning imports](../../../addon-dm-tools/docs/IMPORTING.md).

## Context

The first Import Center composed every compatible adapter as a complete
vertical workflow. Each adapter therefore rendered its own file input. The
planning and campaign-bundle adapters both accept JSON, so choosing a planning
document in the campaign-bundle section sent it to the wrong server provider.
The resulting schema diagnostics were accurate for that provider but
misleading for the user. The page also had more than one visual entry point
for the same action.

DM Tools must discover import owners without hardcoding addon ids or copying
their schemas. Content owners must retain authority over strict parsing,
preview, review, actions, and commit.

## Decision

`codex.import-adapter` version 1.1 uses a shared JSON envelope discriminator.
Every adapter descriptor declares one or more exact top-level `format` strings,
and every adapter implements `open(file)`. DM Tools renders one file chooser,
parses only enough JSON to read the root `format`, and passes the original
browser `File` to the single matching adapter.

The center rejects malformed JSON, a missing discriminator, an unknown format,
or multiple claims for one format before any provider job starts. After a
successful match, only the owning workflow is rendered. The route shows the
document-to-owner decision and provides one way back to the shared chooser.
Its breadcrumb uses the same `DM tools › current page` host helper as Story
Planner.

The center does not inspect `schemaVersion` or any format-specific field. The
owner still submits the untouched file through its scoped import client, and
the server remains the authoritative parser and validator. Duplicate-key,
UTF-8, size, depth, schema, revision, and plan validation therefore remain in
the existing provider boundary.

## Options considered

### Keep one file input per adapter

Rejected because file extensions and MIME types cannot distinguish two JSON
contracts. The visible section would continue to determine the validator and
make wrong-owner diagnostics possible.

### Teach DM Tools every supported schema

Rejected because the composing addon would need known addon ids and would
duplicate content-owner validation. New formats would require central changes.

### Route by a shared discriminator, then delegate

Accepted because routing needs only stable identity metadata. Discovery stays
open-ended, while validation and mutation authority remain with the owner.

## Consequences

- The Import Center has exactly one file browser regardless of adapter count.
- JSON documents cannot reach a provider that does not claim their `format`.
- New adapters must publish service version 1.1, declare `formats`, and
  implement `open(file)`.
- Format strings are public, stable document identities. Two enabled adapters
  claiming the same string block that import instead of resolving by load
  order.
- Version 1.0 adapters are intentionally incompatible with the unified center;
  they must adopt the routing contract before appearing.
- Non-JSON import documents require a future contract version with an explicit
  routing mechanism.
