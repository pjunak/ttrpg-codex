package packagemanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"sort"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

type UninstallEffect struct {
	AddonID  string   `json:"addonId"`
	Name     string   `json:"name"`
	Disabled bool     `json:"disabled"`
	Reasons  []string `json:"reasons"`
}

type RetainedData struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Documents int    `json:"documents"`
}

type UninstallReview struct {
	ContractVersion       string            `json:"contractVersion"`
	AddonID               string            `json:"addonId"`
	Name                  string            `json:"name"`
	Version               string            `json:"version"`
	GenerationID          string            `json:"generationId"`
	ExpectedStateRevision int64             `json:"expectedStateRevision"`
	ConfigurationRevision int64             `json:"configurationRevision"`
	GraphRevision         string            `json:"graphRevision"`
	SourceRevision        int64             `json:"sourceRevision"`
	UnlinksSource         bool              `json:"unlinksSource"`
	RulesetName           string            `json:"rulesetName"`
	Generations           []string          `json:"generations"`
	Effects               []UninstallEffect `json:"effects"`
	StoppedAddonIDs       []string          `json:"stoppedAddonIds"`
	RetainedData          []RetainedData    `json:"retainedData"`
	ReviewSHA256          string            `json:"reviewSha256"`
}

type UninstallResult struct {
	ConfigurationResult
	AddonID        string `json:"addonId"`
	AlreadyRemoved bool   `json:"alreadyRemoved"`
}

func (manager *Manager) PrepareUninstall(ctx context.Context, addonID string) (UninstallReview, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.uninstallReviewLocked(ctx, addonID)
}

func (manager *Manager) uninstallReviewLocked(ctx context.Context, addonID string) (UninstallReview, error) {
	snapshot, err := manager.store.snapshot(ctx, addonID, 1)
	if err != nil {
		return UninstallReview{}, err
	}
	if len(snapshot.Generations) == 0 {
		return UninstallReview{}, ErrGenerationNotFound
	}
	generation := snapshot.State.ActiveGenerationID
	if generation == "" {
		generation = snapshot.Generations[0].GenerationID
	}
	// The durable inspected manifest also allows removal of a corrupt package
	// whose worker/assets can no longer be loaded or recovered.
	manifest, err := manager.store.manifest(ctx, addonID, generation)
	if err != nil {
		return UninstallReview{}, err
	}
	configuration, err := manager.store.configuration(ctx)
	if err != nil {
		return UninstallReview{}, err
	}
	graph, err := manager.browserGraphLocked(ctx)
	if err != nil {
		return UninstallReview{}, err
	}
	review := UninstallReview{ContractVersion: "addon-uninstall-review.v1", AddonID: addonID, Name: manifest.Name, Version: manifest.Version,
		GenerationID: generation, ExpectedStateRevision: snapshot.State.Revision, ConfigurationRevision: configuration.Revision,
		GraphRevision: graph.GraphRevision, Generations: []string{}, Effects: []UninstallEffect{}, StoppedAddonIDs: manager.liveAddonIDs()}
	for _, item := range snapshot.Generations {
		review.Generations = append(review.Generations, item.GenerationID)
	}
	sort.Strings(review.Generations)
	if configuration.Ruleset != nil && configuration.Ruleset.AddonID == addonID {
		review.RulesetName = configuration.Ruleset.Name
	}
	if err := manager.store.uninstallDetails(ctx, &review); err != nil {
		return UninstallReview{}, err
	}
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return UninstallReview{}, err
	}
	manifests := map[string]packageinspect.Manifest{addonID: manifest}
	for _, state := range states {
		item, err := manager.store.manifest(ctx, state.AddonID, state.ActiveGenerationID)
		if err != nil {
			return UninstallReview{}, err
		}
		manifests[state.AddonID] = item
	}
	excluded := []string{addonID}
	disabled := map[string]bool{}
	for {
		changed := false
		for _, state := range states {
			if slices.Contains(excluded, state.AddonID) {
				continue
			}
			mustDisable, _, err := manager.removalEffect(ctx, manifests[state.AddonID], manifests, excluded)
			if err != nil {
				return UninstallReview{}, err
			}
			if mustDisable {
				excluded = append(excluded, state.AddonID)
				disabled[state.AddonID] = true
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	for _, state := range states {
		if state.AddonID == addonID {
			continue
		}
		_, reasons, err := manager.removalEffect(ctx, manifests[state.AddonID], manifests, excluded)
		if err != nil {
			return UninstallReview{}, err
		}
		if len(reasons) > 0 {
			review.Effects = append(review.Effects, UninstallEffect{AddonID: state.AddonID, Name: manifests[state.AddonID].Name, Disabled: disabled[state.AddonID], Reasons: reasons})
		}
	}
	body, err := json.Marshal(review)
	if err != nil {
		return UninstallReview{}, err
	}
	digest := sha256.Sum256(body)
	review.ReviewSHA256 = hex.EncodeToString(digest[:])
	return review, nil
}

func (manager *Manager) removalEffect(ctx context.Context, manifest packageinspect.Manifest, manifests map[string]packageinspect.Manifest, excluded []string) (bool, []string, error) {
	disabled, reasons := false, []string{}
	for _, dependency := range manifest.Dependencies {
		if slices.Contains(excluded, dependency.ID) {
			disabled = disabled || dependency.Required
			reasons = append(reasons, dependency.ID)
		}
	}
	for _, consumer := range manifest.Services.Consumes {
		affected := false
		for _, id := range excluded {
			if id == manifest.ID {
				continue
			}
			for _, provider := range manifests[id].Services.Provides {
				if provider.Contract == consumer.Contract && versionSatisfies(provider.Version, consumer.Range) {
					affected = true
				}
			}
		}
		if !affected {
			continue
		}
		reasons = append(reasons, consumer.Contract)
		if consumer.Required {
			resolution, err := manager.broker.ResolveWithout(ctx, servicebroker.Requirement{ConsumerAddonID: manifest.ID, Contract: consumer.Contract,
				Range: consumer.Range, Cardinality: servicebroker.Cardinality(consumer.Cardinality), Required: true,
				Selection: servicebroker.Selection(consumer.Selection), Scope: servicebroker.GlobalScope()}, excluded)
			if err != nil {
				return false, nil, err
			}
			disabled = disabled || resolution.Status != servicebroker.ResolutionResolved
		}
	}
	sort.Strings(reasons)
	return disabled, slices.Compact(reasons), nil
}

func (manager *Manager) Uninstall(ctx context.Context, addonID, reviewSHA256 string) (UninstallResult, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	previous, err := manager.store.uninstallHash(ctx, addonID)
	if err != nil {
		return UninstallResult{}, err
	}
	if previous != "" {
		if previous != reviewSHA256 {
			return UninstallResult{}, ErrReviewStale
		}
		return UninstallResult{ConfigurationResult: unchangedConfiguration(), AddonID: addonID, AlreadyRemoved: true}, nil
	}
	review, err := manager.uninstallReviewLocked(ctx, addonID)
	if err != nil {
		return UninstallResult{}, err
	}
	if review.ReviewSHA256 != reviewSHA256 {
		return UninstallResult{}, ErrReviewStale
	}
	// Once confirmed, a disconnected browser must not interrupt worker shutdown
	// between withdrawing runtime authority and committing durable removal.
	transitionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	result, err := manager.reconfigureLocked(transitionCtx, func() error { return manager.store.uninstall(transitionCtx, review) })
	return UninstallResult{ConfigurationResult: result, AddonID: addonID}, err
}
