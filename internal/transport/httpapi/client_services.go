package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const (
	clientServiceConnectVersion    = "client-service-connect.v1"
	clientServiceConnectionVersion = "client-service-connection.v1"
	clientServiceCallVersion       = "client-service-call.v1"
	clientServiceResultVersion     = "client-service-result.v1"
)

// ClientServices reaches add-on services by contract for a signed-in client
// that is not an add-on. See docs/reference/CLIENT_API.md.
type ClientServices interface {
	ConnectClientService(context.Context, string, string) (packagemanager.ClientServiceConnection, error)
	CallClientService(
		context.Context, packagemanager.ClientServiceTarget, servicebroker.MethodCall,
	) (json.RawMessage, error)
}

var _ ClientServices = (*packagemanager.Manager)(nil)

// Both routes need a session and its CSRF token, like the add-on service
// routes; the session becomes the call's actor.
func (s *server) registerClientServiceRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/services/connect", s.requireBrowserService(http.HandlerFunc(s.clientServiceConnect)))
	mux.Handle("POST /api/services/call", s.requireBrowserService(http.HandlerFunc(s.clientServiceCall)))
}

func (s *server) clientServiceConnect(w http.ResponseWriter, r *http.Request) {
	if !noQuery(w, r) {
		return
	}
	var request struct {
		ContractVersion string `json:"contractVersion"`
		Contract        string `json:"contract"`
		Range           string `json:"range"`
	}
	if !decodeBoundedJSON(w, r, &request, 16<<10, "client service connect") {
		return
	}
	if request.ContractVersion != clientServiceConnectVersion || request.Contract == "" || request.Range == "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "client service connection is invalid")
		return
	}
	connection, err := s.clientServices.ConnectClientService(r.Context(), request.Contract, request.Range)
	if err != nil {
		s.writeBrowserServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contractVersion": clientServiceConnectionVersion,
		"contract":        connection.Contract, "range": connection.Range, "providers": connection.Providers,
	})
}

func (s *server) clientServiceCall(w http.ResponseWriter, r *http.Request) {
	if !noQuery(w, r) {
		return
	}
	var request struct {
		ContractVersion    string          `json:"contractVersion"`
		Contract           string          `json:"contract"`
		ProviderAddonID    string          `json:"providerAddonId"`
		ProviderVersion    string          `json:"providerVersion"`
		ProviderGeneration string          `json:"providerGeneration"`
		Method             string          `json:"method"`
		Params             json.RawMessage `json:"params"`
		DeadlineMS         int             `json:"deadlineMs"`
		IdempotencyKey     string          `json:"idempotencyKey,omitempty"`
	}
	if !decodeBoundedJSON(w, r, &request, maximumBrowserServiceBody, "client service call") {
		return
	}
	if request.ContractVersion != clientServiceCallVersion || request.Contract == "" ||
		request.ProviderAddonID == "" || request.ProviderVersion == "" ||
		!validAddonGeneration(request.ProviderGeneration) ||
		request.Method == "" || request.DeadlineMS < 1 || request.DeadlineMS > 30_000 ||
		!objectOrArrayJSON(request.Params) || len(request.IdempotencyKey) > 200 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "client service call is invalid")
		return
	}
	actor, _ := r.Context().Value(browserServiceAuthorityKey{}).(workerrpc.Actor)
	result, err := s.clientServices.CallClientService(
		r.Context(),
		packagemanager.ClientServiceTarget{
			Contract: request.Contract, ProviderAddonID: request.ProviderAddonID,
			ContractVersion: request.ProviderVersion, Generation: request.ProviderGeneration,
		},
		servicebroker.MethodCall{
			Method: request.Method, Params: request.Params,
			Context: servicebroker.CallContext{
				Deadline: time.Now().UTC().Add(time.Duration(request.DeadlineMS) * time.Millisecond),
				Actor:    actor, IdempotencyKey: request.IdempotencyKey,
			},
		},
	)
	if err != nil {
		s.writeBrowserServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contractVersion":    clientServiceResultVersion,
		"providerAddonId":    request.ProviderAddonID,
		"providerGeneration": request.ProviderGeneration,
		"result":             json.RawMessage(append([]byte(nil), result...)),
	})
}

func noQuery(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return false
	}
	return true
}
