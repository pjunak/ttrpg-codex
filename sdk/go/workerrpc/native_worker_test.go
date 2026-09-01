package workerrpc

import (
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

func TestNativeWorkerRunsLifecycleDomainCallsAndHostCallbacks(t *testing.T) {
	t.Parallel()
	hostCodec, workerReader, workerWriter, closeTransport := nativeWorkerTransport(t)
	defer closeTransport()
	workerDone := make(chan error, 1)
	var initialized NativeWorkerInitialization
	go func() {
		defer workerReader.Close()
		defer workerWriter.Close()
		workerDone <- RunNativeWorker(context.Background(), NativeWorkerConfig{
			Reader: workerReader, Writer: workerWriter,
			Methods: map[string]string{"service/codex.test-engine/evaluate": "1.0.0"},
			HandlerFactory: NativeWorkerHandlerFactoryFunc(func(
				worker NativeWorkerContext,
			) (RequestHandler, error) {
				initialized = worker.Initialization
				client, err := NewServiceClient(worker.Peer)
				if err != nil {
					return nil, err
				}
				return RequestHandlerFunc(func(
					ctx context.Context,
					request Request,
				) (any, error) {
					if request.Method != "service/codex.test-engine/evaluate" {
						return nil, NewRPCError(JSONRPCMethodNotFound, KindNotFound, "missing", false, nil)
					}
					result, err := client.Call(ctx, request.Meta, ServiceCall{
						Contract: "codex.test-data", Method: "lookup",
						Params: map[string]any{"value": 4},
					})
					if err != nil {
						return nil, err
					}
					var value struct {
						Result int `json:"result"`
					}
					value, err = DecodeServiceResult[struct {
						Result int `json:"result"`
					}](result)
					return map[string]any{"result": value.Result * 2}, err
				}), nil
			}),
		})
	}()

	initialize := nativeHostExchange(t, hostCodec, "host-1", "codex/initialize", map[string]any{
		"protocolVersion": "1.0.0",
		"addon": map[string]any{
			"id": "test-engine", "version": "1.0.0", "generation": serviceTestGeneration,
		},
		"host":   map[string]any{"version": "2.0.0", "locale": "en", "timeZone": "UTC"},
		"grants": []any{},
		"services": []any{map[string]any{
			"consumerAddonId": "test-engine", "contract": "codex.test-data",
		}},
		"limits": map[string]any{
			"maxFrameBytes": 4 << 20, "maxConcurrentRequests": 4, "defaultDeadlineMs": 5000,
		},
	})
	var negotiation struct {
		ProtocolVersion string            `json:"protocolVersion"`
		Capabilities    []string          `json:"capabilities"`
		Methods         map[string]string `json:"methods"`
		HealthCheck     bool              `json:"healthCheck"`
	}
	if err := json.Unmarshal(initialize, &negotiation); err != nil ||
		negotiation.ProtocolVersion != "1.0.0" || !negotiation.HealthCheck ||
		negotiation.Methods["codex/health"] != "1.0.0" ||
		negotiation.Methods["service/codex.test-engine/evaluate"] != "1.0.0" {
		t.Fatalf("negotiation = %+v, %v", negotiation, err)
	}
	nativeHostExchange(t, hostCodec, "host-2", "codex/start", map[string]any{})
	health := nativeHostExchange(t, hostCodec, "host-3", "codex/health", map[string]any{})
	if string(health) != `{"status":"ok"}` {
		t.Fatalf("initial health = %s", health)
	}

	hostPeer, err := NewPeer(hostCodec, PeerConfig{
		IDPrefix: "host-runtime", Generation: serviceTestGeneration,
		MaxOutgoingRequests: 4, MaxIncomingRequests: 4, RequireIncomingMeta: true,
		Handler: RequestHandlerFunc(func(_ context.Context, request Request) (any, error) {
			if request.Method != "host/service.call" || request.Meta == nil ||
				request.Meta.CorrelationID != "correlation-1" {
				return nil, NewRPCError(JSONRPCInvalidRequest, KindInvalidRequest,
					"unexpected host callback", false, nil)
			}
			return map[string]any{
				"contractVersion": "host-service-result.v1", "contract": "codex.test-data",
				"providerAddonId": "test-data", "providerContractVersion": "1.0.0",
				"providerGeneration": serviceTestGeneration,
				"result":             map[string]any{"result": 8},
			}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := hostPeer.Start(); err != nil {
		t.Fatal(err)
	}
	meta := &Meta{
		RequestID: "request-1", CorrelationID: "correlation-1",
		Generation: serviceTestGeneration, Deadline: time.Now().Add(time.Second),
		Actor: &Actor{Role: "system"},
	}
	result, err := hostPeer.Call(context.Background(), "service/codex.test-engine/evaluate", map[string]any{"value": 4}, meta)
	if err != nil || string(result) != `{"result":16}` {
		t.Fatalf("domain result = %s, %v", result, err)
	}
	if initialized.Addon.ID != "test-engine" || len(initialized.Services) != 1 {
		t.Fatalf("worker initialization = %+v", initialized)
	}
	if _, err := hostPeer.Call(context.Background(), "codex/shutdown", map[string]any{}, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-workerDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("native worker did not exit after shutdown response")
	}
}

func TestNativeWorkerRejectsInvalidConfiguration(t *testing.T) {
	t.Parallel()
	_, workerReader, workerWriter, closeTransport := nativeWorkerTransport(t)
	defer closeTransport()
	err := RunNativeWorker(context.Background(), NativeWorkerConfig{
		Reader: workerReader, Writer: workerWriter,
		Capabilities: []string{"duplicate", "duplicate"},
		HandlerFactory: NativeWorkerHandlerFactoryFunc(func(NativeWorkerContext) (RequestHandler, error) {
			return RequestHandlerFunc(func(context.Context, Request) (any, error) { return nil, nil }), nil
		}),
	})
	if err == nil {
		t.Fatal("duplicate capabilities were accepted")
	}
}

func nativeWorkerTransport(
	t *testing.T,
) (*Codec, *io.PipeReader, *io.PipeWriter, func()) {
	t.Helper()
	hostToWorkerReader, hostToWorkerWriter := io.Pipe()
	workerToHostReader, workerToHostWriter := io.Pipe()
	hostCodec, err := NewCodec(workerToHostReader, hostToWorkerWriter, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	closeTransport := func() {
		_ = hostToWorkerWriter.Close()
		_ = hostToWorkerReader.Close()
		_ = workerToHostWriter.Close()
		_ = workerToHostReader.Close()
	}
	return hostCodec, hostToWorkerReader, workerToHostWriter, closeTransport
}

func nativeHostExchange(
	t *testing.T,
	codec *Codec,
	id string,
	method string,
	params any,
) json.RawMessage {
	t.Helper()
	if err := codec.Write(context.Background(), map[string]any{
		"jsonrpc": "2.0", "id": id, "method": method, "params": params,
	}); err != nil {
		t.Fatal(err)
	}
	message, err := codec.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		ID     string          `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *RPCError       `json:"error"`
	}
	if err := json.Unmarshal(message.Raw, &response); err != nil || response.ID != id || response.Error != nil {
		t.Fatalf("response = %s, %v", message.Raw, err)
	}
	return response.Result
}
