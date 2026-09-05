package servicebroker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	semver "github.com/Masterminds/semver/v3"
	"github.com/pjunak/ttrpg-codex/internal/addons/requestcontext"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicecontract"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type RuntimeCaller interface {
	Call(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error)
}

type RuntimeMethodSupport interface {
	Supports(method string) bool
}

type RuntimeAdapters struct {
	Worker  RuntimeCaller
	Content RuntimeCaller
}

func (adapters RuntimeAdapters) caller(transport Transport) RuntimeCaller {
	switch transport {
	case TransportWorker:
		return adapters.Worker
	case TransportContent:
		return adapters.Content
	default:
		return nil
	}
}

type RuntimeDirectory struct {
	mu      sync.RWMutex
	entries map[string]runtimeEntry
}

type runtimeEntry struct {
	generation string
	callers    map[Transport]RuntimeCaller
	catalog    map[string]int64
	contracts  *servicecontract.Registry
}

type Broker struct {
	store    *Store
	runtimes *RuntimeDirectory
	contexts *requestcontext.Registry
	now      func() time.Time
	mu       sync.RWMutex
}

type CallContext struct {
	CorrelationID  string
	Deadline       time.Time
	Actor          workerrpc.Actor
	IdempotencyKey string
	Traceparent    string
}

type MethodCall struct {
	Method  string
	Params  any
	Context CallContext
}

func NewRuntimeDirectory() *RuntimeDirectory {
	return &RuntimeDirectory{entries: make(map[string]runtimeEntry)}
}

func (directory *RuntimeDirectory) activate(
	addonID string,
	generation string,
	adapters RuntimeAdapters,
	catalog map[string]int64,
	contracts *servicecontract.Registry,
) string {
	directory.mu.Lock()
	defer directory.mu.Unlock()
	previous := directory.entries[addonID].generation
	directory.entries[addonID] = runtimeEntry{
		generation: generation,
		callers: map[Transport]RuntimeCaller{
			TransportWorker: adapters.Worker, TransportContent: adapters.Content,
		},
		catalog:   cloneCatalog(catalog),
		contracts: contracts,
	}
	return previous
}

func (directory *RuntimeDirectory) deactivate(addonID, generation string) bool {
	directory.mu.Lock()
	defer directory.mu.Unlock()
	entry, exists := directory.entries[addonID]
	if !exists || entry.generation != generation {
		return false
	}
	delete(directory.entries, addonID)
	return true
}

func (directory *RuntimeDirectory) lookup(provider Provider, methodName string) (RuntimeCaller, servicecontract.Method, error) {
	if directory == nil {
		return nil, servicecontract.Method{}, ErrRuntimeUnavailable
	}
	directory.mu.RLock()
	entry, exists := directory.entries[provider.AddonID]
	directory.mu.RUnlock()
	if !exists {
		return nil, servicecontract.Method{}, ErrRuntimeUnavailable
	}
	if entry.generation != provider.ActiveGeneration || entry.catalog[provider.Contract] != provider.CatalogRevision {
		return nil, servicecontract.Method{}, ErrStaleBinding
	}
	caller := entry.callers[provider.Transport]
	if caller == nil {
		return nil, servicecontract.Method{}, ErrRuntimeUnavailable
	}
	method, err := entry.contracts.Method(provider.Contract, methodName)
	if err != nil {
		if errors.Is(err, servicecontract.ErrMethodNotFound) {
			return nil, servicecontract.Method{}, fmt.Errorf("%w: %s/%s", ErrMethodNotFound, provider.Contract, methodName)
		}
		return nil, servicecontract.Method{}, err
	}
	return caller, method, nil
}

func (directory *RuntimeDirectory) attach(providers []Provider) []Provider {
	result := append([]Provider(nil), providers...)
	directory.mu.RLock()
	defer directory.mu.RUnlock()
	for index := range result {
		if entry, exists := directory.entries[result[index].AddonID]; exists &&
			entry.catalog[result[index].Contract] == result[index].CatalogRevision {
			result[index].ActiveGeneration = entry.generation
		}
	}
	return result
}

func New(store *Store, runtimes *RuntimeDirectory, contexts *requestcontext.Registry) (*Broker, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("service broker store is required")
	}
	if runtimes == nil {
		return nil, errors.New("service broker runtime directory is required")
	}
	if contexts == nil {
		return nil, errors.New("service broker request context registry is required")
	}
	return &Broker{store: store, runtimes: runtimes, contexts: contexts, now: time.Now}, nil
}

