package workerhost

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/addons/workerbroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const providerGeneration = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestWorkerServiceCallUsesBoundHandleAndAuthoritativeContext(t *testing.T) {
	t.Parallel()
	service := &serviceCallerStub{result: json.RawMessage(`{"items":[{"id":"spell-1"}]}`)}
	dispatcher := serviceDispatcher(t, service, []servicebroker.Handle{
		serviceHandle("compendium", 4),
	})
	request := rpcRequest("host/service.call", `{
		"contractVersion":"host-service-call.v1","contract":"dnd5e.rules-data",
		"method":"query","params":{"kind":"spell"},"idempotencyKey":"lookup-1"
	}`)
	request.Meta.Actor = &workerrpc.Actor{Role: "dm", ID: "forged"}

	result, err := dispatcher.HandleRPC(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	body, ok := result.(json.RawMessage)
	if !ok {
		t.Fatalf("response type = %T", result)
	}
	assertJSONEqual(t, body, `{
		"contractVersion":"host-service-result.v1","contract":"dnd5e.rules-data",
		"providerAddonId":"compendium","providerContractVersion":"3.0.0",
		"providerGeneration":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"result":{"items":[{"id":"spell-1"}]}
	}`)
	if service.calls != 1 || service.handle.ProviderAddonID != "compendium" ||
		service.handle.BindingRevision != 4 || service.call.Method != "query" {
		t.Fatalf("service route = calls %d, handle %+v, call %+v", service.calls, service.handle, service.call)
	}
	params, ok := service.call.Params.(json.RawMessage)
	if !ok || string(params) != `{"kind":"spell"}` {
		t.Fatalf("service params = %T %s", service.call.Params, params)
	}
	if service.call.Context.CorrelationID != "authoritative-correlation" ||
		service.call.Context.Actor.Role != "player" || service.call.Context.Actor.ID != "player-7" ||
		service.call.Context.IdempotencyKey != "lookup-1" ||
		service.call.Context.Traceparent != "00-11111111111111111111111111111111-2222222222222222-01" {
		t.Fatalf("service context = %+v", service.call.Context)
	}
}

func TestWorkerServiceCallRequiresUnambiguousBoundProvider(t *testing.T) {
	t.Parallel()
	service := &serviceCallerStub{result: json.RawMessage(`{"items":[]}`)}
	dispatcher := serviceDispatcher(t, service, []servicebroker.Handle{
		serviceHandle("compendium", 1), serviceHandle("homebrew-compendium", 1),
	})
	base := `{
		"contractVersion":"host-service-call.v1","contract":"dnd5e.rules-data",
		"method":"query","params":{"kind":"spell"}
	}`
	_, err := dispatcher.HandleRPC(context.Background(), rpcRequest("host/service.call", base))
	assertRPCError(t, err, workerrpc.KindUnauthorized)
	if service.calls != 0 {
		t.Fatalf("ambiguous request reached broker %d times", service.calls)
	}

	selected := `{
		"contractVersion":"host-service-call.v1","contract":"dnd5e.rules-data",
		"providerAddonId":"homebrew-compendium","method":"query","params":{"kind":"spell"}
	}`
	if _, err := dispatcher.HandleRPC(
		context.Background(), rpcRequest("host/service.call", selected),
	); err != nil {
		t.Fatal(err)
	}
	if service.calls != 1 || service.handle.ProviderAddonID != "homebrew-compendium" {
		t.Fatalf("selected service = calls %d, handle %+v", service.calls, service.handle)
	}

	unbound := `{
		"contractVersion":"host-service-call.v1","contract":"codex.missing",
		"method":"query","params":{}
	}`
	_, err = dispatcher.HandleRPC(context.Background(), rpcRequest("host/service.call", unbound))
	assertRPCError(t, err, workerrpc.KindUnauthorized)
}

func TestWorkerServiceCallRejectsMalformedRequestBeforeBroker(t *testing.T) {
	t.Parallel()
	service := &serviceCallerStub{}
	dispatcher := serviceDispatcher(t, service, []servicebroker.Handle{serviceHandle("compendium", 0)})
	for _, body := range []string{
		`{"contractVersion":"host-service-call.v1","contract":"dnd5e.rules-data","method":"query","params":"not-an-object"}`,
		`{"contractVersion":"host-service-call.v1","contract":"dnd5e.rules-data","method":"query","params":{},"extra":true}`,
		`{"contractVersion":"wrong","contract":"dnd5e.rules-data","method":"query","params":{}}`,
	} {
		_, err := dispatcher.HandleRPC(context.Background(), rpcRequest("host/service.call", body))
		assertRPCError(t, err, workerrpc.KindValidationFailed)
	}
	if service.calls != 0 {
		t.Fatalf("malformed requests reached broker %d times", service.calls)
	}
}

func TestWorkerServiceCallMapsBrokerFailures(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name string
		err  error
		kind string
	}{
		{"stale", servicebroker.ErrStaleBinding, workerrpc.KindStaleBinding},
		{"unavailable", servicebroker.ErrRuntimeUnavailable, workerrpc.KindUnavailable},
		{"missing method", servicebroker.ErrMethodNotFound, workerrpc.KindNotFound},
		{"invalid request", servicebroker.ErrInvalidCall, workerrpc.KindValidationFailed},
		{"deadline", servicebroker.ErrCallDeadline, workerrpc.KindDeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			dispatcher := serviceDispatcher(t, &serviceCallerStub{err: test.err}, []servicebroker.Handle{
				serviceHandle("compendium", 0),
			})
			_, err := dispatcher.HandleRPC(context.Background(), rpcRequest("host/service.call", `{
				"contractVersion":"host-service-call.v1","contract":"dnd5e.rules-data",
				"method":"query","params":{}
			}`))
			assertRPCError(t, err, test.kind)
		})
	}
}

