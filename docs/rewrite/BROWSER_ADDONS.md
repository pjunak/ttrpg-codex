# Browser add-on generations

The TypeScript browser owns presentation resources for one
server-authoritative add-on graph. It does not decide which package generation
or dependency version should run. The Go host publishes an opaque graph
revision and an already-authorized descriptor for each browser contribution.

## Graph contract

The graph envelope declares browser graph contract version `2`. Each
descriptor contains:

- a stable add-on ID;
- the add-on version;
- an immutable package generation ID;
- the integrated or isolated UI mode;
- a same-origin module entry URL;
- same-origin style URLs and isolated-frame sandbox grants;
- required browser add-on dependencies;
- negotiated host capabilities;
- only approved permission IDs with their bounded resource grants;
- only UI contribution declarations whose required capabilities are active.

The graph revision is opaque. The server must change it whenever browser
contributions or their host SDK/service handles must be rebuilt, including a
cold backend cohort, reload, disable, or package update. The browser does not
infer authority from timestamps, URLs, or its previous state.

The coordinator validates the complete graph before touching live UI. It
rejects duplicate or malformed IDs, missing dependencies, self-dependencies,
cycles, unsafe entry URLs, oversized values, and more than 100 active browser
generations.

The contract version is independent of the opaque graph revision and Add-on
API version. An unsupported contract version fails before browser lifecycle
state changes.

## Host projection

Character articles present the core Profile and active article contributions in
separate, keyboard-accessible tabs. The contribution label supplies the second
tab's title when there is one contribution; multiple contributions share the
Record add-ons view. Both panels remain mounted when switching views, so core
and add-on drafts, revision bases, and unload guards survive. The selected view
is remembered per character for the browser session. This presentation does not
change contribution descriptors, role projection, or lifecycle ownership.

The host's Sidebar settings provide a further presentation filter after the
normal generation/role projection. Pages start hidden and may be opted into
Everyone or DM-only navigation using the stable `<addonId>:<route>` key in
`settings/addonSidebarVisibility`. This does not change package permissions,
route access, activation, or contribution descriptors. Preference changes
refresh the existing outlet; hidden links do not dispose the underlying route.
Saved keys for inactive or renamed routes remain available for later review.

`packagemanager.BrowserGraph` builds the deterministic projection from durable
active state and recovered package reports. Only the exact selected generation
of a recovered add-on may contribute UI. Entry and stylesheet paths are
converted to generation-addressed, same-origin asset URLs; clients never
construct filesystem paths.

The projection is also the browser's authority description. Required and
available optional capabilities are normalized, permission reasons and
unapproved requests are omitted, and unavailable capability-gated
contributions are filtered out. Pure manifest kinds and worker HTTP endpoints
never enter the browser graph. Contribution roles, order, requirements, and
opaque configuration are copied into detached deterministic values; the
browser still validates every field before activation.

Browser files are confined to the package `web/` subtree by the v3 manifest
schema. The asset reader additionally requires an exact recovered generation,
an inspected inventory entry, and the original SHA-256 bytes before returning
an open handle. Manifests, worker executables, contracts, content, and locale
files cannot be requested through the browser asset route.

The opaque revision is a SHA-256 digest over every durable active add-on ID,
generation, and state revision plus the projected UI descriptors. Including
worker-only state is intentional: a provider reload or cold backend cohort can
force all browser SDK handles to rebuild even when UI assets did not change.
Stopping a runtime removes its descriptor and changes the digest; recovery of
the same exact durable graph restores the deterministic projection.

## HTTP delivery

The generation-scoped service SDK supports `includeOwn: true` in both browser
modes. `service-client.ts`, the opaque-frame bootstrap and bridge carry the
boolean to the existing authenticated connection endpoint. The manager can then
include the caller's declared native worker without adding a worker dependency
on itself. The public service guide defines ambiguity, actor and stale-handle
behavior. Typed worker errors map to fixed HTTP codes/messages so import
conflicts and expired tokens remain actionable without exposing worker details.

