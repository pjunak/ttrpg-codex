package servicecontract

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestCompilerBuildsDeterministicOfflineMethodRegistry(t *testing.T) {
	t.Parallel()

	compiler := newTestCompiler(t)
	registry, err := compiler.Compile([]Declaration{{
		Contract: "dnd5e.rules-engine", Version: "3.1.0", Document: "contracts/engine.service.json",
	}}, map[string][]byte{
		"contracts/engine.service.json": serviceDocument(t, "dnd5e.rules-engine", "3.1.0", false, map[string]any{
			"summarize":          testMethodDocument("contracts/request.schema.json", "contracts/response.schema.json", 500, IdempotencyNone, []string{"UNAVAILABLE"}),
			"evaluate-character": testMethodDocument("contracts/request.schema.json", "contracts/response.schema.json", 2_000, IdempotencyRequired, []string{"INVALID_INPUT", "UNAVAILABLE"}),
		}),
		"contracts/request.schema.json": []byte(`{
			"$schema":"https://json-schema.org/draft/2020-12/schema",
			"$ref":"common.schema.json#/$defs/request"
		}`),
		"contracts/common.schema.json": []byte(`{
			"$schema":"https://json-schema.org/draft/2020-12/schema",
			"$defs":{"request":{"type":"object","required":["level"],"properties":{"level":{"type":"integer","minimum":1}},"additionalProperties":false}}
		}`),
		"contracts/response.schema.json": []byte(`{
			"$schema":"https://json-schema.org/draft/2020-12/schema",
			"type":"object","required":["total"],"properties":{"total":{"type":"integer"}},"additionalProperties":false
		}`),
	})
	if err != nil {
		t.Fatal(err)
	}

	descriptions := registry.Descriptions()
	if len(descriptions) != 1 || descriptions[0].Contract != "dnd5e.rules-engine" ||
		descriptions[0].Version != "3.1.0" || descriptions[0].AllowsExclusive {
		t.Fatalf("unexpected contract description: %+v", descriptions)
	}
	methodNames := []string{descriptions[0].Methods[0].Name, descriptions[0].Methods[1].Name}
	if !reflect.DeepEqual(methodNames, []string{"evaluate-character", "summarize"}) {
		t.Fatalf("method order = %v", methodNames)
	}
	method, err := registry.Method("dnd5e.rules-engine", "evaluate-character")
	if err != nil {
		t.Fatal(err)
	}
	if err := method.ValidateRequest(json.RawMessage(`{"level":4}`)); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	if err := method.ValidateRequest(json.RawMessage(`{"level":0}`)); err == nil {
		t.Fatal("invalid request passed compiled schema")
	}
	if err := method.ValidateResponse(json.RawMessage(`{"total":8}`)); err != nil {
		t.Fatalf("valid response rejected: %v", err)
	}
	if method.Idempotency() != IdempotencyRequired || method.MaxDeadline().Milliseconds() != 2_000 {
		t.Fatalf("method policy was not compiled: %+v", method.Description())
	}

	// Public descriptions are snapshots, not mutable views into the live registry.
	descriptions[0].Methods[0].Errors[0] = "MUTATED"
	fresh, _ := registry.Description("dnd5e.rules-engine")
	if fresh.Methods[0].Errors[0] != "INVALID_INPUT" {
		t.Fatalf("description mutation reached registry: %+v", fresh.Methods[0].Errors)
	}
}

func TestCompilerRejectsContractMismatchExclusivityAndUnavailableSchemas(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		declaration Declaration
		document    []byte
		schemas     map[string][]byte
		want        error
	}{
		{
			name:        "manifest version mismatch",
			declaration: Declaration{Contract: "codex.import-adapter", Version: "2.1.0", Document: "contracts/import.service.json"},
			document: serviceDocument(t, "codex.import-adapter", "2.0.0", false, map[string]any{
				"preview": testMethodDocument("contracts/request.json", "contracts/response.json", 1_000, IdempotencyNone, nil),
			}),
			want: ErrInvalidDeclaration,
		},
		{
			name:        "forbidden exclusivity",
			declaration: Declaration{Contract: "codex.import-adapter", Version: "2.0.0", Document: "contracts/import.service.json", Exclusive: true},
			document: serviceDocument(t, "codex.import-adapter", "2.0.0", false, map[string]any{
				"preview": testMethodDocument("contracts/request.json", "contracts/response.json", 1_000, IdempotencyNone, nil),
			}),
			want: ErrInvalidDeclaration,
		},
		{
			name:        "missing response schema",
			declaration: Declaration{Contract: "codex.import-adapter", Version: "2.0.0", Document: "contracts/import.service.json"},
			document: serviceDocument(t, "codex.import-adapter", "2.0.0", false, map[string]any{
				"preview": testMethodDocument("contracts/request.json", "contracts/missing.json", 1_000, IdempotencyNone, nil),
			}),
			schemas: map[string][]byte{"contracts/request.json": []byte(`{"type":"object"}`)},
			want:    ErrInvalidSchema,
		},
		{
			name:        "external reference",
			declaration: Declaration{Contract: "codex.import-adapter", Version: "2.0.0", Document: "contracts/import.service.json"},
			document: serviceDocument(t, "codex.import-adapter", "2.0.0", false, map[string]any{
				"preview": testMethodDocument("contracts/request.json", "contracts/response.json", 1_000, IdempotencyNone, nil),
			}),
			schemas: map[string][]byte{
				"contracts/request.json":  []byte(`{"$ref":"https://example.invalid/outside.schema.json"}`),
				"contracts/response.json": []byte(`{"type":"object"}`),
			},
			want: ErrInvalidSchema,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			resources := map[string][]byte{test.declaration.Document: test.document}
			for filename, body := range test.schemas {
				resources[filename] = body
			}
			_, err := newTestCompiler(t).Compile([]Declaration{test.declaration}, resources)
			if !errors.Is(err, test.want) {
				t.Fatalf("compile error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestRegistryReturnsExplicitUnknownMethod(t *testing.T) {
	t.Parallel()

	registry, err := newTestCompiler(t).Compile(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Method("dnd5e.rules-engine", "missing"); !errors.Is(err, ErrMethodNotFound) {
		t.Fatalf("unknown method error = %v", err)
	}
}

func newTestCompiler(t *testing.T) *Compiler {
	t.Helper()
	compiler, err := NewCompiler()
	if err != nil {
		t.Fatal(err)
	}
	return compiler
}

func serviceDocument(
	t *testing.T,
	contract string,
	version string,
	allowsExclusive bool,
	methods map[string]any,
) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"contract": contract, "version": version,
		"allowsExclusive": allowsExclusive, "methods": methods,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func testMethodDocument(
	request string,
	response string,
	maxDeadlineMS int,
	idempotency Idempotency,
	errorKinds []string,
) map[string]any {
	value := map[string]any{
		"requestSchema": request, "responseSchema": response,
		"maxDeadlineMs": maxDeadlineMS, "idempotency": idempotency,
	}
	if len(errorKinds) > 0 {
		value["errors"] = errorKinds
	}
	return value
}
