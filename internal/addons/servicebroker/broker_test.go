package servicebroker

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/requestcontext"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicecontract"
	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestProviderCatalogEnforcesExclusiveMajorAndStoresNoRuntimeState(t *testing.T) {
	t.Parallel()

	store, db := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	ctx := context.Background()
	unsafe := testProvider("dnd5e.rules-data", "2.1.0", true)
	unsafe.Schema = "../outside.json"
	if err := broker.ReplaceProviders(ctx, "unsafe-provider", "1.0.0", []ProviderDeclaration{unsafe}); !errors.Is(err, ErrInvalidDeclaration) {
		t.Fatalf("unsafe schema path error = %v, want ErrInvalidDeclaration", err)
	}
	if err := broker.ReplaceProviders(ctx, "rules-data-a", "1.0.0", []ProviderDeclaration{
		testProvider("dnd5e.rules-data", "2.1.0", true),
	}); err != nil {
		t.Fatal(err)
	}
	if err := broker.ReplaceProviders(ctx, "rules-data-b", "1.0.0", []ProviderDeclaration{
		testProvider("dnd5e.rules-data", "2.4.0", false),
	}); !errors.Is(err, ErrExclusiveConflict) {
		t.Fatalf("same-major conflict = %v, want ErrExclusiveConflict", err)
	}
	if err := broker.ReplaceProviders(ctx, "rules-data-b", "1.0.0", []ProviderDeclaration{
		testProvider("dnd5e.rules-data", "3.0.0", false),
	}); err != nil {
		t.Fatalf("different major should coexist: %v", err)
	}
	providers, err := broker.ListProviders(ctx, "dnd5e.rules-data")
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 2 || providers[0].ActiveGeneration != "" {
		t.Fatalf("provider catalog persisted runtime state: %+v", providers)
	}

	assertForeignKeys(t, db)
}

