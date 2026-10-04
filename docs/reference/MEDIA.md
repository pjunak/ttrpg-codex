# Core media

Core media is built on the shared opaque blob store rather than public data
directories. A campaign record stores the returned `/api/media/b_...` URL; the
browser never learns the hash-addressed filesystem location.

## Media kinds and authority

| Kind | Target | Upload/delete authority | Read visibility |
|---|---|---|---|
| `character-portrait` | existing character key | authenticated player for a public character; effective DM for any character | follows the character |
| `companion-portrait` | existing companion key | authenticated player or effective DM | public |
| `location-map` | existing location key | authenticated player for a public location; effective DM for any location | follows the location |
| `world-map` | `main` | effective DM | public |
| `marker-icon` | existing `settings.pinTypes` key | effective DM | public |
| `branding-logo` | `main` | effective DM | public |

Every write also requires the session-bound CSRF token. A DM using player view
has player authority. A request for DM-only media from any other role returns
the same not-found result as an unknown opaque ID.

## HTTP contract

### Character editor

Character **Edit -> Details** includes a portrait preview, upload/replace,
remove and undo controls. Selection stays local until **Save entry**; Cancel
and navigation discard the preview without uploading. Save a new character
before adding its portrait, because media targets must already exist.

Uploads accept PNG, JPEG, WebP, GIF and SVG up to 20 MiB, with authoritative
signature validation on the server. The host uploads the image and commits its
opaque URL with the other character edits using the original expected record
revision. Failed uploads or conflicting record writes retain the form and file
draft. Removing a portrait clears only the record reference on Save; previous
immutable media remain available to recovery points. An upload whose record
write fails can remain unreferenced; it is never automatically deleted after an
ambiguous response that might have committed successfully.

Media requests stop awaiting cancelled headers or bodies and reject late
results. Portrait, local-map and branding saves retain their original signal and
CSRF token across upload and record publication. Disconnect prevents a late
upload from attaching its URL in a new application lifetime; it does not delete
accepted bytes, previous images or recovery data. The reconnect reads current
server records before another explicit save.

Save visibility changes separately before replacing a portrait: media visibility
is fixed at upload, independently of the character's later visibility. The UI
supports English and Czech and uses the normal authenticated record authority.

Regression coverage: `frontend/test/campaign-record-editor.test.ts` validates
portrait mutation preparation and media binding; `frontend/test/browser/portraits.browser.mts`
exercises desktop/mobile save, replacement, removal, cancellation, retry,
localization and anonymous access against a disposable Go host.

### Displayed portraits

All entity cards, record articles, party/companion avatars and portrait previews
use the [shared artwork renderer](UI_FOUNDATIONS.md#entity-artwork). Missing,
unreadable and undecodable images keep an emblem in the reserved media slot.
Loading/replacement does not resize the slot, and late events from retired images
cannot hide a current image. This is presentation only: failed reads never clear
authored URLs, change visibility, delete handles or upload a replacement.

The editor releases its object URL on disconnect. When the same editor reconnects
with its local File draft, it creates a fresh preview URL for that file; Undo,
removal and subsequent disconnect release the current preview. Reconnect never
uploads or commits the file. A whole application replacement retains its existing
authority/draft policy.

`frontend/test/browser/artwork.browser.mts` covers all nine entity kinds, both
themes and desktop/phone layouts, loading/failure geometry, retired events,
reconnect and preview URL ownership. Real-host portrait tests additionally prove
that deleted media stays unreadable, DM-uploaded media remains private after a
record is published, and fallback leaves the authored record unchanged.

### Endpoints

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

## Map tile contract and cache

`GET /api/media/{id}/tiles/v1/manifest` returns the exact `map-tiles.v1` object:
`contractVersion`, `id`, `width`, `height`, `tileSize` (256), and `depth` (0..7).
`GET /api/media/{id}/tiles/v1/{level}/{x}/{y}` returns PNG bytes on a 256px grid,
with a one-pixel right/bottom overlap (257×257 PNGs). Level `depth` is native
resolution; level 0 fits the whole image in one cell. Coordinates are canonical
non-negative decimal integers and are checked against the level's dimensions.
The client derives tile URLs from the reviewed opaque handle, never a supplied
URL template or filesystem path.

Only world-map and location-map handles may be tiled. Every manifest and tile
request reuses ordinary media authorization, including cached and conditional
requests. Hiding/deleting the owning location or deleting the handle therefore
blocks subsequent reads. Location tiles revalidate before reuse; DM tiles use
private/no-store caching. Fixed-public world tiles use immutable caching.
Manifest JSON and error responses use no-store. Tile ETags include the source
hash, format version, and coordinates, without exposing cache paths.

The Go host generates PNG, JPEG and WebP pyramids on first use under
`data/cache/map-tiles-v1/<source-sha256>/`. `golang.org/x/image` supplies the
[WebP decoder](https://pkg.go.dev/golang.org/x/image/webp) and
[image resampling](https://pkg.go.dev/golang.org/x/image/draw).
Only one decoder runs at a time, and dimensions are inspected before full
decoding: at most 32,768 pixels per axis and 33,554,432 pixels total. SVG, GIF,
JPEGs with absent EXIF orientation or orientation 1 use tiles; unrelated APP1
metadata (such as XMP) does not disable tiling. Rotated/mirrored or malformed
EXIF, unsupported WebP variants, larger images, and decode failures retain the
original-image viewer so browser orientation cannot silently change the map's
coordinate frame.

Generation is cancellable, uses a private staging directory, and publishes the
complete pyramid by rename. An `os.Root` confines cache filesystem operations.
The cache is derived from immutable blobs, contains no authoritative records,
and is excluded from backups. Removing it while the host is stopped is safe;
the next map read regenerates tiles. New uploads use new handles, so an old
image and its cached tiles remain internally consistent. No upload, migration,
or backup format changes are needed.

## Persistence and replacement

Migration 0007 records each core media binding by monotonically increasing
sequence. Upload creates a verified blob first and then binds it; a failed bind
logically deletes the new handle. Replacing media creates a new immutable
handle, so an interrupted campaign-record save cannot corrupt the previous
image. Old handles can be deleted after the new campaign revision commits.
