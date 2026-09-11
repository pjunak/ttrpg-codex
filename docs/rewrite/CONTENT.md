# Immutable add-on content

Package content is reviewed, read-only reference data such as rules, spells,
items, and classes. It is separate from campaign and add-on data: packages own
its files and schema, while user choices, overlays, and campaign state remain
in durable host storage.

## Inspection and ownership

Every `content[]` declaration names a stable set ID, package root, JSON Schema,
and revision. Optional `groups` metadata describes a source field and label
without changing any records. During package inspection the host:

1. compiles the declared schema without executing package code;
2. reads JSON records only below the declared content root;
3. validates every record and requires bounded string `kind` and `id` fields;
4. rejects duplicate `(kind, id)` identities, empty sets, records over 2 MiB,
   and sets over 100,000 records;
5. builds an immutable index owned by the inspected archive generation.

Activation, reload, and startup recovery select that index together with the
same exact package generation used by the browser and worker runtimes. A stale
generation cannot read a replacement package's content. Returned descriptions
and records are copies, so callers cannot mutate the host index.

## Browser contract

Authenticated integrated and isolated add-ons receive the same
generation-scoped `context.content` API:

```ts
const catalog = await context.content.catalog({ signal: context.signal });
const rules = context.content.set<RuleRecord>("rules");
const shield = await rules.get("spell", "shield", {
  signal: context.signal,
});
const spells = await rules.query({
  kind: "spell",
  limit: 50,
  signal: context.signal,
});
```

Catalog, exact-record, and query responses echo the add-on and archive-hash
generation and use strict versioned envelopes. Queries are sorted by
`(kind, id)`, return at most 200 records, and stop before their record values
exceed 4 MiB. Opaque cursors resume after the last returned stable position.
Cursors bind the effective revision, set and query kind. Content responses use
`private, no-store`: source eligibility can change at the same archive URL.

The isolated iframe has no network authority or credentials. Its private JSON
bridge forwards `content.catalog`, `content.get`, and `content.query` to the
same host-owned client, enforces request and response limits, propagates
cancellation, and exposes only safe HTTP status classes.

## Effective source policy

The host's [instance rules and source policy](RULES_SOURCES.md) filters the same
immutable index for browsing and service consumers. Declared source membership
supports alternate allowed books; `groups.catalogKind` supplies book labels.
Selection changes create an effective revision and allow empty filtered sets.
Archive files and authored character records remain unchanged.

An add-on may publish the same immutable index through a `content` service
transport. The host supplies fixed `catalog`, `get`, and `query` methods and
routes them through the normal service broker, including contract selection,
generation checks, deadlines, idempotency policy, and package-owned request and
response schemas. Consumers depend on the service contract, never the provider
add-on ID or package layout.
