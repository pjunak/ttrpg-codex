package workerrpc

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	semver "github.com/Masterminds/semver/v3"

	"github.com/pjunak/ttrpg-codex/contracts/addons/v3"

	"github.com/pjunak/ttrpg-codex/internal/jsonexact"
)

var (
	serviceClientContractPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$`)
	serviceClientMethodPattern   = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`)
)

type ServiceCaller interface {
	Call(context.Context, string, any, *Meta) (json.RawMessage, error)
}

// ServiceClient calls only services that the host bound to this exact worker
// generation. Provider identity is returned with every result so workers can
// include it in caches and diagnostics.
type ServiceClient struct {
	caller ServiceCaller
}

type ServiceCall struct {
	Contract        string
	ProviderAddonID string
	Method          string
	Params          any
	IdempotencyKey  string
}

type ServiceResult struct {
	Contract                string
	ProviderAddonID         string
	ProviderContractVersion string
	ProviderGeneration      string
	Result                  json.RawMessage
}

func NewServiceClient(caller ServiceCaller) (*ServiceClient, error) {
	if caller == nil {
		return nil, errors.New("service RPC caller is required")
	}
	return &ServiceClient{caller: caller}, nil
}

func (client *ServiceClient) Call(
	ctx context.Context,
	meta *Meta,
	call ServiceCall,
) (ServiceResult, error) {
	params, err := json.Marshal(call.Params)
	if client == nil || client.caller == nil || err != nil ||
		!validServiceClientContract(call.Contract) ||
		(call.ProviderAddonID != "" && !addonv3.ValidAddonID(call.ProviderAddonID)) ||
		len(call.Method) > 100 || !serviceClientMethodPattern.MatchString(call.Method) ||
		!validServiceClientPayload(params) || !validServiceClientIdentifier(call.IdempotencyKey, 200) {
		return ServiceResult{}, errors.New("bound service call is invalid")
	}
	request := map[string]any{
		"contractVersion": "host-service-call.v1",
		"contract":        call.Contract, "method": call.Method,
		"params": json.RawMessage(params),
	}
	if call.ProviderAddonID != "" {
		request["providerAddonId"] = call.ProviderAddonID
	}
	if call.IdempotencyKey != "" {
		request["idempotencyKey"] = call.IdempotencyKey
	}
	body, err := client.caller.Call(ctx, "host/service.call", request, meta)
	if err != nil {
		return ServiceResult{}, err
	}
	var response struct {
		ContractVersion         string          `json:"contractVersion"`
		Contract                string          `json:"contract"`
		ProviderAddonID         string          `json:"providerAddonId"`
		ProviderContractVersion string          `json:"providerContractVersion"`
		ProviderGeneration      string          `json:"providerGeneration"`
		Result                  json.RawMessage `json:"result"`
	}
	if err := jsonexact.Decode(body, &response); err != nil {
		return ServiceResult{}, errors.New("host returned an invalid bound service result")
	}
	_, versionErr := semver.StrictNewVersion(response.ProviderContractVersion)
	if response.ContractVersion != "host-service-result.v1" ||
		response.Contract != call.Contract || !validServiceClientContract(response.Contract) ||
		!addonv3.ValidAddonID(response.ProviderAddonID) || versionErr != nil ||
		!validServiceClientGeneration(response.ProviderGeneration) ||
		!validServiceClientPayload(response.Result) ||
		(call.ProviderAddonID != "" && response.ProviderAddonID != call.ProviderAddonID) {
		return ServiceResult{}, errors.New("host returned an invalid bound service result")
	}
	return ServiceResult{
		Contract: response.Contract, ProviderAddonID: response.ProviderAddonID,
		ProviderContractVersion: response.ProviderContractVersion,
		ProviderGeneration:      response.ProviderGeneration,
		Result:                  append(json.RawMessage(nil), response.Result...),
	}, nil
}

func DecodeServiceResult[T any](result ServiceResult) (T, error) {
	var value T
	if !validServiceClientPayload(result.Result) {
		return value, errors.New("bound service result contains invalid JSON")
	}
	if err := json.Unmarshal(result.Result, &value); err != nil {
		return value, err
	}
	return value, nil
}

func validServiceClientContract(value string) bool {
	return len(value) <= 120 && serviceClientContractPattern.MatchString(value)
}

func validServiceClientGeneration(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validServiceClientPayload(value json.RawMessage) bool {
	trimmed := bytes.TrimSpace(value)
	return len(trimmed) > 1 && json.Valid(trimmed) &&
		((trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}') ||
			(trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']'))
}

func validServiceClientIdentifier(value string, maximum int) bool {
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
