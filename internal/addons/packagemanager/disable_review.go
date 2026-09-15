package packagemanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"time"
)

type DisableTarget struct {
	AddonID               string `json:"addonId"`
	GenerationID          string `json:"generationId"`
	ExpectedStateRevision int64  `json:"expectedStateRevision"`
}
type DisableReview struct {
	ContractVersion       string            `json:"contractVersion"`
	AddonID               string            `json:"addonId"`
	Name                  string            `json:"name"`
	Version               string            `json:"version"`
	ConfigurationRevision int64             `json:"configurationRevision"`
	GraphRevision         string            `json:"graphRevision"`
	Targets               []DisableTarget   `json:"targets"`
	Effects               []UninstallEffect `json:"effects"`
	StoppedAddonIDs       []string          `json:"stoppedAddonIds"`
	RestartedAddonIDs     []string          `json:"restartedAddonIds"`
	ReviewSHA256          string            `json:"reviewSha256"`
}
type ReviewedDisableResult struct {
	ConfigurationResult
	AddonID string `json:"addonId"`
}

func (manager *Manager) PrepareDisable(ctx context.Context, addonID string) (DisableReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.disableReviewLocked(ctx, addonID)
}
func (manager *Manager) disableReviewLocked(ctx context.Context, addonID string) (DisableReview, error) {
	state, err := manager.store.state(ctx, addonID)
	if err != nil {
		return DisableReview{}, err
	}
	if state.ActiveGenerationID == "" {
		return DisableReview{}, ErrReviewStale
	}
	// Durable inspected manifests also permit disabling a failed/corrupt runtime.
	manifest, err := manager.store.manifest(ctx, addonID, state.ActiveGenerationID)
	if err != nil {
		return DisableReview{}, err
	}
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return DisableReview{}, err
	}
	graph, err := manager.browserGraphLocked(ctx)
	if err != nil {
		return DisableReview{}, err
	}
	effects, err := manager.removalEffectsLocked(ctx, addonID, manifest)
	if err != nil {
		return DisableReview{}, err
	}
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return DisableReview{}, err
	}
	review := DisableReview{ContractVersion: "addon-disable-review.v1", AddonID: addonID, Name: manifest.Name, Version: manifest.Version,
		ConfigurationRevision: configuration.Revision, GraphRevision: graph.GraphRevision, Effects: effects,
		Targets: []DisableTarget{}, StoppedAddonIDs: manager.shutdownOrder(), RestartedAddonIDs: []string{}}
	for _, item := range states {
		if item.AddonID == addonID || slices.ContainsFunc(effects, func(effect UninstallEffect) bool { return effect.AddonID == item.AddonID && effect.Disabled }) {
			review.Targets = append(review.Targets, DisableTarget{AddonID: item.AddonID, GenerationID: item.ActiveGenerationID, ExpectedStateRevision: item.Revision})
		} else {
			review.RestartedAddonIDs = append(review.RestartedAddonIDs, item.AddonID)
		}
	}
	body, err := json.Marshal(review)
	if err != nil {
		return DisableReview{}, err
	}
	digest := sha256.Sum256(body)
	review.ReviewSHA256 = hex.EncodeToString(digest[:])
	return review, nil
}
func (manager *Manager) DisableReviewed(ctx context.Context, addonID, reviewSHA256 string) (ReviewedDisableResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	review, err := manager.disableReviewLocked(ctx, addonID)
	if err != nil {
		return ReviewedDisableResult{}, err
	}
	if review.ReviewSHA256 != reviewSHA256 {
		return ReviewedDisableResult{}, ErrReviewStale
	}
	// Finish an accepted transition even if the browser disconnects; never replay
	// an uncertain write automatically. A refresh reveals the durable outcome.
	transitionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	result, err := manager.reconfigureLocked(transitionCtx, func() error { return manager.store.disableReviewed(transitionCtx, review) })
	return ReviewedDisableResult{ConfigurationResult: result, AddonID: addonID}, err
}
func (store *store) disableReviewed(ctx context.Context, review DisableReview) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	configuration, err := readConfiguration(ctx, tx)
	if err != nil {
		return err
	}
	if configuration.Revision != review.ConfigurationRevision {
		return ErrReviewStale
	}
	now := store.now().UTC()
	for _, target := range review.Targets {
		result, err := tx.ExecContext(ctx, `UPDATE addon_package_states SET active_generation_id = NULL, revision = revision + 1, updated_at = ?
   WHERE addon_id = ? AND active_generation_id = ? AND revision = ?`, now.Format(time.RFC3339Nano), target.AddonID, target.GenerationID, target.ExpectedStateRevision)
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
		if err := insertEvent(ctx, tx, target.AddonID, target.GenerationID, "disabled", "Reviewed dependency disable: "+review.AddonID, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}
