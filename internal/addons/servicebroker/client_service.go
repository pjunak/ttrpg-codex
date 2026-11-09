package servicebroker

import (
	"context"
	"fmt"
	"sort"

	"github.com/Masterminds/semver/v3"
)

// ConnectClient is for signed-in host clients that are not add-ons, such as
// the Android companion. It returns a handle for every live worker provider of
// contract compatible with versionRange, sorted by add-on ID; the client
// chooses among them. Client handles have no consumer, so they never use
// operator bindings, enter worker initialization or the dependency graph.
// The session's actor travels with each call and providers authorize it.
func (broker *Broker) ConnectClient(ctx context.Context, contract, versionRange string) ([]Handle, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	providers, err := broker.clientProviders(ctx, contract, versionRange)
	if err != nil {
		return nil, err
	}
	handles := make([]Handle, 0, len(providers))
	for _, provider := range providers {
		handle := handleFor(Requirement{Contract: contract, Range: versionRange, Cardinality: CardinalityMany,
			Selection: SelectionAllCompatible, Scope: GlobalScope()}, provider, 0)
		handle.hostClient = true
		handles = append(handles, handle)
	}
	return handles, nil
}

func (broker *Broker) clientProviders(ctx context.Context, contract, versionRange string) ([]Provider, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateContract(contract); err != nil {
		return nil, err
	}
	if versionRange == "" || len(versionRange) > 100 {
		return nil, fmt.Errorf("%w: invalid service version range", ErrInvalidDeclaration)
	}
	constraint, err := semver.NewConstraint(versionRange)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid service version range %q: %v", ErrInvalidDeclaration, versionRange, err)
	}
	providers, err := broker.store.listProviders(ctx, contract)
	if err != nil {
		return nil, err
	}
	live := make([]Provider, 0, len(providers))
	for _, provider := range compatibleProviders(broker.runtimes.attach(providers), constraint, true) {
		if provider.Transport == TransportWorker {
			live = append(live, provider)
		}
	}
	sort.Slice(live, func(i, j int) bool { return live[i].AddonID < live[j].AddonID })
	return live, nil
}

// clientProvider revalidates a client handle: the same provider must still be
// live with the same contract version and generation.
func (broker *Broker) clientProvider(ctx context.Context, handle Handle) (Provider, error) {
	providers, err := broker.clientProviders(ctx, handle.Contract, handle.Range)
	if err != nil {
		return Provider{}, err
	}
	for _, provider := range providers {
		if provider.AddonID == handle.ProviderAddonID && provider.ContractVersion == handle.ContractVersion &&
			provider.Transport == handle.Transport && provider.ActiveGeneration == handle.Generation &&
			handle.BindingRevision == 0 {
			return provider, nil
		}
	}
	return Provider{}, ErrStaleBinding
}