func (broker *Broker) ReplaceProviders(
	ctx context.Context,
	addonID string,
	addonVersion string,
	declarations []ProviderDeclaration,
) error {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	return broker.store.replaceProviders(ctx, addonID, addonVersion, declarations)
}

func (broker *Broker) RemoveProviders(ctx context.Context, addonID string) error {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	return broker.store.removeProviders(ctx, addonID)
}

func (broker *Broker) SetBinding(
	ctx context.Context,
	requirement Requirement,
	providerAddonIDs []string,
	expectedRevision int64,
) (Binding, error) {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	return broker.store.setBinding(ctx, requirement, providerAddonIDs, expectedRevision)
}

func (broker *Broker) ClearBinding(
	ctx context.Context,
	requirement Requirement,
	expectedRevision int64,
) error {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	return broker.store.clearBinding(ctx, requirement, expectedRevision)
}

func (broker *Broker) ListProviders(ctx context.Context, contract string) ([]Provider, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	providers, err := broker.store.listProviders(ctx, contract)
	if err != nil {
		return nil, err
	}
	return broker.runtimes.attach(providers), nil
}

// ActivateRuntime binds one live generation to the exact provider catalog it
// was initialized from. A package replacement changes catalog revisions and
// therefore cannot accidentally reuse the old process during the handoff.
func (broker *Broker) ActivateRuntime(
	ctx context.Context,
	addonID string,
	generation string,
	contracts *servicecontract.Registry,
	caller RuntimeCaller,
) error {
	return broker.ActivateRuntimeWithAdapters(
		ctx, addonID, generation, contracts, RuntimeAdapters{Worker: caller},
	)
}

// ActivateRuntimeWithAdapters binds transport-specific callers to one exact
// live generation. A package may provide worker and immutable-content services
// without routing either through the other's execution boundary.
func (broker *Broker) ActivateRuntimeWithAdapters(
	ctx context.Context,
	addonID string,
	generation string,
	contracts *servicecontract.Registry,
	adapters RuntimeAdapters,
) error {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if err := validateAddonID(addonID); err != nil {
		return err
	}
	if generation == "" || len(generation) > 200 || hasControl(generation) {
		return fmt.Errorf("%w: generation is required", ErrInvalidDeclaration)
	}
	providers, err := broker.store.listAddonProviders(ctx, addonID)
	if err != nil {
		return err
	}
	if len(providers) == 0 {
		return ErrProviderNotFound
	}
	if contracts == nil || contracts.Len() != len(providers) {
		return fmt.Errorf("%w: runtime service registry does not match provider catalog", ErrInvalidDeclaration)
	}
	catalog := make(map[string]int64, len(providers))
	for _, provider := range providers {
		definition, exists := contracts.Description(provider.Contract)
		if !exists || definition.Version != provider.ContractVersion || definition.Document != provider.Schema ||
			(provider.Exclusive && !definition.AllowsExclusive) {
			return fmt.Errorf("%w: compiled contract does not match provider %s", ErrInvalidDeclaration, provider.Contract)
		}
		catalog[provider.Contract] = provider.CatalogRevision
		caller := adapters.caller(provider.Transport)
		if (provider.Transport == TransportWorker || provider.Transport == TransportContent) && caller == nil {
			return fmt.Errorf("%w: %s provider generation requires an adapter", ErrRuntimeUnavailable, provider.Transport)
		}
		if provider.Transport == TransportContent {
			support, ok := caller.(RuntimeMethodSupport)
			if !ok {
				return fmt.Errorf("%w: content transport must declare method support", ErrInvalidDeclaration)
			}
			for _, method := range definition.Methods {
				if !support.Supports(method.Name) {
					return fmt.Errorf("%w: content transport does not support %s/%s", ErrInvalidDeclaration, provider.Contract, method.Name)
				}
			}
		}
	}
	previous := broker.runtimes.activate(addonID, generation, adapters, catalog, contracts)
	if previous != "" {
		broker.contexts.InvalidateGeneration(addonID, previous)
	}
	return nil
}

// DeactivateRuntime removes only an exact generation and revokes its issued
// request contexts. A late stop cannot deactivate or revoke its replacement.
func (broker *Broker) DeactivateRuntime(addonID, generation string) bool {
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if !broker.runtimes.deactivate(addonID, generation) {
		return false
	}
	broker.contexts.InvalidateGeneration(addonID, generation)
	return true
}

func (broker *Broker) Resolve(ctx context.Context, requirement Requirement) (Resolution, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	return broker.resolve(ctx, requirement)
}

