package recoverystore

import (
	"context"
	"database/sql"

	"github.com/pjunak/ttrpg-codex/contracts/addons/v3"
)

// Scope names one part of the campaign: the campaign itself or one add-on.
// Every recovery point belongs to exactly one part.
type Scope struct {
	Scope   string `json:"scope"`
	AddonID string `json:"addonId,omitempty"`
}

func (scope Scope) valid() bool {
	return scope.Scope == "campaign" && scope.AddonID == "" || scope.Scope == "addon" && addonv3.ValidAddonID(scope.AddonID)
}

// args names the part for the queries in this package, followed by extra.
func (scope Scope) args(extra ...any) []any {
	return append([]any{sql.Named("scope", scope.Scope), sql.Named("addon", scope.AddonID)}, extra...)
}

// partOf maps a store's write hook argument to its part.
func partOf(addonID string) Scope {
	if addonID == "" {
		return Scope{Scope: "campaign"}
	}
	return Scope{Scope: "addon", AddonID: addonID}
}

func compatibleContext(ctx context.Context, tx *sql.Tx, image string, scope Scope) (bool, error) {
	if scope.Scope == "campaign" {
		return true, nil
	}
	args := []any{sql.Named("image", image), sql.Named("addon", scope.AddonID)}
	var compatible bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM json_each(@image, '$.packages') old JOIN addon_package_states live
 ON live.addon_id = old.value ->> 'addon_id' AND live.active_generation_id = old.value ->> 'active_generation_id' WHERE live.addon_id = @addon)`, args...).Scan(&compatible)
	if err != nil || !compatible {
		return false, err
	}
	err = tx.QueryRowContext(ctx, `SELECT NOT EXISTS (
 SELECT 1 FROM json_each(@image, '$.sets') old JOIN addon_data_sets live
 ON live.addon_id = old.value ->> 'addon_id' AND live.data_kind = old.value ->> 'data_kind' AND live.data_id = old.value ->> 'data_id'
 WHERE live.addon_id = @addon AND (live.schema_version IS NOT old.value ->> 'schema_version' OR live.schema_sha256 IS NOT old.value ->> 'schema_sha256'
 OR live.target_collection IS NOT old.value ->> 'target_collection' OR live.keyed IS NOT old.value ->> 'keyed'))`, args...).Scan(&compatible)
	if err != nil || !compatible {
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

// RetireAddonGeneration is part of the package cleanup transaction. It removes
// the add-on's points that need the obsolete generation; the campaign's and
// other add-ons' points are separate and stay.
func RetireAddonGeneration(ctx context.Context, tx *sql.Tx, addonID, generationID string) error {
	result, err := tx.ExecContext(ctx, `DELETE FROM recovery_points WHERE scope = 'addon' AND addon_id = @addon
 AND EXISTS(SELECT 1 FROM json_each(image_json, '$.packages') WHERE value ->> 'active_generation_id' = @generation)`,
		sql.Named("addon", addonID), sql.Named("generation", generationID))
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		return err
	}
	// The add-on's history is gone, so its next edit starts a new group.
	if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_capture WHERE scope = 'addon' AND addon_id = ?`, addonID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1`)
	return err
}

type DeleteRequest struct {
	Scope
	ID               int64 `json:"id"`
	ExpectedRevision int64 `json:"expectedRevision"`
}

func (s *Store) Delete(ctx context.Context, request DeleteRequest) error {
	if !request.Scope.valid() || request.ID < 1 || request.ExpectedRevision < 0 {
		return ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := claim(ctx, tx, request.ExpectedRevision); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM recovery_points WHERE point_id = @id AND scope = @scope AND addon_id = @addon`,
		request.Scope.args(sql.Named("id", request.ID))...)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE recovery_control SET suppressed = 0, revision = revision + 1 WHERE singleton = 1`); err != nil {
		return err
	}
	return tx.Commit()
}
