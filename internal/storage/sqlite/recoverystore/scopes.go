package recoverystore

import (
	"context"
	"database/sql"
	"regexp"
)

// Empty scope preserves the original whole-snapshot API for existing clients.
// New clients select campaign or one add-on explicitly.
type Scope struct {
	Scope   string `json:"scope,omitempty"`
	AddonID string `json:"addonId,omitempty"`
}

var addonIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)

func (scope Scope) valid() bool {
	return (scope.Scope == "" || scope.Scope == "campaign") && scope.AddonID == "" || scope.Scope == "addon" && addonIDPattern.MatchString(scope.AddonID)
}

type AddonPoint struct {
	AddonID      string `json:"addonId"`
	GenerationID string `json:"generationId"`
	Documents    int64  `json:"documents"`
	Media        int64  `json:"media"`
	Compatible   bool   `json:"compatible"`
}

// A context exists even for an installed add-on with no saved documents, or a
// disabled add-on whose owned data remains. Package identity is checked later.
const addonContexts = `SELECT value ->> 'addon_id' AS addon_id FROM json_each(@image, '$.packages')
 UNION SELECT value ->> 'addon_id' FROM json_each(@image, '$.sets')
 UNION SELECT b.owner_id FROM json_each(@image, '$.blobs') j JOIN blobs b ON b.blob_id = j.value ->> 'blob_id' WHERE b.owner_kind = 'addon'`

func contextExists(ctx context.Context, tx *sql.Tx, image string, scope Scope) (bool, error) {
	var exists bool
	err := tx.QueryRowContext(ctx, `SELECT CASE WHEN @scope = 'addon' THEN EXISTS(SELECT 1 FROM (`+addonContexts+`) WHERE addon_id = @addon)
 ELSE COALESCE(json_extract(@image, '$.campaignAvailable'), 1) END`, sql.Named("image", image), sql.Named("scope", scope.Scope), sql.Named("addon", scope.AddonID)).Scan(&exists)
	return exists, err
}

