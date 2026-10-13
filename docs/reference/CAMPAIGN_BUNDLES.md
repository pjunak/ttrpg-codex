# Writing campaign bundles

A campaign bundle creates new characters, locations and relationships, and can
carry a DM Tools planning document, in one reviewed import. Use it to bring
prepared content into a campaign, whether written by hand or by an agent. The
DM reviews the exact result in the Import Center and commits it as a single
transaction; nothing is written before that.

The [schema](../../internal/application/campaignimport/campaign-bundle.schema.json)
is the authority for fields. [ADR-0001](../decisions/0001-campaign-bundle-imports.md)
explains ownership, review and the authority model. Planning content follows the
DM Tools [content-generation guide](../../../addon-dm-tools/docs/AGENT_GENERATION.md).

## What a bundle can and cannot do

A bundle **creates** characters, locations and relationships. It cannot update
or delete core records, or create factions, mysteries, artifacts, events,
settings, media or accounts. To change an existing record, edit it on the site.

The Import Center page belongs to the DM Tools add-on, so a site needs DM Tools
installed to import bundles. Bundles appear there as **Campaign bundle**.

## Workflow

1. Collect what the bundle must fit: the story brief, the IDs of existing
   records it refers to, and the campaign's own values for statuses, attitudes,
   relationship types and map markers (see [campaign-defined values](#campaign-defined-values)).
   For planning, also download a planning export from the Import Center.
2. Write the bundle as one UTF-8 JSON file of at most 2 MiB.
3. Validate it against the schema with a JSON Schema draft 2020-12 validator.
   If it contains planning, run DM Tools' `go run ./cmd/check-plan bundle.json
   export.json`, which checks the planning document.
4. In the Import Center, choose the file and read the preview: the reserved IDs,
   and the DM view and player view of every record.
5. Commit, or cancel and revise.

Preview errors do not name the failing record: problems with the schema or
references report *The bundle has invalid records or references*, and core
rule violations report *The bundle violates campaign invariants*. Validating
first saves guesswork.

## Envelope

~~~json
{
  "format": "ttrpg-codex-campaign-bundle",
  "schemaVersion": 1,
  "generatedAt": 1791744000000,
  "records": {
    "characters": [],
    "locations": [],
    "relationships": []
  },
  "addonImports": []
}
~~~

`generatedAt` is the time the file was written, in epoch milliseconds. Each
array in `records` is optional, and so is `addonImports`. No other fields are
allowed anywhere in the bundle except inside an `addonImports` document, which
its add-on validates.

Every record entry has the same shape:

~~~json
{ "ref": "oren-vale", "operation": "create", "record": { "name": "Oren Vale", "visibility": "public" } }
~~~

- `ref` is a local name, unique across the whole bundle, matching
  `^[a-z][a-z0-9._-]{1,99}$`. Other entries use it to refer to this record.
- `operation` is always `create`.
- `record` holds the record's fields. `visibility` is required on every record.

The host chooses the final IDs during preview and shows them under
**Reserved IDs and references**. Characters and locations receive random
48-character hexadecimal IDs; a relationship's ID comes from its source,
target and type.

## Records

### Characters

| Field | Meaning |
| --- | --- |
| `name` (required) | Display name, 1–500 characters |
| `visibility` (required) | `public` or `dm` |
| `title`, `species`, `age` | Short free text |
| `description` | Markdown article text |
| `circumstances` | Current circumstances, up to 1,000 characters |
| `location` | Current location: a [reference](#references) to a location |
| `locationRoles` | Other locations: `[{"locationId": reference, "role": "text"}]` |
| `faction` | Key of an existing faction; `party` marks a party member |
| `status`, `gender` | IDs from the campaign's character statuses and genders |
| `attitudes` | Attitudes toward the party: `[{"id": "attitude-id"}]` |
| `knowledge` | How much players know, 0–4 (see [visibility](#visibility-and-knowledge)) |
| `known` | Known facts, as an array of strings |
| `unknown` | Open questions: `[{"text": "question", "answer": ""}]`; an answer closes the question |
| `tags` | Array of strings |

Leave out `portrait`, `rank` and `rankChain`: portraits are uploaded media,
and ranks need the exact IDs of a faction's rank chain.

### Locations

| Field | Meaning |
| --- | --- |
| `name` (required) | Display name, 1–500 characters |
| `visibility` (required) | `public` or `dm` |
| `type`, `region` | Kind of place and region, as free text |
| `description`, `history` | Markdown article text |
| `parentId` | The containing location: a [reference](#references) |
| `connections` | Connected locations: an array of references |
| `pinType` | ID from the campaign's map markers |
| `x`, `y` | Map marker position, as fractions 0–1 of the map image's width and height |
| `size` | Marker size, 14–64 |
| `mapNotes` | Notes shown with the map marker and on the location page |
| `attitudes`, `knowledge`, `tags` | As for characters |

Leave out `status`, which the location editor does not use. The schema does not
include a location's private DM notes; put private material in a DM-visibility
record or in planning.

### Relationships

| Field | Meaning |
| --- | --- |
| `source` (required) | A character reference |
| `target` (required) | A character reference, or a location reference for location-target types |
| `type` (required) | A relationship type ID from the campaign settings |
| `label` | Short description shown on the relationship |
| `visibility` (required) | `public` or `dm` |

The target is a location when `type` is `mission` or a relationship type whose
settings say it targets locations; otherwise it is a character. Only one
relationship can exist for each source, target and type.

## References

A field that points at another record takes a typed reference, never a plain
string:

~~~json
{ "$ref": "grey-ferry" }
{ "$id": { "collection": "locations", "id": "existing-location-id" } }
~~~

`$ref` names an entry in this bundle. `$id` names an existing record, whose ID
is the last part of its page address, `#/<collection>/<id>`. Either form must
name the collection the field expects, and an `$id` record must exist.

| Field | Expected collection |
| --- | --- |
| Character `location`, `locationRoles[].locationId` | `locations` |
| Location `parentId`, `connections[]` | `locations` |
| Relationship `source` | `characters` |
| Relationship `target` | `characters`, or `locations` as described above |

## Visibility and knowledge

`public` records are visible to players; `dm` records are visible only to the
DM, and players do not see relationships that involve them. Party characters
must be public. The player view in the preview is the exact player projection,
but it does not scan prose: a secret written into a public description is
shown to players.

`knowledge` follows the host's current [reading convention](CORE_DATA.md#character-knowledge-and-dm-inspection):
0 hides the identity, 1 shows the name, and 2–4 show the profile. It is not a
security boundary. The knowledge model is still
[undecided](../design/knowledge-and-investigation.md); use the levels as they
are and do not invent new meanings for them.

## Campaign-defined values

Some fields hold IDs the DM defines in the campaign's settings. Use the
campaign's own IDs; do not invent new ones.

| Field | Settings list |
| --- | --- |
| Character `status` | Character statuses |
| Character `gender` | Genders |
| Location `pinType` | Map markers |
| `attitudes[].id` | Attitudes |
| Relationship `type` | Relationship types |

An empty list in Settings offers a starter set that the DM can add and edit.
Its IDs include `alive`, `dead`, `ally`, `enemy`, `city` and `hostile`, but a
campaign may have changed or replaced them, so read the actual list.

## Planning in the same bundle

Add one `addonImports` entry for DM Tools:

~~~json
{
  "addonId": "dm-tools",
  "contributorId": "planning-json",
  "document": { "format": "dm-tools-planning", "schemaVersion": 3, "...": "..." }
}
~~~

The document is an ordinary DM Tools planning document with the usual merge
rules. Anywhere inside it, an exact `{"$ref": "local-name"}` object is replaced
by the final ID of that bundle record. Use this as the `id` of a core target to
point planning at a new character or location. Do not use it for
relationships: their IDs are not valid planning target IDs.

A bundle may have up to eight `addonImports` entries, one per add-on.

## Limits

| Limit | Value |
| --- | --- |
| File size | 2 MiB |
| Core records | 128 |
| Total writes, core and planning together | 1–256 |
| `addonImports` entries | 8, one per add-on |
| Preview lifetime | 15 minutes, or until the server restarts |

A changed campaign record or planning record between preview and commit
cancels the commit; choose the file again for a fresh preview. If the commit
reply is lost, **Check import result** reads the saved outcome without writing
again.

## Example

This bundle creates a public landing, a DM-only hideout inside it, two
characters, a DM-only relationship, and a planning quest that references the
new characters and locations. `ally` stands for one of the campaign's
relationship types.

~~~json
{
  "format": "ttrpg-codex-campaign-bundle",
  "schemaVersion": 1,
  "generatedAt": 1791744000000,
  "records": {
    "locations": [
      {
        "ref": "grey-ferry",
        "operation": "create",
        "record": {
          "name": "Grey Ferry",
          "visibility": "public",
          "region": "Riverlands",
          "description": "A rope ferry and a bell post on the south bank of the river."
        }
      },
      {
        "ref": "smugglers-hollow",
        "operation": "create",
        "record": {
          "name": "Smugglers' hollow",
          "visibility": "dm",
          "parentId": { "$ref": "grey-ferry" },
          "description": "A dry hollow under the landing where the ferryman hides other people's cargo."
        }
      }
    ],
    "characters": [
      {
        "ref": "oren-vale",
        "operation": "create",
        "record": {
          "name": "Oren Vale",
          "visibility": "public",
          "title": "Ferryman",
          "description": "Weathered, patient and careful about what he admits to strangers.",
          "location": { "$ref": "grey-ferry" }
        }
      },
      {
        "ref": "ila-brand",
        "operation": "create",
        "record": {
          "name": "Ila Brand",
          "visibility": "public",
          "title": "Courier",
          "description": "The missing courier. She crossed on Oren's ferry before the bridge failed."
        }
      }
    ],
    "relationships": [
      {
        "ref": "oren-helps-ila",
        "operation": "create",
        "record": {
          "source": { "$ref": "oren-vale" },
          "target": { "$ref": "ila-brand" },
          "type": "ally",
          "label": "Hid her from pursuers",
          "visibility": "dm"
        }
      }
    ]
  },
  "addonImports": [
    {
      "addonId": "dm-tools",
      "contributorId": "planning-json",
      "document": {
        "format": "dm-tools-planning",
        "schemaVersion": 3,
        "generatedAt": 1791744000000,
        "mode": "merge",
        "items": [
          {
            "operation": "create",
            "id": "ferry-quest",
            "schemaVersion": 3,
            "kind": "quest",
            "parentId": null,
            "title": "The ferryman's silence",
            "summary": "Oren knows where the courier is hiding but will not say so to strangers.",
            "body": "",
            "objective": "Learn where Ila Brand is hiding.",
            "setup": "",
            "resolution": "",
            "tags": ["ferry"]
          },
          {
            "operation": "create",
            "id": "ferry-ask-oren",
            "schemaVersion": 3,
            "kind": "event",
            "eventType": "story",
            "parentId": "ferry-quest",
            "title": "Ask the ferryman",
            "summary": "A conversation at the bell post.",
            "body": "## Approaches\nOren answers honest concern for Ila, not threats or coin.",
            "objective": "",
            "setup": "",
            "resolution": "",
            "tags": ["ferry"]
          }
        ],
        "flowLinks": [],
        "references": [
          {
            "operation": "create",
            "id": "ferry-ref-oren",
            "schemaVersion": 3,
            "itemId": "ferry-ask-oren",
            "name": "Oren Vale",
            "relation": "features",
            "target": { "scope": "core", "collection": "characters", "id": { "$ref": "oren-vale" } },
            "quantity": 1,
            "notes": ""
          }
        ],
        "consequences": [
          {
            "operation": "create",
            "id": "ferry-hollow-revealed",
            "schemaVersion": 3,
            "anchor": { "scope": "item", "itemId": "ferry-ask-oren" },
            "kind": "information",
            "title": "The hollow",
            "body": "If Oren trusts the party, he shows them the hollow where Ila is sheltering.",
            "target": { "scope": "core", "collection": "locations", "id": { "$ref": "smugglers-hollow" } }
          }
        ],
        "notes": []
      }
    }
  ]
}
~~~

Its preview lists five core creates and four planning creates. Players see the
landing and both characters, but not the hollow or the relationship.
