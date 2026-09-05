package servicebroker

import "context"

// ConnectOwnBrowserService is for the host's authenticated browser boundary.
// These handles never enter worker initialization or the dependency graph.
// The package manager must first authorize the active consumer declaration.
func (broker *Broker) ConnectOwnBrowserService(ctx context.Context, addonID, generation, contract, versionRange string) (Handle, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	provider, err := broker.ownBrowserProvider(ctx, addonID, generation, contract, versionRange)
	if err != nil {
		return Handle{}, err
	}
	handle := handleFor(Requirement{ConsumerAddonID: addonID, Contract: contract, Range: versionRange,
		Cardinality: CardinalityOne, Selection: SelectionOperator, Scope: GlobalScope()}, provider, 0)
	handle.ownBrowserProvider = true
	return handle, nil
}

func (broker *Broker) ownBrowserProvider(ctx context.Context, addonID, generation, contract, versionRange string) (Provider, error) {
	if err := ctx.Err(); err != nil {
		return Provider{}, err
	}
	if generation == "" {
		return Provider{}, ErrInvalidDeclaration
	}
	constraint, err := validateRequirement(Requirement{ConsumerAddonID: addonID, Contract: contract, Range: versionRange,
		Cardinality: CardinalityOne, Selection: SelectionOperator, Scope: GlobalScope()})
	if err != nil {
		return Provider{}, err
	}
	providers, err := broker.store.listProviders(ctx, contract)
	if err != nil {
		return Provider{}, err
	}
	for _, provider := range compatibleProviders(broker.runtimes.attach(providers), constraint, true) {
		if provider.AddonID == addonID && provider.ActiveGeneration == generation && provider.Transport == TransportWorker {
			return provider, nil
		}
	}
	return Provider{}, ErrServiceUnavailable
}
