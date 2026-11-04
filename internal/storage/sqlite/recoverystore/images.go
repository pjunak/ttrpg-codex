package recoverystore

import (
	"context"
	"database/sql"
)

// Part images keep every key, empty where the part has no such data, so the
// restore statements and the offline blob collector decode campaign and add-on
// points alike. Migration 0029 split the older combined points into this shape.
const campaignImageSQL = `SELECT json_object(
 'version', 1,
 'collections', (SELECT json_group_array(json_object('name', name, 'shape', shape, 'materialized', materialized))
   FROM (SELECT name, shape, materialized FROM campaign_collections ORDER BY name)),
 'records', (SELECT json_group_array(json_object('collection_name', collection_name, 'record_key', record_key, 'position', position, 'body_json', body_json, 'visibility', visibility, 'created_at', created_at))
   FROM (SELECT collection_name, record_key, position, body_json, visibility, created_at FROM campaign_records ORDER BY collection_name, position)),
 'sets', json('[]'),
 'documents', json('[]'),
 'blobs', (SELECT json_group_array(json_object('blob_id', blob_id, 'deleted', deleted))
   FROM (SELECT blob_id, deleted FROM blobs WHERE owner_kind <> 'addon' ORDER BY blob_id)),
 'assets', (SELECT json_group_array(json_object('sequence', sequence, 'blob_id', blob_id, 'kind', kind, 'target_key', target_key, 'created_at', created_at))
   FROM (SELECT sequence, blob_id, kind, target_key, created_at FROM core_media_assets ORDER BY sequence)),
 'packages', json('[]')) AS image_json`

const addonImageSQL = `SELECT json_object(
 'version', 1,
 'collections', json('[]'),
 'records', json('[]'),
 'sets', (SELECT json_group_array(json_object('addon_id', addon_id, 'data_kind', data_kind, 'data_id', data_id, 'materialized', materialized, 'schema_version', schema_version, 'schema_sha256', schema_sha256, 'target_collection', target_collection, 'keyed', keyed))
   FROM (SELECT addon_id, data_kind, data_id, materialized, schema_version, schema_sha256, target_collection, keyed FROM addon_data_sets WHERE addon_id = @addon ORDER BY data_kind, data_id)),
 'documents', (SELECT json_group_array(json_object('addon_id', addon_id, 'data_kind', data_kind, 'data_id', data_id, 'document_key', document_key, 'position', position, 'body_json', body_json, 'schema_version', schema_version, 'schema_sha256', schema_sha256, 'created_at', created_at, 'target_created_at', target_created_at))
   FROM (SELECT addon_id, data_kind, data_id, document_key, position, body_json, schema_version, schema_sha256, created_at, target_created_at FROM addon_documents WHERE addon_id = @addon ORDER BY data_kind, data_id, position, document_key)),
 'blobs', (SELECT json_group_array(json_object('blob_id', blob_id, 'deleted', deleted))
   FROM (SELECT blob_id, deleted FROM blobs WHERE owner_kind = 'addon' AND owner_id = @addon ORDER BY blob_id)),
 'assets', json('[]'),
 'packages', (SELECT json_group_array(json_object('addon_id', addon_id, 'active_generation_id', active_generation_id))
   FROM (SELECT addon_id, active_generation_id FROM addon_package_states WHERE addon_id = @addon AND active_generation_id IS NOT NULL))) AS image_json`

func imageSQL(part Scope) string {
	if part.Scope == "addon" {
		return addonImageSQL
	}
	return campaignImageSQL
}

type querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// liveParts lists the campaign and every add-on that currently has an active
// package, saved data or owned files.
func liveParts(ctx context.Context, db querier) ([]Scope, error) {
	rows, err := db.QueryContext(ctx, `SELECT addon_id FROM addon_package_states WHERE active_generation_id IS NOT NULL
 UNION SELECT addon_id FROM addon_data_sets
 UNION SELECT owner_id FROM blobs WHERE owner_kind = 'addon' ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	parts := []Scope{{Scope: "campaign"}}
	for rows.Next() {
		var addonID string
		if err := rows.Scan(&addonID); err != nil {
			return nil, err
		}
		parts = append(parts, Scope{Scope: "addon", AddonID: addonID})
	}
	return parts, rows.Err()
}
