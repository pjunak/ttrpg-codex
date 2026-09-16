# Rewrite authentication

The rewrite authentication boundary deliberately starts smaller than the v1
account surface, but it is a real authorization boundary rather than a
development bypass. The Go host owns credentials, sessions, effective roles,
and CSRF checks. TypeScript may render the current authority but cannot create
or upgrade it.

## Credentials and sessions

The first start uses one required `CODEX_DM_PASSWORD` and one optional
`CODEX_PLAYER_PASSWORD`. It persists a singleton credential record in SQLite
with an optimistic revision, a DM hash and an optional player hash. Passwords
use PBKDF2-HMAC-SHA256 with 600,000 iterations, independent random 16-byte salts,
and 32-byte outputs (`pbkdf2-sha256-600000.v1`). Clear-text passwords are never
stored. Later starts use the saved record and ignore bootstrap environment
values, including after player sign-in has been disabled. Malformed saved
credentials never silently fall back to an environment password.

Successful login creates independent random 256-bit session and CSRF tokens.
Only digests of the session and CSRF tokens are used for lookup/comparison;
the CSRF value is retained only so the same-origin client can recover it after
a page reload. Sessions are process-local, bounded, and expire after 30 days by
default. A restart intentionally signs everyone out. Password hashes remain
in SQLite; sessions remain process-local.

The `edit_session` cookie is host-only, HttpOnly, SameSite=Lax, and can be
marked Secure by executable configuration. Deployment must enable Secure
cookies behind TLS. There is no default password. Login bodies and credential
lengths are bounded, failures use one public classification, and repeated
failures are rate limited per direct peer address with bounded bookkeeping.

## Authority model

Every resolved session carries two roles:

- `realRole` is the authenticated identity class and never increases;
- `role` is the effective projection used for data and browser UI.

A player session is always player/player. A DM may switch between DM and
player projections. Every transition replaces both opaque tokens before the
old session is removed, so a failed rotation preserves the current session and
a successful rotation immediately revokes its previous authority.

`GET /api/auth` is the authoritative browser probe. Anonymous responses contain
null roles. Authenticated responses contain the two roles, the current CSRF
token, and the expiry time. Login, logout, and view-as responses follow the
same shape.

Protected browser graph and immutable asset reads accept either authenticated
role. Administrative reads require real and effective DM. Administrative
mutations additionally require the exact `X-Codex-CSRF` value bound to that
session. These checks run before request path, query, or body parsing.

Campaign reading deliberately differs from those protected surfaces.
`GET /api/campaign` is available anonymously because both current websites are
public campaign references. Anonymous users and players receive the same
closed public projection. Authentication can only expand that projection when
the effective session role is DM; a DM using view-as-player receives the
public result.

The shared `GET /api/events` stream follows the same projection rule.
Anonymous callers receive only public invalidations. Player and DM-as-player
sessions also receive the public audience, while an effective DM additionally
receives DM invalidations. The browser closes and reopens its single stream
after an authority change so an older audience is never reused.

Campaign transactions accept either authenticated role and always require the
exact CSRF value bound to the current cookie. The effective role selects DM or
player mutation policy; a DM using view-as-player deliberately receives player
write limits. Audit identity is derived from the resolved session and cannot
be supplied or overridden in JSON.

Twin create, link, and unlink are stricter because they can expose the
existence of a hidden counterpart. They require both the real and effective
role to be DM, as well as the exact CSRF value. A DM using view-as-player must
leave that mode before changing twin relationships. Host-owned enum deletion
uses the same stricter authority because its atomic usage rewrite spans public
and DM-only records.

`GET /api/backup` also requires both real and effective DM authority because
the native archive contains the complete unprojected database and installed
add-on packages. It is a read/download operation and therefore does not use a
CSRF header; same-origin cookie policy and the strict DM check remain required.

## Separate-tab player preview

The DM account menu's **View as player** action opens a separate tab. It calls
`POST /api/player-preview` with the current DM CSRF token and an empty body.
The response is `player-preview.v1` with `token` and `expiresAt`; it never sets
or rotates a cookie. The existing view-as API remains available for deliberate
session-wide transitions and for returning an already-switched session to DM.

Preview sessions have independent player/player authority and CSRF tokens.
They can perform ordinary player actions, including permitted player edits;
they cannot sign in, become DM, create previews, or use administration APIs.
There are at most eight active previews per issuing DM session, within the
ordinary session capacity. They expire after one hour or the parent session's
expiry, whichever comes first. Revoking or rotating the parent also invalidates
its previews. Closing a preview through its button revokes only that preview.
Closing the browser tab directly leaves its credential to expire normally.

