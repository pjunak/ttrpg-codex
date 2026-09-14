# Add-on package lifecycle

The package lifecycle connects verified v3 packages to durable generation state, the
service broker, native worker supervision, and an authorization-gated HTTP
application boundary. The executable registers the administrative routes with
the real-DM and CSRF authorizer. Settings → Add-ons exposes ZIP inspection,
permission/change review, activation, update, rollback, reload, disable,
uninstall, and recent lifecycle diagnostics in English and Czech. **Add add-on**
opens a modal source wizard; ZIP uploads and GitHub downloads continue into the
same permission review. **Check for updates** refreshes inventory and lists
results on the installed add-on cards. Source settings live on each card, and
shared token management stays in a collapsed section. Disabling preserves package generations and campaign data.

`GET /api/admin/addons` returns `addon-inventory.v1` with sorted `addonIds`,
including staged-only and disabled packages. The manager loads each package's
snapshot, then reviews an exact generation before granting permissions and
activating that review. Required grants are explicit checkboxes. Stale reviews
or uncertain responses discard the browser's review; refresh reads current
state before a new review. The server remains authoritative for every action.
Installed desktop/phone browser checks cover the complete workflow, invalid
ZIPs, concurrent state changes, lost responses, persistence and player denial.

The same settings destination exposes [instance rules, sourcebook choices and
service providers](RULES_SOURCES.md). Activation reviews include ruleset
declarations, initially disabled books and the instance configuration revision.
Incompatible sources are blocked before activation. Source and binding changes
use reviewed revision checks and cold graph recovery; accepted configuration
and restart failures remain separately visible. Migration
`0014_addon_instance_configuration.sql` adds settings metadata without changing
campaign records or character extensions.

## GitHub package sources

Settings → Add-ons also installs and updates prebuilt packages from GitHub.
The manager accepts a repository URL or `owner/repository`, links existing
ZIP-installed add-ons, and checks each linked repository independently. A
failed repository check leaves the other results available. GitHub downloads
enter the same inert staging and exact permission-review flow as ZIP uploads;
they never activate automatically or compile repository source.

Two sources are supported:

- **Latest stable release:** list uploaded ZIP assets from GitHub's latest
  non-draft, non-prerelease release. The operator selects the package when
  several ZIPs exist. GitHub's generated source archives are not packages.
- **GitHub Actions build:** follow a chosen branch (blank uses the repository's
  current default) and named artifact (default `reviewed-package`). Inspect the
  latest 30 successful runs, at most 10 eligible push/manual runs, and the first
  100 artifacts per run. Only completed successful runs from that repository
  and branch qualify; pull-request and fork builds do not. The first matching
  unexpired artifact must contain exactly one prebuilt package ZIP. Build
  failures do not replace the last successful package.

Checks only read GitHub metadata. Download requests re-resolve the source and
require the selected asset/artifact identity, digest and update timestamp to
remain unchanged. Available GitHub SHA-256 digests are verified on download.
The package inspector validates every package; updating a linked add-on also
requires its manifest ID to match before staging. Outbound requests use fixed
GitHub API paths, bounded metadata/download sizes and deadlines, and a narrow
HTTPS download redirect allowlist. Authorization headers are removed on every
redirect. Upstream errors and signed URLs are not returned or logged.

Migration `0013_addon_github_sources.sql` records repository configurations
and generation provenance in campaign SQLite. A source edit/unlink uses an
optimistic revision; unlinks retain a revision tombstone. Update status compares
the remote candidate with the **active** generation's provenance, so an
unapproved download or rollback cannot falsely mark the add-on current. A
ZIP-installed generation has no GitHub provenance until its matching remote
package is downloaded and inspected. Unlinking preserves installed versions
and campaign data.

