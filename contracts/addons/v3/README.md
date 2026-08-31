# Add-on Platform v3 contracts

This directory contains the machine-readable foundation for the target add-on
platform described in [`examples/addons/API_V3.md`](../../../examples/addons/API_V3.md).
It is a design contract on `rewrite/go-typescript`; the current Node.js host
does not load it yet.

## Files

- `manifest.schema.json` validates the declarative package manifest.
- `checksums.schema.json` validates the complete SHA-256 file inventory.
- `protocol.schema.json` validates individual JSON-RPC worker messages after
  frame decoding.
- `examples/reference-addon.json` exercises the main manifest features.

All schemas use JSON Schema Draft 2020-12. They are source artifacts, not
generated copies. Go and TypeScript types will be generated from reviewed
boundary schemas once the rewrite toolchain is established.

## Validation layers

JSON Schema validation is necessary but not sufficient. Package inspection
must also enforce constraints that depend on the archive, installed host, or
other packages:

1. archive path normalization, collision, symlink, and size limits;
2. file existence, hashes, executable target, and offline compilation of every
   declared content, collection, extension, and provided-service schema;
3. host/Add-on API/protocol semantic-version compatibility;
4. unique stable IDs across contributions, collections, content, and services;
5. capability availability and structured permission definitions;
6. dependency and service graph resolution, including cycles and exclusivity;
7. operator approval of authority and binding changes.

No package code runs during these checks.

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
