# ADR-0001: Host-owned campaign bundle imports

**Status:** Accepted  
**Date:** 2026-07-28  
**Decider:** Project maintainer

## Context

The reviewed content-import framework currently accepts deterministic plans
from server addons, but provider API v1 deliberately permits only reads from
granted core collections and writes to the provider addon's own collections.
That boundary prevents an addon from using an import provider as indirect
authority over campaign data.

Campaign packages generated outside the application need to create related
characters, locations, map placements, and relationships without knowing the
host's final persistent IDs. Some packages also contain addon-owned planning
records that refer to those newly created core records. Applying the core and
addon portions independently can leave incomplete references and makes retry
reconciliation manual.

The host already has the required durability primitives: a bounded core write
lock, a reader/writer publication barrier, durable staged-file journals,
rollback, startup recovery, snapshots, role-scoped hashes, and coherent SSE
notifications. Core compound mutations also exist, but their current service
methods combine planning with publication and therefore cannot expose derived
writes during preview.

## Decision

The host will own a built-in `core/campaign-bundle` import provider. It will
reuse the existing import job lifecycle for strict parsing, owner-bound
previews, at-most-once commit tokens, expiry, revision conflicts, and
ambiguous-response recovery. Host providers register through a private
internal path; addon provider API v1 remains unchanged and cannot request core
write authority.

Campaign bundle schema version 1 is deliberately narrow:

- JSON input no larger than 2 MiB;
- at most 128 logical input records and 256 materialized writes;
- create operations for `characters`, `locations`, and `relationships`;
- explicit visibility on every record;
- typed references only at fields declared by the owning core schema;
- preview-time reservation of final persistent IDs;
- no deletes, media, settings, authentication, backups, twins, events,
  mysteries, artifacts, or updates.

Core normalization and compound mutation behavior will be extracted into pure
server-owned planners. The same planners will become the compatibility target
for ordinary interactive saves. Preview stores direct and derived writes,
reference-to-ID mappings, and DM/player projections in the exact server-held
plan.

Core-only publication will use the existing campaign staged-file publisher.
Unified core/addon publication will use a host-owned bundle publication
service over the same journal and publication barrier. It will resolve an
explicit allowlist of core and enabled addon collection paths; it will not
relax the addon transaction manager, whose recovery journal is intentionally
bound to one addon's data directory.

Addons may optionally register a restricted bundle contributor. Contributors
run only during preview, outside the write lock, against cloned candidate
snapshots and a typed reference resolver. They return operations only for
their declared collections. Commit never reruns contributor code.

## Options considered

### Grant DM Tools core collection writes

| Dimension | Assessment |
|---|---|
| Complexity | Low initially |
| Security | Poor |
| Compatibility | Couples core authority to one optional addon |
| Maintenance | Creates a second core mutation API |

Rejected because the host would no longer be the sole authority for core
validation and derived mutations.

### Extend addon transaction journals to arbitrary core paths

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Security | Requires a new authority model in a public addon API |
| Durability | Requires a journal schema and recovery migration |
| Maintenance | Conflates addon-owned and host-owned transactions |

Rejected for version 1. The existing addon journal reconstructs targets from
`addonId` and collection name; widening it would add risk without improving the
public addon transaction use case.

### Host-owned provider and scoped staged-file publication

| Dimension | Assessment |
|---|---|
| Complexity | Medium to high |
| Security | Preserves current addon authority |
| Durability | Reuses proven host primitives |
| Maintenance | Keeps one canonical core planning path |

Accepted.

## Consequences

- External generators can create portable reference graphs without inventing
  persistent IDs.
- Preview remains read-only and commit publishes the exact reviewed plan.
- Existing DM Tools planning imports remain compatible.
- Core record validation becomes server-authoritative instead of relying on
  browser forms.
- Import plans distinguish logical inputs from materialized and derived
  writes.
- A crash after the durable commit point may recover to the complete new
  state. The guarantee is old-or-new atomicity, never forced rollback after
  every failure.
- Preview tokens remain consumed before a commit attempt. A lost response is
  resolved by querying the owner-bound job rather than replaying the token.
- Free-text secret detection is not a structural invariant. Review instead
  includes the resulting player projection so the DM can inspect prose.
- Version 1 pin placement is review-only. Moving a pin requires editing the
  source and creating a new preview.
