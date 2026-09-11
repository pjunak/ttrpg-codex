# Retained add-on record history

A record extension can opt into `retained: true`. Its manifest must declare a
native worker and required `data.history` capability. Browser reads still obey
the core record's access policy; generic browser writes to retained extensions
are forbidden. Only a host-authenticated worker invocation can submit a recorded
transaction. Workers receive the requesting actor's authority, not system or DM
authority inferred from a browser payload.

The Go SDK supplies `AddonDataClient.TransactRecorded`, `History` and `Revision`.
Recorded transactions add `operationId`, `operation` and `summary` to the ordinary
transaction request, alongside optimistic mutations. The host atomically stores
the immutable snapshot, audit attribution, operation receipt and head update.
An exact retry returns its receipt; reusing an operation ID for different input
fails. A failed append does not advance the head.

`host/data.history` uses `host-data-history.v1`, a record-extension reference,
character key and a limit from 1 to 100. Entries are descending by revision;
`before` is exclusive and `nextBefore` continues the page. An exact `revision`
requires limit 1 and no `before`; only exact reads include the saved value.
Responses use `host-data-history-result.v1`. Each entry carries its revision,
actor, timestamp, operation identity/type/summary and generation. The preceding
retained entry identifies the prior head within that character's lifetime.

History belongs to the original core record's creation lifetime. Deleting and
recreating the same key cannot expose the earlier character's revisions. Current
core visibility applies to every read, including exact historical reads. Add-on
removal retains stored history. There is no public history deletion or rewrite
operation.

Immutable JSON payloads use content hashes and structural sharing of top-level
values. This keeps growing history outside the per-document size limit and
avoids repeating unchanged projections and evidence. Indexed character/revision
queries do not scan unrelated records. Current backups include all reachable
history payloads; fresh-directory restore preserves them. Campaign recovery
appends a new head instead of moving a retained head backward.

See [add-on data](ADDON_DATA.md), [backup and restore](BACKUP_RESTORE.md), and the
[retired-sheet cutover](CHARACTER_SHEET_CUTOVER.md). The latter refuses any
namespace containing current retained history. Tests cover authority, immutable
snapshots, retries, stale heads, core lifetime isolation, campaign recovery and
backup reconstruction.
