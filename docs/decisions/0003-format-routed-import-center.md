# ADR-0003: Format-routed Import Center

**Status:** Accepted

**Date:** 2026-08-27

**Decider:** Project maintainer

## Context

Several import providers accept JSON, and file extensions or MIME types cannot
tell their documents apart. If each provider had its own file input, the
section the user happened to pick would decide the validator, and a document
sent to the wrong provider would produce accurate but misleading diagnostics.

DM Tools composes the Import Center but must discover providers without
hard-coding add-on IDs or copying their schemas. Each provider keeps authority
over parsing, preview, review and commit.

## Decision

Every JSON import document carries a root `format` string. Providers of
`codex.import-adapter` v2 list the exact formats they accept in `describe`.
DM Tools renders one file chooser, reads only the root `format`, and sends the
document to the single provider claiming it through `preview` and `commit`.

The center rejects malformed JSON, a missing or unknown `format`, or a format
claimed by more than one provider before any provider work starts. It does not
inspect `schemaVersion` or other format-specific fields; the provider remains
the authoritative parser and validator.

## Consequences

- The Import Center has exactly one file chooser regardless of provider count.
- A document cannot reach a provider that does not claim its `format`.
- Format strings are public, stable document identities. Two enabled providers
  claiming the same string block that import instead of resolving by load order.
- Non-JSON import documents need a future contract version with its own routing.

## Alternatives considered

- **One file input per provider:** rejected; the visible section would choose
  the validator.
- **Teach DM Tools every schema:** rejected; it would need known add-on IDs and
  duplicate the providers' validation.