The installed DM Tools workflow test uploads the actual release ZIP, reviews
and activates it, then checks read-only preview, cancelled review/request,
single-use commit, atomic conflicts, DM-only access, and replacement by another
reviewed package generation. The replacement fixture changes the test manifest
version while retaining the real worker binaries and recomputing checksums.

The transport registers browser add-on routes only when both a
`BrowserAddonSource` and `BrowserAuthorizer` are supplied. Partial
configuration fails at startup, and authorization runs before query, ID, or
asset-path validation. The implemented session authorizer accepts either
authenticated effective role, and the rewrite executable composes it with the
recovered package manager.

| Method and path | Cache contract |
|---|---|
| `GET /api/addons/browser-graph` | `private, no-cache` with the graph revision as a strong ETag |
| `GET /api/addons/{addonId}/generations/{generationId}/assets/{webPath}` | `private, max-age=31536000, immutable` with the inspected file digest as a strong ETag |

Both responses vary on cookie and authorization credentials and use
`nosniff`. Assets also require same-origin resource use and deterministic MIME
types. Conditional GET and HEAD are supported. A corrupt expected asset is a
generic 503 rather than a cached or partially trusted response; inactive,
stale, non-web, and unlisted paths share one 404 classification.

Graph change notification uses the implemented shared role-scoped event stream
and its durable replay contract. Successful package activation, rollback,
reviewed cohort activation, reload, disable, and startup recovery publish the
exact resulting graph revision. `SharedEventStream` validates `hello`, `reset`,
and `browser-addons-changed` payloads from one native EventSource and lets its
built-in reconnect behavior own `Last-Event-ID`. There is deliberately no
second add-on-only SSE connection or reconnect policy.

## TypeScript transport

`BrowserGraphClient` serializes refreshes and owns the strong ETag for the last
accepted graph. It sends same-origin credentials and `If-None-Match`, returns
the cached immutable value for a 304, and never interprets an HTTP error body.
`reset()` invalidates both the cache and any in-flight response so a role or
session transition cannot repopulate stale authority.

A 200 response is accepted only when it is JSON below 512 KiB, uses contract
version 2, has exact object fields, lowercase SHA-256 revisions and generation
IDs, and contains only generation-bound asset URLs. The generation manager's
canonical validator then enforces URL, sandbox, capability, permission,
contribution, duplicate, dependency, and cycle semantics before the client
replaces its last good graph. Contribution configuration is bounded JSON with
deterministic object ordering and prototype-sensitive keys rejected. Reusing
one revision for different content is a boundary failure.

## Runtime composition

`BrowserAddonRuntime` is the single browser owner of the complete refresh
operation. It serializes graph transport through generation reconciliation so
a later fetch cannot overtake activation from an earlier response. Every
accepted response, including an unchanged 304, reaches the generation manager;
this lets a previously failed activation retry without inventing a new server
revision.

Transport or boundary-validation failures do not call reconciliation, so the
last successfully activated generation set keeps running. `reset()` first
advances the coordinator's authority epoch and invalidates the graph client's
cache, so queued work and fetched-but-unapplied responses cannot continue. It
then queues ordered disposal of active generations. Role, session, and
permission changes use the explicit `authority-changed` stop reason. This
prevents an old credential context from restoring browser authority while its
resources are being torn down.

`BrowserAddonSession` now instantiates the coordinator behind the authenticated
application shell. It opens the shared stream before its initial graph refresh,
coalesces every graph signal through the serialized runtime, and preserves live
generations across transient transport errors. A 401/403 closes the stream,
aborts the authority scope, clears cached graph authority, tears down active
generations, and returns the shell to anonymous state.

## Cold graph switch

Any changed graph revision deliberately rebuilds the complete contribution
graph:

