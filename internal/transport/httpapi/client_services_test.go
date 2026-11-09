package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

func TestClientServiceRoutesActAsTheSignedInPlayer(t *testing.T) {
	t.Parallel()
	authentication := testAuthService(t)
	generation := strings.Repeat("b", 64)
	services := &recordingClientServices{
		connection: packagemanager.ClientServiceConnection{Contract: "dnd5e.character", Range: "^4.0.0",
			Providers: []packagemanager.ClientServiceProvider{{AddonID: "dnd-sheets", ContractVersion: "4.0.0", Generation: generation}}},
		result: json.RawMessage(`{"character":{"name":"Kael"}}`),
	}
	handler, err := New(Config{
		Version: "test", Logger: slog.New(slog.DiscardHandler), Authentication: authentication,
		BrowserServices: &recordingBrowserServices{}, BrowserServiceAuthorizer: SessionBrowserServiceAuthorizer(authentication),
		ClientServices: services,
	})
	if err != nil {
		t.Fatal(err)
	}
	login := serveAuthRequest(handler, http.MethodPost, "/api/login", `{"password":"party-member"}`, "", "")
	cookie := login.Result().Cookies()[0].String()
	csrf := jsonStringField(t, login.Body.Bytes(), "csrfToken")
	connect := `{"contractVersion":"client-service-connect.v1","contract":"dnd5e.character","range":"^4.0.0"}`
	call := `{"contractVersion":"client-service-call.v1","contract":"dnd5e.character","providerAddonId":"dnd-sheets",` +
		`"providerVersion":"4.0.0","providerGeneration":"` + generation + `","method":"load","params":{"key":"kael"},"deadlineMs":5000}`

	for name, response := range map[string]int{
		"anonymous":    serveAuthRequest(handler, http.MethodPost, "/api/services/connect", connect, "", "").Code,
		"without CSRF": serveAuthRequest(handler, http.MethodPost, "/api/services/call", call, cookie, "").Code,
	} {
		if response != http.StatusForbidden {
			t.Errorf("%s = %d", name, response)
		}
	}
	if services.connectCalls+services.callCalls != 0 {
		t.Fatalf("unauthorized requests reached services: %+v", services)
	}

	response := serveAuthRequest(handler, http.MethodPost, "/api/services/connect", connect, cookie, csrf)
	if response.Code != http.StatusOK || services.contract != "dnd5e.character" || services.versionRange != "^4.0.0" ||
		!strings.Contains(response.Body.String(), `"contractVersion":"client-service-connection.v1"`) ||
		!strings.Contains(response.Body.String(), `"providers":[{"addonId":"dnd-sheets","contractVersion":"4.0.0","generation":"`+generation+`"}]`) {
		t.Fatalf("connect = %d, %s", response.Code, response.Body.String())
	}
	response = serveAuthRequest(handler, http.MethodPost, "/api/services/call", call, cookie, csrf)
	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"result":{"character":{"name":"Kael"}}`) ||
		!strings.Contains(response.Body.String(), `"contractVersion":"client-service-result.v1"`) {
		t.Fatalf("call = %d, %s", response.Code, response.Body.String())
	}
	if services.target != (packagemanager.ClientServiceTarget{Contract: "dnd5e.character", ProviderAddonID: "dnd-sheets",
		ContractVersion: "4.0.0", Generation: generation}) || services.call.Method != "load" ||
		services.call.Context.Actor.Role != "player" || services.call.Context.Actor.ID == "" {
		t.Fatalf("call reached services as %+v %+v", services.target, services.call)
	}

	for name, body := range map[string]string{
		"old contract version": strings.Replace(connect, "client-service-connect.v1", "addon-service-connect.v1", 1),
		"missing range":        strings.Replace(connect, `"^4.0.0"`, `""`, 1),
	} {
		if response := serveAuthRequest(handler, http.MethodPost, "/api/services/connect", body, cookie, csrf); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d", name, response.Code)
		}
	}
	if response := serveAuthRequest(handler, http.MethodPost, "/api/services/call", strings.Replace(call, `"deadlineMs":5000`, `"deadlineMs":60000`, 1), cookie, csrf); response.Code != http.StatusBadRequest {
		t.Errorf("long deadline = %d", response.Code)
	}
	if response := serveAuthRequest(handler, http.MethodPost, "/api/services/connect?x=1", connect, cookie, csrf); response.Code != http.StatusBadRequest {
		t.Errorf("query = %d", response.Code)
	}

	for want, failure := range map[string]error{
		`"kind":"STALE_BINDING"`: servicebroker.ErrStaleBinding,
		`"kind":"FORBIDDEN"`:     workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnauthorized, "DM only", false, nil),
	} {
		services.callError = failure
		response := serveAuthRequest(handler, http.MethodPost, "/api/services/call", call, cookie, csrf)
		if !strings.Contains(response.Body.String(), want) {
			t.Errorf("%v = %d, %s", failure, response.Code, response.Body.String())
		}
	}
}

func TestClientServicesNeedTheSessionAuthorizer(t *testing.T) {
	t.Parallel()
	_, err := New(Config{Version: "test", Logger: slog.New(slog.DiscardHandler), ClientServices: &recordingClientServices{}})
	if !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("config without authorizer = %v", err)
	}
}

type recordingClientServices struct {
	connection   packagemanager.ClientServiceConnection
	connectCalls int
	contract     string
	versionRange string
	result       json.RawMessage
	callError    error
	callCalls    int
	target       packagemanager.ClientServiceTarget
	call         servicebroker.MethodCall
}

func (services *recordingClientServices) ConnectClientService(
	_ context.Context, contract string, versionRange string,
) (packagemanager.ClientServiceConnection, error) {
	services.connectCalls++
	services.contract, services.versionRange = contract, versionRange
	return services.connection, nil
}

func (services *recordingClientServices) CallClientService(
	_ context.Context, target packagemanager.ClientServiceTarget, call servicebroker.MethodCall,
) (json.RawMessage, error) {
	services.callCalls++
	services.target, services.call = target, call
	return services.result, services.callError
}

var _ ClientServices = (*recordingClientServices)(nil)
