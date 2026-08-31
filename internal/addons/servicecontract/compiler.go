package servicecontract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strings"
	"unicode"

	semver "github.com/Masterminds/semver/v3"
	addonv3 "github.com/pjunak/ttrpg-codex/contracts/addons/v3"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type CompileError struct {
	Path  string
	Cause error
}

func (err *CompileError) Error() string {
	if err.Path == "" {
		return err.Cause.Error()
	}
	return fmt.Sprintf("%s: %v", err.Path, err.Cause)
}

func (err *CompileError) Unwrap() error {
	return err.Cause
}

type Compiler struct {
	documentSchema *jsonschema.Schema
}

type document struct {
	Contract        string                    `json:"contract"`
	Version         string                    `json:"version"`
	AllowsExclusive bool                      `json:"allowsExclusive"`
	Methods         map[string]methodDocument `json:"methods"`
}

type methodDocument struct {
	RequestSchema  string      `json:"requestSchema"`
	ResponseSchema string      `json:"responseSchema"`
	MaxDeadlineMS  int         `json:"maxDeadlineMs"`
	Idempotency    Idempotency `json:"idempotency"`
	Errors         []string    `json:"errors,omitempty"`
}

func NewCompiler() (*Compiler, error) {
	documentSchema, err := compileMetaSchema("service-document.schema.json", addonv3.ServiceDocumentSchema())
	if err != nil {
		return nil, fmt.Errorf("compile service document schema: %w", err)
	}
	return &Compiler{documentSchema: documentSchema}, nil
}

// Compile validates every service document and compiles all method schemas
// exclusively from the supplied package resources. It never loads remote
// references or files outside the inspected package.
func (compiler *Compiler) Compile(declarations []Declaration, resources map[string][]byte) (*Registry, error) {
	if compiler == nil || compiler.documentSchema == nil {
		return nil, errorsAt("", ErrInvalidDocument, "service contract compiler is required")
	}
	serviceDocuments := make(map[string]struct{}, len(declarations))
	seenContracts := make(map[string]struct{}, len(declarations))
	for _, declaration := range declarations {
		if _, err := semver.StrictNewVersion(declaration.Version); err != nil {
			return nil, errorsAt(declaration.Document, ErrInvalidDeclaration, "invalid contract version %q: %v", declaration.Version, err)
		}
		if !validSchemaPath(declaration.Document) {
			return nil, errorsAt(declaration.Document, ErrInvalidDeclaration, "invalid service document path")
		}
		if _, exists := resources[declaration.Document]; !exists {
			return nil, errorsAt(declaration.Document, ErrInvalidDocument, "service document is missing")
		}
		if _, exists := seenContracts[declaration.Contract]; exists {
			return nil, errorsAt(declaration.Document, ErrInvalidDeclaration, "duplicate service contract %q", declaration.Contract)
		}
		seenContracts[declaration.Contract] = struct{}{}
		serviceDocuments[declaration.Document] = struct{}{}
	}

	schemaCompiler := jsonschema.NewCompiler()
	schemaCompiler.DefaultDraft(jsonschema.Draft2020)
	schemaCompiler.AssertFormat()
	schemaCompiler.UseLoader(offlineLoader{})
	resourceNames := make([]string, 0, len(resources))
	for filename := range resources {
		if strings.HasPrefix(filename, "contracts/") && strings.HasSuffix(filename, ".json") {
			resourceNames = append(resourceNames, filename)
		}
	}
	sort.Strings(resourceNames)
	for _, filename := range resourceNames {
		if _, isServiceDocument := serviceDocuments[filename]; isServiceDocument {
			continue
		}
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(resources[filename]))
		if err != nil {
			return nil, errorsAt(filename, ErrInvalidSchema, "decode schema: %v", err)
		}
		if err := schemaCompiler.AddResource(packageResourceURL(filename), value); err != nil {
			return nil, errorsAt(filename, ErrInvalidSchema, "register schema: %v", err)
		}
	}

	registry := &Registry{contracts: make(map[string]compiledContract, len(declarations))}
	for _, declaration := range declarations {
		body := resources[declaration.Document]
		value, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
		if err != nil {
			return nil, errorsAt(declaration.Document, ErrInvalidDocument, "decode document: %v", err)
		}
		if err := compiler.documentSchema.Validate(value); err != nil {
			return nil, errorsAt(declaration.Document, ErrInvalidDocument, "validate document: %v", err)
		}
		var definition document
		if err := json.Unmarshal(body, &definition); err != nil {
			return nil, errorsAt(declaration.Document, ErrInvalidDocument, "decode typed document: %v", err)
		}
		if definition.Contract != declaration.Contract {
			return nil, errorsAt(declaration.Document, ErrInvalidDeclaration, "document contract %q does not match manifest contract %q", definition.Contract, declaration.Contract)
		}
		if definition.Version != declaration.Version {
			return nil, errorsAt(declaration.Document, ErrInvalidDeclaration, "document version %q does not match manifest version %q", definition.Version, declaration.Version)
		}
		if declaration.Exclusive && !definition.AllowsExclusive {
			return nil, errorsAt(declaration.Document, ErrInvalidDeclaration, "manifest requests exclusivity but the contract forbids it")
		}

		methodNames := make([]string, 0, len(definition.Methods))
		for name := range definition.Methods {
			methodNames = append(methodNames, name)
		}
		sort.Strings(methodNames)
		compiled := compiledContract{
			description: Description{
				Contract:        definition.Contract,
				Version:         definition.Version,
				Document:        declaration.Document,
				AllowsExclusive: definition.AllowsExclusive,
				Methods:         make([]MethodDescription, 0, len(methodNames)),
			},
			methods: make(map[string]Method, len(methodNames)),
		}
		for _, name := range methodNames {
			methodDocument := definition.Methods[name]
			request, err := compileMethodSchema(schemaCompiler, methodDocument.RequestSchema)
			if err != nil {
				return nil, errorsAt(methodDocument.RequestSchema, ErrInvalidSchema, "%s request schema: %v", name, err)
			}
			response, err := compileMethodSchema(schemaCompiler, methodDocument.ResponseSchema)
			if err != nil {
				return nil, errorsAt(methodDocument.ResponseSchema, ErrInvalidSchema, "%s response schema: %v", name, err)
			}
			errors := append([]string(nil), methodDocument.Errors...)
			sort.Strings(errors)
			description := MethodDescription{
				Name:           name,
				RequestSchema:  methodDocument.RequestSchema,
				ResponseSchema: methodDocument.ResponseSchema,
				MaxDeadlineMS:  methodDocument.MaxDeadlineMS,
				Idempotency:    methodDocument.Idempotency,
				Errors:         errors,
			}
			compiled.description.Methods = append(compiled.description.Methods, description)
			compiled.methods[name] = Method{description: description, request: request, response: response}
		}
		registry.contracts[declaration.Contract] = compiled
	}
	return registry, nil
}

