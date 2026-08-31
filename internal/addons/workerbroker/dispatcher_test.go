package workerbroker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestNewRejectsIncompleteMethodPolicy(t *testing.T) {
	t.Parallel()

	valid := validConfig()
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"missing identity", func(config *Config) { config.AddonID = "" }},
		{"missing context resolver", func(config *Config) { config.ContextResolver = nil }},
		{"missing authorizer", func(config *Config) { config.Authorizer = nil }},
		{"invalid method", func(config *Config) { config.Methods[0].Name = "data.get" }},
		{"invalid permission", func(config *Config) { config.Methods[0].Permission = "read" }},
		{"missing request validation", func(config *Config) { config.Methods[0].ValidateRequest = nil }},
		{"missing response validation", func(config *Config) { config.Methods[0].ValidateResponse = nil }},
		{"missing handler", func(config *Config) { config.Methods[0].Handle = nil }},
		{"duplicate method", func(config *Config) { config.Methods = append(config.Methods, config.Methods[0]) }},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			config := valid
			config.Methods = append([]Method(nil), valid.Methods...)
			test.mutate(&config)
			if _, err := New(config); err == nil {
				t.Fatal("New succeeded")
			}
		})
	}
}

func TestDispatcherValidatesAuthorizesAndReturnsExactValidatedJSON(t *testing.T) {
	t.Parallel()

	var authorized Invocation
	config := validConfig()
	config.Authorizer = AuthorizerFunc(func(_ context.Context, invocation Invocation) error {
		authorized = invocation
		invocation.Params[0] = '['
		return nil
	})
	config.Methods[0].Handle = func(_ context.Context, invocation Invocation) (any, error) {
		if string(invocation.Params) != `{"record":"one"}` {
			t.Fatalf("handler params = %s", invocation.Params)
		}
		return map[string]any{"revision": 7, "record": "one"}, nil
	}
	dispatcher, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	result, err := dispatcher.HandleRPC(context.Background(), validRequest())
	if err != nil {
		t.Fatal(err)
	}
	body, ok := result.(json.RawMessage)
	if !ok || string(body) != `{"record":"one","revision":7}` {
		t.Fatalf("result = %T %s", result, body)
	}
	if authorized.AddonID != "example-addon" || authorized.Permission != "core.data.read" {
		t.Fatalf("authorization invocation = %+v", authorized)
	}
	if authorized.WireMeta.Actor.Role != "dm" || authorized.Authority.Actor.Role != "system" || authorized.Authority.Actor.ID != "verified-job" || authorized.Authority.CorrelationID != "verified-correlation" {
		t.Fatalf("wire and authoritative actors were not separated: %+v", authorized)
	}
	if snapshot := dispatcher.Snapshot(); snapshot.Calls != 1 || snapshot.Succeeded != 1 || snapshot.InFlight != 0 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestDispatcherFailsClosedAtEachPolicyBoundary(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		mutate     func(*Config)
		request    func() workerrpc.Request
		wantKind   string
		wantReport bool
	}{
		{
			name: "unknown method",
			request: func() workerrpc.Request {
				request := validRequest()
				request.Method = "host/unknown"
				return request
			},
			wantKind: workerrpc.KindNotFound,
		},
		{
			name: "stale generation",
			request: func() workerrpc.Request {
				request := validRequest()
				request.Meta.Generation = "old"
				return request
			},
			wantKind: workerrpc.KindUnauthorized,
		},
		{
			name: "invalid request",
			mutate: func(config *Config) {
				config.Methods[0].ValidateRequest = func(json.RawMessage) error { return errors.New("bad request") }
			},
			request:  validRequest,
			wantKind: workerrpc.KindValidationFailed,
		},
		{
			name: "unresolved request context",
			mutate: func(config *Config) {
				config.ContextResolver = ContextResolverFunc(func(context.Context, ContextRequest) (Authority, error) {
					return Authority{}, errors.New("unknown request lineage")
				})
			},
			request:  validRequest,
			wantKind: workerrpc.KindUnauthorized,
		},
		{
			name: "invalid resolved authority",
			mutate: func(config *Config) {
				config.ContextResolver = ContextResolverFunc(func(context.Context, ContextRequest) (Authority, error) {
					authority := validAuthority()
					authority.Actor.Role = "admin"
					return authority, nil
				})
			},
			request:    validRequest,
			wantKind:   workerrpc.KindInternal,
			wantReport: true,
		},
		{
			name: "expired resolved authority",
			mutate: func(config *Config) {
				config.ContextResolver = ContextResolverFunc(func(context.Context, ContextRequest) (Authority, error) {
					authority := validAuthority()
					authority.Deadline = time.Now().Add(-time.Second)
					return authority, nil
				})
			},
			request:  validRequest,
			wantKind: workerrpc.KindDeadlineExceeded,
		},
		{
			name: "unauthorized",
			mutate: func(config *Config) {
				config.Authorizer = AuthorizerFunc(func(context.Context, Invocation) error { return errors.New("private reason") })
			},
			request:  validRequest,
			wantKind: workerrpc.KindUnauthorized,
		},
		{
			name: "handler failure",
			mutate: func(config *Config) {
				config.Methods[0].Handle = func(context.Context, Invocation) (any, error) { return nil, errors.New("database secret") }
			},
			request:    validRequest,
			wantKind:   workerrpc.KindInternal,
			wantReport: true,
		},
		{
			name: "invalid response",
			mutate: func(config *Config) {
				config.Methods[0].ValidateResponse = func(json.RawMessage) error { return errors.New("bad response") }
			},
			request:    validRequest,
			wantKind:   workerrpc.KindInternal,
			wantReport: true,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			config := validConfig()
			if test.mutate != nil {
				test.mutate(&config)
			}
			reports := 0
			config.OnInternalError = func(_ Invocation, err error) {
				reports++
				if err == nil {
					t.Fatal("internal report omitted error")
				}
			}
			dispatcher, err := New(config)
			if err != nil {
				t.Fatal(err)
			}
			_, err = dispatcher.HandleRPC(context.Background(), test.request())
			assertBrokerError(t, err, test.wantKind)
			if (reports == 1) != test.wantReport {
				t.Fatalf("internal reports = %d, wantReport %v", reports, test.wantReport)
			}
			if snapshot := dispatcher.Snapshot(); snapshot.ByErrorKind[test.wantKind] != 1 || snapshot.InFlight != 0 {
				t.Fatalf("snapshot = %+v", snapshot)
			}
		})
	}
}