GitHub tokens live in a separate `credentials/github.db` SQLite database under
the data directory, outside the campaign backup/recovery allowlist. The UI can
set, replace or remove a default token and exact lowercase repository tokens.
Lookup order is exact repository, stored default, `CODEX_GITHUB_TOKEN`, then
`GITHUB_TOKEN`. Responses expose configuration/source and repository names only.
Token inputs are cleared on submission, including uncertain responses; refresh
reads configured state before an explicit retry. Environment tokens are changed
through server configuration. Credentials are not imported from v1 or restored
with campaign backups.

All routes require real and effective DM authority; POST also requires CSRF:

| Method and path | Operation |
|---|---|
| `GET /api/admin/addon-github` | Read `addon-github.v1` sources and credential status |
| `POST /api/admin/addon-github/token` | Save/remove `{repo, token}`; empty repo selects the default |
| `POST /api/admin/addon-github/source` | Save/unlink `{addonId, source, revision, remove}` |
| `POST /api/admin/addon-github/discover` | Resolve `{source, addonId}` to bounded package candidates |
| `POST /api/admin/addon-github/stage` | Download/inspect `{source, addonId, candidateId}`; return the inert generation |

`source` contains `repo`, `channel` (`release` or `actions`), `branch` and
`artifact`. An empty `addonId` discovers a new installation. Public errors use
safe `GITHUB_*` categories. GitHub request contexts are capped at 90 seconds;
only these endpoints extend the ordinary HTTP write deadline.

Regression coverage: `internal/addons/githubsource` tests credential fallback,
replacement, restart persistence, backup exclusion, real reviewed lifecycle,
stale candidates/sources, identity checks, rollback, Actions selection, digest
checks, archive bounds and redirect secrecy. HTTP tests cover authorization,
CSRF, body limits and redaction. `frontend/test/addon-github.test.ts` verifies
wire validation and error categories; `addon-github.browser.mts` exercises
desktop/phone ZIP and GitHub installation through the popup wizard, modal focus
and cancellation, source-edit invalidation, private-token guidance and replacement,
lost responses without secret replay, per-add-on updates, reload and Czech labels
with synthetic GitHub responses. The installed-package fixtures exercise the
same wizard and review against the actual host lifecycle. Actual account access
and production network connectivity remain operator integration checks.

## State ownership

| State | Owner | Durable |
|---|---|---|
| Package archive and extracted generation | Host package directory | Yes |
| Installed generations, reviews, active pointer, grants, revision, events | SQLite | Yes |
| Provider declarations and operator bindings | Service broker store | Yes |
| Add-on documents, tombstones, schema identity, and audit rows | Add-on data store | Yes |
| Worker processes, callable providers, resolved service handles | Package manager and broker memory | No |
| Active generation schema registries | Add-on data service | No |

The archive SHA-256 is the generation ID. One installed generation lives at:

```text
<package-dir>/<addon-id>/generations/<archive-sha256>/
  package.zip
  root/
```

The host copies an input archive into a private staging directory, inspects it,
verifies its complete checksum inventory, and extracts only regular files. A
rename publishes the generation directory. Staging is idempotent and creates
no grant, provider, worker, or active-generation authority.

Every activation and recovery reopens the content-addressed archive and
revalidates the extracted tree against it. Missing, changed, linked, special,
or injected files fail closed before execution. This guards accidental or
same-account package-directory drift; a native worker is still crash isolation,
not an operating-system security sandbox.

## Reviewed activation contract

The package manager now exposes a three-step application contract:

1. `PrepareActivationReview` stores an exact manifest comparison and blockers.
2. `ApproveActivationReview` validates and records the complete grant set.
3. `ActivateReviewed` revalidates the proposal and consumes it during switch.

The stored proposal includes both manifests, current and target generations,
the expected state revision, retained and required permissions, directly
affected add-ons, the complete restart set, blockers, and stable
added/changed/removed summaries for runtime, capabilities, contributions,
dependencies, services, collections, record extensions, content, and locales.
It also includes blockers from the durable add-on data owner when a removed or
changed declaration still has campaign state. The full proposal is SHA-256
hashed. See [`ADDON_DATA.md`](ADDON_DATA.md).

