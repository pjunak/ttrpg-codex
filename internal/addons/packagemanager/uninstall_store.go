package packagemanager

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

func (store *store) uninstallHash(ctx context.Context, addonID string) (string, error) {
	var hash string
	err := store.db.QueryRowContext(ctx, `SELECT review_sha256 FROM addon_package_uninstalls WHERE addon_id = ?`, addonID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return hash, err
}

func (store *store) uninstallDetails(ctx context.Context, review *UninstallReview) error {
	var deleted int
	if err := store.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(revision), 0), COALESCE(MAX(deleted), 1) FROM addon_github_sources WHERE addon_id = ?`, review.AddonID).Scan(&review.SourceRevision, &deleted); err != nil {
		return err
	}
	review.UnlinksSource = deleted == 0
	rows, err := store.db.QueryContext(ctx, `SELECT s.data_kind, s.data_id, COUNT(d.document_key)
		FROM addon_data_sets s LEFT JOIN addon_documents d USING(addon_id, data_kind, data_id)
		WHERE s.addon_id = ? GROUP BY s.data_kind, s.data_id ORDER BY s.data_kind, s.data_id`, review.AddonID)
	if err != nil {
		return err
	}
	defer rows.Close()
	review.RetainedData = []RetainedData{}
	for rows.Next() {
		var item RetainedData
		if err := rows.Scan(&item.Kind, &item.ID, &item.Documents); err != nil {
			return err
		}
		review.RetainedData = append(review.RetainedData, item)
	}
	return rows.Err()
}

func (store *store) uninstall(ctx context.Context, review UninstallReview) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := store.now().UTC()
	configuration, err := readConfiguration(ctx, tx)
	if err != nil {
		return err
	}
	if configuration.Revision != review.ConfigurationRevision {
		return ErrReviewStale
	}
	var sourceRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(revision), 0) FROM addon_github_sources WHERE addon_id = ?`, review.AddonID).Scan(&sourceRevision); err != nil {
		return err
	}
	if sourceRevision != review.SourceRevision {
		return ErrReviewStale
	}
	result, err := tx.ExecContext(ctx, `UPDATE addon_package_states SET active_generation_id = NULL, granted_permissions_json = '[]', revision = revision + 1, updated_at = ? WHERE addon_id = ? AND revision = ?`, now.Format(time.RFC3339Nano), review.AddonID, review.ExpectedStateRevision)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrReviewStale
	}
	for _, effect := range review.Effects {
		if !effect.Disabled {
			continue
		}
		var generation string
		if err := tx.QueryRowContext(ctx, `SELECT active_generation_id FROM addon_package_states WHERE addon_id = ?`, effect.AddonID).Scan(&generation); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE addon_package_states SET active_generation_id = NULL, revision = revision + 1, updated_at = ? WHERE addon_id = ?`, now.Format(time.RFC3339Nano), effect.AddonID); err != nil {
			return err
		}
		if err := insertEvent(ctx, tx, effect.AddonID, generation, "disabled", "Required dependency removed: "+review.AddonID, now); err != nil {
			return err
		}
	}
	if err := servicebroker.RemoveProvidersInTransaction(ctx, tx, review.AddonID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE addon_github_sources SET deleted = 1, source_json = '{}', revision = revision + 1 WHERE addon_id = ? AND deleted = 0`, review.AddonID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO addon_package_uninstalls(addon_id, review_sha256, removed_at) VALUES (?, ?, ?)`, review.AddonID, review.ReviewSHA256, now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE addon_instance_configuration SET revision = revision + 1 WHERE id = 1`); err != nil {
		return err
	}
	if err := insertEvent(ctx, tx, review.AddonID, review.GenerationID, "uninstalled", "Campaign data and recovery archives retained", now); err != nil {
		return err
	}
	return tx.Commit()
}
