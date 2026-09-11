package packagemanager

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

type recoveryCandidate struct {
	state       State
	generation  Generation
	report      packageinspect.Report
	permissions []packageinspect.Permission
}

// Recover reconstructs only the generations selected by durable state. It
// republishes every provider catalog before starting workers, then activates
// candidates in dependency/service order without silently choosing an older
// generation when one fails.
func (manager *Manager) Recover(ctx context.Context) ([]RecoveryResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	results, err := manager.recoverLocked(ctx)
	if err == nil {
		manager.publishBrowserGraphChangeLocked(ctx, "", "recovered")
	}
	return results, err
}

func (manager *Manager) recoverLocked(ctx context.Context) ([]RecoveryResult, error) {
	if len(manager.runtimes) != 0 {
		return nil, fmt.Errorf("%w: manager already has live generations", ErrRecoveryRequired)
	}
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return nil, err
	}
	results := make(map[string]RecoveryResult, len(states))
	pending := make(map[string]recoveryCandidate, len(states))
	for _, state := range states {
		generation, err := manager.store.generation(ctx, state.AddonID, state.ActiveGenerationID)
		if err != nil {
			results[state.AddonID] = recoveryFailure(state, err)
			continue
		}
		report, err := manager.loadPackage(ctx, state.AddonID, state.ActiveGenerationID)
		if err == nil {
			err = manager.validateCompatibility(report.Manifest)
		}
		if err == nil {
			err = manager.validateRulesCompatibility(ctx, report.Manifest)
		}
		if err == nil {
			err = manager.validateRuleSources(ctx, report)
		}
		var permissions []packageinspect.Permission
		if err == nil {
			permissions, _, err = approvedPermissions(report.Manifest.Permissions, state.GrantedPermissionIDs)
		}
		if err == nil {
			err = manager.validateDependencies(ctx, report.Manifest, false)
		}
		if err == nil {
			err = manager.broker.ReplaceProviders(
				ctx, report.Manifest.ID, report.Manifest.Version, providerDeclarations(report),
			)
		}
		if err != nil {
			_ = manager.store.recordFailure(ctx, state.AddonID, state.ActiveGenerationID, "recovery-failed", err)
			results[state.AddonID] = recoveryFailure(state, err)
			continue
		}
		pending[state.AddonID] = recoveryCandidate{
			state: state, generation: generation, report: report, permissions: permissions,
		}
	}

	for len(pending) > 0 {
		progress := false
		for pass := 0; pass < 2 && !progress; pass++ {
			allowOptionalFallback := pass == 1
			for _, addonID := range sortedCandidateIDs(pending) {
				candidate := pending[addonID]
				if !allowOptionalFallback && hasPendingOptionalPrerequisite(candidate, pending) {
					continue
				}
				active, ready, err := manager.recoverCandidate(ctx, candidate)
				if !ready {
					continue
				}
				if err != nil {
					_ = manager.store.recordFailure(ctx, addonID, candidate.generation.GenerationID, "recovery-failed", err)
					results[addonID] = recoveryFailure(candidate.state, err)
				} else {
					manager.runtimes[addonID] = active
					if err := manager.store.recordRecovery(ctx, addonID, candidate.generation.GenerationID); err != nil {
						manager.logger.Error("record recovered add-on generation", "addonId", addonID, "error", err)
					}
					results[addonID] = RecoveryResult{
						AddonID: addonID, GenerationID: candidate.generation.GenerationID, Recovered: true,
					}
				}
				delete(pending, addonID)
				progress = true
			}
		}
		if progress {
			continue
		}
		for _, addonID := range sortedCandidateIDs(pending) {
			candidate := pending[addonID]
			cause := manager.recoveryBlocker(ctx, candidate)
			_ = manager.store.recordFailure(ctx, addonID, candidate.generation.GenerationID, "recovery-failed", cause)
			results[addonID] = recoveryFailure(candidate.state, cause)
			delete(pending, addonID)
		}
	}
	ordered := make([]RecoveryResult, 0, len(states))
	for _, state := range states {
		ordered = append(ordered, results[state.AddonID])
	}
	return ordered, nil
}

func (manager *Manager) recoverCandidate(
	ctx context.Context,
	candidate recoveryCandidate,
) (activeRuntime, bool, error) {
	if err := manager.validateDependencies(ctx, candidate.report.Manifest, true); err != nil {
		return activeRuntime{}, false, nil
	}
	services, err := manager.resolveServices(ctx, candidate.report.Manifest)
	if err != nil {
		return activeRuntime{}, false, nil
	}
	runtime, err := manager.createRuntime(candidate.report, candidate.generation, candidate.permissions, services)
	if err == nil && runtime != nil {
		err = runtime.Start(ctx)
	}
	if err == nil {
		err = manager.activatePublishedServices(ctx, candidate.report, candidate.generation, runtime)
	}
	var dataTransition datalifecycle.Transition
	if err == nil {
		dataTransition, err = manager.dataLifecycle.BeginActivation(
			ctx, candidate.state.AddonID, candidate.generation.GenerationID,
			candidate.report.DataRegistry(),
		)
	}
	if err != nil {
		manager.broker.DeactivateRuntime(candidate.state.AddonID, candidate.generation.GenerationID)
		if runtime != nil {
			_ = runtime.Shutdown(context.Background())
		}
		return activeRuntime{}, true, err
	}
	dataTransition.Commit()
	return activeRuntime{
		generation: candidate.generation, report: candidate.report,
		content: candidate.report.ContentRegistry(), runtime: runtime,
		services: append([]servicebroker.Handle(nil), services...),
	}, true, nil
}

