package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestBrowserServiceConnectAndCallPreserveHostAuthority(t *testing.T) {
	t.Parallel()
	generation := strings.Repeat("a", 64)
	providerGeneration := strings.Repeat("b", 64)
	source := &recordingBrowserServices{connection: packagemanager.BrowserServiceConnection{
		Contract: "dnd5e.rules-engine", Range: "^3.0.0", Cardinality: "one",
		Providers: []packagemanager.BrowserServiceProvider{{
			AddonID: "rules-engine", ContractVersion: "3.1.0",
			Generation: providerGeneration, BindingRevision: 0,
		}},
	}, result: json.RawMessage(`{"sheet":{"level":3}}`)}
	handler := newBrowserServiceHandler(t, source, func(*http.Request) (workerrpc.Actor, error) {
		return workerrpc.Actor{Role: "player", ID: "session-7"}, nil
	})

	connect := serveBrowserServiceRequest(handler,
		"/api/addons/dnd-sheets/generations/"+generation+"/services/connect",
		`{"contractVersion":"addon-service-connect.v1","contract":"dnd5e.rules-engine","range":"^3.0.0","cardinality":"one","includeOwn":true}`,
	)
	if connect.Code != http.StatusOK || !strings.Contains(connect.Body.String(), providerGeneration) {
		t.Fatalf("connect response = %d, %s", connect.Code, connect.Body.String())
	}
	if source.connectAddonID != "dnd-sheets" || source.connectGeneration != generation ||
		source.connectRequest.Range != "^3.0.0" || !source.connectRequest.IncludeOwn {
		t.Fatalf("connect request = %q, %q, %+v", source.connectAddonID, source.connectGeneration, source.connectRequest)
	}

	call := serveBrowserServiceRequest(handler,
		"/api/addons/dnd-sheets/generations/"+generation+"/services/call",
		`{"contractVersion":"addon-service-call.v1","contract":"dnd5e.rules-engine",`+
			`"providerAddonId":"rules-engine","providerVersion":"3.1.0",`+
			`"providerGeneration":"`+providerGeneration+`","bindingRevision":0,`+
			`"method":"hydrate","params":{"characterId":"c1"},"deadlineMs":2000}`,
	)
	if call.Code != http.StatusOK || !strings.Contains(call.Body.String(), `"level":3`) {
		t.Fatalf("call response = %d, %s", call.Code, call.Body.String())
	}
	if source.callTarget.ProviderAddonID != "rules-engine" || source.call.Method != "hydrate" ||
		source.call.Context.Actor.Role != "player" || source.call.Context.Actor.ID != "session-7" ||
		string(source.call.Params.(json.RawMessage)) != `{"characterId":"c1"}` {
		t.Fatalf("routed call = target %+v, call %+v", source.callTarget, source.call)
	}
}

func TestBrowserServiceBoundaryRejectsUnauthorizedMalformedAndStaleCalls(t *testing.T) {
	t.Parallel()
	generation := strings.Repeat("a", 64)
	path := "/api/addons/dnd-sheets/generations/" + generation + "/services/connect"
	source := &recordingBrowserServices{}
	denied := newBrowserServiceHandler(t, source, func(*http.Request) (workerrpc.Actor, error) {
		return workerrpc.Actor{}, errors.New("private session")
	})
	response := serveBrowserServiceRequest(denied, path, `{broken`)
	if response.Code != http.StatusForbidden || source.connectCalls != 0 ||
		strings.Contains(response.Body.String(), "private") {
		t.Fatalf("denied response = %d, %s, calls %d", response.Code, response.Body.String(), source.connectCalls)
	}

	allowed := newBrowserServiceHandler(t, source, func(*http.Request) (workerrpc.Actor, error) {
		return workerrpc.Actor{Role: "dm", ID: "session-1"}, nil
	})
	malformed := serveBrowserServiceRequest(allowed, path,
		`{"contractVersion":"addon-service-connect.v1","contract":"dnd5e.rules-engine","range":"*","cardinality":"some"}`,
	)
	if malformed.Code != http.StatusBadRequest || source.connectCalls != 0 {
		t.Fatalf("malformed response/calls = %d, %d", malformed.Code, source.connectCalls)
	}

	source.connectError = servicebroker.ErrStaleBinding
	stale := serveBrowserServiceRequest(allowed, path,
		`{"contractVersion":"addon-service-connect.v1","contract":"dnd5e.rules-engine","range":"^3.0.0","cardinality":"one"}`,
	)
	if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), "STALE_BINDING") ||
		strings.Contains(stale.Body.String(), "private") {
		t.Fatalf("stale response = %d, %s", stale.Code, stale.Body.String())
	}
}

