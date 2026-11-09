package packagemanager

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestClientLoadsACharacterFromTheLiveSheetProviderAsAPlayer(t *testing.T) {
	t.Parallel()
	db := testDatabase(t)
	factory := &fakeRuntimeFactory{}
	manager, _ := testManager(t, db, filepath.Join(t.TempDir(), "packages"), factory)
	ctx := context.Background()
	spec := packageSpec{ID: "sheet-addon", Version: "1.0.0", Contract: "dnd5e.character", ContractVersion: "4.0.0",
		Worker: true, UIEntry: "web/index.js"}
	generation, err := manager.Stage(ctx, writeAddonPackage(t, spec))
	if err != nil {
		t.Fatal(err)
	}
	if connection, err := manager.ConnectClientService(ctx, spec.Contract, "^4.0.0"); err != nil || len(connection.Providers) != 0 {
		t.Fatalf("staged but inactive = %+v, %v", connection, err)
	}
	if _, err := manager.Activate(ctx, ActivationPlan{AddonID: spec.ID, GenerationID: generation.GenerationID, ExpectedStateRevision: 0}); err != nil {
		t.Fatal(err)
	}

	connection, err := manager.ConnectClientService(ctx, spec.Contract, "^4.0.0")
	if err != nil || len(connection.Providers) != 1 {
		t.Fatalf("connection = %+v, %v", connection, err)
	}
	provider := connection.Providers[0]
	if provider.AddonID != spec.ID || provider.ContractVersion != "4.0.0" || provider.Generation != generation.GenerationID {
		t.Fatalf("provider = %+v", provider)
	}
	target := ClientServiceTarget{Contract: spec.Contract, ProviderAddonID: provider.AddonID,
		ContractVersion: provider.ContractVersion, Generation: provider.Generation}
	call := servicebroker.MethodCall{Method: "evaluate-character", Params: map[string]any{"value": 4},
		Context: servicebroker.CallContext{Actor: workerrpc.Actor{Role: "player", ID: "session-player"}}}
	if result, err := manager.CallClientService(ctx, target, call); err != nil || string(result) != `{"result":8}` {
		t.Fatalf("load = %s, %v", result, err)
	}
	if actor := factory.LastActor(); actor.Role != "player" || actor.ID != "session-player" {
		t.Fatalf("worker saw actor %+v", actor)
	}

	if connection, err := manager.ConnectClientService(ctx, spec.Contract, "^5.0.0"); err != nil || len(connection.Providers) != 0 {
		t.Fatalf("newer contract = %+v, %v", connection, err)
	}
	stale := target
	stale.Generation = strings.Repeat("0", 64)
	if _, err := manager.CallClientService(ctx, stale, call); !errors.Is(err, servicebroker.ErrStaleBinding) {
		t.Fatalf("stale generation = %v", err)
	}
	stale = target
	stale.ContractVersion = "4.1.0"
	if _, err := manager.CallClientService(ctx, stale, call); !errors.Is(err, servicebroker.ErrStaleBinding) {
		t.Fatalf("other contract version = %v", err)
	}
}
