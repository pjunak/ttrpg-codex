package packagemanager

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type heldReloadFactory struct {
	fakeRuntimeFactory
	first *heldReloadRuntime
}

func (factory *heldReloadFactory) New(spec RuntimeSpec) (Runtime, error) {
	runtime, err := factory.fakeRuntimeFactory.New(spec)
	if err != nil || factory.first != nil {
		return runtime, err
	}
	factory.first = &heldReloadRuntime{Runtime: runtime, entered: make(chan struct{}), release: make(chan struct{})}
	return factory.first, nil
}

type heldReloadRuntime struct {
	Runtime
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (runtime *heldReloadRuntime) Call(ctx context.Context, _ string, _ any, _ *workerrpc.Meta) (json.RawMessage, error) {
	close(runtime.entered)
	select {
	case <-runtime.release:
		return json.RawMessage(`{"result":9}`), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (runtime *heldReloadRuntime) Shutdown(ctx context.Context) error {
	err := runtime.Runtime.Shutdown(ctx)
	runtime.once.Do(func() { close(runtime.release) })
	return err
}

func TestReloadRejectsInFlightBrowserReplyFromReplacedRuntime(t *testing.T) {
	ctx := context.Background()
	factory := &heldReloadFactory{}
	manager, broker := testManager(t, testDatabase(t), filepath.Join(t.TempDir(), "packages"), factory)
	t.Cleanup(func() { _ = manager.Shutdown(context.Background()) })
	provider := stageServicePackage(t, manager, "engine-addon", "1.0.0", "3.1.0")
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: provider.AddonID, GenerationID: provider.GenerationID,
		GrantedPermissionIDs: []string{"core.data.read"}}); err != nil {
		t.Fatal(err)
	}
	consumer := installUninstallFixture(t, manager, packageSpec{ID: "sheet-addon", Version: "1.0.0",
		ConsumeContract: "dnd5e.rules-engine", UIEntry: "web/index.js"})
	connection, err := manager.ConnectBrowserService(ctx, consumer.AddonID, consumer.GenerationID,
		BrowserServiceRequest{Contract: "dnd5e.rules-engine", Range: "^3.0.0", Cardinality: "one"})
	if err != nil || len(connection.Providers) != 1 {
		t.Fatalf("browser connection = %+v, %v", connection, err)
	}
	bound := connection.Providers[0]
	target := BrowserServiceTarget{Contract: connection.Contract, ProviderAddonID: bound.AddonID,
		ContractVersion: bound.ContractVersion, Generation: bound.Generation, BindingRevision: bound.BindingRevision}
	call := func() (json.RawMessage, error) {
		return manager.CallBrowserService(ctx, consumer.AddonID, consumer.GenerationID, target,
			servicebroker.MethodCall{Method: "evaluate-character", Params: map[string]any{"value": 4},
				Context: servicebroker.CallContext{Deadline: time.Now().Add(4 * time.Second), Actor: workerrpc.Actor{Role: "dm"}}})
	}
	catalog, err := broker.ListProviders(ctx, connection.Contract)
	if err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		body json.RawMessage
		err  error
	}
	done := make(chan outcome, 1)
	go func() { body, err := call(); done <- outcome{body, err} }()
	select {
	case <-factory.first.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("browser call did not reach the old runtime")
	}
	reloaded, err := manager.Reload(ctx, provider.AddonID, 1)
	if err != nil || reloaded.State.ActiveGenerationID != provider.GenerationID || reloaded.State.Revision != 2 {
		t.Fatalf("reload = %+v, %v", reloaded, err)
	}
	select {
	case old := <-done:
		if !errors.Is(old.err, servicebroker.ErrStaleBinding) || len(old.body) != 0 {
			t.Errorf("retired runtime reply reached browser: %s, %v", old.body, old.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("browser call did not settle after Reload")
	}
	current, err := broker.ListProviders(ctx, connection.Contract)
	if err != nil || len(current) != 1 || current[0].CatalogRevision != catalog[0].CatalogRevision {
		t.Fatalf("Reload changed catalog identity: %+v, %v", current, err)
	}
	if body, err := call(); err != nil || string(body) != `{"result":8}` {
		t.Errorf("retained browser handle did not reach replacement: %s, %v", body, err)
	}
}
