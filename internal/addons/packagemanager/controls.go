package packagemanager

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

// Reload revalidates and replaces the runtime for the exact active generation.
// It deliberately keeps the provider catalog unchanged, so generation-safe
// consumer handles remain valid across the caller swap.
func (manager *Manager) Reload(
	ctx context.Context,
	addonID string,
	expectedStateRevision int64,
) (ActivationResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	state, err := manager.store.state(ctx, addonID)
	if err != nil {
		return ActivationResult{}, err
	}
	if state.Revision != expectedStateRevision {
		return ActivationResult{}, ErrStaleActivationPlan
	}
	if state.ActiveGenerationID == "" {
		return ActivationResult{}, ErrNotActive
	}
	previous, recovered := manager.runtimes[addonID]
	if !recovered {
		return manager.reloadUnavailableWorkerLocked(ctx, state)
	}
	if previous.generation.GenerationID != state.ActiveGenerationID {
		return ActivationResult{}, ErrRecoveryRequired
	}
	_, generation, report, permissions, services, normalizedGrants, err := manager.prepareActivation(ctx, ActivationPlan{
		AddonID: addonID, GenerationID: state.ActiveGenerationID,
		ExpectedStateRevision: expectedStateRevision,
		GrantedPermissionIDs:  state.GrantedPermissionIDs,
	}, true)
	if err != nil {
		return ActivationResult{}, err
	}
	if !reflect.DeepEqual(normalizedGrants, state.GrantedPermissionIDs) {
		return ActivationResult{}, ErrReviewStale
	}
	next, err := manager.createRuntime(report, generation, permissions, services)
	if err != nil {
		return ActivationResult{}, fmt.Errorf("%w: %v", ErrActivationFailed, err)
	}
	if next != nil {
		if err := next.Start(ctx); err != nil {
			_ = manager.store.recordFailure(ctx, addonID, generation.GenerationID, "reload-failed", err)
			return ActivationResult{}, fmt.Errorf("%w: start reloaded runtime: %v", ErrActivationFailed, err)
		}
	}
	stopNext := true
	defer func() {
		if stopNext && next != nil {
			_ = next.Shutdown(context.Background())
		}
	}()
	if err := manager.activatePublishedServices(ctx, report, generation, next); err != nil {
		_ = manager.store.recordFailure(ctx, addonID, generation.GenerationID, "reload-failed", err)
		return ActivationResult{}, fmt.Errorf("%w: publish reloaded runtime: %v", ErrActivationFailed, err)
	}
	newState, err := manager.store.setActive(
		ctx, addonID, generation.GenerationID, expectedStateRevision,
		normalizedGrants, "reloaded", "",
	)
	if err != nil {
		restoreErr := manager.activatePublishedServices(
			ctx, previous.report, previous.generation, previous.runtime,
		)
		return ActivationResult{}, errors.Join(err, restoreErr)
	}
	manager.runtimes[addonID] = activeRuntime{
		generation: generation, report: report, content: report.ContentRegistry(), runtime: next,
		services: append([]servicebroker.Handle(nil), services...),
	}
	stopNext = false
	manager.workerReadyLocked(newState)
	manager.publishBrowserGraphChangeLocked(ctx, addonID, "reloaded")
	result := ActivationResult{
		State: newState, Generation: generation, PreviousGenerationID: generation.GenerationID,
	}
	if previous.runtime != nil {
		if err := previous.runtime.Shutdown(ctx); err != nil {
			result.CleanupError = err.Error()
			_ = manager.store.recordFailure(ctx, addonID, generation.GenerationID, "cleanup-failed", err)
		}
	}
	return result, nil
}

// Disable revokes new service calls before clearing durable activation. Grants
// and installed generations are preserved. A failed or unrecovered runtime can
// still be disabled because no code needs to start for this transition.
func (manager *Manager) Disable(ctx context.Context, plan DisablePlan) (DisableResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	state, err := manager.store.state(ctx, plan.AddonID)
	if err != nil {
		return DisableResult{}, err
	}
	if state.Revision != plan.ExpectedStateRevision {
		return DisableResult{}, ErrStaleActivationPlan
	}
	if state.ActiveGenerationID == "" {
		return DisableResult{State: state}, nil
	}
	if dependents := manager.liveDependents(plan.AddonID); len(dependents) != 0 {
		return DisableResult{}, fmt.Errorf("%w: %v", ErrActivationCohort, dependents)
	}
	previous, recovered := manager.runtimes[plan.AddonID]
	if recovered && previous.generation.GenerationID != state.ActiveGenerationID {
		return DisableResult{}, ErrRecoveryRequired
	}
	dataTransition := manager.dataLifecycle.BeginDeactivation(plan.AddonID, state.ActiveGenerationID)
	defer dataTransition.Rollback()
	manager.broker.DeactivateRuntime(plan.AddonID, state.ActiveGenerationID)
	newState, err := manager.store.setDisabled(
		ctx, plan.AddonID, state.ActiveGenerationID, plan.ExpectedStateRevision,
	)
	if err != nil {
		if recovered {
			restoreErr := manager.activatePublishedServices(
				ctx, previous.report, previous.generation, previous.runtime,
			)
			return DisableResult{}, errors.Join(err, restoreErr)
		}
		return DisableResult{}, err
	}
	dataTransition.Commit()
	delete(manager.runtimes, plan.AddonID)
	manager.publishBrowserGraphChangeLocked(ctx, plan.AddonID, "disabled")
	result := DisableResult{State: newState, PreviousGenerationID: state.ActiveGenerationID}
	if recovered && previous.runtime != nil {
		if err := previous.runtime.Shutdown(ctx); err != nil {
			result.CleanupError = err.Error()
			_ = manager.store.recordFailure(ctx, plan.AddonID, state.ActiveGenerationID, "cleanup-failed", err)
		}
	}
	return result, nil
}