func TestDispatcherPreservesDeclaredApplicationFailure(t *testing.T) {
	t.Parallel()

	config := validConfig()
	config.Methods[0].Handle = func(context.Context, Invocation) (any, error) {
		return nil, workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindNotFound, "The record was not found.", false, map[string]any{"record": "one"})
	}
	dispatcher, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	_, err = dispatcher.HandleRPC(context.Background(), validRequest())
	assertBrokerError(t, err, workerrpc.KindNotFound)
}

func TestDispatcherRecoversHandlerAndDiagnosticPanics(t *testing.T) {
	t.Parallel()

	config := validConfig()
	config.Methods[0].Handle = func(context.Context, Invocation) (any, error) {
		panic("handler exploded")
	}
	config.OnInternalError = func(Invocation, error) {
		panic("diagnostic exploded")
	}
	dispatcher, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	_, err = dispatcher.HandleRPC(context.Background(), validRequest())
	assertBrokerError(t, err, workerrpc.KindInternal)
	if snapshot := dispatcher.Snapshot(); snapshot.InFlight != 0 || snapshot.ByErrorKind[workerrpc.KindInternal] != 1 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestDispatcherCancellationWinsOverPolicyResults(t *testing.T) {
	t.Parallel()

	config := validConfig()
	config.Authorizer = AuthorizerFunc(func(ctx context.Context, _ Invocation) error {
		<-ctx.Done()
		return errors.New("authorization interrupted")
	})
	dispatcher, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = dispatcher.HandleRPC(ctx, validRequest())
	assertBrokerError(t, err, workerrpc.KindCancelled)
}

func TestDispatcherAppliesAuthoritativeShorterDeadline(t *testing.T) {
	t.Parallel()

	config := validConfig()
	config.ContextResolver = ContextResolverFunc(func(context.Context, ContextRequest) (Authority, error) {
		authority := validAuthority()
		authority.Deadline = time.Now().Add(25 * time.Millisecond)
		return authority, nil
	})
	config.Methods[0].Handle = func(ctx context.Context, _ Invocation) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	dispatcher, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	_, err = dispatcher.HandleRPC(context.Background(), validRequest())
	assertBrokerError(t, err, workerrpc.KindDeadlineExceeded)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("authoritative deadline took %s", elapsed)
	}
}