The new tab has no opener. Its bootstrap credential travels in the URL fragment
and is immediately replaced with a non-secret `playerPreview=1` marker before
the app starts. The token is held in tab-local session storage; same-site
navigation and reload retain the preview. Missing, blocked, or malformed tab
storage with an explicit marker keeps invalid preview mode instead of using
the shared DM cookie.

Core clients and host-issued add-on facades use the preview-aware default
transport. Preview API requests omit cookies and carry
`X-Codex-Player-Preview`; it only accepts a preview token, never an ordinary DM
token. Empty, expired, conflicting, or invalid preview credentials fail before
public routes can fall back to cookie or anonymous authority. Fetch requests
do not forward preview credentials to other origins or through redirects.
Native EventSource and rendered media URLs use the narrowly accepted
`playerPreviewToken` query parameter on GET event/media routes. The auth
boundary removes that parameter before ordinary query validation; canonical
stored media URLs never contain credentials. Preview logout never clears the
shared cookie. Request diagnostics record paths, not token-bearing queries.

Tests cover independent authority, parent expiry/rotation/revocation, bounded
capacity, concurrency, invalid-token fallback, protected routes and stream
revocation. Installed-host browser tests cover desktop/phone popups, reload,
same-site navigation, public live updates and media, hidden media refusal,
missing storage, DM logout, and blocked popups.

## Password management

Settings → Server access restores the DM and player password cards in English
and Czech. Each form requires the current DM password and confirmation of the
new value. Disabling player sign-in is explicit; public reading remains
available. Inputs remain local to the mounted form and are cleared after that
form saves or is discarded. Navigation is guarded while dirty and blocked
while a write is pending. Lost responses retain the reviewing DM session and
require a fresh status read before an explicit retry.

`GET /api/passwords` requires real and effective DM authority and returns only
`credential-status.v1`, the credential revision and `playerEnabled`.
`POST /api/passwords` also requires CSRF and takes `role`, `currentPassword`,
`newPassword`, and `expectedRevision`. New passwords contain 4–4096 bytes and
must differ between roles; an empty player password explicitly disables that
role. Status responses use `Cache-Control: no-store` and never return hashes,
passwords, or session identifiers. Invalid current-password attempts share the
login rate limiter. Stale revisions fail with `CREDENTIAL_CONFLICT`.

The service commits credentials before replacing its in-memory state or
revoking sessions. A failed commit leaves existing passwords and sessions
unchanged. DM changes revoke other DM sessions; player changes revoke player
sessions. Both revoke existing player previews, while the reviewing DM keeps
the same session and CSRF token. Login and changes serialize across the
credential check and session creation, so a concurrent old-password login
cannot escape revocation.
Existing authenticated event streams close before their next live publication
or heartbeat when their session is revoked.

Native backups include password hashes; restoring one restores its saved
passwords. Older backups without this table bootstrap on the first start.
Legacy v1 conversion still excludes credentials. The offline
`codex -data-dir <directory> -reset-passwords` command replaces saved passwords
from the environment under the same exclusive data-directory lock as the host,
then exits without changing campaign data. See the
[operator steps](../SELF_HOSTING.md#password-changes-and-access-recovery).

## Recovering a session during core editing

A rejected authorized request triggers an authority read, never an automatic
retry of the write. Retained campaign refreshes also recheck the session before
replacing data, so an expired DM session cannot replace a private record's open
editor with a public snapshot. Concurrent checks are coalesced and transport
listeners end with the application component.

When the previous role is no longer available, an English/Czech sign-in form
appears in the current page using the shared field, button and status styles.
Core editors remain mounted with their original values and opening revisions.
Reauthentication must restore the same real/effective role; wrong credentials
or a different role leave the draft and recovery form intact. A successful
sign-in refreshes campaign data and add-on bindings, announces recovery and
returns keyboard focus to the campaign content. The user reviews and saves
again explicitly. A concurrent record change still fails the original revision
check; reauthentication never grants permission to overwrite it.

Player-preview tabs keep their separate fail-closed contract and never fall
back to the browser's DM cookie through this recovery path. Add-on-local drafts
remain governed by their own lifecycle contract; this does not close DM Tools
T30. Browser tests cover DM/player, desktop/phone, rejected credentials, role
mismatch, stale edits, live expiry before Save, preserved private drafts and
the absence of automatic write replay. Browser fixtures revoke real sessions
through logout; clock-based expiration is also covered by the Go session tests.

## Authentication follow-ups

- Persistent sessions and individual session-management UI remain optional.
- Add request/correlation IDs and security-event diagnostics without recording
  credentials or tokens.
