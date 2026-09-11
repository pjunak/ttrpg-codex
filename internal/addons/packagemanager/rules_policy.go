package packagemanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"sort"

	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

type SourceChoice struct {
	AddonID   string `json:"addonId"`
	AddonName string `json:"addonName"`
	SetID     string `json:"setId"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Enabled   bool   `json:"enabled"`
	Pending   bool   `json:"pending"`
	Required  bool   `json:"required"`
}

type RulesPolicy struct {
	ContractVersion   string           `json:"contractVersion"`
	Revision          int64            `json:"revision"`
	GraphRevision     string           `json:"graphRevision"`
	Ruleset           *InstanceRuleset `json:"ruleset"`
	Sources           []SourceChoice   `json:"sources"`
	RestartedAddonIDs []string         `json:"restartedAddonIds"`
}

type SourceTarget struct {
	AddonID string `json:"addonId"`
	SetID   string `json:"setId"`
	ID      string `json:"id"`
}
type SourcePolicyPlan struct {
	ExpectedRevision      int64          `json:"expectedRevision"`
	ExpectedGraphRevision string         `json:"expectedGraphRevision"`
	Enabled               []SourceTarget `json:"enabled"`
}

func (manager *Manager) RulesPolicy(ctx context.Context) (RulesPolicy, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.rulesPolicyLocked(ctx)
}

func (manager *Manager) rulesPolicyLocked(ctx context.Context) (RulesPolicy, error) {
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return RulesPolicy{}, err
	}
	graph, err := manager.browserGraphLocked(ctx)
	if err != nil {
		return RulesPolicy{}, err
	}
	result := RulesPolicy{ContractVersion: "rules-policy.v1", Revision: configuration.Revision, GraphRevision: graph.GraphRevision, Ruleset: configuration.Ruleset, Sources: []SourceChoice{}, RestartedAddonIDs: manager.liveAddonIDs()}
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return result, err
	}
	for _, state := range states {
		report, err := manager.loadPackage(ctx, state.AddonID, state.ActiveGenerationID)
		if err != nil {
			return result, err
		}
		if report.Manifest.Rules == nil {
			continue
		}
		choices, err := sourceChoices(report, configuration)
		if err != nil {
			return result, err
		}
		result.Sources = append(result.Sources, choices...)
	}
	return result, nil
}

func sourceChoices(report packageinspect.Report, configuration instanceConfiguration) ([]SourceChoice, error) {
	result := make([]SourceChoice, 0)
	for _, set := range report.Manifest.Content {
		if set.Groups == nil {
			continue
		}
		catalog, err := report.ContentRegistry().SourceCatalog(set.ID, set.Groups.CatalogKind)
		if err != nil {
			return nil, err
		}
		foundation := []string{}
		if report.Manifest.Rules != nil && report.Manifest.Rules.Defines != nil && report.Manifest.Rules.Defines.ContentSet == set.ID {
			definition := report.Manifest.Rules.Defines
			foundation, err = report.ContentRegistry().RecordSources(set.ID, definition.RecordKind, definition.RecordID)
			if err != nil {
				return nil, err
			}
		}
		ids := make([]string, 0, len(catalog))
		for id := range catalog {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			enabled, known := configuration.Sources[report.Manifest.ID][set.ID][id]
			required := len(foundation) == 1 && foundation[0] == id
			if !known {
				enabled = len(foundation) > 0 && foundation[0] == id
			}
			result = append(result, SourceChoice{AddonID: report.Manifest.ID, AddonName: report.Manifest.Name, SetID: set.ID, ID: id, Name: catalog[id], Enabled: enabled, Pending: !known && !required, Required: required})
		}
	}
	return result, nil
}

func (manager *Manager) validateRulesCompatibility(ctx context.Context, manifest packageinspect.Manifest) error {
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return err
	}
	active := configuration.Ruleset
	if active == nil {
		if manifest.Rules == nil {
			return nil
		}
		if manifest.Rules.Defines == nil {
			if len(manifest.Content) > 0 {
				return fmt.Errorf("%w: install the defining rules package first", ErrRulesetCompatibility)
			}
			return nil
		}
		active = &InstanceRuleset{RulesetDefinition: *manifest.Rules.Defines, AddonID: manifest.ID}
		states, err := manager.store.activeStates(ctx)
		if err != nil {
			return err
		}
		for _, state := range states {
			if state.AddonID == manifest.ID {
				continue
			}
			installed, err := manager.store.manifest(ctx, state.AddonID, state.ActiveGenerationID)
			if err != nil {
				return err
			}
			if err := compatibleWithRuleset(installed, active); err != nil {
				return err
			}
			if installed.Rules != nil && installed.Rules.Defines != nil {
				return fmt.Errorf("%w: %s already supplies a complete rules profile", ErrRulesetCompatibility, installed.Name)
			}
		}
	}
	if manifest.Rules != nil && manifest.Rules.Defines != nil && manifest.ID != active.AddonID {
		state, err := manager.store.state(ctx, active.AddonID)
		if err != nil {
			return err
		}
		if state.ActiveGenerationID != "" {
			return fmt.Errorf("%w: disable %s before replacing the complete rules profile", ErrRulesetCompatibility, active.AddonID)
		}
	}
	return compatibleWithRuleset(manifest, active)
}

func compatibleWithRuleset(manifest packageinspect.Manifest, active *InstanceRuleset) error {
	if manifest.Rules != nil {
		if !slices.Contains(manifest.Rules.Supports, active.ID) {
			return fmt.Errorf("%w: %s does not declare support for %s", ErrRulesetCompatibility, manifest.Name, active.Name)
		}
		if manifest.Rules.Defines != nil && (manifest.Rules.Defines.ID != active.ID || manifest.Rules.Defines.Contract != active.Contract) {
			return fmt.Errorf("%w: this instance uses %s and %s", ErrRulesetCompatibility, active.ID, active.Contract)
		}
	}
	for _, service := range manifest.Services.Provides {
		if service.Contract == active.Contract && service.Transport == "content" && manifest.Rules == nil {
			return fmt.Errorf("%w: %s must declare supported rulesets", ErrRulesetCompatibility, manifest.Name)
		}
	}
	return nil
}

func (manager *Manager) validateRuleSources(ctx context.Context, report packageinspect.Report) error {
	if report.Manifest.Rules == nil || report.Manifest.Rules.Defines == nil {
		return nil
	}
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return err
	}
	definition := report.Manifest.Rules.Defines
	foundation, err := report.ContentRegistry().RecordSources(definition.ContentSet, definition.RecordKind, definition.RecordID)
	if err != nil {
		return err
	}
	if len(foundation) == 0 {
		return nil
	}
	choices, err := sourceChoices(report, configuration)
	if err != nil {
		return err
	}
	for _, choice := range choices {
		if choice.SetID == definition.ContentSet && choice.Enabled && slices.Contains(foundation, choice.ID) {
			return nil
		}
	}
	return fmt.Errorf("%w: the complete rules profile must retain an enabled source", ErrRulesetCompatibility)
}

func (manager *Manager) effectiveContent(ctx context.Context, report packageinspect.Report) (*contentcontract.Registry, error) {
	if report.Manifest.Rules == nil {
		return report.ContentRegistry(), nil
	}
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return nil, err
	}
	if manager.contentRevision != configuration.Revision {
		manager.contentRevision = configuration.Revision
		manager.contentCache = make(map[string]*contentcontract.Registry)
	}
	key := report.Manifest.ID + ":" + report.ArchiveSHA256
	if cached := manager.contentCache[key]; cached != nil {
		return cached, nil
	}
	choices, err := sourceChoices(report, configuration)
	if err != nil {
		return nil, err
	}
	selections := make(map[string]contentcontract.SourceSelection)
	for _, set := range report.Manifest.Content {
		if set.Groups == nil {
			continue
		}
		enabled := make(map[string]bool)
		for _, choice := range choices {
			if choice.SetID == set.ID {
				enabled[choice.ID] = choice.Enabled
			}
		}
		body, err := json.Marshal(struct {
			Generation string
			Revision   string
			Sources    map[string]bool
		}{report.ArchiveSHA256, set.Revision, enabled})
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(body)
		selections[set.ID] = contentcontract.SourceSelection{Revision: hex.EncodeToString(digest[:]), CatalogKind: set.Groups.CatalogKind, Enabled: enabled}
	}
	result := report.ContentRegistry().SelectSources(selections)
	manager.contentCache[key] = result
	return result, nil
}

func (manager *Manager) SetSourcePolicy(ctx context.Context, plan SourcePolicyPlan) (ConfigurationResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	current, err := manager.rulesPolicyLocked(ctx)
	if err != nil {
		return ConfigurationResult{}, err
	}
	if current.Revision != plan.ExpectedRevision || current.GraphRevision != plan.ExpectedGraphRevision {
		return ConfigurationResult{}, ErrConfigurationConflict
	}
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return ConfigurationResult{}, err
	}
	selected := make(map[SourceTarget]bool)
	before, _ := json.Marshal(configuration.Sources)
	for _, target := range plan.Enabled {
		if selected[target] {
			return ConfigurationResult{}, ErrInvalidPackage
		}
		selected[target] = true
	}
	for _, source := range current.Sources {
		target := SourceTarget{source.AddonID, source.SetID, source.ID}
		enabled := selected[target]
		delete(selected, target)
		if source.Required && !enabled {
			return ConfigurationResult{}, fmt.Errorf("%w: %s supplies the complete rules profile", ErrRulesetCompatibility, source.Name)
		}
		if configuration.Sources[source.AddonID] == nil {
			configuration.Sources[source.AddonID] = make(map[string]map[string]bool)
		}
		if configuration.Sources[source.AddonID][source.SetID] == nil {
			configuration.Sources[source.AddonID][source.SetID] = make(map[string]bool)
		}
		configuration.Sources[source.AddonID][source.SetID][source.ID] = enabled
	}
	if len(selected) > 0 {
		return ConfigurationResult{}, fmt.Errorf("%w: a selected source is no longer installed", ErrConfigurationConflict)
	}
	if current.Ruleset != nil {
		state, err := manager.store.state(ctx, current.Ruleset.AddonID)
		if err != nil {
			return ConfigurationResult{}, err
		}
		if state.ActiveGenerationID != "" {
			report, err := manager.loadPackage(ctx, state.AddonID, state.ActiveGenerationID)
			if err != nil {
				return ConfigurationResult{}, err
			}
			definition := current.Ruleset
			foundation, err := report.ContentRegistry().RecordSources(definition.ContentSet, definition.RecordKind, definition.RecordID)
			if err != nil {
				return ConfigurationResult{}, err
			}
			if len(foundation) > 0 && !slices.ContainsFunc(foundation, func(id string) bool { return configuration.Sources[state.AddonID][definition.ContentSet][id] }) {
				return ConfigurationResult{}, fmt.Errorf("%w: retain a source containing the complete rules profile", ErrRulesetCompatibility)
			}
		}
	}
	after, _ := json.Marshal(configuration.Sources)
	if reflect.DeepEqual(before, after) {
		return unchangedConfiguration(), nil
	}
	return manager.reconfigureLocked(ctx, func() error { return manager.store.saveSources(ctx, configuration) })
}