func TestOperatorBindingRevisionAndStaleProviderRemainVisible(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	directory := NewRuntimeDirectory()
	broker := testBroker(t, store, directory, nil)
	ctx := context.Background()
	installActiveProvider(t, store, broker, "engine-a", "dnd5e.rules-engine", "3.1.0", "generation-a")
	installActiveProvider(t, store, broker, "engine-b", "dnd5e.rules-engine", "3.2.0", "generation-b")
	requirement := oneRequirement("character-sheets", "dnd5e.rules-engine", "^3.0.0")

	resolution, err := broker.Resolve(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Status != ResolutionAmbiguous || len(resolution.Providers) != 2 {
		t.Fatalf("unbound resolution = %+v", resolution)
	}
	binding, err := broker.SetBinding(ctx, requirement, []string{"engine-a"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := broker.ConnectOne(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	if handle.ProviderAddonID != "engine-a" || handle.BindingRevision != 1 {
		t.Fatalf("unexpected bound handle: %+v", handle)
	}
	if _, err := broker.SetBinding(ctx, requirement, []string{"engine-b"}, 0); !errors.Is(err, ErrBindingConflict) {
		t.Fatalf("stale create revision = %v, want ErrBindingConflict", err)
	}
	binding, err = broker.SetBinding(ctx, requirement, []string{"engine-b"}, binding.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if binding.Revision != 2 {
		t.Fatalf("binding revision = %d, want 2", binding.Revision)
	}
	if _, err := broker.ValidateHandle(ctx, handle); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("old handle validation = %v, want ErrStaleBinding", err)
	}
	if err := broker.RemoveProviders(ctx, "engine-b"); err != nil {
		t.Fatal(err)
	}
	resolution, err = broker.Resolve(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Status != ResolutionStale || resolution.Binding == nil || resolution.Binding.Revision != 2 ||
		!reflect.DeepEqual(resolution.StaleTargets, []string{"engine-b"}) {
		t.Fatalf("removed provider did not leave a visible stale binding: %+v", resolution)
	}
	if err := broker.ClearBinding(ctx, requirement, 1); !errors.Is(err, ErrBindingConflict) {
		t.Fatalf("stale clear revision = %v, want ErrBindingConflict", err)
	}
	if err := broker.ClearBinding(ctx, requirement, 2); err != nil {
		t.Fatal(err)
	}
	resolution, err = broker.Resolve(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Status != ResolutionResolved || resolution.Binding != nil || len(resolution.Providers) != 1 ||
		resolution.Providers[0].AddonID != "engine-a" {
		t.Fatalf("clearing binding did not restore automatic single-provider resolution: %+v", resolution)
	}
}

func TestAutomaticSingleProviderHandleBecomesStaleWhenChoiceTurnsAmbiguous(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	directory := NewRuntimeDirectory()
	broker := testBroker(t, store, directory, nil)
	ctx := context.Background()
	installActiveProvider(t, store, broker, "engine-a", "dnd5e.rules-engine", "3.1.0", "generation-a")
	requirement := oneRequirement("character-sheets", "dnd5e.rules-engine", "^3.0.0")
	handle, err := broker.ConnectOne(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	if handle.BindingRevision != 0 {
		t.Fatalf("automatic handle binding revision = %d, want 0", handle.BindingRevision)
	}
	installActiveProvider(t, store, broker, "engine-b", "dnd5e.rules-engine", "3.2.0", "generation-b")
	if _, err := broker.ValidateHandle(ctx, handle); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("automatic handle after ambiguity = %v, want ErrStaleBinding", err)
	}
	if _, err := broker.ConnectOne(ctx, requirement); !errors.Is(err, ErrAmbiguousProvider) {
		t.Fatalf("ambiguous connect = %v, want ErrAmbiguousProvider", err)
	}
}

func TestCatalogReplacementCannotReuseOldRuntimeGeneration(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	contexts, err := requestcontext.New(requestcontext.Config{})
	if err != nil {
		t.Fatal(err)
	}
	broker := testBroker(t, store, NewRuntimeDirectory(), contexts)
	ctx := context.Background()
	installActiveProvider(t, store, broker, "engine-a", "dnd5e.rules-engine", "3.1.0", "generation-1")
	requirement := oneRequirement("character-sheets", "dnd5e.rules-engine", "^3.0.0")
	oldHandle, err := broker.ConnectOne(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := contexts.Issue(requestcontext.IssueRequest{
		AddonID: "engine-a", Generation: "generation-1", Deadline: time.Now().Add(time.Minute),
		Actor: workerrpc.Actor{Role: "system"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { lease.Close() })

	if err := broker.ReplaceProviders(ctx, "engine-a", "1.1.0", []ProviderDeclaration{
		testProvider("dnd5e.rules-engine", "3.2.0", false),
	}); err != nil {
		t.Fatal(err)
	}
	resolution, err := broker.Resolve(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Status != ResolutionUnavailable {
		t.Fatalf("replacement catalog reused old live process: %+v", resolution)
	}
	if _, err := broker.ValidateHandle(ctx, oldHandle); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("old catalog handle validation = %v, want ErrStaleBinding", err)
	}
	caller := runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) { return nil, nil })
	declaration := testProvider("dnd5e.rules-engine", "3.2.0", false)
	if err := broker.ActivateRuntime(ctx, "engine-a", "generation-2", testRegistry(t, declaration), caller); err != nil {
		t.Fatal(err)
	}
	newHandle, err := broker.ConnectOne(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	if newHandle.Generation != "generation-2" || newHandle.ContractVersion != "3.2.0" {
		t.Fatalf("replacement handle = %+v", newHandle)
	}
	if err := broker.RemoveProviders(ctx, "engine-a"); err != nil {
		t.Fatal(err)
	}
	if err := broker.ReplaceProviders(ctx, "engine-a", "1.1.0", []ProviderDeclaration{
		testProvider("dnd5e.rules-engine", "3.2.0", false),
	}); err != nil {
		t.Fatal(err)
	}
	resolution, err = broker.Resolve(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.Status != ResolutionUnavailable {
		t.Fatalf("reinstalled catalog reused pre-uninstall runtime: %+v", resolution)
	}
	if _, err := broker.ValidateHandle(ctx, newHandle); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("pre-uninstall handle validation = %v, want ErrStaleBinding", err)
	}
	if snapshot := contexts.Snapshot(); snapshot.Active != 0 || snapshot.Invalidated != 1 {
		t.Fatalf("old generation contexts were not revoked: %+v", snapshot)
	}
}

func TestManyProviderSelectionIsStableAndSorted(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	directory := NewRuntimeDirectory()
	broker := testBroker(t, store, directory, nil)
	ctx := context.Background()
	installActiveProvider(t, store, broker, "adapter-z", "codex.import-adapter", "2.0.0", "generation-z")
	installActiveProvider(t, store, broker, "adapter-a", "codex.import-adapter", "2.1.0", "generation-a")
	installActiveProvider(t, store, broker, "dm-tools", "codex.import-adapter", "2.0.0", "generation-self")

	all := Requirement{
		ConsumerAddonID: "dm-tools", Contract: "codex.import-adapter", Range: "^2.0.0",
		Cardinality: CardinalityMany, Selection: SelectionAllCompatible, Scope: GlobalScope(),
	}
	handles, err := broker.ConnectMany(ctx, all)
	if err != nil {
		t.Fatal(err)
	}
	if got := []string{handles[0].ProviderAddonID, handles[1].ProviderAddonID}; !reflect.DeepEqual(got, []string{"adapter-a", "adapter-z"}) {
		t.Fatalf("all-compatible provider order = %v", got)
	}
	operator := all
	operator.Selection = SelectionOperator
	if _, err := broker.SetBinding(ctx, operator, []string{"dm-tools"}, 0); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("self-provider binding error = %v, want ErrInvalidSelection", err)
	}
	if handles, err := broker.ConnectMany(ctx, operator); err != nil || len(handles) != 0 {
		t.Fatalf("optional unbound operator-many connect = (%+v, %v), want empty standalone result", handles, err)
	}
	requiredOperator := operator
	requiredOperator.Required = true
	if _, err := broker.ConnectMany(ctx, requiredOperator); !errors.Is(err, ErrInvalidSelection) {
		t.Fatalf("required unbound operator-many connect = %v, want ErrInvalidSelection", err)
	}
	binding, err := broker.SetBinding(ctx, operator, []string{"adapter-z"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	handles, err = broker.ConnectMany(ctx, operator)
	if err != nil {
		t.Fatal(err)
	}
	if len(handles) != 1 || handles[0].ProviderAddonID != "adapter-z" || handles[0].BindingRevision != binding.Revision {
		t.Fatalf("operator-selected handles = %+v", handles)
	}
}

func TestBrokerCallValidatesPayloadAndCarriesHostIssuedLineage(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	now := time.Date(2026, time.August, 31, 11, 0, 0, 0, time.UTC)
	contexts, err := requestcontext.New(requestcontext.Config{
		MaxActive: 8, MaxLifetime: time.Minute, Now: func() time.Time { return now },
		GenerateID: func() (string, error) { return "host-request-1", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	directory := NewRuntimeDirectory()
	broker := testBroker(t, store, directory, contexts)
	broker.now = func() time.Time { return now }
	ctx := context.Background()
	if err := broker.ReplaceProviders(ctx, "engine-a", "1.0.0", []ProviderDeclaration{
		testProvider("dnd5e.rules-engine", "3.1.0", false),
	}); err != nil {
		t.Fatal(err)
	}
	var calledMethod string
	caller := runtimeCallerFunc(func(_ context.Context, method string, params any, meta *workerrpc.Meta) (json.RawMessage, error) {
		calledMethod = method
		forged := *meta
		forged.Actor = &workerrpc.Actor{Role: "dm", ID: "forged"}
		authority, err := contexts.ResolveContext(context.Background(), requestcontext.ResolveRequest{
			AddonID: "engine-a", Generation: "generation-a", Method: "host/data.read", WireMeta: forged,
		})
		if err != nil {
			return nil, err
		}
		if authority.Actor.Role != "player" || authority.Actor.ID != "player-7" || authority.CorrelationID != "http-42" {
			return nil, errors.New("worker callback did not resolve authoritative lineage")
		}
		if string(params.(json.RawMessage)) != `{"value":4}` {
			return nil, errors.New("unexpected service request")
		}
		return json.RawMessage(`{"result":8}`), nil
	})
	declaration := testProvider("dnd5e.rules-engine", "3.1.0", false)
	contracts := testRegistryWithSchemas(
		t,
		declaration,
		`{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}},"additionalProperties":false}`,
		`{"type":"object","required":["result"],"properties":{"result":{"type":"integer"}},"additionalProperties":false}`,
		servicecontract.IdempotencyOptional,
		2_000,
	)
	if err := broker.ActivateRuntime(ctx, "engine-a", "generation-a", contracts, caller); err != nil {
		t.Fatal(err)
	}
	requirement := oneRequirement("character-sheets", "dnd5e.rules-engine", "^3.0.0")
	handle, err := broker.ConnectOne(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	result, err := broker.Call(ctx, handle, MethodCall{
		Method: "evaluate-character",
		Params: map[string]int{"value": 4},
		Context: CallContext{
			CorrelationID: "http-42", Deadline: now.Add(30 * time.Second),
			Actor: workerrpc.Actor{Role: "player", ID: "player-7"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if calledMethod != "service/dnd5e.rules-engine/evaluate-character" || string(result) != `{"result":8}` {
		t.Fatalf("unexpected routed call method=%q result=%s", calledMethod, result)
	}
	if snapshot := contexts.Snapshot(); snapshot.Active != 0 || snapshot.Issued != 1 || snapshot.Resolved != 1 {
		t.Fatalf("request context leaked after call: %+v", snapshot)
	}
}

func TestBrokerCallEnforcesCompiledMethodPolicies(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	now := time.Date(2026, time.August, 31, 12, 0, 0, 0, time.UTC)
	contexts, err := requestcontext.New(requestcontext.Config{
		MaxLifetime: time.Minute, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	broker := testBroker(t, store, NewRuntimeDirectory(), contexts)
	broker.now = func() time.Time { return now }
	declaration := testProvider("dnd5e.rules-engine", "3.1.0", false)
	if err := broker.ReplaceProviders(context.Background(), "engine-a", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	contracts := testRegistryWithSchemas(
		t,
		declaration,
		`{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}},"additionalProperties":false}`,
		`{"type":"object","required":["result"],"properties":{"result":{"type":"integer"}},"additionalProperties":false}`,
		servicecontract.IdempotencyRequired,
		500,
	)
	called := 0
	caller := runtimeCallerFunc(func(ctx context.Context, _ string, _ any, meta *workerrpc.Meta) (json.RawMessage, error) {
		called++
		wantDeadline := now.Add(500 * time.Millisecond)
		contextDeadline, ok := ctx.Deadline()
		if !ok || !contextDeadline.Equal(wantDeadline) || meta == nil || !meta.Deadline.Equal(wantDeadline) {
			return nil, fmt.Errorf("method deadline was not enforced: context=%v meta=%+v", contextDeadline, meta)
		}
		return json.RawMessage(`{"unexpected":true}`), nil
	})
	if err := broker.ActivateRuntime(context.Background(), "engine-a", "generation-a", contracts, caller); err != nil {
		t.Fatal(err)
	}
	handle, err := broker.ConnectOne(context.Background(), oneRequirement("character-sheets", "dnd5e.rules-engine", "^3.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	base := MethodCall{
		Method: "evaluate-character", Params: map[string]any{"value": 4},
		Context: CallContext{Deadline: now.Add(10 * time.Second), Actor: workerrpc.Actor{Role: "system"}},
	}
	if _, err := broker.Call(context.Background(), handle, base); !errors.Is(err, ErrInvalidCall) {
		t.Fatalf("missing idempotency key error = %v, want ErrInvalidCall", err)
	}
	invalid := base
	invalid.Params = map[string]any{"value": "four"}
	invalid.Context.IdempotencyKey = "evaluation-1"
	if _, err := broker.Call(context.Background(), handle, invalid); err == nil {
		t.Fatal("invalid request reached provider")
	}
	unknown := base
	unknown.Method = "missing"
	unknown.Context.IdempotencyKey = "evaluation-2"
	if _, err := broker.Call(context.Background(), handle, unknown); !errors.Is(err, ErrMethodNotFound) {
		t.Fatalf("unknown method error = %v, want ErrMethodNotFound", err)
	}
	valid := base
	valid.Context.IdempotencyKey = "evaluation-3"
	if _, err := broker.Call(context.Background(), handle, valid); err == nil {
		t.Fatal("invalid provider response passed compiled schema")
	}
	if called != 1 {
		t.Fatalf("provider calls = %d, want 1", called)
	}
	if snapshot := contexts.Snapshot(); snapshot.Active != 0 || snapshot.Issued != 1 {
		t.Fatalf("request context leaked after invalid response: %+v", snapshot)
	}
}

func TestActivateRuntimeRejectsRegistryThatDoesNotMatchCatalog(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	declaration := testProvider("dnd5e.rules-engine", "3.1.0", false)
	if err := broker.ReplaceProviders(context.Background(), "engine-a", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	mismatch := testProvider("dnd5e.rules-engine", "3.2.0", false)
	err := broker.ActivateRuntime(
		context.Background(), "engine-a", "generation-a", testRegistry(t, mismatch),
		runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) { return nil, nil }),
	)
	if !errors.Is(err, ErrInvalidDeclaration) {
		t.Fatalf("mismatched registry activation = %v, want ErrInvalidDeclaration", err)
	}
}

func TestBrokerRoutesContentServicesThroughTheirDedicatedAdapter(t *testing.T) {
	t.Parallel()
	store, _ := testStore(t)
	now := time.Date(2026, time.September, 1, 8, 0, 0, 0, time.UTC)
	contexts, err := requestcontext.New(requestcontext.Config{
		MaxLifetime: time.Minute, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	broker := testBroker(t, store, NewRuntimeDirectory(), contexts)
	broker.now = func() time.Time { return now }
	declaration := testProvider("dnd5e.rules-data", "3.0.0", true)
	declaration.Transport = TransportContent
	if err := broker.ReplaceProviders(context.Background(), "compendium", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	contracts := testRegistryForMethod(
		t, declaration, "catalog", `{"type":"object","additionalProperties":false}`,
		`{"type":"object","required":["sets"],"properties":{"sets":{"type":"array"}},"additionalProperties":false}`,
		servicecontract.IdempotencyNone, 2_000,
	)
	called := ""
	adapter := supportedRuntimeCaller{
		runtimeCallerFunc: func(_ context.Context, method string, _ any, _ *workerrpc.Meta) (json.RawMessage, error) {
			called = method
			return json.RawMessage(`{"sets":[]}`), nil
		},
		methods: map[string]bool{"catalog": true},
	}
	if err := broker.ActivateRuntimeWithAdapters(
		context.Background(), "compendium", "generation-a", contracts,
		RuntimeAdapters{Content: adapter},
	); err != nil {
		t.Fatal(err)
	}
	handle, err := broker.ConnectOne(context.Background(), oneRequirement(
		"engine", "dnd5e.rules-data", "^3.0.0",
	))
	if err != nil {
		t.Fatal(err)
	}
	result, err := broker.Call(context.Background(), handle, MethodCall{
		Method: "catalog", Params: map[string]any{},
		Context: CallContext{
			CorrelationID: "content-test", Deadline: now.Add(time.Second),
			Actor: workerrpc.Actor{Role: "system", ID: "host"},
		},
	})
	if err != nil || string(result) != `{"sets":[]}` || called != "service/dnd5e.rules-data/catalog" {
		t.Fatalf("content call = %s, method %q, error %v", result, called, err)
	}
}

func TestContentRuntimeRejectsMissingAndUnsupportedAdapters(t *testing.T) {
	t.Parallel()
	store, _ := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	declaration := testProvider("dnd5e.rules-data", "3.0.0", true)
	declaration.Transport = TransportContent
	if err := broker.ReplaceProviders(context.Background(), "compendium", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	contracts := testRegistryForMethod(
		t, declaration, "search", `{"type":"object"}`, `{"type":"object"}`,
		servicecontract.IdempotencyNone, 2_000,
	)
	if err := broker.ActivateRuntimeWithAdapters(
		context.Background(), "compendium", "generation-a", contracts, RuntimeAdapters{},
	); !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("missing adapter error = %v", err)
	}
	adapter := supportedRuntimeCaller{
		runtimeCallerFunc: func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
			return nil, nil
		},
		methods: map[string]bool{"catalog": true},
	}
	if err := broker.ActivateRuntimeWithAdapters(
		context.Background(), "compendium", "generation-a", contracts,
		RuntimeAdapters{Content: adapter},
	); !errors.Is(err, ErrInvalidDeclaration) {
		t.Fatalf("unsupported method error = %v", err)
	}
}

func TestRuntimeDirectoryExactGenerationPreventsLateTeardown(t *testing.T) {
	t.Parallel()

	directory := NewRuntimeDirectory()
	first := runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) { return nil, nil })
	second := runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) { return nil, nil })
	catalog := map[string]int64{"dnd5e.rules-engine": 1}
	declaration := testProvider("dnd5e.rules-engine", "3.1.0", false)
	contracts := testRegistry(t, declaration)
	directory.activate("engine-a", "generation-1", RuntimeAdapters{Worker: first}, catalog, contracts)
	directory.activate("engine-a", "generation-2", RuntimeAdapters{Worker: second}, catalog, contracts)
	if directory.deactivate("engine-a", "generation-1") {
		t.Fatal("late old-generation teardown removed replacement runtime")
	}
	caller, _, err := directory.lookup(Provider{
		AddonID:          "engine-a",
		Contract:         "dnd5e.rules-engine",
		Transport:        TransportWorker,
		ActiveGeneration: "generation-2",
		CatalogRevision:  1,
	}, "evaluate-character")
	if err != nil || reflect.ValueOf(caller).Pointer() != reflect.ValueOf(second).Pointer() {
		t.Fatalf("replacement runtime lookup = (%v, %v)", caller, err)
	}
}

func TestBindingUpdateInvalidatesUnlockedInFlightCall(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	ctx := context.Background()
	for _, addonID := range []string{"engine-a", "engine-b"} {
		if err := broker.ReplaceProviders(ctx, addonID, "1.0.0", []ProviderDeclaration{
			testProvider("dnd5e.rules-engine", "3.1.0", false),
		}); err != nil {
			t.Fatal(err)
		}
	}
	started := make(chan struct{})
	release := make(chan struct{})
	blocking := runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
		close(started)
		<-release
		return json.RawMessage(`{}`), nil
	})
	declaration := testProvider("dnd5e.rules-engine", "3.1.0", false)
	if err := broker.ActivateRuntime(ctx, "engine-a", "generation-a", testRegistry(t, declaration), blocking); err != nil {
		t.Fatal(err)
	}
	if err := broker.ActivateRuntime(ctx, "engine-b", "generation-b", testRegistry(t, declaration), runtimeCallerFunc(
		func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
			return json.RawMessage(`{}`), nil
		},
	)); err != nil {
		t.Fatal(err)
	}
	requirement := oneRequirement("character-sheets", "dnd5e.rules-engine", "^3.0.0")
	binding, err := broker.SetBinding(ctx, requirement, []string{"engine-a"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := broker.ConnectOne(ctx, requirement)
	if err != nil {
		t.Fatal(err)
	}
	callDone := make(chan error, 1)
	go func() {
		_, err := broker.Call(ctx, handle, MethodCall{
			Method: "evaluate-character", Params: map[string]any{},
			Context: CallContext{Deadline: time.Now().Add(time.Second), Actor: workerrpc.Actor{Role: "system"}},
		})
		callDone <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("service call did not reach runtime")
	}
	updateDone := make(chan error, 1)
	go func() {
		_, err := broker.SetBinding(ctx, requirement, []string{"engine-b"}, binding.Revision)
		updateDone <- err
	}()
	select {
	case err := <-updateDone:
		if err != nil {
			t.Fatalf("binding update failed during in-flight call: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("binding update waited on provider execution")
	}
	close(release)
	if err := <-callDone; !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("in-flight call error = %v, want ErrStaleBinding", err)
	}
	if _, err := broker.ValidateHandle(ctx, handle); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("old handle after ordered binding update = %v, want ErrStaleBinding", err)
	}
}

func TestCatalogReplacementInvalidatesInFlightCallAtTheSameGeneration(t *testing.T) {
	store, _ := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	ctx := context.Background()
	declaration := testProvider("dnd5e.rules-engine", "3.1.0", false)
	if err := broker.ReplaceProviders(ctx, "engine", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	caller := runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
		close(started)
		<-release
		return json.RawMessage(`{}`), nil
	})
	if err := broker.ActivateRuntime(ctx, "engine", "same-generation", testRegistry(t, declaration), caller); err != nil {
		t.Fatal(err)
	}
	handle, err := broker.ConnectOne(ctx, oneRequirement("sheets", "dnd5e.rules-engine", "^3.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := broker.Call(ctx, handle, MethodCall{Method: "evaluate-character", Params: map[string]any{}, Context: CallContext{Deadline: time.Now().Add(time.Second), Actor: workerrpc.Actor{Role: "system"}}})
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("call did not start")
	}
	if err := broker.ReplaceProviders(ctx, "engine", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		close(release)
		t.Fatal(err)
	}
	if err := broker.ActivateRuntime(ctx, "engine", "same-generation", testRegistry(t, declaration), caller); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if err := <-done; !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("old runtime result accepted after configuration restart: %v", err)
	}
}

func TestProviderCanCallBoundServiceWhileCatalogWriteCompletes(t *testing.T) {
	t.Parallel()

	store, _ := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	ctx := context.Background()
	requestSchema := `{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}},"additionalProperties":false}`
	responseSchema := `{"type":"object","required":["result"],"properties":{"result":{"type":"integer"}},"additionalProperties":false}`

	dataDeclaration := testProvider("codex.test-data", "1.0.0", false)
	if err := broker.ReplaceProviders(ctx, "data-provider", "1.0.0", []ProviderDeclaration{dataDeclaration}); err != nil {
		t.Fatal(err)
	}
	dataContracts := testRegistryForMethod(
		t, dataDeclaration, "lookup", requestSchema, responseSchema,
		servicecontract.IdempotencyNone, 2_000,
	)
	if err := broker.ActivateRuntime(ctx, "data-provider", "data-generation", dataContracts,
		runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
			return json.RawMessage(`{"result":8}`), nil
		})); err != nil {
		t.Fatal(err)
	}
	dataHandle, err := broker.ConnectOne(ctx, oneRequirement("engine", "codex.test-data", "^1.0.0"))
	if err != nil {
		t.Fatal(err)
	}

	engineDeclaration := testProvider("codex.test-engine", "1.0.0", false)
	if err := broker.ReplaceProviders(ctx, "engine", "1.0.0", []ProviderDeclaration{engineDeclaration}); err != nil {
		t.Fatal(err)
	}
	engineContracts := testRegistryForMethod(
		t, engineDeclaration, "evaluate", requestSchema, responseSchema,
		servicecontract.IdempotencyNone, 2_000,
	)
	providerStarted := make(chan struct{})
	continueProvider := make(chan struct{})
	engineCaller := runtimeCallerFunc(func(callCtx context.Context, _ string, _ any, _ *workerrpc.Meta) (json.RawMessage, error) {
		close(providerStarted)
		<-continueProvider
		return broker.Call(callCtx, dataHandle, MethodCall{
			Method: "lookup", Params: map[string]any{"value": 4},
			Context: CallContext{
				Deadline: time.Now().Add(time.Second), Actor: workerrpc.Actor{Role: "system"},
			},
		})
	})
	if err := broker.ActivateRuntime(ctx, "engine", "engine-generation", engineContracts, engineCaller); err != nil {
		t.Fatal(err)
	}
	engineHandle, err := broker.ConnectOne(ctx, oneRequirement("sheets", "codex.test-engine", "^1.0.0"))
	if err != nil {
		t.Fatal(err)
	}

	callDone := make(chan error, 1)
	go func() {
		result, callErr := broker.Call(ctx, engineHandle, MethodCall{
			Method: "evaluate", Params: map[string]any{"value": 4},
			Context: CallContext{
				Deadline: time.Now().Add(time.Second), Actor: workerrpc.Actor{Role: "system"},
			},
		})
		if callErr == nil && string(result) != `{"result":8}` {
			callErr = fmt.Errorf("nested service result = %s", result)
		}
		callDone <- callErr
	}()
	<-providerStarted

	writeDone := make(chan error, 1)
	go func() {
		writeDone <- broker.ReplaceProviders(ctx, "unrelated-provider", "1.0.0", []ProviderDeclaration{
			testProvider("codex.unrelated", "1.0.0", false),
		})
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			close(continueProvider)
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		close(continueProvider)
		t.Fatal("catalog write was blocked by provider execution")
	}
	close(continueProvider)
	if err := <-callDone; err != nil {
		t.Fatal(err)
	}
}

type runtimeCallerFunc func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error)

func (call runtimeCallerFunc) Call(ctx context.Context, method string, params any, meta *workerrpc.Meta) (json.RawMessage, error) {
	return call(ctx, method, params, meta)
}

func testStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	db, err := codexsqlite.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	result, err := codexsqlite.Migrate(ctx, db, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if result.CurrentVersion != 17 {
		t.Fatalf("migration version = %d, want 17", result.CurrentVersion)
	}
	store, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time {
		return time.Date(2026, time.August, 31, 10, 0, 0, 0, time.UTC)
	}
	return store, db
}

func testBroker(t *testing.T, store *Store, directory *RuntimeDirectory, contexts *requestcontext.Registry) *Broker {
	t.Helper()
	if contexts == nil {
		var err error
		contexts, err = requestcontext.New(requestcontext.Config{})
		if err != nil {
			t.Fatal(err)
		}
	}
	broker, err := New(store, directory, contexts)
	if err != nil {
		t.Fatal(err)
	}
	return broker
}

func testProvider(contract, version string, exclusive bool) ProviderDeclaration {
	return ProviderDeclaration{
		Contract: contract, Version: version, Transport: TransportWorker,
		Schema: "contracts/service.schema.json", Exclusive: exclusive,
	}
}

func installActiveProvider(
	t *testing.T,
	store *Store,
	broker *Broker,
	addonID, contract, version, generation string,
) {
	t.Helper()
	if err := broker.ReplaceProviders(context.Background(), addonID, "1.0.0", []ProviderDeclaration{
		testProvider(contract, version, false),
	}); err != nil {
		t.Fatal(err)
	}
	caller := runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
		return nil, errors.New("test provider was not expected to receive a call")
	})
	if err := broker.ActivateRuntime(context.Background(), addonID, generation, testRegistry(t, testProvider(contract, version, false)), caller); err != nil {
		t.Fatal(err)
	}
}

func testRegistry(t *testing.T, declaration ProviderDeclaration) *servicecontract.Registry {
	t.Helper()
	return testRegistryWithSchemas(
		t,
		declaration,
		`{"type":"object"}`,
		`{"type":"object"}`,
		servicecontract.IdempotencyOptional,
		2_000,
	)
}

func testRegistryWithSchemas(
	t *testing.T,
	declaration ProviderDeclaration,
	requestSchema string,
	responseSchema string,
	idempotency servicecontract.Idempotency,
	maxDeadlineMS int,
) *servicecontract.Registry {
	return testRegistryForMethod(
		t, declaration, "evaluate-character", requestSchema, responseSchema,
		idempotency, maxDeadlineMS,
	)
}

func testRegistryForMethod(
	t *testing.T,
	declaration ProviderDeclaration,
	methodName string,
	requestSchema string,
	responseSchema string,
	idempotency servicecontract.Idempotency,
	maxDeadlineMS int,
) *servicecontract.Registry {
	t.Helper()
	compiler, err := servicecontract.NewCompiler()
	if err != nil {
		t.Fatal(err)
	}
	document, err := json.Marshal(map[string]any{
		"contract":        declaration.Contract,
		"version":         declaration.Version,
		"allowsExclusive": declaration.Exclusive,
		"methods": map[string]any{
			methodName: map[string]any{
				"requestSchema":  "contracts/request.schema.json",
				"responseSchema": "contracts/response.schema.json",
				"maxDeadlineMs":  maxDeadlineMS,
				"idempotency":    idempotency,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	registry, err := compiler.Compile([]servicecontract.Declaration{{
		Contract:  declaration.Contract,
		Version:   declaration.Version,
		Document:  declaration.Schema,
		Exclusive: declaration.Exclusive,
	}}, map[string][]byte{
		declaration.Schema:               document,
		"contracts/request.schema.json":  []byte(requestSchema),
		"contracts/response.schema.json": []byte(responseSchema),
	})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func oneRequirement(consumer, contract, versionRange string) Requirement {
	return Requirement{
		ConsumerAddonID: consumer, Contract: contract, Range: versionRange,
		Cardinality: CardinalityOne, Selection: SelectionOperator, Scope: GlobalScope(),
	}
}

func assertForeignKeys(t *testing.T, db *sql.DB) {
	t.Helper()
	var enabled int
	if err := db.QueryRow(`PRAGMA foreign_keys`).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled != 1 {
		t.Fatalf("foreign_keys = %d, want 1", enabled)
	}
}

var _ RuntimeCaller = runtimeCallerFunc(nil)

type supportedRuntimeCaller struct {
	runtimeCallerFunc
	methods map[string]bool
}

func (caller supportedRuntimeCaller) Supports(method string) bool {
	return caller.methods[method]
}

var _ RuntimeMethodSupport = supportedRuntimeCaller{}
