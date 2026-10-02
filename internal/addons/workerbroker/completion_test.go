package workerbroker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

type completionJSONFunc func() ([]byte, error)

func (marshal completionJSONFunc) MarshalJSON() ([]byte, error) { return marshal() }

func TestDispatcherStopsCancelledCompletionStages(t *testing.T) {
	for _, stage := range []string{"request-validation", "context-resolution", "authorization", "encoding", "encoding-error", "response-validation", "response-validation-error"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			config := validConfig()
			handled, authorized, resolved, validated, reports := false, false, false, false, 0
			config.Methods[0].ValidateRequest = func(json.RawMessage) error {
				if stage == "request-validation" {
					cancel()
				}
				return nil
			}
			config.ContextResolver = ContextResolverFunc(func(context.Context, ContextRequest) (Authority, error) {
				resolved = true
				if stage == "context-resolution" {
					cancel()
				}
				return validAuthority(), nil
			})
			config.Authorizer = AuthorizerFunc(func(context.Context, Invocation) error {
				authorized = true
				if stage == "authorization" {
					cancel()
				}
				return nil
			})
			config.Methods[0].Handle = func(context.Context, Invocation) (any, error) {
				handled = true
				return completionJSONFunc(func() ([]byte, error) {
					if stage == "encoding" || stage == "encoding-error" {
						cancel()
					}
					if stage == "encoding-error" {
						return nil, errors.New("interrupted fixture encoding")
					}
					return []byte(`{"revision":1}`), nil
				}), nil
			}
			config.Methods[0].ValidateResponse = func(json.RawMessage) error {
				validated = true
				if stage == "response-validation" || stage == "response-validation-error" {
					cancel()
				}
				if stage == "response-validation-error" {
					return errors.New("interrupted fixture validation")
				}
				return nil
			}
			config.OnInternalError = func(Invocation, error) { reports++ }
			dispatcher, err := New(config)
			if err != nil {
				t.Fatal(err)
			}
			result, err := dispatcher.HandleRPC(ctx, validRequest())
			assertBrokerError(t, err, workerrpc.KindCancelled)
			if result != nil || reports != 0 {
				t.Errorf("cancelled completion returned %v and %d internal reports", result, reports)
			}
			if stage == "request-validation" && resolved ||
				(stage == "request-validation" || stage == "context-resolution") && authorized ||
				(stage == "request-validation" || stage == "context-resolution" || stage == "authorization") && handled ||
				(stage == "encoding" || stage == "encoding-error") && validated {
				t.Errorf("continued after cancellation: resolved=%t authorized=%t handled=%t validated=%t", resolved, authorized, handled, validated)
			}
			if snapshot := dispatcher.Snapshot(); snapshot.InFlight != 0 || snapshot.Succeeded != 0 || snapshot.ByErrorKind[workerrpc.KindCancelled] != 1 {
				t.Errorf("cancelled completion counted incorrectly: %+v", snapshot)
			}
		})
	}
}

func TestDispatcherRejectsLateValidatedResponseThroughPeer(t *testing.T) {
	config := validConfig()
	config.ContextResolver = ContextResolverFunc(func(context.Context, ContextRequest) (Authority, error) {
		authority := validAuthority()
		authority.Deadline = time.Now().Add(100 * time.Millisecond)
		return authority, nil
	})
	var authorizedCtx context.Context
	config.Methods[0].Handle = func(ctx context.Context, _ Invocation) (any, error) {
		authorizedCtx = ctx
		return map[string]any{"revision": 1}, nil
	}
	config.Methods[0].ValidateResponse = func(json.RawMessage) error {
		<-authorizedCtx.Done()
		return nil
	}
	config.OnInternalError = func(_ Invocation, err error) { t.Errorf("deadline reported as an internal error: %v", err) }
	dispatcher, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	hostConnection, workerConnection := net.Pipe()
	t.Cleanup(func() {
		_ = hostConnection.Close()
		_ = workerConnection.Close()
	})
	hostCodec, err := workerrpc.NewCodec(hostConnection, hostConnection, workerrpc.DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	workerCodec, err := workerrpc.NewCodec(workerConnection, workerConnection, workerrpc.DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	host, err := workerrpc.NewPeer(hostCodec, workerrpc.PeerConfig{
		Generation: config.Generation, RequireIncomingMeta: true, Handler: dispatcher,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workerrpc.NewPeer(workerCodec, workerrpc.PeerConfig{
		Generation: config.Generation, RequireIncomingMeta: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { host.Close(); worker.Close() })
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	request := validRequest()
	result, err := worker.Call(context.Background(), request.Method, json.RawMessage(request.Params), request.Meta)
	assertBrokerError(t, err, workerrpc.KindDeadlineExceeded)
	if len(result) != 0 {
		t.Errorf("late validated response reached the worker: %s", result)
	}
	if snapshot := dispatcher.Snapshot(); snapshot.InFlight != 0 || snapshot.Succeeded != 0 || snapshot.ByErrorKind[workerrpc.KindDeadlineExceeded] != 1 {
		t.Errorf("late response counted incorrectly: %+v", snapshot)
	}
}
