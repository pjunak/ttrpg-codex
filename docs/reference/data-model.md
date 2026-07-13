# Data model + Store — deep reference (ttrpg-codex)

> Moved verbatim out of CLAUDE.md to keep sessions lean. This file is
> CANONICAL for its subsystem — read it before working here and keep it
> as current as CLAUDE.md itself. Cross-references like "see X above"
> may point at a sibling file in this directory.

## Data model

Collections live in `data/*.json`. Defaults in `web/js/data.js`.
Merged at startup via `store.js:_mergeDefaults()`.

| Collection | Key fields |
|---|---|
| `characters` | `id`, `name`, `faction`, `status` [alive/dead/unknown], `circumstances` (free text — replaces `captured` status with a richer note like "Zajat/a", "Na útěku"), `attitudes[]` (array of `{id}` — stance toward the party; strength lives on the enum, see Settings; empty array = no own stance, renderer falls back to `faction.attitudes`; party members always render with the `party` palette via faction), `knowledge` [0–4], `title`, `portrait`, `location`, `description` (markdown), `known[]` (string array of "co víme" facts), `unknown[]` (array of `{text, answer}` objects — "otevřené otázky"; an item is answered when `answer.trim().length > 0`, flowing through the same `Store.isQuestionAnswered` helper that mystery questions use), `tags[]`, `rank`, `locationRoles[]`, `species` (free-text string — the `species` wiki collection was removed; D&D 2024 species now live in a separate addon), `gender` ('' / 'Muž' / 'Žena' / free text), `age` (free text, placeholder "neznámý"), `linkedTwinId` (DM-only metadata when paired with a DM-side twin entity; stripped from non-DM payloads server-side). Profile chips render only when `knowledge >= 2`. Migrations: legacy `status:'captured'` → `alive` + `circumstances:'Zajat/a'`; legacy single-string `attitude` and `{id, strength}` entry shapes → canonical `[{id}]`; legacy string-array `unknown[]` → `{text, answer}` via `_migrateQuestionsToObjects`. |
| `relationships` | `id`, `source` (charId), `target` (charId), `type` [commands/ally/enemy/mission/mystery/captured_by/history/uncertain/negotiates] |
| `locations` | `id`, `name`, `region`, `description`, `history`, `tags[]`, `knowledge`. Map-pin fields (optional): `x`, `y` fractions 0–1, `pinType` (icon/affiliation key), `attitudes[]` (array of `{id}` — mixed stances allowed; renderer stacks one drop-shadow glow per entry, scaled by the enum's `strength`), `size` (per-place marker px override; falls back to `pinTypes[type].size` when unset), `mapNotes`. Hierarchy: `parentId` (id of containing Location), `localMap` (image URL or `/maps/local/{locId}/map.{ext}` when uploaded). **`characters[]` is deprecated** — `character.location` is the canonical source of truth (a character can be in only one place). Legacy `mapStatus` → `attitudes[]`; legacy `priority` (1/2/3) → `size` (36/30/26 px); legacy `status` is dropped on load by `_migrateDropLocationStatus` (the `locationStatuses` enum was retired); legacy `characters[]` ignored on read (`getCharactersInLocation` walks `c.location` via `_idxCharsByLocation`). |
| `events` | `id`, `name`, `date`, `description`, `short`, `characters[]`, `locations[]`, `priority` [kritická/vysoká/střední/nízká], `tags[]`, `sitting` (number, game session), `order` (int; **internal — not user-editable**, owned by timeline drag-drop; auto-assigned to tail of sitting on first save or when sitting changes). Event-only map pin (optional): `mapX`/`mapY` fractions 0–1 and `mapParentId` (null for world map, location id for a sub-map). Used to mark session progress at a spot that isn't a named Location. The `consequence` field was removed — the timeline is the sole ordering source of truth. |
| `mysteries` | `id`, `name`, `questions[]` (array of `{text, answer}` objects — a question is answered when `answer.trim().length > 0`), `clues[]` (string array — atomic facts the party has collected), `characters[]`, `locations[]`, `solved` (boolean — legacy explicit flag; `Store.isMysterySolved(m)` returns true when `m.solved === true` OR every question is answered, so the field is now a manual override more than a computed state), `priority` [kritická/vysoká/střední/nízká], `linkedTwinId` (DM-only twin link metadata). Legacy string-array `questions[]` → `{text, answer}` via `_migrateQuestionsToObjects`. |
| `historicalEvents` | `id`, `name`, `start`, `end` (free-text year strings — D&D-calendar years, vague ranges, etc.), `summary` (markdown), `body` (markdown), `characters[]`, `locations[]`, `tags[]`, `updatedAt`. Separate from campaign `events` so the timeline stays campaign-only. Sorted on `/historie` by `start` (numeric-aware `localeCompare`). |
| `pets` | Lightweight companions (Mazlíčci). `id`, `name`, `icon` (emoji, default 🐾), `portrait` (optional uploaded URL — reuses `/api/portrait/:id`), `species` (short free text), `note`, `ownerType` (`'none'`\|`'party'`\|`'character'`\|`'faction'`), `ownerId` (`''` for none/party · charId · factionId), `updatedAt`. Plain **public, non-visibility-bearing** list collection (no twin/visibility wiring). `getPartyPets()` (party-owned + individual-PC-owned) flanks the dashboard party grid; faction/character articles show their own pets. Deleting an owning character/faction reassigns its pets to `ownerType:'none'` (see `_orphanPetsOf` in store.js) so they survive. See **Pets (Mazlíčci)**. |
| ~~`mapPins`~~ | **REMOVED.** Folded into `locations` in a prior deploy. All `saveMapPin`/`deleteMapPin`/`getMapPins` shims are gone. |
| `factions` | keyed object. `name`, `color`, `textColor`, `badge`, `description`, `rankChains[]`, `attitudes[]` (array of `{id}` — faction-level stance inherited by characters with empty own-attitudes via `Store.getEffectiveAttitudes`). Each chain is `{id, name, ranks: string[]}` — the character editor's "řetězec hodností" dropdown stores `character.rankChain = chain.id`, and `character.rank` stores the selected rank string. Seeded with `attitudes: []` on first load via `_seedFactionAttitudes`. |
| `settings` | keyed-by-category object (`relationshipTypes`, `genders`, `pinTypes`, `characterStatuses`, `eventPriorities`, `attitudes`, `mapViews`, `mapConfigs`, `sidebarLayout`, `playerParty`, `branding`; the legacy `hiddenSidebarPages` is folded into `sidebarLayout.hidden` on read). See Settings section above. `branding` carries `{logoUrl, title, subtitle, updatedAt}` — site logo + sidebar wordmark; empty `logoUrl` renders the bundled `web/branding/logo-default.svg`, a non-empty value points at an uploaded `data/branding/logo.<ext>` (via `POST /api/logo`). `playerParty` carries `{name, icon, badge, color, textColor}` — visual identity of the PC group; member list is derived from `character.faction === PARTY_FACTION_ID` (replaces the legacy `factions.party` keyed-object record via `_migratePartyFactionToPlayerParty`). `sidebarLayout` holds the DM-curated left-nav structure (`{ sections:[{ id, label, icon, collapsible, defaultOpen, role, pages[] }], hidden[] }`) — see **Sidebar structure**. The old `mapStatuses` category was replaced by `attitudes`; `pinTypes[].priority` was replaced by `pinTypes[].size`; `locationStatuses` and `artifactStates` were retired (the location-status icon-variant strategy went unused and `artifactStates` was a purely cosmetic chip). **`pinTypes[i].iconConfig`** (optional) carries custom marker artwork: `{ strategy: 'single' \| 'random', files: [{ id, url }] }`. Files live on disk under `data/icons/<pinTypeId>/<file>` and are uploaded/deleted via `/api/icons/...`. The map-side resolver in [map.js](web/js/map.js) (`_resolveIconUrl`) consumes this config: `single` (default) → `files[0]`; `random` → deterministic per-pin hash across all files. Empty/missing `iconConfig` falls through to the bundled game-icons SVG (`/icons-defaults/<id>.svg` for ids in `BUNDLED_DEFAULT_ICONS`), and finally to the `pinTypes[i].icon` emoji as last resort. `_migrateRetirePinTypeStateStrategy` strips the legacy `state` strategy and any per-file `stateId` markers on load. |
| `campaign` | Keyed-object collection with a single `main` record: `{ name, tagline }`. Used by the dashboard hero. Seeded to `{name:'O Barvách Draků', tagline:''}` on first load. Round-trips through the PATCH handler the same way factions/settings do. |
| `deletedDefaults` | **Keyed object** `{ "<key>": true }`. IDs explicitly deleted (prevents re-merging on restart); also carries `"settings:<cat>:<id>"` tombstones. Was previously a string array — `_mergeDefaults` coerces legacy array shape on load. Tombstones round-trip through the keyed-object PATCH path via the `_tombstone` helper in store.js. |

**PC vs NPC.** A character is a PC iff `Store.isPartyMember(c)` —
currently a wrapper around `c.faction === PARTY_FACTION_ID`. Use
`Store.getPartyMembers()` / `Store.getNPCs()` for filtered lists.
Never inline the faction check; route through the helpers so a
future change to the PC-detection rule (e.g. a dedicated `isPC`
field) is a single-spot edit. `/postavy` lists NPCs only; the
dashboard's *Naše parta* strip and `/parta` list PCs only;
Comboboxes (relationships / event characters) intentionally span
both. NPC-only editor fields live inside `#ef-npc-only-<uid>` in
[edit_templates.js](web/js/edit_templates.js) — add new
stance/perception fields there so they participate in the same
faction-driven toggle (`EditMode.onCharacterFactionChange`).
On save, `EditMode.saveCharacter` strips `attitudes[]` for PCs
since `Store.getEffectiveAttitudes` already short-circuits to the
`party` palette; `_migratePartyAttitudesEmpty` cleans up legacy
rows on load.

⚠ **Faction picker must always offer a default-selected `neutral`
option.** The character editor's faction `<select>`
(`renderCharacterEditor` in [edit_templates.js](web/js/edit_templates.js))
lists `neutral` (👤 Bez frakce) first, then `party`, then the real
factions. The new-character default is `faction:'neutral'`, but there
is no `neutral` *faction* object — so if the picker only emitted
`party + factions`, a `<select>` with no matching `<option>` would
fall back to its first entry. On a **fresh instance (0 factions)** that
first entry is `party`, silently turning every new NPC into a party PC
and hiding it from `/postavy` (`getNPCs` excludes `party`). The
explicit, first, default-selected `neutral` option prevents that; it
also catches deleted-faction ids. `/postavy` grouping renders the
`neutral` bucket as "👤 Neutrální".

**`updatedAt`** — every `Store.saveX()` stamps `entity.updatedAt =
Date.now()` before persist. Surfaces the dashboard "Poslední změny"
feed, the global-search recent suggestions, and any future "last
modified" labels. Absent = treated as 0 and excluded from the feed.
`Store.getRecentActivity(n)` returns the top-n cross-collection
(covered by `test/store-logic.test.mjs`).

**`lastChange`** — alongside `updatedAt`, every primary `saveX` records
a compact "what changed" summary on the entity itself (computed
client-side by `Store.computeChangeSummary(before, after)` — pure,
exported, tested). Shapes: `{created: true}` (first save) ·
`{refs: true}` (cascade write — peer connection sync, dead-ref cleanup;
set via `_noteRefChange`) · `{fields: [{key, from?, to?}]}` (user edit;
`from`/`to` captured only when both sides are scalars ≤ 40 chars — enum
ids, names, numbers — long text/arrays are name-only; capped at 6
entries; internal keys `id/updatedAt/lastChange/order/visibility/
linkedTwinId/addonData/secrets` are skipped). A no-op re-save keeps the
previous summary (`_noteChange`). Values are stored RAW (enum ids,
location ids) — the dashboard resolves labels at render time
(`wiki.js _changeValueLabel`) so previews survive renames and language
switches. Rides the entity JSON through PATCH/`_sanitizePlayerEntity`
untouched; entities saved before this feature show name + time only.
`saveRelationship`/`savePet` don't record it (not in the feed).

**`addonData`** (optional, any entity) — a namespaced envelope
`{ "<addonId>": {…} }` written by addons (Phase 5, see **Addon
framework → Phase 5**). Core code never reads it; it rides inside the
entity's JSON (snapshotted + role-filtered with the entity). Addons
patch only their own namespace via `Store.patchAddonData(collection,
id, addonId, fn)`; the server's `_sanitizePlayerEntity` shallow-merges
a player's incoming namespaces over the existing ones so a normal
player edit can't drop one by omission.

`knowledge` 0 shows heavy blur+grayscale. 4 shows no filter.
Controls SVG sketch effect on portraits.

## Pets (Mazlíčci)

Lightweight companions, deliberately **zero-footprint until used** — with
no pets the only standing change is the single (hideable) sidebar link.
Stored in the `pets` list collection (see Data model).

**Owner model.** `ownerType` is `'none'` (unassigned — prepared in
advance, assigned later), `'party'` (the player party — `playerParty`
identity, NOT a faction), `'character'`, or `'faction'`; `ownerId` holds
the charId/factionId (empty for none/party). `Store.savePet` normalises
`ownerId` to `''` for none/party. On owner deletion,
`deleteCharacter`/`deleteFaction` call `_orphanPetsOf(type, id)` so pets
revert to `'none'` rather than dangle.

**Server.** Plain public list collection — `'pets'` added to
`ALLOWED_TYPES` + `ALL_TYPES` only. Not visibility-bearing, so
`filterForRole` is identity (all roles receive pets) and player saves
pass through `_sanitizePlayerEntity` cleanly. Pictures reuse
`POST /api/portrait/:id` (the id is sanitised, not character-coupled) —
no new endpoint, no Dockerfile change.

**Editor.** `EditMode.openPetEditor(petId|null, prefill)` — a lightweight
modal (modeled on `_passwordPrompt`, NOT a route/article editor) usable
from anywhere. The owner `<select>` reveals a character Combobox or a
faction `<select>`. Emoji always; image upload (reuses
`Store.uploadPortrait`) is gated until the pet has been saved once.
Save/delete → `Store.savePet`/`deletePet`, then
`_refreshTo(window.location.hash)` re-renders the current page; delete
shows an undo toast (`Store.undelete('pets', id)`). Exported on
`EditMode` so card `data-action="EditMode.openPetEditor"` resolves
(ACTIONS maps the module, not individual methods). Pet cards are
`<button>`s — pets have no detail page — and an anonymous click surfaces
the login modal.

**Display surfaces** (all render-on-demand — nothing until a pet exists):
- Dashboard `_dashPartyHtml` — pets owned by the party OR by any
  individual party member (`Store.getPartyPets()`) flank the party grid
  in `.dash-pets-col` columns, **first card on the right** then
  alternating left. No add button here (creation lives on the Mazlíčci
  page / inline on owner articles). Columns stack below the party under
  768 px.
- `/mazlicci` (`renderPetsList`) — every pet grouped by owner.
- Faction/character articles — a `🐾 Mazlíčci` section
  (`_petsArticleSection`) renders only when that owner has pets, plus an
  inline `＋ Mazlíček` for authed viewers.

Shared card renderer `_petCardHtml(pet, {cls})` in wiki.js;
`.dash-pet-card` (flank) / `.pet-card` (page) live in wiki.css, `.pet-modal`
in edit.css. Sidebar link is in `SIDEBAR_PAGES` (constants.js) +
`web/index.html`, hideable via Settings → Postranní panel like any page.

## Twin entity model (visibility pairing)

Players see a curated view of the campaign; DMs see the full lore.
Rather than per-field secret markers, the codebase uses **twin
entities**: two records of the same kind that share a name, link
to each other via `linkedTwinId`, and live in opposite visibility
spaces (one `visibility: 'public'`, one `visibility: 'dm'`). The
player sees only the public half; the DM sees both halves of every
pair plus all DM-only solo entities.

**Data shape.** Every visibility-bearing collection (`characters`,
`locations`, `events`, `mysteries`, `factions`,
`pantheon`, `artifacts`, `historicalEvents`) carries:

- `visibility: 'public' | 'dm'` — defaults to `'public'` (see
  `server/migrations.cjs → runVisibilityMigration`).
- `linkedTwinId` — id of the twin in the same collection (when
  paired). DM-only metadata: `server/visibility.cjs:stripEntityForRole`
  deletes the field from non-DM payloads so the presence of a DM
  twin isn't inferable from the public record's shape.

The visibility-bearing set lives in `VISIBILITY_BEARING` in
`server/visibility.cjs` (also re-exported from server.js for the
PATCH handler's role-gate logic).

**Server-side filtering** (`filterForRole`):
- DM role → identity pass-through.
- Player / anonymous → drop entities with `visibility: 'dm'`, then
  run remaining entities through `stripEntityForRole` (deletes
  `linkedTwinId`). Applied at `GET /api/data` time so non-DM
  callers literally cannot see DM content via DevTools.

**Player save sanitization** (`_sanitizePlayerEntity` in server.js).
A player save through `PATCH /api/data` is forced through:
- `visibility = existing.visibility || 'public'` — players can
  NEVER flip visibility. New player entities are always public.
- `linkedTwinId = existing.linkedTwinId` (preserved verbatim) —
  players don't see the field so they can't intentionally manage
  it; this prevents the link from being silently dropped on the
  next player edit.
- `secrets` field unconditionally stripped (legacy from the
  pre-twin "per-field secret marker" design).

The pre-twin per-field secrets system is retired entirely.
`_sanitizePlayerEntity` also rejects writes to DM-only entities
(player can't see them so can't sensibly write them) and bounces
the whole `settings` / `campaign` collections to DM-only (see
`DM_ONLY_WRITE_TYPES`).

**API.** `POST /api/twin` is the only endpoint that creates,
links, or unlinks twin pairs:
- `action: 'create'` — clones source into the opposite-visibility
  space; sets bidirectional `linkedTwinId`. Relationships are NOT
  auto-mirrored (DM clones those manually if needed).
- `action: 'link'` — marries two existing entities (one public,
  one DM). Used when a player accidentally created a duplicate of
  a DM-only entity — the DM marries them instead of recreating.
- `action: 'unlink'` — clears the link both ways. Entities remain;
  they just stop pointing at each other.
- All twin ops gated on `req.realRole === 'dm'` (impersonating DM
  can't manage twins — the signed claim is what matters here).

**Client API.** `Store.linkTwin(action, type, sourceId, targetId?)`
wraps the POST. `Store.getTwin(collection, entity)` returns the
twin record (or null). `Store.dedupeShadowTwins(collection, list)`
filters list-shaped collections so paired entities show once on
search / aggregate views (drops the public half when the DM half
is present — keeps the DM context).

**UI surfaces.** Twin link / unlink lives in the editor header for
every entity type via `_twinHeaderRow(uid, entity, collection)`
in `edit_templates.js`. The "🔗 Připojit twin" picker (in
`editmode.js`) opens a Jaro-Winkler ranked search of candidate
twins (same collection, opposite visibility, no existing twin).
The `body.is-dm` CSS gate hides every twin affordance from non-DM
viewers.

**Visibility-flip guard.** PATCH `/api/data` rejects saves that
would change `visibility` on a record with an active twin —
flipping would leave both sides in the same space (incoherent).
The DM has to explicitly unlink first.

## Entity IDs

`Store.generateId(name)` returns a slugified name **plus a 6-char
random base36 suffix**: `frulam_mondath_a7b3c9`. Shape is deliberate:
- Readable in hash URLs
- Two entities with the same name get distinct keys — no silent overwrites
- Renaming the entity never changes its id, so links stay stable

Existing records keep whatever id they were created with; only new
creations get the new shape. No migration needed.

## Undo-on-delete

Every `Store.deleteX(id)` snapshots the entity (and cascade-stripped
relationships for characters) into a session-only `_trash` Map
keyed by `${kind}:${id}`. `Store.undelete(kind, id)` re-applies the
snapshot through the public `saveX` APIs. Trash does not survive a
reload — that's the commit point. The edit-mode `deleteX` handlers
trigger `EditMode.toast(msg, true, { action: { label, onClick }})`
which renders an inline "↶ Vrátit" button for 8 seconds. Confirm
dialogs were removed from deletes because undo replaces the safety
net.

## Wiki-links `[[Name]]`

`utils.expandWikiLinks(src)` rewrites `[[Name]]` and `[[Name|kind:id]]`
into markdown links before `marked` parses them. The resolver is
injected from `app.js` at init via `setWikiLinkResolver(fn)` so
`utils.js` stays clean of Store imports. Resolution order (matches
the `order` array in `app.js`):
characters → locations → events → mysteries → pantheon →
artifacts → historicalEvents → factions (factions are a keyed object
so they're scanned separately). The `KIND_ROUTE` in `app.js` maps
collection keys to their wiki route prefixes (e.g.
`historicalEvents → 'historicka-udalost'`). Unresolved links render
as `<span class="wlink-missing">[[text]]</span>` (dashed red underline,
"Nenalezeno" tooltip). Disambiguation syntax: `[[Frulam|postava:frulam_a7b3c9]]`
(explicit id) or `[[Frulam|postava]]` (scope search).

## Store API

`Store` is the single data source. Never mutate `_data` directly.

Getters:
`getCharacters()` · `getRelationships()` · `getLocations()` · `getEvents()` ·
`getMysteries()` · `getPantheon()` · `getArtifacts()` ·
`getHistoricalEvents()` · `getFactions()` · `getFaction(id)` · `getStatusMap()`

Pets: `getPets()` · `getPet(id)` · `getPetsForOwner(ownerType, ownerId)`
(`'none'`/`'party'` ignore `ownerId`) · `getPartyPets()` — party-owned
plus individual-party-member-owned, in that order (the dashboard flank) ·
`getPetOwner(pet)` → `{label, icon, href}` owner descriptor (`href` null
for none/deleted owner).

Pin/hierarchy getters (Locations replace pins):
`getLocationsOnMap(parentId)` returns Locations placed on the given
parent map (`null`/omitted = world map). `getSubLocations(parentId)`
returns child Locations regardless of placement. `getAncestorLocations(id)`
walks the `parentId` chain (cycle-guarded) for breadcrumb rendering.
`getPinForLocation(lid)` is now a derived view returning a pin-shaped
object from a placed Location.

Single-item getters:
`getCharacter(id)` · `getLocation(id)` · `getEvent(id)` · `getMystery(id)` ·
`getBuh(id)` · `getArtifact(id)` · `getHistoricalEvent(id)` ·
`getCollection(name)` (generic — any collection by name string, used by the twin
picker and visibility helpers).

Save. Upsert by id. Fires PATCH to server. Every save stamps
`entity.updatedAt = Date.now()` before persisting.
`saveCharacter(c)` · `saveRelationship(r)` · `saveLocation(l)` ·
`saveEvent(e)` · `saveMystery(m)` · `saveBuh(g)` ·
`saveArtifact(a)` · `saveHistoricalEvent(h)` · `saveFaction(id, f)` ·
`savePet(p)` (normalises `ownerId` to `''` for none/party owners).

`saveLocation` maintains **connection symmetry**: `connections[]` is
undirected, so adds/removes mirror onto the peer Location and each
touched peer is persisted with its own `_sync` call. Pin fields
(`x`/`y`/`pinType`/`size`/`parentId`/`mapNotes`) survive edits via
the spread `{...existing, ...formFields}`; to unplace from the map,
save the Location with `x`/`y` cleared.
`saveMapPin` / `deleteMapPin` / `getMapPins` have been **removed**
entirely — no shims remain.

Delete:
`deleteCharacter(id)` · `deleteRelationship(source, target, type)` ·
`deleteLocation(id)` · `deleteEvent(id)` · `deleteMystery(id)` ·
`deleteBuh(id)` · `deleteArtifact(id)` ·
`deleteHistoricalEvent(id)` · `deleteFaction(id)` · `deletePet(id)`
(trashes for undo via `undelete('pets', id)`; removes the portrait file).
`deleteLocation` cascades: strips the dead id from every peer's
`connections[]`, clears `parentId` on children, clears `c.location`
and strips `c.locationRoles[]` entries on any character that
referenced it (the canonical "where they are" pointer must not
dangle), and persists each touched peer + character.

Indexed reverse lookups. Each save/delete invokes only the
per-collection reindex helper(s) it could affect — saving a
character calls `_reindexCharacters()` only, not the full
`_reindex()`. `_reindex()` (the union) is reserved for `load()`.
The five helpers are `_reindexCharacters` / `_reindexRelationships`
/ `_reindexEvents` / `_reindexMysteries` / `_reindexLocations`.
`getCharactersByFaction(fid)` · `getCharactersInLocation(lid)` covers
`.location` and `locationRoles[]` · `getRelationshipsFor(cid)` both
directions · `getEventsWithCharacter(cid)` · `getEventsAtLocation(lid)` ·
`getMysteriesWithCharacter(cid)` · `getPinForLocation(lid)`. New:
`_idxChildLocations` (parentId → children).

Each reindex helper also calls `_bustMarkdownCache()` to invalidate
the LRU memo of rendered markdown — wiki-link `[[Name]]` resolution
walks every collection, so a rename or creation can change the link
target, and any cached HTML referencing the old target would be
stale.

Search. Diacritic-insensitive substring over name + title + tags (plus
body/summary for historicalEvents, description for artifacts,
domain for pantheon).
`searchCharacters(q)` · `searchLocations(q)` · `searchEvents(q)` ·
`searchMysteries(q)` · `searchPantheon(q)` ·
`searchArtifacts(q)` · `searchHistoricalEvents(q)` ·
`searchAll(q)` returns
`{characters, locations, events, mysteries, pantheon, artifacts, historicalEvents}`.

Campaign metadata (dashboard hero):
`getCampaign()` → `{ name, tagline }` with defaults substituted when
unset. `setCampaign(patch)` merges the patch over the current values
and persists. Backed by the `campaign` keyed-object collection with
a single `main` record.

Question / unknown helpers:
`isQuestionAnswered(entry)` — true when `entry.answer` is a non-empty
string. Used for both mystery `questions[]` and character `unknown[]`
since the post-migration shape is identical (`{text, answer}`).
`isMysterySolved(m)` — `m.solved === true` OR every question
answered. `getOpenQuestions()` returns a flat list across the whole
campaign: `[{source: 'mystery'|'character', sourceEntity, index, text}]`
walks both mysteries' `questions[]` AND characters' `unknown[]`, used
by the /zahady aggregate view. `questionText(q)` / `questionAnswer(q)`
are defensive accessors that survive pre-migration string entries.

Twin helpers (DM-only feature, see "Twin entity model"):
`linkTwin(action, type, sourceId, targetId?)` — POSTs `/api/twin`
with action `'create' | 'link' | 'unlink'`. `getTwin(collection,
entity)` returns the linked twin record (or null). `dedupeShadowTwins(collection, list)`
filters list-shaped collections so each twin pair shows once on
search / aggregate views — drops the public half when the DM-half
already linked it. `isVisibleTo(entity, role)` for role-aware
predicates outside the server filter (the server-side `filterForRole`
in `server/visibility.cjs` is the truth; this is for UI gating).

Player party:
`getPlayerParty()` / `setPlayerParty(patch)` — visual identity
record for the PC group (name, icon, badge, colour, textColor).
Stored in `settings.playerParty` (migrated from the old
`factions.party` record). Member list is derived from
`character.faction === PARTY_FACTION_ID`, not stored on the party
record.

Appearance (visual theme):
`getAppearance()` / `setAppearance(patch)` — `{theme}` in
`settings.appearance` (DM-only write). `Settings.applyTheme()` activates
it via `<html data-theme>`; themes live in `web/css/themes.css` + the
`THEMES` registry (constants.js), default `classic` = the `:root`
baseline. See Settings → **Vzhled**.

Site branding:
`getBranding()` / `setBranding(patch)` — logo + sidebar wordmark
config (`{logoUrl, title, subtitle, updatedAt}`) in
`settings.branding`. `uploadLogo(file)` POSTs `/api/logo` and
resolves the new `/branding/logo.<ext>` URL (caller persists it via
`setBranding`); `deleteLogo()` DELETEs it (revert to bundled
default). `Settings.applyBranding()` is what pushes the config onto
the chrome.

File uploads:
`uploadPortrait(file, charId)` returns URL; `deletePortrait(url)`
removes one. `uploadLocalMap(file, locId)` returns URL (saved
under `/maps/local/{locId}/map.{ext}`). `uploadIcons(pinTypeId,
files)` for marker-icon variant upload; `deleteIcon(pinTypeId,
fileId)` / `deleteIcons(pinTypeId)` for cleanup.

Enum management:
`getEnum(category)` · `getEnumValue(category, id)` ·
`saveEnumItem(category, item)` · `deleteEnumItem(category, id,
{replaceWith, force})` · `findEnumUsages(category, id)` returns
`[{collection, field, id, name}]` for the delete-with-usage modal ·
`resetEnumCategory(category)` re-adds missing defaults without
touching user edits.

Data-driven "kinds" registry (base/DM settings + addon layer):
`getKinds(domain)` merges the settings-backed base/DM list for a domain
with the addon-registered layer (addon ids namespaced `<addonId>:<id>`,
base wins on collision). `getKind(domain, id)` resolves one (orphan-safe;
`connections` orphans carry the rel-type shape). `setAddonKindProvider(fn)`
is the late-binding seam app.js uses to inject the addon layer
(`Addons.kindsForDomain`) so store.js never imports addons.js. The
`_KIND_DOMAIN_CATEGORY` map wires each DATA enum domain to its settings
category: `connections`→`relationshipTypes` (seeded from `REL_TYPES`),
`statuses`→`characterStatuses`, `priorities`→`eventPriorities`,
`attitudes`→`attitudes`, `genders`→`genders`, `pinTypes`→`pinTypes`. Addon
kinds are contributed via the **generic** host method
`registerKind(domain, def)` (permission `kinds:<domain>`;
`registerConnectionKind` is a back-compat alias for
`registerKind('connections', …)`); the addon-side registry is a single
`_dataKinds` Map keyed by domain. **`getKinds` is RENDERER-only — the
Settings enum editor stays settings-only** (`getEnum`/`getEnumValue`/
`saveEnumItem`/`deleteEnumItem`/`findEnumUsages` never merge addon kinds,
so addon kinds are NOT editable/deletable rows in Settings). With zero
addons, `getKinds(domain)` === `getEnum(category)`.

Central renderer resolvers repointed to the merged registry (so addon
kinds render everywhere for free): `getStatusMap()` (statuses — the single
status resolver behind cloudmap/wiki/map), `_attitudeColorMap()` +
`_attitudeGlow` strength lookup in `wiki.js` and `_pinStatuses()` /
`_resolveAttitudeStripes()` / the pin side-panel strength label in `map.js`
(attitudes), the character-editor gender `<select>` and the event-editor
priority `<select>` in `edit_templates.js` (genders / priorities). Attitude
FILTER-chip / editor-chip rows and the cloudmap hardcoded priority-colour
switch are deliberately left on `getEnum` (they present the editable
settings list / are out of scope). The cloudmap, the relationship editor
(`edit_templates`/`editmode`), and the wiki relation chips read
`getKinds('connections')`. `REL_TYPES`/`getRelType`/`relLabel` remain in
data.js only as the seed + latent helpers.

Content slots (additive `Addons.slotContent(slotId, ctx)`, zero-cost
without addons, each item wrapped in a `data-addon-id` div) now also
fire on the **dashboard** (`dashboard:section`, ctx `{role}`) and the
**world-map pin side-panel** (`map:pin:panel`, ctx `{location, pin, role}`)
— in addition to the existing timeline slots.

Utilities:
`generateId(name)` slugifies. Lowercase. NFD-normalized. Max 40 chars.
`load()` is async. Fetches `/api/data`, merges defaults, then runs
idempotent migrations. Each migration helper returns the entities it
touched so `load()` syncs each via the per-entity PATCH path (no
whole-dataset wipe). On an empty server, `load()` keeps defaults
locally — first user edit lazily creates files server-side.
`exportJSON()` for download.

⚠ **`load()` layers the server payload OVER `_defaults()`**
(`_data = { ..._defaults(), ...serverData }`), NOT a bare
`_data = serverData`. The server omits collections that have no file
yet (a fresh instance where the user added characters but never a
relationship has no `relationships.json`), so a wholesale replace
left those keys `undefined` and any getter doing `_data.X.filter(…)`
(e.g. `getRelationships()` in the character article) threw — breaking
every article render on a fresh dataset. Spreading defaults first
guarantees every collection key exists (empty array / object);
present keys are still overridden by the server (source of truth).
Keep this when adding a new collection.

Tombstones (`_data.deletedDefaults`) round-trip through the keyed-
object PATCH path via `_tombstone(key)`. Used by `deleteCharacter` /
`deleteCharacter` (default-id removal) and `deleteEnumItem` (settings
default removal). The previous `Store.reset` / `Store.exportJS` /
`Store.importJSON` were dead code paired to the removed POST
`/api/data` route; all three were removed.

## Frontend write queue

`Store._sync(type, action, payload)` no longer fires-and-forgets.
It enqueues the PATCH onto `_writeChain` (a Promise chain), retries
transient failures (network / 5xx) up to 3 times with exponential
backoff (200 ms, 800 ms), and surfaces:

- `store:auth-failed` — 401 from server (cookie expired/invalid)
- `store:save-failed` — `{ type, action, status? }` after retries
  exhausted or for terminal 4xx
- `store:inflight` — `{ count }` whenever the queue depth changes;
  consumers can show a "Saving…" indicator

Local mutations are *not* rolled back on server failure — the next
page load reconciles from the server's truth. The `store:save-failed`
banner in `app.js` lets the user know to refresh.
