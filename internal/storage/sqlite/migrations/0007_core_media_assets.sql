CREATE TABLE core_media_assets (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(blob_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN (
        'character-portrait',
        'pet-portrait',
        'location-map',
        'world-map',
        'marker-icon',
        'branding-logo'
    )),
    target_key TEXT NOT NULL CHECK(length(target_key) BETWEEN 1 AND 1024),
    created_at TEXT NOT NULL
);

CREATE INDEX core_media_assets_target
    ON core_media_assets(kind, target_key, sequence DESC);
