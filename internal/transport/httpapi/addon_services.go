package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packagemanager"
	"github.com/pjunak/ttrpg-codex/internal/addons/requestcontext"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	sessionauth "github.com/pjunak/ttrpg-codex/internal/auth"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const (
	browserServiceConnectVersion          = "addon-service-connect.v1"
	browserServiceConnectionVersion       = "addon-service-connection.v1"
	browserServiceCallVersion             = "addon-service-call.v1"
	browserServiceResultVersion           = "addon-service-result.v1"
	maximumBrowserServiceBody       int64 = 2<<20 + 128<<10
)

type BrowserServices interface {
	ConnectBrowserService(
		context.Context, string, string, packagemanager.BrowserServiceRequest,
	) (packagemanager.BrowserServiceConnection, error)
	CallBrowserService(
		context.Context, string, string, packagemanager.BrowserServiceTarget,
		servicebroker.MethodCall,
	) (json.RawMessage, error)
}

type BrowserServiceAuthorizer func(*http.Request) (workerrpc.Actor, error)

var _ BrowserServices = (*packagemanager.Manager)(nil)

func SessionBrowserServiceAuthorizer(service *sessionauth.Service) BrowserServiceAuthorizer {
	return func(r *http.Request) (workerrpc.Actor, error) {
		actor, ok := sessionauth.ActorFromContext(r.Context())
		if !ok || service == nil ||
			!service.ValidateCSRF(sessionToken(r), r.Header.Get(csrfHeaderName)) {
			return workerrpc.Actor{}, errAuthorizationRequired
		}
		return workerrpc.Actor{Role: string(actor.Role), ID: actor.SessionID}, nil
	}
}

func (s *server) registerBrowserServiceRoutes(mux *http.ServeMux) {
	base := "/api/addons/{addonID}/generations/{generationID}/services/"
	mux.Handle("POST "+base+"connect", s.requireBrowserService(http.HandlerFunc(s.browserServiceConnect)))
	mux.Handle("POST "+base+"call", s.requireBrowserService(http.HandlerFunc(s.browserServiceCall)))
}

type browserServiceAuthorityKey struct{}

func (s *server) requireBrowserService(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor, err := s.browserServiceAuthorizer(r)
		if err != nil {
			s.logger.Warn("browser add-on service access denied", "method", r.Method, "path", r.URL.Path)
			writeAPIError(w, http.StatusForbidden, "FORBIDDEN", "browser add-on service authorization is required")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), browserServiceAuthorityKey{}, actor)))
	})
}

func (s *server) browserServiceConnect(w http.ResponseWriter, r *http.Request) {
	addonID, generationID, ok := browserServiceIdentity(w, r)
	if !ok {
		return
	}
	var request struct {
		ContractVersion string `json:"contractVersion"`
		Contract        string `json:"contract"`
		Range           string `json:"range"`
		Cardinality     string `json:"cardinality"`
		IncludeOwn      bool   `json:"includeOwn,omitempty"`
	}
	if !decodeBoundedJSON(w, r, &request, 16<<10, "browser service connect") {
		return
	}
	if request.ContractVersion != browserServiceConnectVersion || request.Contract == "" ||
		request.Range == "" || request.Cardinality != "one" && request.Cardinality != "many" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "browser service connection is invalid")
		return
	}
	connection, err := s.browserServices.ConnectBrowserService(
		r.Context(), addonID, generationID,
		packagemanager.BrowserServiceRequest{
			Contract: request.Contract, Range: request.Range, Cardinality: request.Cardinality,
			IncludeOwn: request.IncludeOwn,
		},
	)
	if err != nil {
		s.writeBrowserServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"contractVersion": browserServiceConnectionVersion,
		"contract":        connection.Contract, "range": connection.Range,
		"cardinality": connection.Cardinality, "providers": connection.Providers,
	})
}

func (s *server) browserServiceCall(w http.ResponseWriter, r *http.Request) {
	addonID, generationID, ok := browserServiceIdentity(w, r)
	if !ok {
		return
	}
	var request struct {
		ContractVersion    string          `json:"contractVersion"`
		Contract           string          `json:"contract"`
		ProviderAddonID    string          `json:"providerAddonId"`
		ProviderVersion    string          `json:"providerVersion"`
		ProviderGeneration string          `json:"providerGeneration"`
		BindingRevision    int64           `json:"bindingRevision"`
		Method             string          `json:"method"`
		Params             json.RawMessage `json:"params"`
		DeadlineMS         int             `json:"deadlineMs"`
		IdempotencyKey     string          `json:"idempotencyKey,omitempty"`
	}
	if !decodeBoundedJSON(w, r, &request, maximumBrowserServiceBody, "browser service call") {
		return
	}
	if request.ContractVersion != browserServiceCallVersion || request.Contract == "" ||
		request.ProviderAddonID == "" || request.ProviderVersion == "" ||
		!validAddonGeneration(request.ProviderGeneration) || request.BindingRevision < 0 ||
		request.Method == "" || request.DeadlineMS < 1 || request.DeadlineMS > 30_000 ||
		!objectOrArrayJSON(request.Params) || len(request.IdempotencyKey) > 200 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "browser service call is invalid")
		return
	}
	actor, _ := r.Context().Value(browserServiceAuthorityKey{}).(workerrpc.Actor)
	result, err := s.browserServices.CallBrowserService(
		r.Context(), addonID, generationID,
		packagemanager.BrowserServiceTarget{
			Contract: request.Contract, ProviderAddonID: request.ProviderAddonID,
			ContractVersion: request.ProviderVersion, Generation: request.ProviderGeneration,
			BindingRevision: request.BindingRevision,
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
		"contractVersion":    browserServiceResultVersion,
		"providerAddonId":    request.ProviderAddonID,
		"providerGeneration": request.ProviderGeneration,
		"result":             json.RawMessage(append([]byte(nil), result...)),
	})
}

