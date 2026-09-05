package packagemanager

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestBrowserCanOptIntoOwnWorkerWithoutStartupSelfBinding(t *testing.T) {
	t.Parallel()
	db := testDatabase(t)
	factory := &fakeRuntimeFactory{}
	manager, _ := testManager(t, db, filepath.Join(t.TempDir(), "packages"), factory)
	ctx := context.Background()
	spec := packageSpec{ID: "engine-addon", Version: "1.0.0", Contract: "dnd5e.rules-engine", ContractVersion: "3.1.0",
		ConsumeContract: "dnd5e.rules-engine", OptionalConsume: true, Worker: true, UIEntry: "web/index.js"}
	generation, err := manager.Stage(ctx, writeAddonPackage(t, spec))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: spec.ID, GenerationID: generation.GenerationID, ExpectedStateRevision: 0}); err != nil {
		t.Fatal(err)
	}
	if len(factory.Specs()[0].BoundServices) != 0 {
		t.Fatal("worker bound itself")
	}
	request := BrowserServiceRequest{Contract: spec.Contract, Range: "^3.0.0", Cardinality: "one"}
	ordinary, err := manager.ConnectBrowserService(ctx, spec.ID, generation.GenerationID, request)
	if err != nil || len(ordinary.Providers) != 0 {
		t.Fatalf("default connection = %+v, %v", ordinary, err)
	}
	request.IncludeOwn = true
	own, err := manager.ConnectBrowserService(ctx, spec.ID, generation.GenerationID, request)
	if err != nil || len(own.Providers) != 1 {
		t.Fatalf("own connection = %+v, %v", own, err)
	}
	provider := own.Providers[0]
	target := BrowserServiceTarget{Contract: spec.Contract, ProviderAddonID: spec.ID, ContractVersion: provider.ContractVersion, Generation: provider.Generation}
	call := servicebroker.MethodCall{Method: "evaluate-character", Params: map[string]any{"value": 4}, Context: servicebroker.CallContext{Actor: workerrpc.Actor{Role: "dm", ID: "test-dm"}}}
	if result, err := manager.CallBrowserService(ctx, spec.ID, generation.GenerationID, target, call); err != nil || string(result) != `{"result":8}` {
		t.Fatalf("own call = %s, %v", result, err)
	}
	request.Range = "*"
	if _, err := manager.ConnectBrowserService(ctx, spec.ID, generation.GenerationID, request); !errors.Is(err, ErrServiceResolution) {
		t.Fatalf("widened declaration = %v", err)
	}
	target.BindingRevision++
	if _, err := manager.CallBrowserService(ctx, spec.ID, generation.GenerationID, target, call); !errors.Is(err, servicebroker.ErrStaleBinding) {
		t.Fatalf("forged binding = %v", err)
	}
	target.BindingRevision = 0
	target.Contract = "undeclared.service"
	if _, err := manager.CallBrowserService(ctx, spec.ID, generation.GenerationID, target, call); !errors.Is(err, servicebroker.ErrStaleBinding) {
		t.Fatalf("undeclared service = %v", err)
	}
}
