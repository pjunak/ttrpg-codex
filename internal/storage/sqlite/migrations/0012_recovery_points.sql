-- Recovery images contain campaign state only. Credentials, package lifecycle,
-- audit history and optimistic revision tombstones are never rewound.
CREATE TABLE recovery_control (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0, 1)),
    last_capture REAL NOT NULL DEFAULT 0
) STRICT;
INSERT INTO recovery_control(singleton) VALUES (1);

CREATE TABLE recovery_points (
    point_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('manual', 'save', 'pre-restore')),
    image_json TEXT NOT NULL CHECK(json_valid(image_json) AND length(CAST(image_json AS BLOB)) <= 67108864)
) STRICT;

CREATE TABLE recovery_restores (
    restore_id INTEGER PRIMARY KEY AUTOINCREMENT,
    point_id INTEGER NOT NULL,
    safety_point_id INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL
) STRICT;

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

CREATE TRIGGER recovery_point_inserted AFTER INSERT ON recovery_points BEGIN
    UPDATE recovery_control SET last_capture = CASE
        WHEN NEW.reason = 'save' THEN unixepoch('subsec')
        WHEN NEW.reason = 'pre-restore' THEN 0 ELSE last_capture END,
        revision = revision + 1 WHERE singleton = 1;
    DELETE FROM recovery_points WHERE point_id NOT IN (SELECT point_id FROM recovery_points ORDER BY point_id DESC LIMIT 50);
END;

CREATE TRIGGER recovery_campaign_collections_insert BEFORE INSERT ON campaign_collections
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_campaign_collections_update BEFORE UPDATE ON campaign_collections
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_campaign_collections_delete BEFORE DELETE ON campaign_collections
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_campaign_records_insert BEFORE INSERT ON campaign_records
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_campaign_records_update BEFORE UPDATE ON campaign_records
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_campaign_records_delete BEFORE DELETE ON campaign_records
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_addon_data_sets_insert BEFORE INSERT ON addon_data_sets
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_addon_data_sets_update BEFORE UPDATE ON addon_data_sets
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_addon_data_sets_delete BEFORE DELETE ON addon_data_sets
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_addon_documents_insert BEFORE INSERT ON addon_documents
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_addon_documents_update BEFORE UPDATE ON addon_documents
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_addon_documents_delete BEFORE DELETE ON addon_documents
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_blobs_insert BEFORE INSERT ON blobs
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_blobs_update BEFORE UPDATE ON blobs
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_blobs_delete BEFORE DELETE ON blobs
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

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

CREATE TRIGGER recovery_addon_package_states_insert BEFORE INSERT ON addon_package_states
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_addon_package_states_update BEFORE UPDATE ON addon_package_states
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER recovery_addon_package_states_delete BEFORE DELETE ON addon_package_states
WHEN (SELECT suppressed = 0 FROM recovery_control WHERE singleton = 1)
BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
END;