func (broker *Broker) resolve(ctx context.Context, requirement Requirement) (Resolution, error) {
	constraint, err := validateRequirement(requirement)
	if err != nil {
		return Resolution{}, err
	}
	providers, err := broker.store.listProviders(ctx, requirement.Contract)
	if err != nil {
		return Resolution{}, err
	}
	providers = excludeConsumerProvider(providers, requirement.ConsumerAddonID)
	providers = broker.runtimes.attach(providers)
	compatible := compatibleProviders(providers, constraint, false)
	active := compatibleProviders(providers, constraint, true)
	if requirement.Selection == SelectionOperator {
		binding, err := broker.store.readBinding(ctx, requirement)
		if err != nil {
			return Resolution{}, err
		}
		if binding != nil {
			return resolveBinding(requirement, providers, constraint, binding), nil
		}
	}

	if requirement.Cardinality == CardinalityOne {
		switch len(active) {
		case 0:
			return Resolution{Status: ResolutionUnavailable, Providers: compatible}, nil
		case 1:
			return Resolution{Status: ResolutionResolved, Providers: active}, nil
		default:
			return Resolution{Status: ResolutionAmbiguous, Providers: active}, nil
		}
	}
	if requirement.Selection == SelectionOperator {
		if len(compatible) == 0 {
			return Resolution{Status: ResolutionUnavailable}, nil
		}
		return Resolution{Status: ResolutionUnbound, Providers: active}, nil
	}
	if len(active) == 0 {
		return Resolution{Status: ResolutionUnavailable, Providers: compatible}, nil
	}
	return Resolution{Status: ResolutionResolved, Providers: active}, nil
}

func excludeConsumerProvider(providers []Provider, consumerAddonID string) []Provider {
	result := make([]Provider, 0, len(providers))
	for _, provider := range providers {
		if provider.AddonID != consumerAddonID {
			result = append(result, provider)
		}
	}
	return result
}

func (broker *Broker) ConnectOne(ctx context.Context, requirement Requirement) (Handle, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	if requirement.Cardinality != CardinalityOne {
		return Handle{}, fmt.Errorf("%w: ConnectOne requires cardinality one", ErrInvalidDeclaration)
	}
	resolution, err := broker.resolve(ctx, requirement)
	if err != nil {
		return Handle{}, err
	}
	if err := resolutionError(resolution.Status); err != nil {
		return Handle{}, err
	}
	if len(resolution.Providers) != 1 {
		return Handle{}, fmt.Errorf("%w: cardinality-one resolution returned %d providers", ErrStaleBinding, len(resolution.Providers))
	}
	return handleFor(requirement, resolution.Providers[0], bindingRevision(resolution.Binding)), nil
}

func (broker *Broker) ConnectMany(ctx context.Context, requirement Requirement) ([]Handle, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	if requirement.Cardinality != CardinalityMany {
		return nil, fmt.Errorf("%w: ConnectMany requires cardinality many", ErrInvalidDeclaration)
	}
	resolution, err := broker.resolve(ctx, requirement)
	if err != nil {
		return nil, err
	}
	if err := resolutionError(resolution.Status); err != nil {
		if !requirement.Required &&
			(errors.Is(err, ErrServiceUnavailable) || errors.Is(err, ErrInvalidSelection)) {
			return []Handle{}, nil
		}
		return nil, err
	}
	revision := bindingRevision(resolution.Binding)
	handles := make([]Handle, 0, len(resolution.Providers))
	for _, provider := range resolution.Providers {
		handles = append(handles, handleFor(requirement, provider, revision))
	}
	return handles, nil
}

func (broker *Broker) ValidateHandle(ctx context.Context, handle Handle) (Provider, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	return broker.validateHandle(ctx, handle)
}

