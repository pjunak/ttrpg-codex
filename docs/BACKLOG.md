# Project backlog

This is the single durable backlog for `ttrpg-codex` and its companion addons:
`dnd-character-sheets`, `dnd55e-compendium`, and `dm-tools`.

Repository reference documents describe current behavior and deliberate
boundaries; they are not secondary roadmaps. Temporary implementation plans
belong only in the gitignored `docs/plans/` directory and must be deleted when
their task closes. Do not create separate `TODO.md`, `ROADMAP.md`, or planning
lists in source files or companion repositories.

There are currently no known release blockers.

## Maintainability

### Incrementally reduce the remaining large host modules

`server.js`, `web/js/store.js`, `web/js/settings.js`, and
`web/js/editmode.js` still combine several domains. Extract one cohesive
responsibility at a time when related behavior is next changed, preserving
public module APIs and adding focused tests before moving code. Avoid a
wholesale rewrite or splitting files solely by line count.

The similar built-in entity editors should converge on shared form and
mutation primitives after their owning controller boundaries are clear.
Consumer-specific fields and validation should remain explicit rather than
being forced through an abstraction that obscures behavior.

### Reassess the `brace-expansion` override

The dependency tree currently resolves the patched `brace-expansion@5.0.8`
through `minimatch@10.2.5`. Remove the explicit override only after a clean
install proves the upstream production dependency chain selects a patched
release without it.

## Conditional hardening

These are not priorities under the current trusted, maintainer-reviewed addon
model. Promote them before accepting untrusted third-party addons:

- Scope action dispatch inside addon-owned DOM so addon markup cannot invoke
  core `data-action` handlers, including deferred-action indirection.
- Revisit process isolation for server addon code. The current permission
  facade prevents mistakes and constrains host APIs but is not an OS sandbox.

## Decisions requiring the maintainer

- **Password hashing:** migrate stored password hashes to `crypto.scrypt`.
  This needs a versioned hash migration and invalidates existing sessions.
- **Content Security Policy:** enable a restrictive external-script policy.
  Inline style attributes still require a separate style-policy decision.

## Product candidates

- Per-map-view marker visibility rules.
- Bulk ZIP upload for marker icon variants.
- Per-location marker icon override.
- Strength presets in the attitude editor.
- Segmented multi-attitude presentation for wiki portraits and cards. The
  existing vertical marker segmentation is the reference; radial wedges are
  an alternative design, not a separate backlog item.

## D&D addon suite

- Add an optional structured 2014 ruleset provider when authoritative content
  and a real compatibility test target are available.
- Treat combat resolution and encounter automation as a separate addon rather
  than expanding character sheets into a combat engine.
- Structure narrative mechanics only when a concrete consumer needs them.
  Effects targeting other creatures, attacks, saves, areas, encounter timing,
  renown workflows, and similar rules may remain reference prose until then.
- Keep combat resolution, homebrew rule automation, and detailed retrospective
  session bookkeeping outside DM Tools. Its story canvas should grow only
  through concrete planning/world-building workflows and stored relationships,
  never inferred edges or automatic quest progress.

## Explicit non-goals

- Offline/local play and vendoring the SRI-pinned browser libraries.
- Duplicating content records to model reprints; canonical provenance plus
  `availableIn` membership remains the sourcebook-toggle contract.
- Keeping completed implementation plans or historical task ledgers in the
  repository.