Approval hashes that proposal together with the normalized grant set. A
package, state, dependency, service, recovery, or dependent-set change makes
the review stale or blocked; client input cannot silently revise an existing
approval.

The resulting `ActivationPlan` identifies all authority consumed by one activation:

- exact add-on ID and archive-hash generation;
- expected durable state revision;
- complete set of granted permission IDs.

The manager rejects stale revisions, unrequested grants, missing required
grants, unsupported required capabilities, incompatible host/API/worker
versions, inactive identity dependencies, and unresolved required services.
It passes only the normalized grants and generation-bound service handles to
the new worker.

The active-generation update and transition from `approved` to `consumed`
share one SQLite transaction. A crash therefore cannot leave activated code
with a reusable approval. Direct activation remains an internal test and
coordinator primitive; administrative transports use review IDs.

## Switch and failure ordering

For an activation, update, or rollback the manager performs:

1. Revalidate the package and exact extracted generation.
2. Check compatibility, dependencies, grants, and service resolution.
3. Create and fully start the new worker while the previous runtime remains
   callable.
4. Publish the new provider catalog and exact generation caller.
5. Quiesce that add-on's data calls under a reversible generation transition.
6. Commit the active-generation pointer, grants, revision, and lifecycle event
   in one SQLite transaction, then select the new immutable schema registry.
7. Make the new runtime manager-owned, then stop the previous runtime.

If worker start, catalog publication, or the durable commit fails, new routing
is withdrawn, the previous catalog/runtime is restored, the new worker is
stopped, and the durable active pointer is unchanged. A failure to stop the old
worker after a successful switch is diagnostic cleanup failure; generation-
exact broker teardown prevents it from withdrawing the replacement.

Rollback deliberately uses the same path as forward activation. It never
changes a filesystem pointer or starts an older generation without current
compatibility, grant, dependency, service, and content checks.

Provider generation changes make existing consumer handles stale by design.
Direct internal activation therefore refuses changes when a live add-on has
an identity dependency, resolved service handle, or compatible consumer
declaration for the target. Reviewed activation uses the cold cohort below instead of attempting a
partial live upgrade.

## Coordinated cold activation

This personal deployment values a small, legible recovery model over seamless
add-on availability. When a reviewed provider change affects a live consumer,
the proposal records both the direct dependents and every active add-on that
will restart. Required dependents are checked against the target add-on
version and service-contract ranges before approval; incompatible targets are
hard blockers.

This also covers first installation and reactivation of an optional provider.
Consumers that started without a matching service handle must restart to use
the newly available provider. The review includes compatible declarations as
well as existing handles, so installation order cannot leave workers stuck in
their provider-free fallback. Disabling still requires stopping consumers
before their provider; campaign records and installed packages are retained.

After approval, the manager:

1. withdraws routing and stops the complete add-on graph, consumers first;
2. atomically changes only the reviewed target generation, grants, state
   revision, event, and review status;
3. invokes the normal recovery algorithm, which republishes catalogs and
   starts providers before consumers with new generation-bound handles.

Unrelated add-ons also restart. With the suite's small fixed add-on count this
is intentionally simpler than maintaining a shadow provider catalog and two
simultaneous runtime graphs. Core HTTP and campaign storage remain outside the
cohort, so add-on downtime cannot partially commit campaign files.

If recovery fails after the durable switch, the activation result reports a
per-add-on recovery outcome and leaves the exact reviewed generation selected.
The operator may fix the package and restart the host; startup recovery uses
the same state and never silently falls back. A process crash after the commit
has the same recovery behavior. This choice should be revisited only if add-on
count, restart cost, or availability requirements materially increase.

## Restart recovery

The durable active generation is the only recovery authority. Startup never
falls back to another installed generation automatically.

Recovery first validates every selected package and republishes durable
provider catalogs without claiming that a process is live. It then repeatedly
starts candidates whose required identity dependencies and service providers
are already live. This yields provider-before-consumer order without depending
on add-on IDs. Available optional dependencies are preferred before consumers;
if they fail or form only an optional cycle, recovery proceeds with the
consumer's declared standalone behavior. Cycles, missing required providers,
corrupt generations, invalid grants, or startup failures remain failed with
lifecycle diagnostics.