func compileMetaSchema(name string, body []byte) (*jsonschema.Schema, error) {
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	compiler.UseLoader(offlineLoader{})
	if err := compiler.AddResource(name, document); err != nil {
		return nil, err
	}
	return compiler.Compile(name)
}

type offlineLoader struct{}

func (offlineLoader) Load(location string) (any, error) {
	return nil, fmt.Errorf("external schema resource %q is unavailable during package inspection", location)
}

func compileMethodSchema(compiler *jsonschema.Compiler, filename string) (*jsonschema.Schema, error) {
	if !validSchemaPath(filename) {
		return nil, fmt.Errorf("invalid package schema path")
	}
	return compiler.Compile(packageResourceURL(filename))
}

func packageResourceURL(filename string) string {
	return (&url.URL{Scheme: "file", Path: "/addon/" + filename}).String()
}

func validSchemaPath(value string) bool {
	return strings.HasPrefix(value, "contracts/") && strings.HasSuffix(value, ".json") && validPackagePath(value)
}

func validPackagePath(value string) bool {
	if value == "" || len(value) > 500 || strings.Contains(value, "\\") ||
		strings.HasPrefix(value, "/") || hasControl(value) || path.Clean(value) != value {
		return false
	}
	first, _, _ := strings.Cut(value, "/")
	return !strings.Contains(first, ":") && value != "." && value != ".." && !strings.HasPrefix(value, "../")
}

func hasControl(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}

func errorsAt(filename string, sentinel error, format string, values ...any) error {
	return &CompileError{Path: filename, Cause: fmt.Errorf("%w: %s", sentinel, fmt.Sprintf(format, values...))}
}
