package packagemanager

import (
	"context"
	"errors"
)

// PackageStorage reports the automatic package cleanup policy and any cleanup
// the server is still retrying.
type PackageStorage struct {
	ContractVersion string `json:"contractVersion"`
	Automatic       bool   `json:"automatic"`
	Pending         int    `json:"pending"`
}

var ErrPackageUnavailable = errors.New("exact historical package is unavailable; supply its matching ZIP")

// ConfigurePackageRetention is called after healthy startup recovery and before
// serving requests. With automatic cleanup, only the selected build of each
// add-on is kept: superseded packages and their add-on recovery contexts are
// retired, while campaign snapshots and current saves stay intact. Every build
// remains available as a GitHub release, so an older one can be installed again.
func (manager *Manager) ConfigurePackageRetention(ctx context.Context, enabled bool) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.automaticCleanup = enabled
	if err := manager.expirePackageReviewsLocked(ctx); err != nil {
		return err
	}
	return manager.retryPackageStorageLocked(ctx)
}

func (manager *Manager) PackageStorage(ctx context.Context) (PackageStorage, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	result := PackageStorage{ContractVersion: "addon-package-storage.v1", Automatic: manager.automaticCleanup}
	err := manager.store.db.QueryRowContext(ctx, `SELECT count(*) FROM addon_package_cleanups WHERE status='pending'`).Scan(&result.Pending)
	return result, err
}

func (manager *Manager) evictSupersededLocked(ctx context.Context, addonID string) error {
	if !manager.automaticCleanup {
		return nil
	}
	pending, err := manager.retryCleanupsLocked(ctx)
	if err != nil {
		return err
	}
	if !pending.Complete {
		return ErrCleanupPending
	}
	keep := 0
	result, err := manager.cleanupLocked(ctx, CleanupScope{AddonID: addonID, KeepInactive: &keep, DiscardAddonRecovery: true}, "")
	if err == nil && !result.Complete {
		return ErrCleanupPending
	}
	return err
}

// RetryPackageCleanup finishes journaled cleanup and, with automatic cleanup,
// retires every superseded build. Each add-on must be running its selected
// build first, so a cleanup never removes what a failed activation needs.
func (manager *Manager) RetryPackageCleanup(ctx context.Context) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.retryPackageStorageLocked(ctx)
}

func (manager *Manager) retryPackageStorageLocked(ctx context.Context) error {
	result, err := manager.retryCleanupsLocked(ctx)
	if err != nil {
		return err
	}
	if !result.Complete {
		return ErrCleanupPending
	}
	if !manager.automaticCleanup {
		return nil
	}
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return err
	}
	for _, state := range states {
		if active, ok := manager.runtimes[state.AddonID]; !ok || active.generation.GenerationID != state.ActiveGenerationID {
			return ErrCleanupPending
		}
	}
	ids, err := manager.store.installedAddonIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := manager.evictSupersededLocked(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

func (manager *Manager) cleanupAfterActivationLocked(ctx context.Context, result *ActivationResult) {
	if result.CleanupError != "" || result.RecoveryError != "" {
		return
	}
	for _, recovered := range result.RecoveryResults {
		if !recovered.Recovered {
			return
		}
	}
	if active, ok := manager.runtimes[result.State.AddonID]; !ok || active.generation.GenerationID != result.State.ActiveGenerationID {
		return
	}
	// Activation is already committed. Cleanup failure must not turn a successful
	// activation into a retryable activation error.
	if err := manager.evictSupersededLocked(ctx, result.State.AddonID); err != nil {
		result.CleanupError = "Package file cleanup is pending; the server will retry automatically."
		manager.logger.Error("automatic package cleanup pending", "addonId", result.State.AddonID, "error", err)
	}
}