func TestBrowserServiceKeepsWorkerErrorKindsWithoutPrivateDetails(t *testing.T) {
	t.Parallel()
	for _, check := range []struct {
		kind   string
		status int
		code   string
	}{
		{workerrpc.KindConflict, 409, "CONFLICT"}, {workerrpc.KindNotFound, 404, "NOT_FOUND"},
		{workerrpc.KindUnauthorized, 403, "FORBIDDEN"}, {workerrpc.KindValidationFailed, 400, "INVALID_REQUEST"},
		{workerrpc.KindUnavailable, 503, "SERVICE_UNAVAILABLE"}, {workerrpc.KindDeadlineExceeded, 504, "DEADLINE_EXCEEDED"},
		{workerrpc.KindCancelled, 408, "CANCELLED"}, {workerrpc.KindRateLimited, 429, "RATE_LIMITED"},
		{workerrpc.KindStaleBinding, 409, "STALE_BINDING"}, {workerrpc.KindInternal, 500, "INTERNAL"},
	} {
		t.Run(check.kind, func(t *testing.T) {
			source := &recordingBrowserServices{callError: workerrpc.NewRPCError(workerrpc.JSONRPCApplication, check.kind, "private worker details", false, map[string]any{"private": "hidden"})}
			handler := newBrowserServiceHandler(t, source, func(*http.Request) (workerrpc.Actor, error) { return workerrpc.Actor{Role: "dm", ID: "fixture"}, nil })
			generation := strings.Repeat("a", 64)
			response := serveBrowserServiceRequest(handler, "/api/addons/dm-tools/generations/"+generation+"/services/call",
				`{"contractVersion":"addon-service-call.v1","contract":"codex.import-adapter","providerAddonId":"dm-tools","providerVersion":"2.0.0","providerGeneration":"`+generation+`","bindingRevision":0,"method":"commit","params":{},"deadlineMs":2000}`)
			if response.Code != check.status || !strings.Contains(response.Body.String(), check.code) || strings.Contains(response.Body.String(), "private") {
				t.Fatalf("response = %d, %s", response.Code, response.Body.String())
			}
		})
	}
}

func newBrowserServiceHandler(
	t *testing.T,
	source BrowserServices,
	authorize BrowserServiceAuthorizer,
) http.Handler {
	t.Helper()
	handler, err := New(Config{
		Version: "test-version", Logger: slog.New(slog.DiscardHandler),
		BrowserServices: source, BrowserServiceAuthorizer: authorize,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func serveBrowserServiceRequest(handler http.Handler, path string, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

type recordingBrowserServices struct {
	connection        packagemanager.BrowserServiceConnection
	connectError      error
	connectCalls      int
	connectAddonID    string
	connectGeneration string
	connectRequest    packagemanager.BrowserServiceRequest
	result            json.RawMessage
	callError         error
	callTarget        packagemanager.BrowserServiceTarget
	call              servicebroker.MethodCall
}

func (source *recordingBrowserServices) ConnectBrowserService(
	_ context.Context,
	addonID string,
	generation string,
	request packagemanager.BrowserServiceRequest,
) (packagemanager.BrowserServiceConnection, error) {
	source.connectCalls++
	source.connectAddonID = addonID
	source.connectGeneration = generation
	source.connectRequest = request
	return source.connection, source.connectError
}

func (source *recordingBrowserServices) CallBrowserService(
	_ context.Context,
	_ string,
	_ string,
	target packagemanager.BrowserServiceTarget,
	call servicebroker.MethodCall,
) (json.RawMessage, error) {
	source.callTarget = target
	source.call = call
	return source.result, source.callError
}

var _ BrowserServices = (*recordingBrowserServices)(nil)
