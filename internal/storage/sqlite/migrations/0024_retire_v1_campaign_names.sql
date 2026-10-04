-- Finish moving converted v1 campaigns onto native names and data.
-- v1 "deleted default" tombstones and the hiddenSidebarPages preference are
-- never read by the host; companions were stored under the v1 name "pets";
-- activity summaries still used the v1 shape; recovery points no longer carry
-- the combined-restore "partial" marker.

-- Remove the deletedDefaults collection and everything recorded for it.
DELETE FROM campaign_commit_records WHERE collection_name = 'deletedDefaults';
DELETE FROM campaign_record_versions WHERE collection_name = 'deletedDefaults';
DELETE FROM campaign_records WHERE collection_name = 'deletedDefaults';
DELETE FROM campaign_collections WHERE name = 'deletedDefaults';
DELETE FROM change_log WHERE topic = 'campaign-data-changed' AND resource_id = 'deletedDefaults';

-- Delete the retired setting the same way an ordinary save deletes a record.
UPDATE campaign_collections SET revision = revision + 1
WHERE name = 'settings'
  AND EXISTS (SELECT 1 FROM campaign_records WHERE collection_name = 'settings' AND record_key = 'hiddenSidebarPages');
UPDATE campaign_record_versions SET deleted = 1, revision = revision + 1
WHERE collection_name = 'settings' AND record_key = 'hiddenSidebarPages' AND deleted = 0;
DELETE FROM campaign_records WHERE collection_name = 'settings' AND record_key = 'hiddenSidebarPages';

-- v1 sidebar layouts list pages by their old Czech routes; store the current
-- routes and drop /druhy, a v1 page that no longer exists, and /dm, which is a
-- header link rather than a sidebar page. Sections take the default English IDs
-- and sections left without pages are removed.
UPDATE campaign_collections SET revision = revision + 1
WHERE name = 'settings'
  AND EXISTS (SELECT 1 FROM campaign_records WHERE collection_name = 'settings' AND record_key = 'sidebarLayout');
UPDATE campaign_record_versions SET revision = revision + 1
WHERE collection_name = 'settings' AND record_key = 'sidebarLayout' AND deleted = 0;
UPDATE campaign_records SET revision = revision + 1, body_json = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(body_json, '"/mapa/vztahy"', '"/graph/relationships"'), '"/mapa/palac"', '"/graph/factions"'), '"/mapa/frakce"', '"/graph/factions"'), '"/mapa/tajemstvi"', '"/graph/mysteries"'), '"/casova-osa"', '"/timeline"'), '"/mapa/svet"', '"/map/world"'), '"/mista"', '"/locations"'), '"/postavy"', '"/characters"'), '"/frakce"', '"/factions"'), '"/mazlicci"', '"/companions"'), '"/zahady"', '"/mysteries"'), '"/panteon"', '"/pantheon"'), '"/artefakty"', '"/artifacts"'), '"/historie"', '"/history"'), ',"/druhy"', ''), '"/druhy",', ''), '"/druhy"', ''), ',"/dm"', ''), '"/dm",', ''), '"/dm"', '')
WHERE collection_name = 'settings' AND record_key = 'sidebarLayout';
UPDATE campaign_records SET body_json = json_set(body_json, '$.sections', (
    SELECT json_group_array(json(json_set(section.value, '$.id', CASE section.value ->> 'id'
        WHEN 'prehled' THEN 'overview' WHEN 'kampan' THEN 'campaign'
        WHEN 'svet' THEN 'world' WHEN 'kompendium' THEN 'compendium'
        ELSE section.value ->> 'id' END)) ORDER BY section.key)
    FROM json_each(body_json, '$.sections') AS section
    WHERE json_array_length(section.value, '$.pages') > 0))
WHERE collection_name = 'settings' AND record_key = 'sidebarLayout' AND json_type(body_json, '$.sections') = 'array';

-- Rename pets to companions.
INSERT INTO campaign_collections(name, shape, materialized, revision, updated_at)
SELECT 'companions', shape, materialized, revision, updated_at FROM campaign_collections WHERE name = 'pets';
UPDATE campaign_records SET collection_name = 'companions' WHERE collection_name = 'pets';
UPDATE campaign_record_versions SET collection_name = 'companions' WHERE collection_name = 'pets';
UPDATE campaign_commit_records SET collection_name = 'companions' WHERE collection_name = 'pets';
DELETE FROM campaign_collections WHERE name = 'pets';
UPDATE addon_data_sets SET target_collection = 'companions' WHERE target_collection = 'pets';
UPDATE change_log SET resource_id = 'companions' WHERE topic = 'campaign-data-changed' AND resource_id = 'pets';

