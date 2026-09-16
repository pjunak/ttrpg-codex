# Add-on Platform v3 contracts

This directory contains the machine-readable foundation for the add-on
platform described in [`examples/addons/API_V3.md`](../../../examples/addons/API_V3.md).
The Go host validates package and worker contracts; feature-owned browser
boundaries validate browser models.

## Files

- `ui-controls.d.ts` is the public integrated DOM UI handle and query-event type contract; see [shared UI](../../../docs/rewrite/UI_FOUNDATIONS.md) for markers and tokens.
- `manifest.schema.json` validates the declarative package manifest.
- `checksums.schema.json` validates the complete SHA-256 file inventory.
- `protocol.schema.json` validates individual JSON-RPC worker messages after
  frame decoding.
- `service-document.schema.json` validates the method catalog referenced by a
  provided service declaration.
- `graph-model.schema.json` describes Mind Palace provider responses. The
  browser also checks total bytes, unique IDs, references, and active routes.
- `wiki-links.schema.json` describes reference resolution, legacy bookmarks,
  and library search. The browser also checks response bytes, request-relative
  indices and same-generation, role-visible route targets.
- `examples/reference-addon.json` exercises the main manifest features.
- `examples/import-adapter.service.json` shows a package-owned service
  document.

UI entry modules (`.js` or `.mjs`) and styles (`.css`) are restricted to the
package `web/` subtree. This matches the host's browser asset boundary and
keeps worker, contract, content, locale, and metadata files outside browser
delivery. Isolated entry modules are transferred into an opaque frame and must
be self-contained; integrated modules may use additional immutable files from
the same generation's `web/` subtree.

All schemas use JSON Schema Draft 2020-12. They are source artifacts, not
generated copies. Runtime validation and public schema changes must stay
synchronized; a schema alone does not enforce ownership or authorization.

## Validation layers

JSON Schema validation is necessary but not sufficient. Package inspection
must also enforce constraints that depend on the archive, installed host, or
other packages:

1. archive path normalization, collision, symlink, and size limits;
2. file existence, hashes, executable target, and offline compilation of every
   declared content, collection, extension, service document, and service
   method schema;
3. host/Add-on API/protocol semantic-version compatibility;
4. unique stable IDs across contributions, collections, content, and services;
5. capability availability and structured permission definitions;
6. dependency and service graph resolution, including cycles and exclusivity;
7. operator approval of authority and binding changes.

No package code runs during these checks.

`services.provides[].schema` names a service document, not a payload JSON
Schema. The document repeats the contract ID and exact version, declares
whether exclusivity is permitted, and owns the complete method registry. Each
method points to package-relative request and response schemas and declares a
maximum deadline, idempotency-key policy, and stable application error kinds.
The host rejects external schema references; references resolve only among the
package's inspected `contracts/**/*.json` resources.

`checksums.json` lists every regular package file except itself. Directory
entries are not listed. Paths use the exact normalized archive spelling, and
every digest is lowercase SHA-256. An omitted, additional, or mismatched file
rejects the whole package.

## Versioning

Package format, Add-on API, worker protocol, service contracts, and collection
schemas have independent versions. Changing this manifest schema in a way that
invalidates an otherwise valid manifest requires a package-format or Add-on API
major-version decision. Adding an optional field does not.

Protocol framing is outside `protocol.schema.json`. A message is accepted only
after its `Content-Length` frame, UTF-8 bytes, JSON syntax, envelope, negotiated
method, metadata, and method-specific params/result schema all validate.
The shared Go framing and envelope implementation lives in
[`sdk/go/workerrpc`](../../../sdk/go/workerrpc); host supervisor policy remains
internal to the host.

## Extension rule

Schemas are strict by default. Experimental metadata belongs under the
top-level `extensions` object using a reverse-domain or similarly collision-
resistant key. An extension cannot grant authority, weaken validation, or
silently become a required core behavior.
