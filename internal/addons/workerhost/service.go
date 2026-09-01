package workerhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	semver "github.com/Masterminds/semver/v3"
	"github.com/pjunak/ttrpg-codex/internal/addons/servicebroker"
	"github.com/pjunak/ttrpg-codex/internal/addons/workerbroker"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const (
	serviceCallVersion   = "host-service-call.v1"
	serviceResultVersion = "host-service-result.v1"
)

var (
	serviceContractPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$`)
	serviceMethodPattern   = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`)
	errServiceNotBound     = errors.New("worker has no matching bound service")
	errServiceAmbiguous    = errors.New("worker service selection is ambiguous")
)

// ServiceCaller is the narrow broker boundary needed by a native add-on
// worker. Package-manager-issued handles remain the sole routing authority.
type ServiceCaller interface {
	Call(context.Context, servicebroker.Handle, servicebroker.MethodCall) (json.RawMessage, error)
}

type boundServices struct {
	handles []servicebroker.Handle
}

type serviceCallRequest struct {
	ContractVersion string          `json:"contractVersion"`
	Contract        string          `json:"contract"`
	ProviderAddonID string          `json:"providerAddonId,omitempty"`
	Method          string          `json:"method"`
	Params          json.RawMessage `json:"params"`
	IdempotencyKey  string          `json:"idempotencyKey,omitempty"`
}

type serviceCallResponse struct {
	ContractVersion         string          `json:"contractVersion"`
	Contract                string          `json:"contract"`
	ProviderAddonID         string          `json:"providerAddonId"`
	ProviderContractVersion string          `json:"providerContractVersion"`
	ProviderGeneration      string          `json:"providerGeneration"`
	Result                  json.RawMessage `json:"result"`
}

func compileBoundServices(addonID string, handles []servicebroker.Handle) (boundServices, error) {
	compiled := boundServices{handles: make([]servicebroker.Handle, 0, len(handles))}
	for _, handle := range handles {
		_, versionErr := semver.StrictNewVersion(handle.ContractVersion)
		if handle.ConsumerAddonID != addonID || !validServiceContract(handle.Contract) ||
			!validAddonID(handle.ProviderAddonID) || versionErr != nil ||
			!validGeneration(handle.Generation) || handle.BindingRevision < 0 ||
			(handle.Transport != servicebroker.TransportUI &&
				handle.Transport != servicebroker.TransportWorker &&
				handle.Transport != servicebroker.TransportContent) {
			return boundServices{}, errors.New("worker host service binding configuration is invalid")
		}
		compiled.handles = append(compiled.handles, handle)
	}
	return compiled, nil
}

func (services boundServices) selectHandle(contract, providerAddonID string) (servicebroker.Handle, error) {
	var selected servicebroker.Handle
	matches := 0
	for _, handle := range services.handles {
		if handle.Contract != contract || providerAddonID != "" && handle.ProviderAddonID != providerAddonID {
			continue
		}
		selected = handle
		matches++
	}
	switch matches {
	case 0:
		return servicebroker.Handle{}, errServiceNotBound
	case 1:
		return selected, nil
	default:
		return servicebroker.Handle{}, errServiceAmbiguous
	}
}

