package servicebroker

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestClientHandlesReachLiveWorkerProvidersWithTheSessionActor(t *testing.T) {
	t.Parallel()
	store, _ := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	ctx := context.Background()
	declaration := testProvider("dnd5e.character", "4.0.0", false)
	if err := broker.ReplaceProviders(ctx, "sheets", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	if handles, err := broker.ConnectClient(ctx, declaration.Contract, "^4.0.0"); err != nil || len(handles) != 0 {
		t.Fatalf("installed but not live = %+v, %v", handles, err)
	}
	var actor workerrpc.Actor
	caller := runtimeCallerFunc(func(_ context.Context, _ string, _ any, meta *workerrpc.Meta) (json.RawMessage, error) {
		actor = *meta.Actor
		return json.RawMessage(`{"result":8}`), nil
	})
	registry := testRegistry(t, declaration)
	if err := broker.ActivateRuntime(ctx, "sheets", "generation-1", registry, caller); err != nil {
		t.Fatal(err)
	}
	if handles, err := broker.ConnectClient(ctx, declaration.Contract, "^5.0.0"); err != nil || len(handles) != 0 {
		t.Fatalf("incompatible range = %+v, %v", handles, err)
	}
	handles, err := broker.ConnectClient(ctx, declaration.Contract, "^4.0.0")
	if err != nil || len(handles) != 1 || handles[0].ProviderAddonID != "sheets" || handles[0].ConsumerAddonID != "" {
		t.Fatalf("client connection = %+v, %v", handles, err)
	}
	call := MethodCall{Method: "evaluate-character", Params: map[string]any{"value": 4},
		Context: CallContext{Actor: workerrpc.Actor{Role: "player", ID: "session-player"}}}
	if result, err := broker.Call(ctx, handles[0], call); err != nil || string(result) != `{"result":8}` {
		t.Fatalf("client call = %s, %v", result, err)
	}
	if actor.Role != "player" || actor.ID != "session-player" {
		t.Fatalf("worker saw actor %+v", actor)
	}

	encoded, _ := json.Marshal(handles[0])
	var decoded Handle
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, err := broker.ValidateHandle(ctx, decoded); err == nil {
		t.Fatal("a serialized handle acquired client authority")
	}
	if err := broker.ActivateRuntime(ctx, "sheets", "generation-2", registry, caller); err != nil {
		t.Fatal(err)
	}
	if _, err := broker.Call(ctx, handles[0], call); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("old generation = %v", err)
	}
	if _, err := broker.ConnectClient(ctx, "Not A Contract", "^4.0.0"); !errors.Is(err, ErrInvalidDeclaration) {
		t.Fatalf("invalid contract = %v", err)
	}
	if _, err := broker.ConnectClient(ctx, declaration.Contract, ""); !errors.Is(err, ErrInvalidDeclaration) {
		t.Fatalf("missing range = %v", err)
	}
}
