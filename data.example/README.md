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
│       └── {mapId}/{z}/{x}/{y}.jpg    #   mapId = `world` or `local-{locId}`
│
├── portraits/                         # Character / pet portraits
│   └── {charId}/portrait.{ext}        #   served at /portraits/{id}/...
│
├── icons/                             # Custom marker artwork
│   └── {pinTypeId}/{file}.{svg,png}   #   served at /icons/{id}/...
│
├── branding/                          # Custom site logo (optional)
│   └── logo.{ext}                     #   served at /branding/...
│
├── addons/                            # Installed addon CODE
│   └── {addonId}/{contentHash}/       #   content-addressed versions
├── addon-data/                        # Per-addon isolated data
│   └── {addonId}/{collection}.json
├── addons.json                        # Addon registry (versions, grants)
│
├── characters.json                    # Per-collection JSON files
├── relationships.json
├── locations.json
├── events.json
├── mysteries.json
├── factions.json
├── pets.json
├── pantheon.json
├── artifacts.json
├── historicalEvents.json
├── settings.json                      # User-editable enums + chrome config
├── campaign.json                      # Campaign name + tagline
├── deletedDefaults.json               # Tombstones for removed seed entries
└── auth.json                          # Salted password hashes (set in-app;
                                       #   excluded from snapshots + data hash)
```

Snapshots live in a sibling directory (`data-snapshots/`), not inside
`data/`. See [`docs/SELF_HOSTING.md`](../docs/SELF_HOSTING.md) for
backup, restore, and snapshot operations.
