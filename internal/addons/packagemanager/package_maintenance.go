package packagemanager

import (
	"context"
	"errors"
	"time"
)

func (manager *Manager) CancelActivationReview(ctx context.Context, id string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	review, err := manager.store.review(ctx, id)
	if errors.Is(err, ErrReviewNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if review.Status == ReviewConsumed {
		return nil
	}
	tx, err := manager.store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM addon_activation_reviews WHERE review_id=? AND status IN ('prepared','approved')", id); err != nil {
		return err
	}
	if err = insertEvent(ctx, tx, review.AddonID, review.GenerationID, "review-cancelled", "", manager.store.now().UTC()); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	// Cleanup is housekeeping after cancellation, never a failed cancellation.
	if err = manager.evictSupersededLocked(ctx, review.AddonID); err != nil {
		manager.logger.Warn("cancelled update cleanup pending", "addonId", review.AddonID, "error", err)
	}
	return nil
}

// MaintainPackages expires abandoned reviews and retries confined file cleanup.
// The host monitor owns scheduling and joins it during shutdown.
func (manager *Manager) MaintainPackages(ctx context.Context) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	var pending bool
	if err := manager.store.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM addon_update_attempts WHERE status='pending')").Scan(&pending); err != nil {
		return err
	}
	if pending {
		if err := manager.restorePendingUpdatesLocked(ctx); err != nil {
			return err
		}
		if _, err := manager.recoverLocked(ctx); err != nil {
			return err
		}
	}
	if err := manager.expirePackageReviewsLocked(ctx); err != nil {
		return err
	}
	return manager.retryPackageStorageLocked(ctx)
}

func (manager *Manager) expirePackageReviewsLocked(ctx context.Context) error {
	cutoff := manager.store.now().UTC().Add(-30 * time.Minute).Format(time.RFC3339Nano)
	if _, err := manager.store.db.ExecContext(ctx, `DELETE FROM addon_activation_reviews WHERE status IN ('prepared','approved') AND julianday(created_at)<=julianday(?) AND NOT EXISTS(SELECT 1 FROM addon_update_attempts u WHERE u.review_id=addon_activation_reviews.review_id)`, cutoff); err != nil {
		return err
	}
	_, err := manager.store.db.ExecContext(ctx, `DELETE FROM addon_schema_reviews WHERE status='prepared' AND julianday(plan_json->>'expiresAt')<=julianday(?) AND NOT EXISTS(SELECT 1 FROM addon_update_attempts u WHERE u.schema_review_id=addon_schema_reviews.review_id)`, manager.store.now().UTC().Format(time.RFC3339Nano))
	return err
}
