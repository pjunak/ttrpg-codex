package packagemanager

import (
	"context"
	"github.com/pjunak/ttrpg-codex/internal/addons/contentcontract"
)

// ContentRegistry returns immutable content only for the exact generation that
// currently owns new work. The registry itself is generation-local and clones
// every record returned to callers.
func (manager *Manager) ContentRegistry(
	addonID string,
	generationID string,
) (*contentcontract.Registry, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	active, exists := manager.runtimes[addonID]
	if !exists || active.generation.GenerationID != generationID {
		return nil, ErrNotActive
	}
	registry := active.content
	if registry == nil {
		return nil, contentcontract.ErrSetNotFound
	}
	if active.report.Manifest.Rules != nil {
		return manager.effectiveContent(context.Background(), active.report)
	}
	return registry, nil
}
