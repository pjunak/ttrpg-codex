package servicebroker

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicecontract"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestOwnBrowserServiceKeepsWorkerExclusionAndValidatedCalls(t *testing.T) {
	t.Parallel()
	store, _ := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	ctx := context.Background()
	declaration := testProvider("codex.import-adapter", "2.0.0", false)
	if err := broker.ReplaceProviders(ctx, "dm-tools", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	registry := testRegistryWithSchemas(t, declaration, `{"type":"object","required":["value"],"additionalProperties":false,"properties":{"value":{"type":"integer"}}}`, `{"type":"object"}`, servicecontract.IdempotencyRequired, 2000)
	calls := 0
	caller := runtimeCallerFunc(func(_ context.Context, _ string, _ any, meta *workerrpc.Meta) (json.RawMessage, error) {
		calls++
		if meta.Actor.Role != "dm" || meta.Actor.ID != "session-dm" || meta.IdempotencyKey != "review-token" {
			t.Errorf("authority = %+v", meta)
		}
		return json.RawMessage(`{"ok":true}`), nil
	})
	if err := broker.ActivateRuntime(ctx, "dm-tools", "generation-1", registry, caller); err != nil {
		t.Fatal(err)
	}
	ordinary, err := broker.Resolve(ctx, oneRequirement("dm-tools", declaration.Contract, "^2.0.0"))
	if err != nil || len(ordinary.Providers) != 0 {
		t.Fatalf("worker resolution = %+v, %v", ordinary, err)
	}
	handle, err := broker.ConnectOwnBrowserService(ctx, "dm-tools", "generation-1", declaration.Contract, "^2.0.0")
	if err != nil {
		t.Fatal(err)
	}
	call := MethodCall{Method: "evaluate-character", Params: map[string]any{"value": 1}, Context: CallContext{Actor: workerrpc.Actor{Role: "dm", ID: "session-dm"}, IdempotencyKey: "review-token"}}
	if _, err := broker.Call(ctx, handle, call); err != nil {
		t.Fatal(err)
	}
	bad := call
	bad.Params = map[string]any{"unexpected": true}
	if _, err := broker.Call(ctx, handle, bad); !errors.Is(err, ErrInvalidCall) {
		t.Fatalf("schema error = %v", err)
	}
	bad = call
	bad.Context.IdempotencyKey = ""
	if _, err := broker.Call(ctx, handle, bad); err == nil {
		t.Fatal("missing idempotency accepted")
	}
	if calls != 1 {
		t.Fatalf("invalid call reached worker: %d", calls)
	}
	forged := handle
	forged.ProviderAddonID = "another-addon"
	if _, err := broker.ValidateHandle(ctx, forged); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("forged provider = %v", err)
	}
	encoded, _ := json.Marshal(handle)
	var decoded Handle
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, err := broker.ValidateHandle(ctx, decoded); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("wire handle acquired browser authority: %v", err)
	}
	if _, err := broker.ConnectOwnBrowserService(ctx, "dm-tools", "generation-1", declaration.Contract, "^3.0.0"); !errors.Is(err, ErrServiceUnavailable) {
		t.Fatalf("wrong range = %v", err)
	}
	if err := broker.ActivateRuntime(ctx, "dm-tools", "generation-2", registry, caller); err != nil {
		t.Fatal(err)
	}
	if _, err := broker.Call(ctx, handle, call); !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("old generation = %v", err)
	}
}

func TestOwnBrowserServiceRejectsResultAfterReplacement(t *testing.T) {
	t.Parallel()
	store, _ := testStore(t)
	broker := testBroker(t, store, NewRuntimeDirectory(), nil)
	ctx := context.Background()
	declaration := testProvider("codex.import-adapter", "2.0.0", false)
	if err := broker.ReplaceProviders(ctx, "dm-tools", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
		t.Fatal(err)
	}
	entered, resume := make(chan struct{}), make(chan struct{}, 1)
	defer close(resume)
	caller := runtimeCallerFunc(func(ctx context.Context, _ string, _ any, _ *workerrpc.Meta) (json.RawMessage, error) {
		close(entered)
		select {
		case <-resume:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return json.RawMessage(`{}`), nil
	})
	registry := testRegistry(t, declaration)
	if err := broker.ActivateRuntime(ctx, "dm-tools", "generation-1", registry, caller); err != nil {
		t.Fatal(err)
	}
	handle, err := broker.ConnectOwnBrowserService(ctx, "dm-tools", "generation-1", declaration.Contract, "^2.0.0")
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := broker.Call(ctx, handle, MethodCall{Method: "evaluate-character", Params: map[string]any{}, Context: CallContext{Actor: workerrpc.Actor{Role: "system"}}})
		result <- err
	}()
	select {
	case <-entered:
	case err := <-result:
		t.Fatalf("call did not reach worker: %v", err)
	case <-time.After(time.Second):
		t.Fatal("call did not reach worker")
	}
	if err := broker.ActivateRuntime(ctx, "dm-tools", "generation-2", registry, caller); err != nil {
		t.Fatal(err)
	}
	resume <- struct{}{}
	if err := <-result; !errors.Is(err, ErrStaleBinding) {
		t.Fatalf("late result = %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := broker.ConnectOwnBrowserService(cancelled, "dm-tools", "generation-2", declaration.Contract, "^2.0.0"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled connect = %v", err)
	}
}
