package packagemanager

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

type ServiceCandidate struct {
	servicebroker.Provider
	Compatible bool `json:"compatible"`
}
type ServiceSelection struct {
	Active       bool                      `json:"active"`
	Version      string                    `json:"version"`
	ConsumerName string                    `json:"consumerName"`
	GenerationID string                    `json:"generationId"`
	Requirement  servicebroker.Requirement `json:"requirement"`
	Resolution   servicebroker.Resolution  `json:"resolution"`
	Candidates   []ServiceCandidate        `json:"candidates"`
}
type ServiceSelections struct {
	ContractVersion   string             `json:"contractVersion"`
	Revision          int64              `json:"revision"`
	GraphRevision     string             `json:"graphRevision"`
	Services          []ServiceSelection `json:"services"`
	RestartedAddonIDs []string           `json:"restartedAddonIds"`
}
type ServiceSelectionPlan struct {
	ExpectedRevision        int64    `json:"expectedRevision"`
	ExpectedGraphRevision   string   `json:"expectedGraphRevision"`
	ConsumerAddonID         string   `json:"consumerAddonId"`
	GenerationID            string   `json:"generationId"`
	Contract                string   `json:"contract"`
	ExpectedBindingRevision int64    `json:"expectedBindingRevision"`
	Automatic               bool     `json:"automatic"`
	ProviderAddonIDs        []string `json:"providerAddonIds"`
}
type ConfigurationResult struct {
	ContractVersion   string           `json:"contractVersion"`
	Applied           bool             `json:"applied"`
	RestartedAddonIDs []string         `json:"restartedAddonIds"`
	RecoveryResults   []RecoveryResult `json:"recoveryResults"`
	RecoveryError     string           `json:"recoveryError,omitempty"`
}

func (manager *Manager) ServiceSelections(ctx context.Context) (ServiceSelections, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.serviceSelectionsLocked(ctx)
}
func (manager *Manager) serviceSelectionsLocked(ctx context.Context) (ServiceSelections, error) {
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return ServiceSelections{}, err
	}
	graph, err := manager.browserGraphLocked(ctx)
	if err != nil {
		return ServiceSelections{}, err
	}
	result := ServiceSelections{ContractVersion: "service-selections.v1", Revision: configuration.Revision, GraphRevision: graph.GraphRevision, Services: []ServiceSelection{}, RestartedAddonIDs: manager.liveAddonIDs()}
	ids, err := manager.store.installedAddonIDs(ctx)
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		snapshot, err := manager.store.snapshot(ctx, id, 1)
		if err != nil {
			return result, err
		}
		generations := []string{}
		if snapshot.State.ActiveGenerationID != "" {
			generations = append(generations, snapshot.State.ActiveGenerationID)
		}
		if len(snapshot.Generations) > 0 && !slices.Contains(generations, snapshot.Generations[0].GenerationID) {
			generations = append(generations, snapshot.Generations[0].GenerationID)
		}
		for _, generation := range generations {
			manifest, err := manager.store.manifest(ctx, id, generation)
			if err != nil {
				return result, err
			}
			for _, consumer := range manifest.Services.Consumes {
				requirement := servicebroker.Requirement{ConsumerAddonID: id, Contract: consumer.Contract, Range: consumer.Range, Cardinality: servicebroker.Cardinality(consumer.Cardinality), Required: consumer.Required, Selection: servicebroker.Selection(consumer.Selection), Scope: servicebroker.GlobalScope()}
				resolution, err := manager.broker.Resolve(ctx, requirement)
				if err != nil {
					return result, err
				}
				if resolution.Providers == nil {
					resolution.Providers = []servicebroker.Provider{}
				}
				providers, err := manager.broker.ListProviders(ctx, consumer.Contract)
				if err != nil {
					return result, err
				}
				row := ServiceSelection{Active: generation == snapshot.State.ActiveGenerationID, Version: manifest.Version, ConsumerName: manifest.Name, GenerationID: generation, Requirement: requirement, Resolution: resolution, Candidates: []ServiceCandidate{}}
				for _, provider := range providers {
					if provider.AddonID == id {
						continue
					}
					row.Candidates = append(row.Candidates, ServiceCandidate{Provider: provider, Compatible: versionSatisfies(provider.ContractVersion, consumer.Range)})
				}
				result.Services = append(result.Services, row)
			}
		}
	}
	return result, nil
}

