package recoverystore

// Keep revision tombstones for every key ever seen. Restored records receive
// fresh revisions, including records deleted since the selected point, so an
// editor opened before recovery cannot overwrite the recovered state.
var restoreStatements = []string{
	`INSERT INTO campaign_record_versions(collection_name, record_key, revision, deleted, updated_at)
     SELECT keys.collection_name, keys.record_key, COALESCE(versions.revision, 0) + 1,
        NOT EXISTS (SELECT 1 FROM json_each(@image, '$.records') AS old WHERE old.value ->> 'collection_name' = keys.collection_name AND old.value ->> 'record_key' = keys.record_key),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     FROM (SELECT collection_name, record_key FROM campaign_records UNION SELECT value ->> 'collection_name', value ->> 'record_key' FROM json_each(@image, '$.records')) AS keys
     LEFT JOIN campaign_record_versions AS versions USING(collection_name, record_key) WHERE true
     ON CONFLICT(collection_name, record_key) DO UPDATE SET revision = excluded.revision, deleted = excluded.deleted, updated_at = excluded.updated_at`,

	`DELETE FROM campaign_records WHERE json_valid(@image)`,

	`INSERT INTO campaign_records(collection_name, record_key, position, body_json, visibility, revision, created_at, updated_at)
     SELECT value ->> 'collection_name', value ->> 'record_key', value ->> 'position', value ->> 'body_json', value ->> 'visibility', versions.revision, value ->> 'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     FROM json_each(@image, '$.records') JOIN campaign_record_versions AS versions
     ON versions.collection_name = value ->> 'collection_name' AND versions.record_key = value ->> 'record_key'`,

	`UPDATE campaign_collections SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        materialized = (SELECT value ->> 'materialized' FROM json_each(@image, '$.collections') WHERE value ->> 'name' = campaign_collections.name)`,

	`INSERT INTO addon_data_sets(addon_id, data_kind, data_id, materialized, schema_version, schema_sha256, target_collection, keyed)
     SELECT value ->> 'addon_id', value ->> 'data_kind', value ->> 'data_id', value ->> 'materialized', value ->> 'schema_version', value ->> 'schema_sha256', value ->> 'target_collection', value ->> 'keyed'
     FROM json_each(@image, '$.sets') WHERE true ON CONFLICT(addon_id, data_kind, data_id) DO NOTHING`,

	`INSERT INTO addon_document_versions(addon_id, data_kind, data_id, document_key, revision, deleted, updated_at)
     SELECT keys.addon_id, keys.data_kind, keys.data_id, keys.document_key, COALESCE(versions.revision, 0) + 1,
        NOT EXISTS (SELECT 1 FROM json_each(@image, '$.documents') AS old WHERE old.value ->> 'addon_id' = keys.addon_id AND old.value ->> 'data_kind' = keys.data_kind AND old.value ->> 'data_id' = keys.data_id AND old.value ->> 'document_key' = keys.document_key),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     FROM (SELECT addon_id, data_kind, data_id, document_key FROM addon_documents UNION
        SELECT value ->> 'addon_id', value ->> 'data_kind', value ->> 'data_id', value ->> 'document_key' FROM json_each(@image, '$.documents')) AS keys
     LEFT JOIN addon_document_versions AS versions USING(addon_id, data_kind, data_id, document_key) WHERE true
     ON CONFLICT(addon_id, data_kind, data_id, document_key) DO UPDATE SET revision = excluded.revision, deleted = excluded.deleted, updated_at = excluded.updated_at`,

	`DELETE FROM addon_documents WHERE json_valid(@image)`,

	`INSERT INTO addon_documents(addon_id, data_kind, data_id, document_key, position, body_json, schema_version, schema_sha256, revision, created_at, updated_at, target_created_at)
     SELECT value ->> 'addon_id', value ->> 'data_kind', value ->> 'data_id', value ->> 'document_key', value ->> 'position', value ->> 'body_json', value ->> 'schema_version', value ->> 'schema_sha256', versions.revision, value ->> 'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), value ->> 'target_created_at'
     FROM json_each(@image, '$.documents') JOIN addon_document_versions AS versions
     ON versions.addon_id = value ->> 'addon_id' AND versions.data_kind = value ->> 'data_kind' AND versions.data_id = value ->> 'data_id' AND versions.document_key = value ->> 'document_key'`,

	`UPDATE addon_data_sets SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        materialized = COALESCE((SELECT value ->> 'materialized' FROM json_each(@image, '$.sets') WHERE value ->> 'addon_id' = addon_data_sets.addon_id AND value ->> 'data_kind' = addon_data_sets.data_kind AND value ->> 'data_id' = addon_data_sets.data_id), 0)`,

	// Physical objects and immutable handle ownership remain in place. Handles
	// created after the point become deleted, making logical 'latest' slots
	// select the historical map/logo again. A safety restore can revive them.
	`UPDATE blobs SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        deleted = COALESCE((SELECT value ->> 'deleted' FROM json_each(@image, '$.blobs') WHERE value ->> 'blob_id' = blobs.blob_id), 1)
     WHERE deleted != COALESCE((SELECT value ->> 'deleted' FROM json_each(@image, '$.blobs') WHERE value ->> 'blob_id' = blobs.blob_id), 1)`,

	`DELETE FROM core_media_assets WHERE json_valid(@image)`,

	`INSERT INTO core_media_assets(sequence, blob_id, kind, target_key, created_at)
     SELECT value ->> 'sequence', value ->> 'blob_id', value ->> 'kind', value ->> 'target_key', value ->> 'created_at' FROM json_each(@image, '$.assets')`,
}