1. Abort and dispose current consumers before their providers.
2. Continue teardown after individual disposer failures and retain labeled
   diagnostics.
3. Activate target providers before consumers.
4. If activation fails, abort and dispose that partial generation.
5. Skip required dependents of a failed generation while allowing independent
   add-ons to activate.
6. Publish the successful active subset and structured failure list.

Operations are serialized, so rapid server updates cannot interleave scopes.
An identical revision and descriptor set is an idempotent no-op. A partial
activation is not treated as a no-op on retry because the active set differs
from the target.

This trades a brief full contribution refresh for one small, deterministic
lifecycle. That is appropriate for the current personal deployment and small
first-party add-on set. The owner accepted this as an expected limitation on
September 11, 2026. A graph change restarts all browser add-ons, including
otherwise unchanged ones. Local actions honor published edit guards, but a
change from another session or authority loss can discard unsaved in-memory
add-on drafts. Saved data remains under its storage contract. Per-generation
rolling replacement and generic draft persistence are not current commitments.

## Module boundary

`GenerationScope` remains the sole owner of listeners, subscriptions,
requests, observers, object URLs, and returned module cleanup. It aborts first,
then runs cleanup once in LIFO order with failure isolation.

`BrowserGenerationManager` receives an injected activator selected by the
server-projected UI mode. The integrated adapter loads every declared
stylesheet into the generation scope, imports the server-provided immutable
entry URL, requires an `activate(context)` export, and adapts the v3
`{ dispose() }` result into scope-owned cleanup. Cleanup unpublishes
contributions, invokes module cleanup, and then removes generation styles;
partial activation retains fallback cleanup for every acquired resource.

Integrated modules receive a public `BrowserAddonContext`, never the internal
generation scope or graph descriptor. The context exposes immutable add-on
identity, the generation abort signal, effective capability and permission
queries, generation-bound add-on data and immutable content clients, and the
UI binding API. Those queries support conditional UI only;
server endpoints must independently enforce every permission and resource.
Closed sessions report no authority and reject new contribution work.

`BrowserContributionRegistry` owns every live implementation by add-on,
contribution ID, and generation. It rejects undeclared IDs, duplicate binding,
replacement-generation theft, invalid custom-element names, and an
implementation shape that does not match the declared surface. Visual surfaces
bind custom elements, article actions bind action functions, and graph views or
contributors bind model providers. Sidebar entries are declarative and cannot
bind code. Both activation adapters publish reviewed sidebar metadata directly
into the registry; a feature-owned navigation surface can consume it without
loading another renderer or accepting a route callback. No binding accepts raw
HTML or a string action dispatcher.

Registry queries apply declared roles and deterministic order without exposing
private host DOM. Action and model callbacks are wrapped with the generation
signal so a stale registry snapshot cannot execute after revocation. A partial
activation is held by a fallback SDK disposer; successful activation transfers
cleanup into one composite that unpublishes contributions before calling the
module's own disposer.

The registry now publishes host-only change notifications after a binding is
added or removed. Observer failures are reported through the shell diagnostic
boundary and cannot turn a valid add-on binding into a partial failure.
`BrowserContributionOutlet` performs a keyed projection for one host-selected
surface and effective role. It preserves an unchanged custom-element instance,
orders panels by the registry contract, and removes stale elements on binding,
generation, or authority teardown. Each mounted element receives a frozen
`codexContribution` property containing its add-on and generation identity,
declaration, configuration, generation abort signal, and a scoped `edits.set`
handle; it never receives the registry or private host DOM.

The registry aggregates edit flags per mounted instance. Dirty views join the
shell's discard and browser-unload guards; pending writes block shell navigation
and authentication changes. An explicit `retainOnQueryChange` flag permits
same-route query updates only for views that keep their drafts. The isolated
bridge validates flag-only `edit-state` messages, including during activation;
frame closure clears the state. Outlet disposal and generation abort retire
handles even when the element has no custom disposer. These guards cannot veto
disable, replacement, or authority loss and do not persist draft contents.

