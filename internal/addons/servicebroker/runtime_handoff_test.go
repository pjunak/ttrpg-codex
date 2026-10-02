package servicebroker

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/servicecontract"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestRuntimeHandoffRejectsOldRepliesAndRetainsHandles(t *testing.T) {
	for _, transport := range []Transport{TransportWorker, TransportContent} {
		for _, reuse := range []bool{false, true} {
			name := string(transport) + "/replacement"
			if reuse {
				name = string(transport) + "/same-caller-reactivation"
			}
			t.Run(name, func(t *testing.T) {
				ctx := context.Background()
				store, _ := testStore(t)
				broker := testBroker(t, store, NewRuntimeDirectory(), nil)
				declaration := testProvider("example.handoff", "1.0.0", false)
				declaration.Transport = transport
				if err := broker.ReplaceProviders(ctx, "provider", "1.0.0", []ProviderDeclaration{declaration}); err != nil {
					t.Fatal(err)
				}
				contracts := testRegistryForMethod(t, declaration, "catalog", `{"type":"object"}`,
					`{"type":"object","required":["result"],"properties":{"result":{"type":"integer"}}}`,
					servicecontract.IdempotencyNone, 5_000)
				entered, release := make(chan struct{}), make(chan struct{})
				var releaseOnce sync.Once
				releaseCall := func() { releaseOnce.Do(func() { close(release) }) }
				t.Cleanup(releaseCall)
				var calls atomic.Int32
				old := runtimeCallerFunc(func(callCtx context.Context, _ string, _ any, _ *workerrpc.Meta) (json.RawMessage, error) {
					if calls.Add(1) == 1 {
						close(entered)
						select {
						case <-release:
						case <-callCtx.Done():
							return nil, callCtx.Err()
						}
					}
					return json.RawMessage(`{"result":8}`), nil
				})
				adapters := func(caller runtimeCallerFunc) RuntimeAdapters {
					if transport == TransportContent {
						return RuntimeAdapters{Content: supportedRuntimeCaller{
							runtimeCallerFunc: caller, methods: map[string]bool{"catalog": true},
						}}
					}
					return RuntimeAdapters{Worker: caller}
				}
				oldAdapters := adapters(old)
				if err := broker.ActivateRuntimeWithAdapters(ctx, "provider", "same-generation", contracts, oldAdapters); err != nil {
					t.Fatal(err)
				}
				handle, err := broker.ConnectOne(ctx, oneRequirement("consumer", declaration.Contract, "^1.0.0"))
				if err != nil {
					t.Fatal(err)
				}
				call := func() (json.RawMessage, error) {
					return broker.Call(ctx, handle, MethodCall{Method: "catalog", Params: map[string]any{},
						Context: CallContext{Deadline: time.Now().Add(4 * time.Second), Actor: workerrpc.Actor{Role: "system"}}})
				}
				type outcome struct {
					body json.RawMessage
					err  error
				}
				done := make(chan outcome, 1)
				go func() { body, err := call(); done <- outcome{body, err} }()
				select {
				case <-entered:
				case <-time.After(3 * time.Second):
					t.Fatal("old provider call did not start")
				}
				nextAdapters := oldAdapters
				if !reuse {
					nextAdapters = adapters(runtimeCallerFunc(func(context.Context, string, any, *workerrpc.Meta) (json.RawMessage, error) {
						return json.RawMessage(`{"result":8}`), nil
					}))
				}
				if err := broker.ActivateRuntimeWithAdapters(ctx, "provider", "same-generation", contracts, nextAdapters); err != nil {
					t.Fatal(err)
				}
				releaseCall()
				select {
				case result := <-done:
					if !errors.Is(result.err, ErrStaleBinding) || len(result.body) != 0 {
						t.Errorf("old runtime result = %s, %v; want ErrStaleBinding and no result", result.body, result.err)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("old provider call did not settle")
				}
				if body, err := call(); err != nil || string(body) != `{"result":8}` {
					t.Errorf("retained handle failed on current runtime: %s, %v", body, err)
				}
				if snapshot := broker.contexts.Snapshot(); snapshot.Active != 0 || snapshot.Issued != 2 || snapshot.Invalidated != 1 {
					t.Errorf("handoff request leases = %+v", snapshot)
				}
			})
		}
	}
}