func serviceCallMethod(services ServiceCaller, bindings boundServices) workerbroker.Method {
	return workerbroker.Method{
		Name: "host/service.call", Permission: "addon.services",
		ValidateRequest: func(body json.RawMessage) error {
			request, err := decodeExact[serviceCallRequest](body)
			if err != nil || !validServiceRequest(request) {
				return errors.New("invalid host/service.call request")
			}
			return nil
		},
		ValidateResponse: validateServiceResponse,
		Handle: func(ctx context.Context, invocation workerbroker.Invocation) (any, error) {
			request, err := decodeExact[serviceCallRequest](invocation.Params)
			if err != nil {
				return nil, err
			}
			handle, err := bindings.selectHandle(request.Contract, request.ProviderAddonID)
			if err != nil {
				return nil, serviceCallError(err)
			}
			result, err := services.Call(ctx, handle, servicebroker.MethodCall{
				Method: request.Method,
				Params: append(json.RawMessage(nil), request.Params...),
				Context: servicebroker.CallContext{
					CorrelationID: invocation.Authority.CorrelationID,
					Deadline:      invocation.Authority.Deadline,
					Actor: workerrpc.Actor{
						Role: invocation.Authority.Actor.Role,
						ID:   invocation.Authority.Actor.ID,
					},
					IdempotencyKey: request.IdempotencyKey,
					Traceparent:    invocation.Authority.Traceparent,
				},
			})
			if err != nil {
				return nil, serviceCallError(err)
			}
			return serviceCallResponse{
				ContractVersion: serviceResultVersion,
				Contract:        request.Contract, ProviderAddonID: handle.ProviderAddonID,
				ProviderContractVersion: handle.ContractVersion,
				ProviderGeneration:      handle.Generation,
				Result:                  append(json.RawMessage(nil), result...),
			}, nil
		},
	}
}

func validServiceRequest(request serviceCallRequest) bool {
	return request.ContractVersion == serviceCallVersion &&
		validServiceContract(request.Contract) &&
		(request.ProviderAddonID == "" || validAddonID(request.ProviderAddonID)) &&
		len(request.Method) <= 100 && serviceMethodPattern.MatchString(request.Method) &&
		validServicePayload(request.Params) && validServiceIdentifier(request.IdempotencyKey, 200)
}

func validateServiceResponse(body json.RawMessage) error {
	response, err := decodeExact[serviceCallResponse](body)
	if err != nil || response.ContractVersion != serviceResultVersion ||
		!validServiceContract(response.Contract) || !validAddonID(response.ProviderAddonID) ||
		!validGeneration(response.ProviderGeneration) || !validServicePayload(response.Result) {
		return errors.New("invalid host/service.call response")
	}
	if _, err := semver.StrictNewVersion(response.ProviderContractVersion); err != nil {
		return errors.New("invalid host/service.call provider version")
	}
	return nil
}

func validServiceContract(value string) bool {
	return len(value) <= 120 && serviceContractPattern.MatchString(value)
}

func validServicePayload(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) > 1 && json.Valid(trimmed) &&
		((trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}') ||
			(trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']'))
}

func validServiceIdentifier(value string, maximum int) bool {
	if len(value) > maximum || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func serviceCallError(err error) error {
	var failure *workerrpc.RPCError
	if errors.As(err, &failure) {
		return failure
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, servicebroker.ErrCallDeadline):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindDeadlineExceeded,
			"The bound service call deadline was exceeded.", true, nil)
	case errors.Is(err, context.Canceled):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindCancelled,
			"The bound service call was cancelled.", false, nil)
	case errors.Is(err, servicebroker.ErrStaleBinding):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindStaleBinding,
			"The bound service changed; refresh the worker generation before retrying.", true, nil)
	case errors.Is(err, servicebroker.ErrMethodNotFound):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindNotFound,
			"The bound service method was not found.", false, nil)
	case errors.Is(err, servicebroker.ErrInvalidCall), errors.Is(err, servicebroker.ErrInvalidDeclaration):
		return workerrpc.NewRPCError(workerrpc.JSONRPCInvalidParams, workerrpc.KindValidationFailed,
			"The bound service request did not match its contract.", false, nil)
	case errors.Is(err, errServiceNotBound), errors.Is(err, errServiceAmbiguous):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnauthorized,
			"The worker is not bound to exactly one matching service.", false, nil)
	case errors.Is(err, servicebroker.ErrProviderNotFound),
		errors.Is(err, servicebroker.ErrServiceUnavailable),
		errors.Is(err, servicebroker.ErrRuntimeUnavailable),
		errors.Is(err, servicebroker.ErrAmbiguousProvider),
		errors.Is(err, servicebroker.ErrInvalidSelection):
		return workerrpc.NewRPCError(workerrpc.JSONRPCApplication, workerrpc.KindUnavailable,
			"The bound service is unavailable.", true, nil)
	default:
		return err
	}
}

var _ ServiceCaller = (*servicebroker.Broker)(nil)
