package packagemanager

import (
	"context"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
)

func (manager *Manager) PrepareSchemaReview(ctx context.Context, addon, generation string) (datalifecycle.SchemaReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	coordinator, ok := manager.dataLifecycle.(datalifecycle.SchemaUpgrades)
	if !ok {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeUnavailable
	}
	state, err := manager.store.state(ctx, addon)
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	if state.ActiveGenerationID != "" {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeActive
	}
	if _, err = manager.store.generation(ctx, addon, generation); err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	report, err := manager.loadPackage(ctx, addon, generation)
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	id, err := manager.generateID()
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	if !validStageID(id) {
		return datalifecycle.SchemaReview{}, ErrInvalidConfig
	}
	return coordinator.PrepareSchemaReview(ctx, datalifecycle.SchemaReviewRequest{ReviewID: id, AddonID: addon, GenerationID: generation, ExpectedStateRevision: state.Revision}, report.DataRegistry())
}
func (manager *Manager) GetSchemaReview(ctx context.Context, id string) (datalifecycle.SchemaReview, error) {
	coordinator, ok := manager.dataLifecycle.(datalifecycle.SchemaUpgrades)
	if !ok {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeUnavailable
	}
	return coordinator.GetSchemaReview(ctx, id)
}
func (manager *Manager) SchemaReviewRecovery(ctx context.Context, id string) ([]byte, error) {
	coordinator, ok := manager.dataLifecycle.(datalifecycle.SchemaUpgrades)
	if !ok {
		return nil, datalifecycle.ErrUpgradeUnavailable
	}
	return coordinator.SchemaReviewRecovery(ctx, id)
}
func (manager *Manager) ApplySchemaReview(ctx context.Context, id, digest string) (datalifecycle.SchemaReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	coordinator, ok := manager.dataLifecycle.(datalifecycle.SchemaUpgrades)
	if !ok {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeUnavailable
	}
	review, err := coordinator.GetSchemaReview(ctx, id)
	if err != nil {
		return review, err
	}
	if review.ReviewSHA256 != digest {
		return review, datalifecycle.ErrUpgradeStale
	}
	if review.Status != "applied" {
		if _, err = manager.loadPackage(ctx, review.AddonID, review.GenerationID); err != nil {
			return review, err
		}
	}
	return coordinator.ApplySchemaReview(ctx, id, digest)
}