The current shell instantiates the generic outlet for the `slot` surface under
Campaign tools and shows a direct empty state when that role has no panels.
Routes, record outlets, and settings use the same registry. Editor locations
and custom renderers remain owned by their corresponding core features.

## Add-on settings

`codex-addon-settings` lazily mounts role-visible `settings` contributions
inside each add-on's card in Settings → Add-ons. Its disclosure uses a native
button with `aria-expanded` and `aria-controls`, following the
[W3C disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
Expanded panels retain their DOM and edit registrations when collapsed.
Cards use stable add-on keys and player cards sort by add-on ID, so an
inventory refresh or another package's panel-order change cannot transfer
drafts or expansion state between add-ons.

The host's shared contribution controller owns registry subscriptions for
discovery; the existing outlet owns ordering, labels, roles, integrated
elements, isolated frames, and cleanup. Player settings discover add-ons from
the role-filtered registry without requesting the admin inventory or mounting
management controls. Empty disclosures are omitted; a direct unavailable
target gets an explanatory message. Integrated mount failures offer a retry
that preserves successfully mounted siblings.

The [public settings contract](../../examples/addons/API_V3.md#add-on-settings)
defines the context and direct links. Category changes use the same dirty and
saving flags as shell navigation. Local activation, reload, disable, uninstall,
and source/provider application also check these flags before restarting
add-ons. They cannot prevent external generation changes or authority loss.
The browser runtime restarts its whole graph on graph changes, so an update
from another session can discard unsaved drafts in other add-ons as well.
This integration does not create a separate settings store or migrate data.

`installed-settings-fixture.mts` exercises reviewed fixture ZIPs in both UI
modes, persisted saves and reload, collapsed drafts, guarded navigation and
reload, player filtering, replacement, disable, retry, unrelated card stability,
localized labels, and desktop/phone layouts.

## DM dashboard outlet

The composition also owns data invalidation dispatch. The shared stream's
validated `addon-data-changed` events reach only that package's generation
subscribers; connection resets and campaign recovery invalidate all active
subscribers. Integrated clients receive `context.data.subscribe`; isolated
frames receive the same bounded notification over their existing private port.
Frame disposal removes its host subscription and aborts frame-local listeners.
No document payload or internal data revision crosses this interface.
`data-changes.test.ts`, `isolated-frame.test.ts` and the installed DM browser
suite cover parsing, package scoping, reset, errors, cancellation and cleanup.
The real planner/overview cases also cover automatic refresh, draft conflicts,
typing during a pending read, and retry after failed reads.

The [DM dashboard contract](../../examples/addons/API_V3.md#dm-dashboard)
uses `codex-dm-dashboard` at `#/dm`. Only real/effective DMs mount its exact
`dm:dashboard` slots. Empty, failed, and disabled contributions leave core
hidden-content counts, browser lifecycle status, reload, and active route links
available. Sidebar hiding does not prevent those workflow links. The UI uses
the preserved panel/card geometry and bundled English/Czech messages.
`installed-dm.browser.mts` covers this boundary through reviewed fixture ZIPs,
desktop/phone screenshots, live counts, both roles and anonymous access,
integrated/isolated modes, refresh, failure, replacement, disable and retry.
To additionally exercise the separately built first-party package, set
`CODEX_DM_TOOLS_ZIP` to its release ZIP before running that browser test. This
acceptance case uploads, reviews, approves and activates the package, then opens
the planner and Import Center from the panel.

The Import Center acceptance also installs an independent native test provider
through the same reviewed lifecycle. Desktop/phone cases cover routing by
format, provider-owned writes, duplicate format claims, partial/all-provider
discovery failure and retry, rejected mismatched reviews, preview cancellation,
pending-commit navigation protection, and English/Czech review presentation.
The provider fixture is test-only; production installation never compiles it.

The isolated bootstrap sends `ready` before its first resize report. Reversing
those messages caused healthy widgets to emit a false protocol-failure
diagnostic; the installed DM panel regression checks that no degraded state is
reported for a healthy isolated widget.

## Timeline contribution outlets

The timeline restores its four additive toolbar, column-header/footer, and
card-extra slots through compact `BrowserContributionOutlet` instances.
`timeline-contributions.ts` owns slot recognition and bounded event-reference
projection; `codex-timeline-slot` lazily starts an outlet when first visible.
Started widgets remain connected through ordinary refresh, scrolling, and
context updates. They leave with the slot, role, or generation. Core event
ordering and unsaved drafts remain owned by `codex-timeline`.

The public [timeline context contract](../../examples/addons/API_V3.md#timeline-slots)
contains display metadata and permission-filtered event identities, never
record bodies. References are intersected with the latest role projection
even when an unsaved draft retains an older displayed snapshot. Named slots
are excluded from the dashboard outlet. Add-on controls live outside event
anchors and cannot start core dragging or enter its order transaction.

Generic outlets reconcile children by identity, preserving unchanged custom
elements and frames instead of detaching them during every refresh. Isolated
mounts optionally accept a host context and an update handle. This is opt-in at
the owning feature: timeline, DM dashboard, and route outlets enable it, while other isolated outlets
retain their existing null context. Updates are bounded JSON messages on the
existing private port; a pending update keeps only the latest value until the
frame is ready, and disposal prevents further delivery. Timeline frames measure
their content root, allowing compact layouts to shrink as well as grow, with
heights bounded to 1–2,400 pixels and transparent dark backgrounds.

`installed-timeline.browser.mts` exercises actual reviewed integrated and
isolated ZIPs on a disposable Go host: all four slots, desktop/phone layout,
form-state retention, context updates, role/read grants, generation replacement,
disable, and unsaved order drafts. `timeline-contributions.test.ts` and the
outlet/bridge unit suites cover recognition, projection bounds, and delivery.

## Wiki references and library search

`wiki-links.ts` validates the public `wiki-links.v1` provider protocol and
constructs same-generation route targets. `AddonLinksController` owns batching,
view caches, search debounce, retries, and cancellation. Record articles and
Markdown previews preserve core resolution priority; global search appends
provider groups to existing campaign results. The app only offers unknown
hashes to providers claiming that complete legacy root, then replaces the
history entry with the canonical URL. Disabling/replacing a binding clears all
cached results synchronously. Both integrated callbacks and isolated callback
frames use the same boundary and ten-second deadline.

`installed-wiki.browser.mts` exercises real reviewed integrated/isolated ZIPs,
roles, core priority, search, old hashes, replacement, disable and reactivation.
With `CODEX_COMPENDIUM_ZIP`, `installed-compendium.browser.mts` also checks real
typed spell/armor identities, Markdown previews, failed-load Retry and classic
bookmarks on desktop/phone. See the [public contract](../../examples/addons/API_V3.md#wiki-references-and-library-search).

## Mind Palace graph models

`codex-campaign-graph` consumes role-visible `graph-view` and
`graph-contributor` model providers through `campaign-addon-graph.ts`.
The version-1 config, request, and bounded JSON response are documented in
[the public graph provider contract](../../examples/addons/API_V3.md#mind-palace-graph-providers).
Provider references contain only current role-visible core identities allowed
by that generation's approved `core.data.read` resource grants. The registry
carries an immutable grant snapshot for this host-owned projection; providers
never receive the registry or campaign object.

Each matching provider has a ten-second host deadline and an invocation signal
combined with its generation signal. The canvas aborts on campaign refresh,
binding changes, role changes, view changes, and detach, and ignores late
results even if an integrated provider ignores cancellation. It validates the
whole model before adding any nodes or edges. One failed model does not remove
healthy models or core cards; a localized message supports explicit retry.
Routes must be active in the same generation and role. Provider IDs are
namespaced, and saved browser positions take precedence over model defaults.
Asynchronous arrival fits the initial view but preserves explicit user zoom
and movement. Ordinary refresh does not reset a viewed add-on layout.

`installed-graph.browser.mts` builds a disposable Go host and uploads real
checksummed integrated/isolated fixture ZIPs through stage, review, approval,
and activation. It verifies the production frontend on desktop and phone,
role restrictions, local movement, detail routes, invalid models, cancellation,
replacement, and disable. The first-party packages currently declare no graph
providers. Their other workflows and real-campaign visual acceptance remain
separate checks.

## Isolated frame bridge

The isolated adapter never imports package code into the host realm and never
navigates the frame to an authenticated package URL. It fetches the immutable
entry module and CSS through the authenticated host, applies explicit 2 MiB
module and stylesheet limits, and transfers their text over a document-owned
message port into a host-generated `srcdoc`. The frame has a unique opaque
origin, a restrictive CSP that blocks ambient connections and external
subresources, and a sandbox that always
allows scripts but maps only the reviewed `downloads`, `forms`, `modals`, and
`popups` grants. It never receives `allow-same-origin`, host cookies, storage,
or usable access to the parent document. This boundary contains DOM and
ambient browser authority; it is not a general-purpose sandbox for actively
malicious computation. Such code belongs behind a narrower worker or WASI
contract.

The generated bootstrap imports the self-contained entry through a frame-local
blob URL and calls the same `activate(context)` shape used by integrated
modules. Current context support covers immutable add-on identity, generation
cancellation, capability and permission queries, generation-bound add-on data
and immutable content, the one role-visible declaration represented by that
frame, and surface-compatible element, action, or model-provider binding. The
entry module and declared styles must therefore
be `.js`/`.mjs` and `.css`; isolated entry modules cannot depend on relative
imports or network assets.

Each mounted visual contribution owns one transferred `MessagePort` using
`codex.browser-addon/1`. The initial document receives its private port before
asset loading completes, so a replacement document cannot inherit the module
bundle. Exact, bounded messages cover activation, ready, instance-context updates, resize, diagnostic,
revoke, and the current read-only SDK queries. The host accepts no
global-window commands after connection, limits reported height, revokes a
frame that misses its handshake deadline, and closes the port on outlet,
generation, or authority teardown. Only the initial `srcdoc` load receives a
port, so an add-on that navigates its frame cannot reconnect from another
document. Binding disposal or document unload sends an unavailable signal that
withdraws the corresponding host registration instead of leaving a dead
contribution visible.

### Callback ownership and flow

Declarative sidebar entries execute no add-on code and are published directly
from reviewed graph metadata. Each isolated article action, graph view, or
graph contributor instead receives one hidden opaque frame. Activation must
bind the exact declared callback and complete its handshake before the registry
publishes the host proxy.

```text
host feature -> registry proxy -> bounded invoke message -> callback frame
host feature <- validated JSON <- bounded result message <- callback frame
       cancel/deadline -------------------------------> abort signal
generation teardown ---------------------------------> revoke and dispose
```

Requests and results must be bounded JSON inside the existing 64 KiB message
limit. A frame accepts at most 32 concurrent calls; the host applies a ten
second deadline, forwards caller cancellation, rejects late results, and
removes every pending call on generation teardown. Feature owners still
validate their request and result schemas because the bridge provides transport
safety, not domain meaning. Activation, add-on, invalid-result, timeout, busy,
and revoked failures remain distinguishable in diagnostics or typed host
errors.

One frame per executable contribution deliberately favors obvious ownership,
failure isolation, and cleanup over minimum memory. The current deployment has
a small first-party add-on set, so a pooled per-generation callback frame would
add multiplexing complexity without demonstrated benefit. Revisit pooling only
if browser measurements show frame startup or memory is material; preserve the
same per-contribution cancellation and authority rules if that changes.

The browser shell projects a sidebar declaration only while its exact
same-generation route binding is active and visible to the current role.
Route paths are canonical manifest metadata, but the host owns the complete
hash namespace and creates the anchors. Selecting a page filters the route
outlet to one exact contribution; stale, disabled, role-hidden, and malformed
targets cannot leave the previous route mounted. Direct route hashes remain
usable even when a valid route intentionally has no sidebar declaration.

Route selection ignores the bounded query suffix only after validating the
whole hash with `parseBrowserAddonLocation`. The public
`addon-route-context.v1` carries decoded ordered pairs and the selected locale
to integrated and isolated elements. Duplicate keys remain visible to the
consumer. Query and locale changes update the mounted contribution instead of
recreating it. The same locale delivery uses `dm-dashboard-context.v1` for the
guarded DM slot; neither context includes campaign bodies.

Route context optionally includes `recordReferences`, projected by
`route-record-references.ts` from the role-visible campaign snapshot and the
generation's approved `core.data.read` collection grants. The catalog contains
only collection/key identities, bounded labels and host-built hash links. Its
ready/truncated flags distinguish unavailable snapshots and omitted records;
the exact limits are in the public API guide. Campaign refresh updates the
mounted route context in both UI modes without resetting its local draft.

`installed-dm.browser.mts` verifies both UI modes retain drafts across route
query updates, alongside DM slot authorization, replacement, disable and
failure recovery. With `CODEX_DM_TOOLS_ZIP` pointing to the rebuilt first-party
archive it also exercises dashboard counts, desktop/phone styling, Czech copy,
planner edits and notes, recent-item links, reload/new-tab/back navigation,
invalid/deleted targets and failed-read retry through an installed package.
`installed-planner-annotation-fixture.mts` covers core/planning/external targets,
quantities, optional consequence targets, shared/unanchored notes, retained
drafts, failed writes and phone layout. Separate installed route fixtures check
grant and player filtering plus context refresh in both UI modes.

Core data and host-issued add-on data/content/service facades share the default
session transport. In a player-preview tab it supplies independent player
authority, omits the shared cookie, and retains the existing CSRF and generation
checks. Integrated and isolated contributions therefore receive player policy
through the same host boundary. See [authentication](AUTHENTICATION.md) for
preview lifetime, resource requests, and separate-tab browser coverage.

## Record panels and planning prose

`codex-record-contributions` shares one role/grant-filtered outlet across
persisted record editors and the map's read-only location panel. The exact
[public record context and Markdown contracts](../../examples/addons/API_V3.md#record-editor-and-map-panels)
define bounded identity projection, separate saves and disconnect cleanup.
The core editor never gathers add-on inputs into its Save request. Dirty add-on
panels survive a successful core save; saving panels block conflicting local
navigation. Missing/currently hidden records remove their contributions.

DM Tools consumes the map slot to link related planning items. Its integrated
reader uses `codex-addon-markdown`, which reuses the host parser/renderer and
has no campaign-data access. The reader keeps its canvas viewport, offers
explicit editing and expanded reading, and defers automatic refresh while
reading. Tests in `installed-record-panels-fixture.mts` exercise integrated
and isolated contexts, grants, role visibility and independent save failures;
`installed-planning-reader-fixture.mts` exercises the rebuilt DM Tools ZIP,
safe rendered prose, annotations and desktop/phone reading and editing.

## Remaining integration

- Add data, service, import, event, settings, navigation, graph, and log handles
  to the implemented capability-scoped SDK as their transports land.
- Combined core/add-on save transactions and arbitrary field injection remain
  deferred; separate editor panels are supported. Graph node-kind
  renderers, a general `context.graphs` facade,
  and provider-driven graph invalidation remain unimplemented.
- Surface activation and disposal diagnostics in the Add-on Inspector.
