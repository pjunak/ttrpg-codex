package packagemanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

type browserGraphState struct {
	AddonID            string `json:"addonId"`
	ActiveGenerationID string `json:"activeGenerationId"`
	Revision           int64  `json:"revision"`
}

// BrowserGraph projects only recovered, server-authoritative UI generations.
// Its opaque revision also includes every durable active add-on state, so a
// worker-only reload or provider cohort can force browser SDK handles to be
// rebuilt even when UI package URLs remain unchanged.
func (manager *Manager) BrowserGraph(ctx context.Context) (BrowserGraph, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	states, err := manager.store.activeStates(ctx)
	if err != nil {
		return BrowserGraph{}, err
	}
	revisionStates := make([]browserGraphState, 0, len(states))
	addOns := make([]BrowserGeneration, 0)
	for _, state := range states {
		revisionStates = append(revisionStates, browserGraphState{
			AddonID: state.AddonID, ActiveGenerationID: state.ActiveGenerationID,
			Revision: state.Revision,
		})
		active, recovered := manager.runtimes[state.AddonID]
		if !recovered || active.generation.GenerationID != state.ActiveGenerationID ||
			active.report.Manifest.Runtime == nil || active.report.Manifest.Runtime.UI == nil {
			continue
		}
		ui := active.report.Manifest.Runtime.UI
		generation := BrowserGeneration{
			AddonID: state.AddonID, AddonVersion: active.generation.Version,
			GenerationID: active.generation.GenerationID, Mode: ui.Mode,
			EntryURL:     browserAssetURL(state.AddonID, active.generation.GenerationID, ui.Entry),
			StyleURLs:    make([]string, 0, len(ui.Styles)),
			Sandbox:      append([]string{}, ui.Sandbox...),
			Dependencies: make([]string, 0),
		}
		for _, style := range ui.Styles {
			generation.StyleURLs = append(
				generation.StyleURLs,
				browserAssetURL(state.AddonID, active.generation.GenerationID, style),
			)
		}
		for _, dependency := range active.report.Manifest.Dependencies {
			if !dependency.Required {
				continue
			}
			provider, exists := manager.runtimes[dependency.ID]
			if exists && provider.report.Manifest.Runtime != nil && provider.report.Manifest.Runtime.UI != nil {
				generation.Dependencies = append(generation.Dependencies, dependency.ID)
			}
		}
		sort.Strings(generation.StyleURLs)
		sort.Strings(generation.Sandbox)
		sort.Strings(generation.Dependencies)
		addOns = append(addOns, generation)
	}
	sort.Slice(addOns, func(left, right int) bool { return addOns[left].AddonID < addOns[right].AddonID })
	body, err := json.Marshal(struct {
		States []browserGraphState `json:"states"`
		Addons []BrowserGeneration `json:"addons"`
	}{States: revisionStates, Addons: addOns})
	if err != nil {
		return BrowserGraph{}, fmt.Errorf("encode browser graph revision: %w", err)
	}
	digest := sha256.Sum256(body)
	return BrowserGraph{GraphRevision: hex.EncodeToString(digest[:]), Addons: addOns}, nil
}

func browserAssetURL(addonID string, generationID string, packagePath string) string {
	parts := strings.Split(packagePath, "/")
	for index := range parts {
		parts[index] = url.PathEscape(parts[index])
	}
	return "/api/addons/" + url.PathEscape(addonID) +
		"/generations/" + url.PathEscape(generationID) +
		"/assets/" + strings.Join(parts, "/")
}
