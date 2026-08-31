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
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type ValidateFunc func(json.RawMessage) error

type RuntimeCaller interface {
	Call(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error)
}

type RuntimeDirectory struct {
	mu      sync.RWMutex
	entries map[string]runtimeEntry
}

type runtimeEntry struct {
	generation string
	caller     RuntimeCaller
	catalog    map[string]int64
}

type Broker struct {
	store    *Store
	runtimes *RuntimeDirectory
	contexts *requestcontext.Registry
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
	Method           string
	Params           any
	ValidateRequest  ValidateFunc
	ValidateResponse ValidateFunc
	Context          CallContext
}

func NewRuntimeDirectory() *RuntimeDirectory {
	return &RuntimeDirectory{entries: make(map[string]runtimeEntry)}
}

func (directory *RuntimeDirectory) activate(addonID, generation string, caller RuntimeCaller, catalog map[string]int64) string {
	directory.mu.Lock()
	defer directory.mu.Unlock()
	previous := directory.entries[addonID].generation
	directory.entries[addonID] = runtimeEntry{
		generation: generation,
		caller:     caller,
		catalog:    cloneCatalog(catalog),
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

func (directory *RuntimeDirectory) lookup(provider Provider) (RuntimeCaller, error) {
	if directory == nil {
		return nil, ErrRuntimeUnavailable
	}
	directory.mu.RLock()
	entry, exists := directory.entries[provider.AddonID]
	directory.mu.RUnlock()
	if !exists {
		return nil, ErrRuntimeUnavailable
	}
	if entry.generation != provider.ActiveGeneration || entry.catalog[provider.Contract] != provider.CatalogRevision {
		return nil, ErrStaleBinding
	}
	if entry.caller == nil {
		return nil, ErrRuntimeUnavailable
	}
	return entry.caller, nil
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
	return &Broker{store: store, runtimes: runtimes, contexts: contexts}, nil
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
	caller RuntimeCaller,
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
	catalog := make(map[string]int64, len(providers))
	requiresCaller := false
	for _, provider := range providers {
		catalog[provider.Contract] = provider.CatalogRevision
		if provider.Transport == TransportWorker {
			requiresCaller = true
		}
	}
	if requiresCaller && caller == nil {
		return fmt.Errorf("%w: worker provider generation requires a caller", ErrRuntimeUnavailable)
	}
	previous := broker.runtimes.activate(addonID, generation, caller, catalog)
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

// Call routes one already-declared service method. Compiled contract-specific
// request and response validators are mandatory; the broker never forwards an
// unvalidated payload merely because the provider is selected.
func (broker *Broker) Call(ctx context.Context, handle Handle, call MethodCall) (json.RawMessage, error) {
	broker.mu.RLock()
	defer broker.mu.RUnlock()
	if !methodPattern.MatchString(call.Method) || len(call.Method) > 100 {
		return nil, fmt.Errorf("%w: invalid service method %q", ErrInvalidDeclaration, call.Method)
	}
	if call.ValidateRequest == nil || call.ValidateResponse == nil {
		return nil, fmt.Errorf("%w: service calls require request and response validators", ErrInvalidDeclaration)
	}
	provider, err := broker.validateHandle(ctx, handle)
	if err != nil {
		return nil, err
	}
	if provider.Transport != TransportWorker {
		return nil, fmt.Errorf("%w: %s services require a different transport adapter", ErrRuntimeUnavailable, provider.Transport)
	}
	caller, err := broker.runtimes.lookup(provider)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(call.Params)
	if err != nil {
		return nil, fmt.Errorf("encode service request: %w", err)
	}
	if !objectOrArray(body) {
		return nil, fmt.Errorf("%w: service request must be an object or array", ErrInvalidDeclaration)
	}
	if err := call.ValidateRequest(body); err != nil {
		return nil, fmt.Errorf("validate service request: %w", err)
	}
	lease, err := broker.contexts.Issue(requestcontext.IssueRequest{
		AddonID:        provider.AddonID,
		Generation:     provider.ActiveGeneration,
		CorrelationID:  call.Context.CorrelationID,
		Deadline:       call.Context.Deadline,
		Actor:          call.Context.Actor,
		IdempotencyKey: call.Context.IdempotencyKey,
		Traceparent:    call.Context.Traceparent,
	})
	if err != nil {
		return nil, fmt.Errorf("issue service request context: %w", err)
	}
	defer lease.Close()
	meta := lease.Meta()
	result, err := caller.Call(ctx, "service/"+handle.Contract+"/"+call.Method, json.RawMessage(body), &meta)
	if err != nil {
		return nil, err
	}
	if err := call.ValidateResponse(result); err != nil {
		return nil, fmt.Errorf("validate service response: %w", err)
	}
	return append(json.RawMessage(nil), result...), nil
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