func (broker *Broker) validateHandle(ctx context.Context, handle Handle) (Provider, error) {
	if err := ctx.Err(); err != nil {
		return Provider{}, err
	}
	if handle.ownBrowserProvider {
		provider, err := broker.ownBrowserProvider(ctx, handle.ConsumerAddonID, handle.Generation, handle.Contract, handle.Range)
		if err != nil || provider.AddonID != handle.ProviderAddonID || provider.ContractVersion != handle.ContractVersion ||
			provider.Transport != handle.Transport || handle.BindingRevision != 0 {
			return Provider{}, ErrStaleBinding
		}
		return provider, nil
	}
	requirement := Requirement{
		ConsumerAddonID: handle.ConsumerAddonID,
		Contract:        handle.Contract,
		Range:           handle.Range,
		Cardinality:     handle.Cardinality,
		Selection:       handle.Selection,
		Scope:           handle.Scope,
	}
	resolution, err := broker.resolve(ctx, requirement)
	if err != nil {
		return Provider{}, err
	}
	if resolution.Status != ResolutionResolved || bindingRevision(resolution.Binding) != handle.BindingRevision {
		return Provider{}, ErrStaleBinding
	}
	for _, provider := range resolution.Providers {
		if provider.AddonID == handle.ProviderAddonID &&
			provider.ContractVersion == handle.ContractVersion &&
			provider.Transport == handle.Transport &&
			provider.ActiveGeneration == handle.Generation {
			return provider, nil
		}
	}
	return Provider{}, ErrStaleBinding
}

// Call routes one package-declared service method. The exact-generation
// runtime registry supplies the host-compiled request and response validators;
// callers cannot replace or bypass them.
func (broker *Broker) Call(ctx context.Context, handle Handle, call MethodCall) (json.RawMessage, error) {
	if !methodPattern.MatchString(call.Method) || len(call.Method) > 100 {
		return nil, fmt.Errorf("%w: invalid service method %q", ErrInvalidDeclaration, call.Method)
	}
	prepared, err := broker.prepareCall(ctx, handle, call)
	if err != nil {
		return nil, err
	}
	defer prepared.lease.Close()
	defer prepared.cancel()
	result, err := prepared.caller.Call(
		prepared.context, "service/"+handle.Contract+"/"+call.Method,
		json.RawMessage(prepared.body), &prepared.meta,
	)
	if err != nil {
		return nil, err
	}
	if err := prepared.method.ValidateResponse(result); err != nil {
		return nil, fmt.Errorf("validate service response: %w", err)
	}

	// Provider execution is deliberately outside the broker lock. This permits
	// a worker provider to call one of its bound services without recursively
	// acquiring a writer-preferring RWMutex. The result becomes authoritative
	// only if the exact handle and runtime are still current afterwards.
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	provider, err := broker.validateHandle(ctx, handle)
	if err != nil {
		return nil, err
	}
	if _, _, err := broker.runtimes.lookup(provider, call.Method); err != nil {
		return nil, err
	}
	return append(json.RawMessage(nil), result...), nil
}

type preparedCall struct {
	caller  RuntimeCaller
	method  servicecontract.Method
	body    []byte
	context context.Context
	cancel  context.CancelFunc
	lease   *requestcontext.Lease
	meta    workerrpc.Meta
}

func (broker *Broker) prepareCall(
	ctx context.Context,
	handle Handle,
	call MethodCall,
) (preparedCall, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	provider, err := broker.validateHandle(ctx, handle)
	if err != nil {
		return preparedCall{}, err
	}
	caller, method, err := broker.runtimes.lookup(provider, call.Method)
	if err != nil {
		return preparedCall{}, err
	}
	if err := validateIdempotency(method.Idempotency(), call.Context.IdempotencyKey); err != nil {
		return preparedCall{}, err
	}
	body, err := json.Marshal(call.Params)
	if err != nil {
		return preparedCall{}, fmt.Errorf("encode service request: %w", err)
	}
	if !objectOrArray(body) {
		return preparedCall{}, fmt.Errorf("%w: service request must be an object or array", ErrInvalidDeclaration)
	}
	if err := method.ValidateRequest(body); err != nil {
		return preparedCall{}, fmt.Errorf("%w: validate service request: %v", ErrInvalidCall, err)
	}
	deadline, err := broker.effectiveDeadline(ctx, call.Context.Deadline, method.MaxDeadline())
	if err != nil {
		return preparedCall{}, err
	}
	callContext, cancel := context.WithDeadline(ctx, deadline)
	lease, err := broker.contexts.Issue(requestcontext.IssueRequest{
		AddonID:        provider.AddonID,
		Generation:     provider.ActiveGeneration,
		CorrelationID:  call.Context.CorrelationID,
		Deadline:       deadline,
		Actor:          call.Context.Actor,
		IdempotencyKey: call.Context.IdempotencyKey,
		Traceparent:    call.Context.Traceparent,
	})
	if err != nil {
		cancel()
		return preparedCall{}, fmt.Errorf("issue service request context: %w", err)
	}
	return preparedCall{
		caller: caller, method: method, body: body, context: callContext,
		cancel: cancel, lease: lease, meta: lease.Meta(),
	}, nil
}