func compatibleContext(ctx context.Context, tx *sql.Tx, image string, scope Scope) (bool, error) {
	if scope.Scope == "campaign" {
		return true, nil
	}
	args := []any{sql.Named("image", image), sql.Named("addon", scope.AddonID)}
	var compatible bool
	if scope.Scope == "addon" {
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM json_each(@image, '$.packages') old JOIN addon_package_states live
 ON live.addon_id = old.value ->> 'addon_id' AND live.active_generation_id = old.value ->> 'active_generation_id' WHERE live.addon_id = @addon)`, args...).Scan(&compatible)
		if err != nil || !compatible {
			return false, err
		}
	} else {
		// A legacy whole-snapshot request cannot erase data from a retired context.
		err := tx.QueryRowContext(ctx, `SELECT COALESCE(json_extract(@image, '$.partial'), 0) = 0 AND
 json_extract(@image, '$.packages') = json_extract(image_json, '$.packages') FROM recovery_image`, sql.Named("image", image)).Scan(&compatible)
		if err != nil || !compatible {
			return false, err
		}
	}
	err := tx.QueryRowContext(ctx, `SELECT NOT EXISTS (
 SELECT 1 FROM json_each(@image, '$.sets') old JOIN addon_data_sets live
 ON live.addon_id = old.value ->> 'addon_id' AND live.data_kind = old.value ->> 'data_kind' AND live.data_id = old.value ->> 'data_id'
 WHERE (@addon = '' OR live.addon_id = @addon) AND (live.schema_version IS NOT old.value ->> 'schema_version' OR live.schema_sha256 IS NOT old.value ->> 'schema_sha256'
 OR live.target_collection IS NOT old.value ->> 'target_collection' OR live.keyed IS NOT old.value ->> 'keyed'))`, args...).Scan(&compatible)
	if err != nil || !compatible || scope.Scope != "addon" {
		return compatible, err
	}
	// Never attach saved extension data to a different incarnation of a record.
	err = tx.QueryRowContext(ctx, `SELECT NOT EXISTS (
 SELECT 1 FROM json_each(@image, '$.documents') d JOIN json_each(@image, '$.sets') s
 ON s.value ->> 'addon_id' = d.value ->> 'addon_id' AND s.value ->> 'data_kind' = d.value ->> 'data_kind' AND s.value ->> 'data_id' = d.value ->> 'data_id'
 WHERE d.value ->> 'addon_id' = @addon AND d.value ->> 'data_kind' = 'record-extension' AND NOT EXISTS (
 SELECT 1 FROM campaign_records c WHERE c.collection_name = s.value ->> 'target_collection' AND c.record_key = d.value ->> 'document_key' AND c.created_at = d.value ->> 'target_created_at'))`, args...).Scan(&compatible)
	return compatible, err
}

func listContexts(ctx context.Context, tx *sql.Tx, image string, point *Point) error {
	point.Addons = []AddonPoint{}
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(json_extract(@image, '$.campaignAvailable'), 1),
 (SELECT count(*) FROM json_each(@image, '$.blobs') j JOIN blobs b ON b.blob_id = j.value ->> 'blob_id' WHERE b.owner_kind <> 'addon' AND j.value ->> 'deleted' = 0)`, sql.Named("image", image)).Scan(&point.CampaignAvailable, &point.CampaignMedia); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT addon_id,
 COALESCE((SELECT value ->> 'active_generation_id' FROM json_each(@image, '$.packages') WHERE value ->> 'addon_id' = owners.addon_id), ''),
 (SELECT count(*) FROM json_each(@image, '$.documents') WHERE value ->> 'addon_id' = owners.addon_id),
 (SELECT count(*) FROM json_each(@image, '$.blobs') j JOIN blobs b ON b.blob_id = j.value ->> 'blob_id' WHERE b.owner_kind = 'addon' AND b.owner_id = owners.addon_id AND j.value ->> 'deleted' = 0)
 FROM (`+addonContexts+`) owners ORDER BY addon_id`, sql.Named("image", image))
	if err != nil {
		return err
	}
	for rows.Next() {
		var addon AddonPoint
		if err := rows.Scan(&addon.AddonID, &addon.GenerationID, &addon.Documents, &addon.Media); err != nil {
			rows.Close()
			return err
		}
		point.Addons = append(point.Addons, addon)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for i := range point.Addons {
		point.Addons[i].Compatible, err = compatibleContext(ctx, tx, image, Scope{Scope: "addon", AddonID: point.Addons[i].AddonID})
		if err != nil {
			return err
		}
	}
	return nil
}

// RetireAddonContext is part of the package cleanup transaction. Removing an
// obsolete package can never remove the campaign or another add-on's snapshot.
func RetireAddonContext(ctx context.Context, tx *sql.Tx, addonID, generationID string) error {
	result, err := tx.ExecContext(ctx, retireAddonSQL+` WHERE EXISTS(SELECT 1 FROM json_each(image_json, '$.packages')
 WHERE value ->> 'addon_id' = @addon AND value ->> 'active_generation_id' = @generation)`, sql.Named("addon", addonID), sql.Named("generation", generationID))
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		return err
	}
	return finishContextRetirement(ctx, tx)
}

const retireAddonSQL = `UPDATE recovery_points SET image_json = json_set(image_json, '$.partial', json('true'),
 '$.packages', (SELECT json_group_array(json(value)) FROM json_each(image_json, '$.packages') WHERE value ->> 'addon_id' <> @addon),
 '$.sets', (SELECT json_group_array(json(value)) FROM json_each(image_json, '$.sets') WHERE value ->> 'addon_id' <> @addon),
 '$.documents', (SELECT json_group_array(json(value)) FROM json_each(image_json, '$.documents') WHERE value ->> 'addon_id' <> @addon),
 '$.blobs', (SELECT json_group_array(json(j.value)) FROM json_each(image_json, '$.blobs') j WHERE NOT EXISTS(SELECT 1 FROM blobs b WHERE b.blob_id = j.value ->> 'blob_id' AND b.owner_kind = 'addon' AND b.owner_id = @addon)))`

func finishContextRetirement(ctx context.Context, tx *sql.Tx) error {
	// Remove envelopes only when every independently recoverable context is gone.
	if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_points WHERE json_extract(image_json, '$.campaignAvailable') = 0
 AND json_array_length(image_json, '$.packages') = 0 AND json_array_length(image_json, '$.sets') = 0 AND json_array_length(image_json, '$.blobs') = 0`); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE recovery_control SET revision = revision + 1, last_capture = 0 WHERE singleton = 1`)
	return err
}

type DeleteRequest struct {
	Scope
	ID               int64 `json:"id"`
	ExpectedRevision int64 `json:"expectedRevision"`
}

func (s *Store) DeleteContext(ctx context.Context, request DeleteRequest) error {
	if !request.Scope.valid() || request.ID < 1 || request.ExpectedRevision < 0 {
		return ErrInvalid
	}
	if request.Scope.Scope == "" {
		return s.Delete(ctx, request.ID, request.ExpectedRevision)
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := claim(ctx, tx, request.ExpectedRevision); err != nil {
		return err
	}
	var image string
	if err := tx.QueryRowContext(ctx, `SELECT image_json FROM recovery_points WHERE point_id = ?`, request.ID).Scan(&image); err == sql.ErrNoRows {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	exists, err := contextExists(ctx, tx, image, request.Scope)
	if err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	if request.Scope.Scope == "addon" {
		_, err = tx.ExecContext(ctx, retireAddonSQL+` WHERE point_id = @id`, sql.Named("addon", request.AddonID), sql.Named("id", request.ID))
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE recovery_points SET image_json = json_set(image_json, '$.partial', json('true'), '$.campaignAvailable', json('false'),
 '$.collections', json('[]'), '$.records', json('[]'), '$.assets', json('[]'),
 '$.blobs', (SELECT json_group_array(json(j.value)) FROM json_each(image_json, '$.blobs') j JOIN blobs b ON b.blob_id = j.value ->> 'blob_id' WHERE b.owner_kind = 'addon')) WHERE point_id = ?`, request.ID)
	}
	if err != nil {
		return err
	}
	if err := finishContextRetirement(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE recovery_control SET suppressed = 0 WHERE singleton = 1`); err != nil {
		return err
	}
	return tx.Commit()
}
