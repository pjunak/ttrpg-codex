package packagemanager

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

// BrowserServiceRequest repeats a package-owned consumer declaration at the
// browser boundary. The manager accepts it only when it exactly matches the
// active manifest; browser code cannot widen its own service authority.
type BrowserServiceRequest struct {
	Contract    string
	Range       string
	Cardinality string
	IncludeOwn  bool
}

type BrowserServiceProvider struct {
	AddonID         string `json:"addonId"`
	ContractVersion string `json:"contractVersion"`
	Generation      string `json:"generation"`
	BindingRevision int64  `json:"bindingRevision"`
}

type BrowserServiceConnection struct {
	Contract    string                   `json:"contract"`
	Range       string                   `json:"range"`
	Cardinality string                   `json:"cardinality"`
	Providers   []BrowserServiceProvider `json:"providers"`
}

type BrowserServiceTarget struct {
	Contract        string
	ProviderAddonID string
	ContractVersion string
	Generation      string
	BindingRevision int64
}

// ConnectBrowserService returns only the handles resolved for the exact active
// generation. Optional unavailable services are represented by an empty
// provider list so the browser package can keep its documented fallback mode.
func (manager *Manager) ConnectBrowserService(
	ctx context.Context,
	addonID string,
	generationID string,
	request BrowserServiceRequest,
) (BrowserServiceConnection, error) {
	if err := ctx.Err(); err != nil {
		return BrowserServiceConnection{}, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	active, ok := manager.browserServiceRuntime(addonID, generationID)
	if !ok {
		return BrowserServiceConnection{}, ErrNotActive
	}
	declaration, ok := consumedService(active.report.Manifest, request.Contract)
	if !ok || declaration.Range != request.Range || declaration.Cardinality != request.Cardinality {
		return BrowserServiceConnection{}, fmt.Errorf(
			"%w: browser request does not match the active consumer declaration",
			ErrServiceResolution,
		)
	}
	providers := make([]BrowserServiceProvider, 0)
	for _, handle := range active.services {
		if handle.Contract != request.Contract {
			continue
		}
		providers = append(providers, BrowserServiceProvider{
			AddonID: handle.ProviderAddonID, ContractVersion: handle.ContractVersion,
			Generation: handle.Generation, BindingRevision: handle.BindingRevision,
		})
	}
	if request.IncludeOwn {
		own, err := manager.broker.ConnectOwnBrowserService(ctx, addonID, generationID, request.Contract, declaration.Range)
		if err != nil && !errors.Is(err, servicebroker.ErrServiceUnavailable) {
			return BrowserServiceConnection{}, err
		}
		if err == nil {
			providers = append(providers, BrowserServiceProvider{AddonID: own.ProviderAddonID,
				ContractVersion: own.ContractVersion, Generation: own.Generation, BindingRevision: own.BindingRevision})
		}
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].AddonID < providers[j].AddonID })
	if request.Cardinality == string(servicebroker.CardinalityOne) && len(providers) > 1 {
		return BrowserServiceConnection{}, fmt.Errorf(
			"%w: cardinality-one service has multiple bound providers",
			servicebroker.ErrAmbiguousProvider,
		)
	}
	return BrowserServiceConnection{
		Contract: request.Contract, Range: request.Range,
		Cardinality: request.Cardinality, Providers: providers,
	}, nil
}

// CallBrowserService routes through the same broker and schema registry as a
// worker call. The browser-supplied target is used only to select an already
// bound handle and must match every stale-sensitive field.
func (manager *Manager) CallBrowserService(
	ctx context.Context,
	addonID string,
	generationID string,
	target BrowserServiceTarget,
	call servicebroker.MethodCall,
) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	manager.mu.Lock()
	active, ok := manager.browserServiceRuntime(addonID, generationID)
	if !ok {
		manager.mu.Unlock()
		return nil, ErrNotActive
	}
	var selected *servicebroker.Handle
	if target.ProviderAddonID == addonID {
		if declaration, ok := consumedService(active.report.Manifest, target.Contract); ok {
			own, err := manager.broker.ConnectOwnBrowserService(ctx, addonID, generationID, target.Contract, declaration.Range)
			if err == nil && own.ContractVersion == target.ContractVersion && own.Generation == target.Generation && own.BindingRevision == target.BindingRevision {
				selected = &own
			}
		}
	}
	for index := range active.services {
		handle := active.services[index]
		if handle.Contract == target.Contract &&
			handle.ProviderAddonID == target.ProviderAddonID &&
			handle.ContractVersion == target.ContractVersion &&
			handle.Generation == target.Generation &&
			handle.BindingRevision == target.BindingRevision {
			selected = &handle
			break
		}
	}
	manager.mu.Unlock()
	if selected == nil {
		return nil, servicebroker.ErrStaleBinding
	}
	return manager.broker.Call(ctx, *selected, call)
}

func (manager *Manager) browserServiceRuntime(
	addonID string,
	generationID string,
) (activeRuntime, bool) {
	active, ok := manager.runtimes[addonID]
	return active, ok && active.generation.GenerationID == generationID &&
		active.report.Manifest.Runtime != nil && active.report.Manifest.Runtime.UI != nil
}

func consumedService(
	manifest packageinspect.Manifest,
	contract string,
) (packageinspect.ConsumedService, bool) {
	for _, declaration := range manifest.Services.Consumes {
		if declaration.Contract == contract {
			return declaration, true
		}
	}
	return packageinspect.ConsumedService{}, false
}