func (broker *Broker) effectiveDeadline(ctx context.Context, requested time.Time, maximum time.Duration) (time.Time, error) {
	now := broker.now().UTC()
	deadline := now.Add(maximum)
	if !requested.IsZero() && requested.Before(deadline) {
		deadline = requested.UTC()
	}
	if contextDeadline, exists := ctx.Deadline(); exists && contextDeadline.Before(deadline) {
		deadline = contextDeadline.UTC()
	}
	if maximum <= 0 || !deadline.After(now) {
		return time.Time{}, ErrCallDeadline
	}
	return deadline, nil
}

func validateIdempotency(policy servicecontract.Idempotency, key string) error {
	switch policy {
	case servicecontract.IdempotencyNone:
		if key != "" {
			return fmt.Errorf("%w: method does not accept an idempotency key", ErrInvalidCall)
		}
	case servicecontract.IdempotencyOptional:
		return nil
	case servicecontract.IdempotencyRequired:
		if key == "" {
			return fmt.Errorf("%w: method requires an idempotency key", ErrInvalidCall)
		}
	default:
		return fmt.Errorf("%w: unknown idempotency policy", ErrInvalidCall)
	}
	return nil
}

func compatibleProviders(providers []Provider, constraint *semver.Constraints, activeOnly bool) []Provider {
	result := make([]Provider, 0, len(providers))
	for _, provider := range providers {
		version, err := semver.StrictNewVersion(provider.ContractVersion)
		if err != nil || !constraint.Check(version) || (activeOnly && provider.ActiveGeneration == "") {
			continue
		}
		result = append(result, provider)
	}
	return result
}

func resolveBinding(
	requirement Requirement,
	providers []Provider,
	constraint *semver.Constraints,
	binding *Binding,
) Resolution {
	byID := make(map[string]Provider, len(providers))
	for _, provider := range providers {
		byID[provider.AddonID] = provider
	}
	selected := make([]Provider, 0, len(binding.ProviderAddonIDs))
	stale := make([]string, 0)
	for _, providerAddonID := range binding.ProviderAddonIDs {
		provider, exists := byID[providerAddonID]
		if !exists || provider.ActiveGeneration == "" {
			stale = append(stale, providerAddonID)
			continue
		}
		version, err := semver.StrictNewVersion(provider.ContractVersion)
		if err != nil || !constraint.Check(version) {
			stale = append(stale, providerAddonID)
			continue
		}
		selected = append(selected, provider)
	}
	if requirement.Cardinality == CardinalityOne && len(binding.ProviderAddonIDs) > 1 {
		stale = append(stale, binding.ProviderAddonIDs...)
	}
	sort.Strings(stale)
	if len(stale) > 0 {
		return Resolution{Status: ResolutionStale, Providers: selected, Binding: binding, StaleTargets: stale}
	}
	if len(binding.ProviderAddonIDs) == 0 {
		return Resolution{Status: ResolutionUnbound, Binding: binding}
	}
	return Resolution{Status: ResolutionResolved, Providers: selected, Binding: binding}
}

func resolutionError(status ResolutionStatus) error {
	switch status {
	case ResolutionResolved:
		return nil
	case ResolutionAmbiguous:
		return ErrAmbiguousProvider
	case ResolutionStale:
		return ErrStaleBinding
	case ResolutionUnbound:
		return ErrInvalidSelection
	default:
		return ErrServiceUnavailable
	}
}

func handleFor(requirement Requirement, provider Provider, revision int64) Handle {
	return Handle{
		ConsumerAddonID: requirement.ConsumerAddonID,
		Contract:        requirement.Contract,
		Range:           requirement.Range,
		Cardinality:     requirement.Cardinality,
		Selection:       requirement.Selection,
		Scope:           requirement.Scope,
		ProviderAddonID: provider.AddonID,
		ContractVersion: provider.ContractVersion,
		Transport:       provider.Transport,
		Generation:      provider.ActiveGeneration,
		BindingRevision: revision,
	}
}

func bindingRevision(binding *Binding) int64 {
	if binding == nil {
		return 0
	}
	return binding.Revision
}

func objectOrArray(body []byte) bool {
	for _, value := range body {
		switch value {
		case ' ', '\t', '\r', '\n':
			continue
		case '{', '[':
			return true
		default:
			return false
		}
	}
	return false
}

func cloneCatalog(catalog map[string]int64) map[string]int64 {
	result := make(map[string]int64, len(catalog))
	for contract, revision := range catalog {
		result[contract] = revision
	}
	return result
}