func browserServiceIdentity(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	if r.URL.RawQuery != "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "query parameters are not supported")
		return "", "", false
	}
	addonID, ok := pathResourceID(w, r, "addonID")
	if !ok {
		return "", "", false
	}
	generationID, ok := pathResourceID(w, r, "generationID")
	if !ok || !validAddonGeneration(generationID) {
		if ok {
			writeAPIError(w, http.StatusBadRequest, "INVALID_REQUEST", "generationID is invalid")
		}
		return "", "", false
	}
	return addonID, generationID, true
}

func objectOrArrayJSON(value json.RawMessage) bool {
	for _, character := range value {
		if character == ' ' || character == '\n' || character == '\r' || character == '\t' {
			continue
		}
		return character == '{' || character == '['
	}
	return false
}

func (s *server) writeBrowserServiceError(w http.ResponseWriter, r *http.Request, err error) {
	status, kind, message := http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "the add-on service is unavailable"
	var workerError *workerrpc.RPCError
	switch {
	case errors.Is(err, packagemanager.ErrNotActive):
		status, kind, message = http.StatusConflict, "STALE_GENERATION", "the add-on generation is no longer active"
	case errors.Is(err, servicebroker.ErrStaleBinding):
		status, kind, message = http.StatusConflict, "STALE_BINDING", "the add-on service binding is stale"
	case errors.Is(err, servicebroker.ErrMethodNotFound):
		status, kind, message = http.StatusNotFound, "METHOD_NOT_FOUND", "the add-on service method does not exist"
	case errors.Is(err, packagemanager.ErrServiceResolution),
		errors.Is(err, servicebroker.ErrInvalidDeclaration),
		errors.Is(err, servicebroker.ErrInvalidCall),
		errors.Is(err, servicebroker.ErrCallDeadline),
		errors.Is(err, requestcontext.ErrInvalidContext):
		status, kind, message = http.StatusBadRequest, "INVALID_REQUEST", "the add-on service request is invalid"
	case errors.Is(err, servicebroker.ErrServiceUnavailable),
		errors.Is(err, servicebroker.ErrRuntimeUnavailable),
		errors.Is(err, servicebroker.ErrProviderNotFound),
		errors.Is(err, servicebroker.ErrAmbiguousProvider),
		errors.Is(err, servicebroker.ErrInvalidSelection):
		// Stable unavailable response above.
	case errors.As(err, &workerError):
		status, kind, message = http.StatusInternalServerError, "INTERNAL", "the add-on service request failed"
		if workerError.Data != nil {
			switch workerError.Data.Kind {
			case workerrpc.KindConflict:
				status, kind, message = http.StatusConflict, "CONFLICT", "the data changed; review a new preview before committing"
			case workerrpc.KindStaleBinding:
				status, kind, message = http.StatusConflict, "STALE_BINDING", "the add-on service binding is stale"
			case workerrpc.KindNotFound:
				status, kind, message = http.StatusNotFound, "NOT_FOUND", "the requested service resource is missing or expired"
			case workerrpc.KindUnauthorized:
				status, kind, message = http.StatusForbidden, "FORBIDDEN", "the service operation is not allowed for this user"
			case workerrpc.KindInvalidRequest, workerrpc.KindValidationFailed:
				status, kind, message = http.StatusBadRequest, "INVALID_REQUEST", "the service input failed validation"
			case workerrpc.KindRateLimited:
				status, kind, message = http.StatusTooManyRequests, "RATE_LIMITED", "the service request limit was reached"
			case workerrpc.KindCancelled:
				status, kind, message = http.StatusRequestTimeout, "CANCELLED", "the service request was cancelled"
			case workerrpc.KindDeadlineExceeded:
				status, kind, message = http.StatusGatewayTimeout, "DEADLINE_EXCEEDED", "the service request timed out"
			case workerrpc.KindUnavailable:
				status, kind, message = http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "the add-on service is unavailable"
			}
		}
	default:
		status, kind, message = http.StatusInternalServerError, "INTERNAL", "the add-on service request failed"
	}
	s.logger.Error("browser add-on service request failed", "method", r.Method, "path", r.URL.Path, "kind", kind, "error", err)
	writeAPIError(w, status, kind, message)
}
