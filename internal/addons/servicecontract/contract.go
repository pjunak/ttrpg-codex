// Package servicecontract compiles package-owned service documents into
// immutable method registries used by the host service broker.
package servicecontract

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

var (
	ErrInvalidDeclaration = errors.New("invalid service declaration")
	ErrInvalidDocument    = errors.New("invalid service document")
	ErrInvalidSchema      = errors.New("invalid service method schema")
	ErrMethodNotFound     = errors.New("service method not found")
)

type Idempotency string

const (
	IdempotencyNone     Idempotency = "none"
	IdempotencyOptional Idempotency = "optional"
	IdempotencyRequired Idempotency = "required"
)

type Declaration struct {
	Contract  string
	Version   string
	Document  string
	Exclusive bool
}

type MethodDescription struct {
	Name           string      `json:"name"`
	RequestSchema  string      `json:"requestSchema"`
	ResponseSchema string      `json:"responseSchema"`
	MaxDeadlineMS  int         `json:"maxDeadlineMs"`
	Idempotency    Idempotency `json:"idempotency"`
	Errors         []string    `json:"errors,omitempty"`
}

type Description struct {
	Contract        string              `json:"contract"`
	Version         string              `json:"version"`
	Document        string              `json:"document"`
	AllowsExclusive bool                `json:"allowsExclusive"`
	Methods         []MethodDescription `json:"methods"`
}

type Method struct {
	description MethodDescription
	request     *jsonschema.Schema
	response    *jsonschema.Schema
}

func (method Method) Description() MethodDescription {
	return cloneMethodDescription(method.description)
}

func (method Method) MaxDeadline() time.Duration {
	return time.Duration(method.description.MaxDeadlineMS) * time.Millisecond
}

func (method Method) Idempotency() Idempotency {
	return method.description.Idempotency
}

func (method Method) ValidateRequest(body json.RawMessage) error {
	return validatePayload(method.request, body)
}

func (method Method) ValidateResponse(body json.RawMessage) error {
	return validatePayload(method.response, body)
}

type compiledContract struct {
	description Description
	methods     map[string]Method
}

// Registry is immutable after compilation and may be shared by concurrent
// broker calls for one activated package generation.
type Registry struct {
	contracts map[string]compiledContract
}

func (registry *Registry) Len() int {
	if registry == nil {
		return 0
	}
	return len(registry.contracts)
}

func (registry *Registry) Description(contract string) (Description, bool) {
	if registry == nil {
		return Description{}, false
	}
	compiled, exists := registry.contracts[contract]
	if !exists {
		return Description{}, false
	}
	return cloneDescription(compiled.description), true
}

func (registry *Registry) Descriptions() []Description {
	if registry == nil {
		return []Description{}
	}
	contracts := make([]string, 0, len(registry.contracts))
	for contract := range registry.contracts {
		contracts = append(contracts, contract)
	}
	sort.Strings(contracts)
	result := make([]Description, 0, len(contracts))
	for _, contract := range contracts {
		result = append(result, cloneDescription(registry.contracts[contract].description))
	}
	return result
}

func (registry *Registry) Method(contract, name string) (Method, error) {
	if registry == nil {
		return Method{}, fmt.Errorf("%w: %s/%s", ErrMethodNotFound, contract, name)
	}
	compiled, exists := registry.contracts[contract]
	if !exists {
		return Method{}, fmt.Errorf("%w: %s/%s", ErrMethodNotFound, contract, name)
	}
	method, exists := compiled.methods[name]
	if !exists {
		return Method{}, fmt.Errorf("%w: %s/%s", ErrMethodNotFound, contract, name)
	}
	return method, nil
}

func validatePayload(schema *jsonschema.Schema, body json.RawMessage) error {
	if schema == nil {
		return errors.New("compiled schema is unavailable")
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return err
	}
	return schema.Validate(value)
}

func cloneDescription(value Description) Description {
	result := value
	result.Methods = make([]MethodDescription, len(value.Methods))
	for index, method := range value.Methods {
		result.Methods[index] = cloneMethodDescription(method)
	}
	return result
}

func cloneMethodDescription(value MethodDescription) MethodDescription {
	result := value
	result.Errors = append([]string(nil), value.Errors...)
	return result
}
