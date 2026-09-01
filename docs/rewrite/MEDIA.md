# Core media

Core media is built on the shared opaque blob store rather than public data
directories. A campaign record stores the returned `/api/media/b_...` URL; the
browser never learns the hash-addressed filesystem location.

## Media kinds and authority

| Kind | Target | Upload/delete authority | Read visibility |
|---|---|---|---|
| `character-portrait` | existing character key | authenticated player for a public character; effective DM for any character | follows the character |
| `pet-portrait` | existing pet key | authenticated player or effective DM | public |
| `location-map` | existing location key | authenticated player for a public location; effective DM for any location | follows the location |
| `world-map` | `main` | effective DM | public |
| `marker-icon` | existing `settings.pinTypes` key | effective DM | public |
| `branding-logo` | `main` | effective DM | public |

Every write also requires the session-bound CSRF token. A DM using player view
has player authority. A request for DM-only media from any other role returns
the same not-found result as an unknown opaque ID.

## HTTP contract

`POST /api/media/{kind}/{target}` sends the image bytes directly. It requires
an exact `Content-Length`, an allowed image `Content-Type`, URL-encoded UTF-8 in
`X-Codex-Filename`, and `X-Codex-CSRF`. Raster signatures must match their
declared PNG, JPEG, GIF, or WebP type. SVG is supported for migrated and custom
artwork, but declarations such as a doctype are rejected.

The exact `media-blob.v1` response contains the opaque ID and URL, logical kind
and target, normalized media type, byte count, revision, and creation time. It
never includes a host path. `GET /api/media/latest/{kind}/{target}` resolves the
newest non-deleted binding when a screen owns a logical slot such as the world
map. `DELETE /api/media/{id}` accepts an exact `media-delete.v1` body with the
expected handle revision and performs logical deletion.

`GET /api/media/{id}` supports normal HTTP range and conditional requests.
Character portraits and location maps revalidate before reuse because the
owning record can later become DM-only; the service rechecks its current
visibility on every read. Media uploaded while DM-only remains DM-only even if
the record is later published, until it is deliberately replaced. Fixed-public
handles receive long-lived immutable caching, while DM-only responses are
private and no-store. All responses use `nosniff` and a restrictive sandbox CSP
so directly opened user SVG cannot become a same-origin application page.

The strict TypeScript `MediaClient` validates requests and the complete JSON
response at the browser boundary. The host remains authoritative for target
existence, visibility, and role.

## Persistence and replacement

Migration 0007 records each core media binding by monotonically increasing
sequence. Upload creates a verified blob first and then binds it; a failed bind
logically deletes the new handle. Replacing media creates a new immutable
handle, so an interrupted campaign-record save cannot corrupt the previous
image. Old handles can be deleted after the new campaign revision commits.

The one-time v1 converter creates these same bindings for record-referenced
portraits, local maps, configured icons and branding plus the canonical world
map. It rewrites known record URLs to opaque handles, discards generated tile
caches, and reports unreferenced media instead of guessing ownership. It never
restores the old public directory layout.