func hasPendingOptionalPrerequisite(
	candidate recoveryCandidate,
	pending map[string]recoveryCandidate,
) bool {
	for _, dependency := range candidate.report.Manifest.Dependencies {
		if dependency.Required {
			continue
		}
		provider, exists := pending[dependency.ID]
		if exists && versionSatisfies(provider.generation.Version, dependency.Range) {
			return true
		}
	}
	for _, consumer := range candidate.report.Manifest.Services.Consumes {
		if consumer.Required {
			continue
		}
		for providerID, provider := range pending {
			if providerID == candidate.state.AddonID {
				continue
			}
			for _, declaration := range provider.report.Manifest.Services.Provides {
				if declaration.Contract == consumer.Contract && versionSatisfies(declaration.Version, consumer.Range) {
					return true
				}
			}
		}
	}
	return false
}

func (manager *Manager) recoveryBlocker(ctx context.Context, candidate recoveryCandidate) error {
	if err := manager.validateDependencies(ctx, candidate.report.Manifest, true); err != nil {
		return err
	}
	if _, err := manager.resolveServices(ctx, candidate.report.Manifest); err != nil {
		return err
	}
	return fmt.Errorf("%w: dependency cycle or unavailable provider", ErrRecoveryRequired)
}

func recoveryFailure(state State, cause error) RecoveryResult {
	return RecoveryResult{
		AddonID: state.AddonID, GenerationID: state.ActiveGenerationID,
		Recovered: false, Error: cause.Error(),
	}
}

func sortedCandidateIDs(values map[string]recoveryCandidate) []string {
	result := make([]string, 0, len(values))
	for addonID := range values {
		result = append(result, addonID)
	}
	sort.Strings(result)
	return result
}

// Shutdown withdraws service routing before stopping workers. Durable active
// pointers remain unchanged so the same exact generations are recovered on
// the next host start.
func (manager *Manager) Shutdown(ctx context.Context) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.shutdownLocked(ctx)
}

func (manager *Manager) shutdownLocked(ctx context.Context) error {
	order := manager.shutdownOrder()
	var shutdownErrors []error
	for _, addonID := range order {
		active := manager.runtimes[addonID]
		dataTransition := manager.dataLifecycle.BeginDeactivation(addonID, active.generation.GenerationID)
		manager.broker.DeactivateRuntime(addonID, active.generation.GenerationID)
		dataTransition.Commit()
		if active.runtime != nil {
			if err := active.runtime.Shutdown(ctx); err != nil {
				shutdownErrors = append(shutdownErrors, fmt.Errorf("%s: %w", addonID, err))
			}
		}
		delete(manager.runtimes, addonID)
	}
	return errors.Join(shutdownErrors...)
}

func (manager *Manager) shutdownOrder() []string {
	dependencies := make(map[string][]string, len(manager.runtimes))
	for addonID, active := range manager.runtimes {
		set := make(map[string]struct{})
		for _, dependency := range active.report.Manifest.Dependencies {
			if _, exists := manager.runtimes[dependency.ID]; exists {
				set[dependency.ID] = struct{}{}
			}
		}
		for _, handle := range active.services {
			if _, exists := manager.runtimes[handle.ProviderAddonID]; exists && handle.ProviderAddonID != addonID {
				set[handle.ProviderAddonID] = struct{}{}
			}
		}
		for dependency := range set {
			dependencies[addonID] = append(dependencies[addonID], dependency)
		}
		sort.Strings(dependencies[addonID])
	}
	visited := make(map[string]bool, len(manager.runtimes))
	visiting := make(map[string]bool, len(manager.runtimes))
	providersFirst := make([]string, 0, len(manager.runtimes))
	var visit func(string)
	visit = func(addonID string) {
		if visited[addonID] || visiting[addonID] {
			return
		}
		visiting[addonID] = true
		for _, dependency := range dependencies[addonID] {
			visit(dependency)
		}
		delete(visiting, addonID)
		visited[addonID] = true
		providersFirst = append(providersFirst, addonID)
	}
	addonIDs := make([]string, 0, len(manager.runtimes))
	for addonID := range manager.runtimes {
		addonIDs = append(addonIDs, addonID)
	}
	sort.Strings(addonIDs)
	for _, addonID := range addonIDs {
		visit(addonID)
	}
	for left, right := 0, len(providersFirst)-1; left < right; left, right = left+1, right-1 {
		providersFirst[left], providersFirst[right] = providersFirst[right], providersFirst[left]
	}
	return providersFirst
}