-- v1 activity summaries ("lastChange" with old field entries) and records that
-- never received one get the current activity.v1 envelope. Field names are
-- kept for the DM; the public summary lists none so no DM-only field leaks.
UPDATE campaign_records SET body_json = json_set(body_json, '$.lastChange', json_object(
    'contractVersion', 'activity.v1',
    'dm', CASE WHEN typeof(body_json ->> 'updatedAt') = 'integer' AND (body_json ->> 'updatedAt') > 0 THEN json_object(
        'kind', CASE WHEN json_extract(body_json, '$.lastChange.created') = 1 THEN 'created' ELSE 'updated' END,
        'fields', json((SELECT json_group_array(name ORDER BY name) FROM (
            SELECT name FROM (SELECT DISTINCT CASE field.type
                WHEN 'object' THEN COALESCE(field.value ->> 'key', field.value ->> 'field')
                WHEN 'text' THEN field.value END AS name
                FROM json_each(body_json, '$.lastChange.fields') AS field)
            WHERE length(name) BETWEEN 1 AND 100 ORDER BY name LIMIT 24))),
        'at', body_json ->> 'updatedAt') END,
    'public', CASE WHEN visibility = 'public' AND typeof(body_json ->> 'updatedAt') = 'integer' AND (body_json ->> 'updatedAt') > 0 THEN json_object(
        'kind', CASE WHEN json_extract(body_json, '$.lastChange.created') = 1 THEN 'created' ELSE 'updated' END, 'fields', json('[]'), 'at', body_json ->> 'updatedAt') END))
WHERE collection_name IN ('characters', 'relationships', 'locations', 'events', 'mysteries', 'factions', 'pantheon', 'artifacts', 'historicalEvents') AND json_type(body_json) = 'object'
  AND json_extract(body_json, '$.lastChange.contractVersion') IS NOT 'activity.v1';

-- Rebuild the media table to rename the pet-portrait kind; SQLite cannot alter
-- a CHECK constraint. The recovery view and the table's triggers and index are
-- recreated unchanged.
DROP VIEW recovery_image;

CREATE TABLE core_media_assets_next (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    blob_id TEXT NOT NULL UNIQUE REFERENCES blobs(blob_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN (
        'character-portrait',
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
SELECT sequence, blob_id, CASE kind WHEN 'pet-portrait' THEN 'companion-portrait' ELSE kind END, target_key, created_at
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

-- Apply the same changes inside stored recovery points so restoring one never
-- brings the old names back.
UPDATE recovery_points SET image_json = json_set(image_json, '$.collections', (
    SELECT json_group_array(json(CASE WHEN item.value ->> 'name' = 'pets'
        THEN json_set(item.value, '$.name', 'companions') ELSE item.value END) ORDER BY item.value ->> 'name')
    FROM json_each(recovery_points.image_json, '$.collections') AS item
    WHERE item.value ->> 'name' <> 'deletedDefaults'))
WHERE json_type(image_json, '$.collections') = 'array';

UPDATE recovery_points SET image_json = json_set(image_json, '$.records', (
    SELECT json_group_array(json(CASE
        WHEN item.value ->> 'collection_name' = 'pets'
            THEN json_set(item.value, '$.collection_name', 'companions')
        WHEN item.value ->> 'collection_name' = 'settings' AND item.value ->> 'record_key' = 'sidebarLayout'
            THEN json_set(item.value, '$.body_json', replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace((item.value ->> 'body_json'), '"/mapa/vztahy"', '"/graph/relationships"'), '"/mapa/palac"', '"/graph/factions"'), '"/mapa/frakce"', '"/graph/factions"'), '"/mapa/tajemstvi"', '"/graph/mysteries"'), '"/casova-osa"', '"/timeline"'), '"/mapa/svet"', '"/map/world"'), '"/mista"', '"/locations"'), '"/postavy"', '"/characters"'), '"/frakce"', '"/factions"'), '"/mazlicci"', '"/companions"'), '"/zahady"', '"/mysteries"'), '"/panteon"', '"/pantheon"'), '"/artefakty"', '"/artifacts"'), '"/historie"', '"/history"'), ',"/druhy"', ''), '"/druhy",', ''), '"/druhy"', ''), ',"/dm"', ''), '"/dm",', ''), '"/dm"', ''))
        ELSE item.value END) ORDER BY item.key)
    FROM json_each(recovery_points.image_json, '$.records') AS item
    WHERE item.value ->> 'collection_name' <> 'deletedDefaults'
      AND NOT (item.value ->> 'collection_name' = 'settings' AND item.value ->> 'record_key' = 'hiddenSidebarPages')))