func TestDispatcherRunsBehindBidirectionalPeer(t *testing.T) {
	t.Parallel()

	dispatcher, err := New(validConfig())
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
		IDPrefix:            "host",
		Generation:          "generation-42",
		MaxOutgoingRequests: 2,
		MaxIncomingRequests: 2,
		RequireIncomingMeta: true,
		Handler:             dispatcher,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workerrpc.NewPeer(workerCodec, workerrpc.PeerConfig{
		IDPrefix:            "worker",
		Generation:          "generation-42",
		MaxOutgoingRequests: 2,
		MaxIncomingRequests: 2,
		RequireIncomingMeta: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.Start(); err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}

	request := validRequest()
	body, err := worker.Call(context.Background(), request.Method, json.RawMessage(request.Params), request.Meta)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"record":"one","revision":1}` {
		t.Fatalf("peer result = %s", body)
	}
	if snapshot := dispatcher.Snapshot(); snapshot.Calls != 1 || snapshot.Succeeded != 1 {
		t.Fatalf("dispatcher snapshot = %+v", snapshot)
	}
}

func validConfig() Config {
	validateRequest := func(body json.RawMessage) error {
		if !json.Valid(body) || !strings.Contains(string(body), `"record"`) {
			return errors.New("record is required")
		}
		return nil
	}
	validateResponse := func(body json.RawMessage) error {
		if !json.Valid(body) || !strings.Contains(string(body), `"revision"`) {
			return errors.New("revision is required")
		}
		return nil
	}
	return Config{
		AddonID:    "example-addon",
		Generation: "generation-42",
		ContextResolver: ContextResolverFunc(func(context.Context, ContextRequest) (Authority, error) {
			return validAuthority(), nil
		}),
		Authorizer: AuthorizerFunc(func(context.Context, Invocation) error { return nil }),
		Methods: []Method{
			{
				Name:             "host/data.get",
				Permission:       "core.data.read",
				ValidateRequest:  validateRequest,
				ValidateResponse: validateResponse,
				Handle: func(context.Context, Invocation) (any, error) {
					return map[string]any{"record": "one", "revision": 1}, nil
				},
			},
		},
	}
}

func validAuthority() Authority {
	return Authority{
		RequestID:     "verified-request",
		CorrelationID: "verified-correlation",
		Deadline:      time.Now().Add(2 * time.Second),
		Actor:         workerrpc.Actor{Role: "system", ID: "verified-job"},
	}
}

func validRequest() workerrpc.Request {
	return workerrpc.Request{
		ID:     json.RawMessage(`"worker-1"`),
		Method: "host/data.get",
		Params: json.RawMessage(`{"record":"one"}`),
		Meta: &workerrpc.Meta{
			RequestID:     "request-1",
			CorrelationID: "correlation-1",
			Generation:    "generation-42",
			Deadline:      time.Now().Add(time.Second),
			Actor:         &workerrpc.Actor{Role: "dm", ID: "dm-1"},
		},
	}
}

func assertBrokerError(t *testing.T, err error, wantKind string) {
	t.Helper()
	var failure *workerrpc.RPCError
	if !errors.As(err, &failure) || failure.Data == nil {
		t.Fatalf("error = %T %v, want RPCError %s", err, err, wantKind)
	}
	if failure.Data.Kind != wantKind {
		t.Fatalf("kind = %s, want %s: %v", failure.Data.Kind, wantKind, err)
	}
}