func unchangedConfiguration() ConfigurationResult {
	return ConfigurationResult{ContractVersion: "addon-configuration-result.v1", Applied: true, RestartedAddonIDs: []string{}, RecoveryResults: []RecoveryResult{}}
}

func (manager *Manager) SetServiceSelection(ctx context.Context, plan ServiceSelectionPlan) (ConfigurationResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	current, err := manager.serviceSelectionsLocked(ctx)
	if err != nil {
		return ConfigurationResult{}, err
	}
	if current.Revision != plan.ExpectedRevision || current.GraphRevision != plan.ExpectedGraphRevision {
		return ConfigurationResult{}, ErrConfigurationConflict
	}
	for _, row := range current.Services {
		if row.Requirement.ConsumerAddonID != plan.ConsumerAddonID || row.Requirement.Contract != plan.Contract || row.GenerationID != plan.GenerationID {
			continue
		}
		if row.Requirement.Selection != servicebroker.SelectionOperator {
			return ConfigurationResult{}, servicebroker.ErrInvalidSelection
		}
		revision := int64(0)
		if row.Resolution.Binding != nil {
			revision = row.Resolution.Binding.Revision
		}
		if revision != plan.ExpectedBindingRevision {
			return ConfigurationResult{}, ErrConfigurationConflict
		}
		if plan.Automatic {
			if len(plan.ProviderAddonIDs) != 0 {
				return ConfigurationResult{}, servicebroker.ErrInvalidSelection
			}
			if revision == 0 {
				return ConfigurationResult{ContractVersion: "addon-configuration-result.v1", Applied: true, RestartedAddonIDs: []string{}, RecoveryResults: []RecoveryResult{}}, nil
			}
		} else {
			if row.Requirement.Cardinality == servicebroker.CardinalityOne && len(plan.ProviderAddonIDs) != 1 {
				return ConfigurationResult{}, servicebroker.ErrInvalidSelection
			}
			for index, id := range plan.ProviderAddonIDs {
				if slices.Contains(plan.ProviderAddonIDs[:index], id) {
					return ConfigurationResult{}, servicebroker.ErrInvalidSelection
				}
				if !slices.ContainsFunc(row.Candidates, func(candidate ServiceCandidate) bool {
					return candidate.AddonID == id && candidate.Compatible && candidate.ActiveGeneration != ""
				}) {
					return ConfigurationResult{}, servicebroker.ErrInvalidSelection
				}
			}
		}
		return manager.reconfigureLocked(ctx, func() error {
			if plan.Automatic {
				return manager.broker.ClearBinding(ctx, row.Requirement, revision)
			}
			_, err := manager.broker.SetBinding(ctx, row.Requirement, plan.ProviderAddonIDs, revision)
			return err
		})
	}
	return ConfigurationResult{}, fmt.Errorf("%w: consumer declaration changed", ErrConfigurationConflict)
}

// Configuration uses the same provider-first recovery as reviewed upgrades.
// A failed restart leaves the accepted configuration visible and recoverable;
// it never reports a silent fallback to another provider or touches campaign data.
func (manager *Manager) reconfigureLocked(ctx context.Context, save func() error) (ConfigurationResult, error) {
	result := ConfigurationResult{ContractVersion: "addon-configuration-result.v1", RestartedAddonIDs: manager.liveAddonIDs(), RecoveryResults: []RecoveryResult{}}
	if err := manager.shutdownLocked(ctx); err != nil {
		_, recoveryErr := manager.recoverLocked(ctx)
		manager.publishBrowserGraphChangeLocked(ctx, "", "configuration-stop-failed")
		return result, errors.Join(err, recoveryErr)
	}
	if err := save(); err != nil {
		_, recoveryErr := manager.recoverLocked(ctx)
		manager.publishBrowserGraphChangeLocked(ctx, "", "configuration-rejected")
		return result, errors.Join(err, recoveryErr)
	}
	result.Applied = true
	var err error
	result.RecoveryResults, err = manager.recoverLocked(ctx)
	if err != nil {
		result.RecoveryError = err.Error()
	}
	manager.publishBrowserGraphChangeLocked(ctx, "", "configuration-changed")
	return result, nil
}