WHERE json_type(image_json, '$.records') = 'array';

UPDATE recovery_points SET image_json = json_set(image_json, '$.records', (
    SELECT json_group_array(json(CASE
        WHEN item.value ->> 'collection_name' = 'settings' AND item.value ->> 'record_key' = 'sidebarLayout'
            AND json_type(item.value ->> 'body_json', '$.sections') = 'array'
            THEN json_set(item.value, '$.body_json', '' || json_set((item.value ->> 'body_json'), '$.sections', (
        SELECT json_group_array(json(json_set(section.value, '$.id', CASE section.value ->> 'id'
            WHEN 'prehled' THEN 'overview' WHEN 'kampan' THEN 'campaign'
            WHEN 'svet' THEN 'world' WHEN 'kompendium' THEN 'compendium'
            ELSE section.value ->> 'id' END)) ORDER BY section.key)
        FROM json_each((item.value ->> 'body_json'), '$.sections') AS section
        WHERE json_array_length(section.value, '$.pages') > 0)))
        ELSE item.value END) ORDER BY item.key)
    FROM json_each(recovery_points.image_json, '$.records') AS item))
WHERE json_type(image_json, '$.records') = 'array';

UPDATE recovery_points SET image_json = json_set(image_json, '$.records', (
    SELECT json_group_array(json(CASE
        WHEN item.value ->> 'collection_name' IN ('characters', 'relationships', 'locations', 'events', 'mysteries', 'factions', 'pantheon', 'artifacts', 'historicalEvents')
            AND json_type(item.value ->> 'body_json') = 'object'
            AND json_extract((item.value ->> 'body_json'), '$.lastChange.contractVersion') IS NOT 'activity.v1'
            THEN json_set(item.value, '$.body_json', '' || json_set((item.value ->> 'body_json'), '$.lastChange', json_object(
                'contractVersion', 'activity.v1',
                'dm', CASE WHEN typeof((item.value ->> 'body_json') ->> 'updatedAt') = 'integer' AND ((item.value ->> 'body_json') ->> 'updatedAt') > 0 THEN json_object(
                    'kind', CASE WHEN json_extract((item.value ->> 'body_json'), '$.lastChange.created') = 1 THEN 'created' ELSE 'updated' END,
                    'fields', json((SELECT json_group_array(name ORDER BY name) FROM (
                        SELECT name FROM (SELECT DISTINCT CASE field.type
                            WHEN 'object' THEN COALESCE(field.value ->> 'key', field.value ->> 'field')
                            WHEN 'text' THEN field.value END AS name
                            FROM json_each((item.value ->> 'body_json'), '$.lastChange.fields') AS field)
                        WHERE length(name) BETWEEN 1 AND 100 ORDER BY name LIMIT 24))),
                    'at', (item.value ->> 'body_json') ->> 'updatedAt') END,
                'public', CASE WHEN (item.value ->> 'visibility') = 'public' AND typeof((item.value ->> 'body_json') ->> 'updatedAt') = 'integer' AND ((item.value ->> 'body_json') ->> 'updatedAt') > 0 THEN json_object(
                    'kind', CASE WHEN json_extract((item.value ->> 'body_json'), '$.lastChange.created') = 1 THEN 'created' ELSE 'updated' END, 'fields', json('[]'), 'at', (item.value ->> 'body_json') ->> 'updatedAt') END)))
        ELSE item.value END) ORDER BY item.key)
    FROM json_each(recovery_points.image_json, '$.records') AS item))
WHERE json_type(image_json, '$.records') = 'array';

UPDATE recovery_points SET image_json = json_set(image_json, '$.sets', (
    SELECT json_group_array(json(CASE WHEN item.value ->> 'target_collection' = 'pets'
        THEN json_set(item.value, '$.target_collection', 'companions') ELSE item.value END) ORDER BY item.key)
    FROM json_each(recovery_points.image_json, '$.sets') AS item))
WHERE json_type(image_json, '$.sets') = 'array';

UPDATE recovery_points SET image_json = json_set(image_json, '$.assets', (
    SELECT json_group_array(json(CASE WHEN item.value ->> 'kind' = 'pet-portrait'
        THEN json_set(item.value, '$.kind', 'companion-portrait') ELSE item.value END) ORDER BY item.key)
    FROM json_each(recovery_points.image_json, '$.assets') AS item))
WHERE json_type(image_json, '$.assets') = 'array';

-- Only the retired combined restore read the "partial" marker.
UPDATE recovery_points SET image_json = json_remove(image_json, '$.partial')
WHERE json_type(image_json, '$.partial') IS NOT NULL;
