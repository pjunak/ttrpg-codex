# Client API

The routes that clients other than this repository's web app rely on. Today
that is the Android [TTRPG Companion](https://github.com/pjunak/ttrpg-companion)
([ADR-0008](../decisions/0008-android-companion-app.md)). The web app uses the
same routes; this page lists the ones an outside client may depend on.

## Compatibility

A client checks `GET /api/version` (`{"version":"2.2.0","runtime":"go"}`) and
supports one host major version; the companion supports 2.x. Within a major
version, routes keep their shapes: adding response fields is fine, while
removing or renaming fields or routes needs a new major version or the client
updated first. Run the host's `npm run check` and the companion's
`gradlew test` for a change here.

## Sessions

| Route | Behaviour |
| --- | --- |
| `POST /api/login` `{"password"}` | Signs in with the site's DM or player password: `{"ok":true,"role","csrfToken","expiresAt"}` and the HttpOnly `edit_session` cookie. Wrong password `401 INVALID_CREDENTIALS`, too many attempts `429 LOGIN_RATE_LIMITED`. |
| `GET /api/auth` | The same shape for the current session, or `{"role":null}` when signed out. |
| `POST /api/logout` | Ends the session (`{"ok":true}`) and expires the cookie. |

Writes send the session's CSRF token as `X-Codex-CSRF`; read it from
`/api/auth` rather than storing it. Sessions expire after 30 days by default
and survive host restarts ([authentication](AUTHENTICATION.md)). Errors are
`{"error":{"kind","message"}}`.

## Reading the campaign

| Route | Behaviour |
| --- | --- |
| `GET /api/campaign` | The whole campaign as `campaign-data.v1`, projected for the session's role; signed out and player sessions get the public projection ([core data](CORE_DATA.md)). Compressed with gzip when asked. |
| `GET /api/events` | Server-sent events: `hello` and `reset` on connection, `campaign-data-changed` per committed change, plus add-on and recovery topics. Resume with `Last-Event-ID`; a heartbeat comment arrives every 20 seconds ([event stream](EVENT_STREAM.md)). |
| `GET /api/media/{blobID}` | A portrait or other image referenced as `/api/media/b_…` in records ([media](MEDIA.md)). |
| `GET /api/media/latest/{kind}/{target}` | The current blob for a media slot as `media-blob.v1`; `latest/world-map/main` finds the world map image. A location's own map is its `localMap` field. |
| `GET /api/media/{blobID}/tiles/v1/manifest` | The image's tile pyramid as `map-tiles.v1` (size, tile size, depth). An error answer means the image is not tiled (an SVG, for example); show the original image instead ([maps](MAPS.md)). |
| `GET /api/media/{blobID}/tiles/v1/{level}/{x}/{y}` | One tile of that pyramid. |

Pages without a native screen can open in a web view: the app's own pages
(`/characters/<key>` and so on) accept the same session cookie.

## Writing session notes

The companion writes events (its session notes) with the website's record
transaction ([core data](CORE_DATA.md)):

| Route | Behaviour |
| --- | --- |
| `POST /api/campaign/transactions` | `{"contractVersion":"campaign-mutation.v1","mutations":[…]}` with `X-Codex-CSRF`. Each mutation is `put` (with the whole record `value`) or `delete`, names `collection` and `key`, and carries `expectedRevision` (0 to create). Answers a `campaign-commit.v1` receipt with `commitId`. |

A client builds a put from the record it read and changes only the fields it
edits, so unknown fields survive. New keys follow the website's
`createCampaignRecordKey` (a name slug and a random suffix); an event states
its `sitting` and gets an `order` after the session's last event. The host
forces player writes to public visibility and keeps references the player
cannot see. Errors: `409 WRITE_CONFLICT` when any expected revision is stale
(nothing is written; refresh and prepare again), `403 FORBIDDEN`,
`400 INVALID_REQUEST` or `MANAGED_FIELD`, `404 NOT_FOUND`.

## Add-on services

Since host 2.2.0, signed-in clients reach worker services by contract, as
add-on consumers do, without being an add-on; older hosts answer
`405 Method Not Allowed`. Both routes need the session cookie and
`X-Codex-CSRF`; the session is the call's actor, and providers authorize it
the way they authorize the web app.

`POST /api/services/connect`

```json
{"contractVersion":"client-service-connect.v1","contract":"dnd5e.character","range":"^4.0.0"}
```

returns every live worker provider of the contract within the range, sorted by
add-on ID:

```json
{"contractVersion":"client-service-connection.v1","contract":"dnd5e.character","range":"^4.0.0",
 "providers":[{"addonId":"dnd-sheets","contractVersion":"4.0.0","generation":"<64 hex>"}]}
```

An empty list means the site does not offer the feature. The client chooses a
provider from the list; operator bindings, which belong to consuming add-ons,
do not apply.

`POST /api/services/call`

```json
{"contractVersion":"client-service-call.v1","contract":"dnd5e.character",
 "providerAddonId":"dnd-sheets","providerVersion":"4.0.0","providerGeneration":"<64 hex>",
 "method":"load","params":{},"deadlineMs":10000}
```

`params` is a JSON object or array, `deadlineMs` is 1 to 30,000 (the method's
own limit may be shorter), and `idempotencyKey` is added when the method
declares one. The answer is
`{"contractVersion":"client-service-result.v1","providerAddonId","providerGeneration","result"}`,
compressed with gzip when asked, as the campaign is (a character sheet load
shrinks to about a fifth). A request that accepts neither gzip nor identity
gets `406 ENCODING_UNAVAILABLE` before the call runs.
The call reaches only the exact provider version and generation from the
connection; after an add-on update or reload it fails with
`409 STALE_BINDING`, and the client connects again. The host also answers
`STALE_BINDING` when the provider changed while it ran the call, so the call
may have taken effect: a client asks a load again, and sends a save again
unchanged, with the same operation ID, to a provider that recognizes a
repeated one (as `dnd5e.character` does with `operationId`).

Errors follow the add-on service routes: `400 INVALID_REQUEST` (with an
optional one-line `issue` from the provider), `403 FORBIDDEN`,
`404 NOT_FOUND` or `METHOD_NOT_FOUND`, `408 CANCELLED`,
`409 CONFLICT` or `STALE_BINDING`, `429 RATE_LIMITED`, `500 INTERNAL`,
`503 SERVICE_UNAVAILABLE` and `504 DEADLINE_EXCEEDED`. `403 FORBIDDEN` means
either that the session ended (or the CSRF token belongs to an earlier one)
or that the provider refused the call; `GET /api/auth` tells them apart.
Content-transport services (rules data from the Compendium) are not reachable
this way.

When an add-on saves its data, `GET /api/events` sends `addon-data-changed`
to the audience of that data, with `resourceId`
`<addonId>/<kind>/<dataId>` and the data set's `revision`. It names neither
the record nor who saved, so a client's own saves bring it too. A client
showing a service answer loads it again when the resource ID starts with the
add-on ID of the provider it connected to; it takes that ID from the
connection, never from its own code.