Normal shutdown reverses the live dependency graph: consumers lose routing and
stop before providers. Durable active pointers remain intact for the next
recovery.

## Reload and disable

Reload revalidates the exact active archive and extracted tree, resolves its
current dependencies, grants, and service bindings, then starts a replacement
runtime. It swaps only the live caller against the existing provider catalog;
the add-on generation and catalog revisions do not change, so already-issued
consumer handles remain valid. The state revision and `reloaded` event still
advance, invalidating any review prepared against the older operational state.

Disable deactivates generation routing before clearing the durable active
pointer. Installed generations, provider declarations, bindings, grants, and
add-on data remain preserved. A failed or unrecovered generation can therefore
be disabled without starting its code. Live dependents block disable until a
coordinated transition is available. Successful disable increments the state
revision, records `disabled`, and then performs bounded worker cleanup.

## Reviewed uninstall

Settings → Add-ons offers **Uninstall** for active, disabled, failed and
staged-only packages. The review names the package, retained data namespaces
and current record counts, affected consumers, running add-ons that will stop,
the GitHub update link, and any retained instance ruleset. The final action is
**Uninstall and keep data**; cancellation has no lifecycle side effects.

The review fingerprint binds the package state, installed generations,
configuration and graph revisions, source-link revision and dependency effects.
The server recomputes it before confirmation. Concurrent staging, activation,
binding/source changes or reloads require a fresh review. This uses the
[check answers pattern](https://design-system.service.gov.uk/patterns/check-answers/)
and descriptive action labels from the [button guidance](https://design-system.service.gov.uk/components/button/).
There is no permanent-delete checkbox or extra typed-name hurdle in this
reversible, data-preserving operation.

The dependency preview uses normal broker resolution with removed providers
excluded. Required dependencies and newly unresolved required services disable
their consumers transitively. A required service that still resolves keeps its
consumer enabled. Optional consumers reconnect or keep their standalone
fallback; explicit unavailable provider selections remain visible as stale.
The review lists all live add-ons affected by the shared cold restart.

Confirmation stops consumers before providers, then atomically clears target
activation/grants, disables the reviewed dependents, retires provider
declarations, unlinks the GitHub update source, records `uninstalled`, and
advances the configuration revision. Remaining eligible add-ons recover in
provider-first order. A failed database write rolls back unregistration and
recovers the previous graph. A recovery failure after commit leaves removal
accepted and reports the remaining failures. Once confirmed, a bounded
transition continues if the browser disconnects. Retrying the same fingerprint
while the package remains removed acknowledges completion without removing
anything again.

An in-progress GitHub update is bound to the installation revision captured
before its download. Completion after uninstall cannot restage the package or
recreate its update link; a fresh explicit install is required.

The package disappears from inventory, settings and browser contributions;
generation asset/data access and activation are unavailable. Its sourcebook
choices, service bindings, authored documents, revision tombstones, recovery
points and immutable generation archives remain stored. Repository tokens are
shared credential settings and remain unchanged. Removing the defining rules
package preserves the instance ruleset; replacement still requires the same
ruleset and contract.

Migration `0015_addon_uninstall.sql` records removal separately from recovery
artifacts. Restaging a validated ZIP clears removal and advances state, but
does not activate it or restore permission grants. Normal activation review
validates retained records and schemas. Incompatible retained data blocks
activation; no converter or legacy handler is introduced. Retained generation
history remains available after reinstall, subject to the same review.
If a retired generation is corrupt, a validated ZIP with the same fingerprint
can repair it. The old directory is preserved under the package's `retired/`
area before replacement; active installations are never repaired in place.

Uninstall does not free archive storage or purge campaign data. Permanent data
deletion remains a separate contract. Saved archives can be removed through
the reviewed package cleanup below, including recovery-reference eligibility. Full backups retain uninstall state;
campaign recovery does not rewind package lifecycle authority.

Regression coverage includes package-manager uninstall tests, normal broker
resolution, transaction rollback, corrupt/unrecovered packages, transitive
dependencies and retained ruleset identity. Desktop/phone installed fixtures
exercise English/Czech review, cancellation, conflicts, lost-response retries,
DM/CSRF boundaries, revoked access, retained records and incompatible reinstall.

## Reviewed saved package cleanup

Settings → Add-ons → **Clean up saved packages** reviews the complete saved
inventory, including archives of uninstalled add-ons. Each inactive package also
has **Remove saved package** for a review of that exact generation. Only a real
and effective DM with CSRF authority can review, apply or retry cleanup.

A count selection retains zero to five additional inactive packages per add-on,
newest installation first (generation hash breaks timestamp ties). Active
packages, every generation named by a campaign recovery point, and the newest
package of a still-installed but disabled add-on are protected independently of
that count. Uninstall first to remove the last installed package. Recovery-point
IDs are shown; managing those points is a separate explicit action under
Backup & recovery. This is a one-time reviewed retention rule, not automatic
expiry. A future installation requires another review.

The review lists exact generation hashes, eligibility, file counts, byte sizes,
activation-review counts and retained character-history counts. Its fingerprint
binds the selected inventory, package-state revisions, recovery references,
activation-review identities/status/approval fingerprints, provenance counts,
and candidate file paths, sizes, modes and modification times. The coordinator
recomputes that fingerprint before changing anything. Changed inputs require a
new review; an activation or staged-package transition cannot race removal.
Reviews are bounded to 512 generations and each candidate to 100,000 files / 4 GiB.
A larger inventory can be narrowed to one add-on or one exact generation.

Approval removes generation metadata, activation reviews, GitHub generation
provenance and generation lifecycle events in one SQLite transaction. It leaves
campaign documents, retained revision payloads, data audit history, add-on source
settings and instance configuration intact. The current worker/browser graph is
not restarted. Reusing a deleted package requires uploading and reviewing it
again. Existing full backup ZIPs remain self-contained and unchanged.

Migration `0017_addon_package_cleanup.sql` journals the approved cleanup in the
same transaction before files are removed. ZIPs and extracted files are deleted
through a filesystem root confined to the configured package directory, with
symbolic-link parent paths rejected. An interruption leaves a pending receipt;
retrying the same approval, the explicit retry action, or host startup resumes
that approved removal. A pending generation cannot be restaged. Completed
receipts acknowledge repeated requests without deleting a later reinstallation.
Receipts remain small audit/idempotency records; they contain no executable
package bytes. Corrupt receipts or reappearing package metadata fail closed.

Online backup creation holds the same coordinator lock from the SQLite snapshot
through archive publication; staging, activation and pruning wait until that
snapshot is complete. Offline maintenance holds the exclusive host-process lock.
A backup containing a pending receipt resumes the approved cleanup on startup.
The reported reclaimed size is the reviewed logical byte total, not filesystem
allocation or backup-file savings. Partial cleanup is reported as pending;
completion/retry reports the approved total.

| POST path | Body and result |
| --- | --- |
| `/api/admin/addon-package-cleanup/review` | `{addonId?, keepInactive: 0..5}` or `{addonId, generationId}`; returns `addon-package-cleanup-review.v1` |
| `/api/admin/addon-package-cleanup/apply` | `{scope, reviewSha256}`; returns `addon-package-cleanup-result.v1` with `applied`, `complete`, counts and pending cleanup count |
| `/api/admin/addon-package-cleanup/retry` | `{}`; retries already approved pending files, without approving another inventory |

This cleanup owns registered saved generations. Historical repair copies under
`retired/`, external backup retention, campaign namespaces and blob collection
have separate operational/data ownership; this action does not erase them.
Regression coverage: `cleanup_test.go` exercises reference protection, retention,
file and review conflicts, transaction rollback, interruption/restart, confinement,
reinstallation and self-contained backups. HTTP/client tests reject unauthorized
and malformed requests. Installed desktop/phone tests cover English/Czech review,
retention, recovery protection and a lost response after a successful removal.


## Administrative HTTP boundary

The transport registers add-on administration only when both the lifecycle
service and an `AdminAuthorizer` are supplied. Supplying only one is a startup
configuration error. Authorization runs before path or body parsing, and a
denial returns a generic response without exposing session details. The
cookie-backed authorizer requires a real-and-effective DM session and a bound
CSRF token for mutations.

| Method and path | Operation |
|---|---|
| `POST /api/admin/addons/generations` | Accept a bounded `application/zip` upload and stage an inert immutable generation |
| `GET /api/admin/addons/{addonId}` | Read durable and live lifecycle diagnostics; optional `eventLimit` is bounded to 0-500 |
| `POST /api/admin/addons/{addonId}/activation-reviews` | Prepare and persist an exact generation review |
| `GET /api/admin/addon-activation-reviews/{reviewId}` | Re-read a durable review |
| `POST /api/admin/addon-activation-reviews/{reviewId}/approval` | Approve an exact complete grant set |
| `POST /api/admin/addon-activation-reviews/{reviewId}/activation` | Consume an approved review and switch generation |
| `POST /api/admin/addons/{addonId}/reload` | Reload the active generation at an expected state revision |
| `POST /api/admin/addons/{addonId}/disable` | Disable at an expected state revision without deleting files or data |
| `POST /api/admin/addons/{addonId}/uninstall-review` | Read the current `addon-uninstall-review.v1` proposal with body `{}` |
| `POST /api/admin/addons/{addonId}/uninstall` | Confirm `{reviewSha256}`; return the configuration/recovery result with `addonId` and `alreadyRemoved` |

Mutation bodies require `application/json`, reject unknown fields and multiple
JSON values, and are capped at 64 KiB before lifecycle code is invoked. Path
identifiers and diagnostic limits are bounded. Public errors expose stable
categories and safe messages; full joined errors remain in administrator logs.
State/review conflicts use HTTP 409, rejected lifecycle inputs use 422, worker
activation failure uses 503, and unclassified failures use a generic 500.

Browser delivery is a separate read-only authorization surface. It exposes the
versioned private revalidated graph at `GET /api/addons/browser-graph` and exact
generation assets below
`GET /api/addons/{addonId}/generations/{generationId}/assets/web/...`.
Generation assets are served only while that exact package is recovered,
remain confined to inspected `web/` inventory entries, and are rehashed before
each response. Their archive generation and file digest make the URL and ETag
immutable without revealing filesystem layout.

## Durable diagnostics

Migrations `0003_addon_package_lifecycle.sql` and
`0004_addon_activation_reviews.sql` store:

- every content-addressed generation and inspected manifest;
- the active generation, grants, and optimistic state revision;
- separate last-attempt and last-successful-activation times;
- the last bounded failure message;
- ordered staged, activated, rolled-back, recovered, activation-failed,
  recovery-failed, and cleanup-failed events.
- prepared, approved, and consumed review records with proposal and approval
  hashes and separate timestamps.

`Snapshot` combines that history with the live supervisor snapshot when a
worker exists. Package bytes, process handles, service registries, and request
payloads are not stored in the event log.

## Remaining lifecycle work

Current review, activation, configuration, uninstall, basic diagnostics and
browser calls to an add-on's own service are implemented. Browser self-calls
use explicit `includeOwn` and do not imply planned self-binding during native
worker initialization.

The actionable work is consolidated in [the suite backlog](../BACKLOG.md):
namespace cleanup (T05), migration orchestration
(T08), dependent disable (T09), worker monitoring/restart/quarantine (T10), and
richer redacted diagnostics (T11). Planned native self-binding and other new
worker capabilities require a concrete consumer under C07; WASI and OS limits
are conditional under C08. Extend the existing coordinator and preserve exact
generations, optimistic revisions, broker authority and stored approval.