func serviceDispatcher(
	t *testing.T,
	services ServiceCaller,
	handles []servicebroker.Handle,
) *workerbroker.Dispatcher {
	t.Helper()
	dispatcher, err := New(Config{
		AddonID: "dm-tools", Generation: testGeneration, Data: &dataStub{}, Services: services,
		BoundServices: handles, Manifest: packageinspect.Manifest{ID: "dm-tools"},
		ContextResolver: workerbroker.ContextResolverFunc(func(
			context.Context, workerbroker.ContextRequest,
		) (workerbroker.Authority, error) {
			return workerbroker.Authority{
				RequestID: "verified", CorrelationID: "authoritative-correlation",
				Deadline: time.Now().Add(time.Minute), Actor: workerrpc.Actor{Role: "player", ID: "player-7"},
				Traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
			}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	return dispatcher
}

func serviceHandle(provider string, revision int64) servicebroker.Handle {
	return servicebroker.Handle{
		ConsumerAddonID: "dm-tools", Contract: "dnd5e.rules-data", Range: "^3.0.0",
		Cardinality: servicebroker.CardinalityOne, Selection: servicebroker.SelectionOperator,
		Scope: servicebroker.GlobalScope(), ProviderAddonID: provider, ContractVersion: "3.0.0",
		Transport: servicebroker.TransportContent, Generation: providerGeneration,
		BindingRevision: revision,
	}
}

type serviceCallerStub struct {
	calls  int
	handle servicebroker.Handle
	call   servicebroker.MethodCall
	result json.RawMessage
	err    error
}

func (stub *serviceCallerStub) Call(
	_ context.Context,
	handle servicebroker.Handle,
	call servicebroker.MethodCall,
) (json.RawMessage, error) {
	stub.calls++
	stub.handle = handle
	stub.call = call
	return append(json.RawMessage(nil), stub.result...), stub.err
}

func TestWorkerServiceConfigurationRejectsForeignHandle(t *testing.T) {
	t.Parallel()
	handle := serviceHandle("compendium", 0)
	handle.ConsumerAddonID = "another-worker"
	_, err := compileBoundServices("dm-tools", []servicebroker.Handle{handle})
	if err == nil || errors.Is(err, errServiceNotBound) {
		t.Fatalf("foreign handle configuration error = %v", err)
	}
}
