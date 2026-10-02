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

func TestBrokerRejectsExpiredServiceCompletion(t *testing.T) {
	for _, stage := range []string{"provider-response", "catalog-recheck", "cancelled-invalid-response"} {
		t.Run(stage, func(t *testing.T) {
			store, db := testStore(t)
			broker := testBroker(t, store, NewRuntimeDirectory(), nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			declaration := testProvider("example.completion", "1.0.0", false)
			if err := broker.ReplaceProviders(ctx, "provider", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
				t.Fatal(err)
			}
			contracts := testRegistryForMethod(t, declaration, "read", `{"type":"object"}`,
				`{"type":"object","required":["value"],"properties":{"value":{"type":"integer"}}}`,
				servicecontract.IdempotencyNone, 100)
			// Retain the only DB connection to place the final catalog check after
			// the provider returns, across the shorter method deadline.
			db.SetMaxOpenConns(1)
			released := make(chan struct{})
			caller := runtimeCallerFunc(func(callCtx context.Context, _ string, _ any, _ *workerrpc.Meta) (json.RawMessage, error) {
				switch stage {
				case "provider-response":
					<-callCtx.Done()
				case "catalog-recheck":
					held, err := db.Conn(callCtx)
					if err != nil {
						return nil, err
					}
					go func() {
						<-callCtx.Done()
						_ = held.Close()
						close(released)
					}()
				case "cancelled-invalid-response":
					cancel()
					return json.RawMessage(`{"value":"invalid"}`), nil
				}
				return json.RawMessage(`{"value":7}`), nil
			})
			if err := broker.ActivateRuntime(ctx, "provider", "generation-1", contracts, caller); err != nil {
				t.Fatal(err)
			}
			handle, err := broker.ConnectOne(ctx, oneRequirement("consumer", declaration.Contract, "^1.0.0"))
			if err != nil {
				t.Fatal(err)
			}
			result, err := broker.Call(ctx, handle, MethodCall{
				Method: "read", Params: map[string]any{},
				Context: CallContext{Deadline: time.Now().Add(3 * time.Second), Actor: workerrpc.Actor{Role: "system"}},
			})
			if stage == "catalog-recheck" {
				select {
				case <-released:
				case <-time.After(time.Second):
					t.Fatal("catalog fixture did not release its connection")
				}
			}
			want := context.DeadlineExceeded
			if stage == "cancelled-invalid-response" {
				want = context.Canceled
			}
			if !errors.Is(err, want) || len(result) != 0 {
				t.Errorf("completion returned %s, %v; want no result and %v", result, err, want)
			}
			if snapshot := broker.contexts.Snapshot(); snapshot.Active != 0 || snapshot.Issued != 1 {
				t.Errorf("completion leaked a request lease: %+v", snapshot)
			}
		})
	}
}
