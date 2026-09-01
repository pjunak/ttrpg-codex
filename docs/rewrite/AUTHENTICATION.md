# Rewrite authentication

The rewrite authentication boundary deliberately starts smaller than the v1
account surface, but it is a real authorization boundary rather than a
development bypass. The Go host owns credentials, sessions, effective roles,
and CSRF checks. TypeScript may render the current authority but cannot create
or upgrade it.

## Initial credential and session model

The executable composition uses one required `CODEX_DM_PASSWORD` and one
optional `CODEX_PLAYER_PASSWORD`. The service immediately reduces each
configured value to a role-separated SHA-256 comparison digest and does not
persist the clear-text configuration. These environment-backed values are
bootstrap credentials, not the final password store; a later versioned
credential table will use a deliberately slow password hash and provide the
reviewed password-management flow.

Successful login creates independent random 256-bit session and CSRF tokens.
Only digests of the session and CSRF tokens are used for lookup/comparison;
the CSRF value is retained only so the same-origin client can recover it after
a page reload. Sessions are process-local, bounded, and expire after 30 days by
default. A restart intentionally signs everyone out. This avoids coupling the
authentication foundation to campaign save migration or inventing a durable
credential format before that format is reviewed.

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

## Remaining authentication work

- Add persistent slow-hashed credentials, password rotation, session
  revocation records, and backup/migration policy.
- Reintroduce bounded separate-tab player preview without exposing a DM
  session to the preview tab.
- Add request/correlation IDs and security-event diagnostics without recording
  credentials or tokens.
