# `data/` — Server Data Directory

This folder shows the expected layout of the runtime `data/` directory.
The real `data/` is gitignored — it lives as a Docker volume and is
never committed.

## Layout

```
data/
├── maps/
│   ├── swordcoast/                    # World-map backdrop image
│   │   └── sword_coast.{jpg,png}      #   served at /maps/swordcoast/...
│   ├── local/                         # Per-location sub-map images
│   │   └── {locationId}/map.{ext}     #   served at /maps/local/{id}/...
│   └── tiles/                         # Generated tile pyramids (sharp)
│       └── {mapId}/{z}/{x}/{y}.jpg
│
├── portraits/                         # Character portraits
│   └── {charId}/portrait.{ext}        #   served at /portraits/{id}/...
│
├── icons/                             # Custom marker artwork
│   └── {pinTypeId}/{file}.{svg,png}   #   served at /icons/{id}/...
│
├── characters.json                    # Per-collection JSON files
├── relationships.json
├── locations.json
├── events.json
├── mysteries.json
├── factions.json
├── pantheon.json
├── artifacts.json
├── historicalEvents.json
├── settings.json                      # User-editable enums
├── campaign.json                      # Campaign name + tagline
└── deletedDefaults.json               # Tombstones for removed seed entries
```

Snapshots live in a sibling directory (`data-snapshots/`), not inside
`data/`. See [`docs/SELF_HOSTING.md`](../docs/SELF_HOSTING.md) for
backup, restore, and snapshot operations.
