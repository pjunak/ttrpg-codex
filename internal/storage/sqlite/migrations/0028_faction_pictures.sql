-- Factions carry an uploaded picture (media kind 'faction-picture'). SQLite
-- cannot alter a CHECK constraint, so the media table is rebuilt with the new
-- kind; its rows keep their sequence, and the recovery view and the table's
-- triggers and index are recreated unchanged.
DROP VIEW recovery_image;

CREATE TABLE core_media_assets_next (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(blob_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN (
        'character-portrait',
        'faction-picture',
        'companion-portrait',
        'location-map',
        'world-map',
        'marker-icon',
        'branding-logo'
    )),
    target_key TEXT NOT NULL CHECK(length(target_key) BETWEEN 1 AND 1024),
    created_at TEXT NOT NULL
);
INSERT INTO core_media_assets_next(sequence, blob_id, kind, target_key, created_at)
SELECT sequence, blob_id, kind, target_key, created_at
FROM core_media_assets;
DROP TABLE core_media_assets;
ALTER TABLE core_media_assets_next RENAME TO core_media_assets;

CREATE INDEX core_media_assets_target
    ON core_media_assets(kind, target_key, sequence DESC);

CREATE TRIGGER recovery_core_media_assets_insert BEFORE INSERT ON core_media_assets
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_core_media_assets_update BEFORE UPDATE ON core_media_assets
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_core_media_assets_delete BEFORE DELETE ON core_media_assets
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE VIEW recovery_image AS SELECT json_object(
    'version', 1,
    'collections', (SELECT json_group_array(json_object('name', name, 'shape', shape, 'materialized', materialized)) FROM (SELECT name, shape, materialized FROM campaign_collections ORDER BY name)),
    'records', (SELECT json_group_array(json_object('collection_name', collection_name, 'record_key', record_key, 'position', position, 'body_json', body_json, 'visibility', visibility, 'created_at', created_at)) FROM (SELECT collection_name, record_key, position, body_json, visibility, created_at FROM campaign_records ORDER BY collection_name, position)),
    'sets', (SELECT json_group_array(json_object('addon_id', addon_id, 'data_kind', data_kind, 'data_id', data_id, 'materialized', materialized, 'schema_version', schema_version, 'schema_sha256', schema_sha256, 'target_collection', target_collection, 'keyed', keyed)) FROM (SELECT addon_id, data_kind, data_id, materialized, schema_version, schema_sha256, target_collection, keyed FROM addon_data_sets ORDER BY addon_id, data_kind, data_id)),
    'documents', (SELECT json_group_array(json_object('addon_id', addon_id, 'data_kind', data_kind, 'data_id', data_id, 'document_key', document_key, 'position', position, 'body_json', body_json, 'schema_version', schema_version, 'schema_sha256', schema_sha256, 'created_at', created_at, 'target_created_at', target_created_at)) FROM (SELECT addon_id, data_kind, data_id, document_key, position, body_json, schema_version, schema_sha256, created_at, target_created_at FROM addon_documents ORDER BY addon_id, data_kind, data_id, position, document_key)),
    'blobs', (SELECT json_group_array(json_object('blob_id', blob_id, 'deleted', deleted)) FROM (SELECT blob_id, deleted FROM blobs ORDER BY blob_id)),
    'assets', (SELECT json_group_array(json_object('sequence', sequence, 'blob_id', blob_id, 'kind', kind, 'target_key', target_key, 'created_at', created_at)) FROM (SELECT sequence, blob_id, kind, target_key, created_at FROM core_media_assets ORDER BY sequence)),
    'packages', (SELECT json_group_array(json_object('addon_id', addon_id, 'active_generation_id', active_generation_id)) FROM (SELECT addon_id, active_generation_id FROM addon_package_states WHERE active_generation_id IS NOT NULL ORDER BY addon_id))
) AS image_json;
