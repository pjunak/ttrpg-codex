# Project backlog

This is the only durable backlog for the host and its four companion add-ons.
Implementation contracts describe current behavior; they are not roadmaps.

## Supervised cutover gates

These are operational acceptance tasks, not missing rewrite code:

- Build the Docker image on a Docker-capable machine; Docker is unavailable on
  the development workstation used for the final implementation pass.
- Convert both downloaded v1 UI backups into separate fresh data directories
  and review their reports.
- Deploy one disposable or secondary instance, stage the four reviewed v3
  packages, and complete the acceptance checklist in `SELF_HOSTING.md`.
- Repeat for both websites, retain the old data and backup ZIPs, then make this
  branch the new main branch only after the maintainer accepts the result.

## Platform follow-ups

- Add a DM-facing package Inspector/approval UI over the existing protected
  stage, review, approval, activation, reload, and disable APIs.
- Add coordinated dependent disable and a separately reviewed uninstall/data-
  deletion workflow if routine package removal becomes useful.
- Add migration plan/apply workers when a real released add-on schema change
  requires them; do not build speculative migration machinery.
- Consider a WASI worker target only for a package that benefits from it.
- Add OS-level native worker limits before accepting untrusted third-party
  workers. The current model assumes maintainer-reviewed first-party packages.
- Persist password hashes only if runtime credential rotation becomes a real
  need; current credentials intentionally come from deployment configuration.

## Product candidates

- Reintroduce specialized map, timeline, and relationship visualizations as
  focused v3 add-ons when their desired workflows are clear. The generic core
  record browser remains the fallback and data authority.
- Add richer core field editors only where structured editing materially
  improves the common workflow; preserve unknown fields and JSON portability.
- Add an optional structured 2014 rules-data provider only with authoritative
  content and a real compatibility target.
- Keep combat resolution and encounter automation separate from character
  sheets and DM Tools.

## Explicit non-goals

- Permanent v1 save readers, startup migration branches, or a general legacy
  backup UI.
- Building add-on source in production.
- Hardcoding first-party add-on IDs in host or consumer behavior.
- Silently selecting among ambiguous providers.
- Deleting old saves or branches as part of automated cutover.
