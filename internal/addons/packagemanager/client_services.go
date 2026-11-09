package packagemanager

import (
	"context"
	"encoding/json"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
)

// ClientServiceProvider is one live provider a signed-in host client (the
// Android companion) may call.
type ClientServiceProvider struct {
	AddonID         string `json:"addonId"`
	ContractVersion string `json:"contractVersion"`
	Generation      string `json:"generation"`
}

type ClientServiceConnection struct {
	Contract  string                  `json:"contract"`
	Range     string                  `json:"range"`
	Providers []ClientServiceProvider `json:"providers"`
}

// ClientServiceTarget names the provider a client chose from a connection.
type ClientServiceTarget struct {
	Contract        string
	ProviderAddonID string
	ContractVersion string
	Generation      string
}

// ConnectClientService lists every live worker provider of contract within
// versionRange. An empty list means the feature is unavailable on this site.
func (manager *Manager) ConnectClientService(
	ctx context.Context,
	contract string,
	versionRange string,
) (ClientServiceConnection, error) {
	handles, err := manager.broker.ConnectClient(ctx, contract, versionRange)
	if err != nil {
		return ClientServiceConnection{}, err
	}
	providers := make([]ClientServiceProvider, 0, len(handles))
	for _, handle := range handles {
		providers = append(providers, ClientServiceProvider{
			AddonID: handle.ProviderAddonID, ContractVersion: handle.ContractVersion, Generation: handle.Generation,
		})
	}
	return ClientServiceConnection{Contract: contract, Range: versionRange, Providers: providers}, nil
}

// CallClientService routes one call to the exact provider version and
// generation the client chose; anything that changed since is a stale binding.
func (manager *Manager) CallClientService(
	ctx context.Context,
	target ClientServiceTarget,
	call servicebroker.MethodCall,
) (json.RawMessage, error) {
	// The exact contract version is a one-version range, so the handle is
	// rebuilt from current state rather than trusted from the client.
	handles, err := manager.broker.ConnectClient(ctx, target.Contract, target.ContractVersion)
	if err != nil {
		return nil, err
	}
	for _, handle := range handles {
		if handle.ProviderAddonID == target.ProviderAddonID && handle.Generation == target.Generation {
			return manager.broker.Call(ctx, handle, call)
		}
	}
	return nil, servicebroker.ErrStaleBinding
}
