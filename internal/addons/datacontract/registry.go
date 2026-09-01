package datacontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type Kind string

const (
	Collection      Kind = "collection"
	RecordExtension Kind = "record-extension"
)

type Visibility string

const (
	VisibilityPublic  Visibility = "public"
	VisibilityDM      Visibility = "dm"
	VisibilityPrivate Visibility = "private"
)

var (
	ErrInvalidDeclaration = errors.New("invalid add-on data declaration")
	ErrDefinitionNotFound = errors.New("add-on data definition not found")
	ErrInvalidDocument    = errors.New("add-on document failed schema validation")
)

type Index struct {
	Path   string `json:"path"`
	Unique bool   `json:"unique,omitempty"`
}

type Declaration struct {
	Kind          Kind
	ID            string
	Target        string
	Keyed         bool
	Visibility    Visibility
	Schema        string
	SchemaVersion string
	Indexes       []Index
}

type Description struct {
	Kind          Kind       `json:"kind"`
	ID            string     `json:"id"`
	Target        string     `json:"target,omitempty"`
	Keyed         bool       `json:"keyed,omitempty"`
	Visibility    Visibility `json:"visibility"`
	Schema        string     `json:"schema"`
	SchemaVersion string     `json:"schemaVersion"`
	SchemaSHA256  string     `json:"schemaSha256"`
	Indexes       []Index    `json:"indexes,omitempty"`
}

type definition struct {
	description Description
	schema      *jsonschema.Schema
}

type Registry struct {
	definitions  map[string]definition
	descriptions []Description
}

func Compile(declarations []Declaration, resources map[string][]byte) (*Registry, error) {
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	compiler.UseLoader(offlineLoader{})

	resourceNames := make([]string, 0, len(resources))
	for filename := range resources {
		resourceNames = append(resourceNames, filename)
	}
	sort.Strings(resourceNames)
	for _, filename := range resourceNames {
		if !validSchemaPath(filename) {
			return nil, fmt.Errorf("%w: invalid schema path %q", ErrInvalidDeclaration, filename)
		}
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(resources[filename]))
		if err != nil {
			return nil, fmt.Errorf("%w: decode %s: %v", ErrInvalidDeclaration, filename, err)
		}
		if err := compiler.AddResource(resourceURL(filename), document); err != nil {
			return nil, fmt.Errorf("%w: add %s: %v", ErrInvalidDeclaration, filename, err)
		}
	}

	registry := &Registry{
		definitions:  make(map[string]definition, len(declarations)),
		descriptions: make([]Description, 0, len(declarations)),
	}
	for _, declaration := range declarations {
		if !validDeclaration(declaration) {
			return nil, fmt.Errorf("%w: malformed %s %q", ErrInvalidDeclaration, declaration.Kind, declaration.ID)
		}
		key := definitionKey(declaration.Kind, declaration.ID)
		if _, duplicate := registry.definitions[key]; duplicate {
			return nil, fmt.Errorf("%w: duplicate %s %q", ErrInvalidDeclaration, declaration.Kind, declaration.ID)
		}
		if _, exists := resources[declaration.Schema]; !exists {
			return nil, fmt.Errorf("%w: schema %q is missing", ErrInvalidDeclaration, declaration.Schema)
		}
		compiled, err := compiler.Compile(resourceURL(declaration.Schema))
		if err != nil {
			return nil, fmt.Errorf("%w: compile %s: %v", ErrInvalidDeclaration, declaration.Schema, err)
		}
		digest, err := schemaClosureDigest(declaration.Schema, resources)
		if err != nil {
			return nil, err
		}
		description := Description{
			Kind: declaration.Kind, ID: declaration.ID, Target: declaration.Target,
			Keyed: declaration.Keyed, Visibility: declaration.Visibility,
			Schema: declaration.Schema, SchemaVersion: declaration.SchemaVersion,
			SchemaSHA256: digest, Indexes: cloneIndexes(declaration.Indexes),
		}
		registry.definitions[key] = definition{description: description, schema: compiled}
		registry.descriptions = append(registry.descriptions, description)
	}
	sort.Slice(registry.descriptions, func(left, right int) bool {
		if registry.descriptions[left].Kind != registry.descriptions[right].Kind {
			return registry.descriptions[left].Kind < registry.descriptions[right].Kind
		}
		return registry.descriptions[left].ID < registry.descriptions[right].ID
	})
	return registry, nil
}

func (registry *Registry) Description(kind Kind, id string) (Description, error) {
	if registry == nil {
		return Description{}, ErrDefinitionNotFound
	}
	value, ok := registry.definitions[definitionKey(kind, id)]
	if !ok {
		return Description{}, ErrDefinitionNotFound
	}
	return cloneDescription(value.description), nil
}

func (registry *Registry) Descriptions() []Description {
	if registry == nil {
		return []Description{}
	}
	result := make([]Description, len(registry.descriptions))
	for index, description := range registry.descriptions {
		result[index] = cloneDescription(description)
	}
	return result
}

func (registry *Registry) Validate(kind Kind, id string, value json.RawMessage) error {
	if registry == nil {
		return ErrDefinitionNotFound
	}
	definition, ok := registry.definitions[definitionKey(kind, id)]
	if !ok {
		return ErrDefinitionNotFound
	}
	var document any
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("%w: invalid JSON", ErrInvalidDocument)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: trailing JSON content", ErrInvalidDocument)
	}
	if err := definition.schema.Validate(document); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidDocument, err)
	}
	return nil
}

func validDeclaration(declaration Declaration) bool {
	if declaration.ID == "" || declaration.SchemaVersion == "" || !validSchemaPath(declaration.Schema) ||
		(declaration.Visibility != VisibilityPublic && declaration.Visibility != VisibilityDM &&
			declaration.Visibility != VisibilityPrivate) {
		return false
	}
	switch declaration.Kind {
	case Collection:
		return declaration.Target == ""
	case RecordExtension:
		return declaration.Target != "" && !declaration.Keyed && len(declaration.Indexes) == 0
	default:
		return false
	}
}

func validSchemaPath(filename string) bool {
	return strings.HasPrefix(filename, "contracts/") && strings.HasSuffix(filename, ".json") &&
		path.Clean(filename) == filename && !strings.Contains(filename, "\\")
}

func definitionKey(kind Kind, id string) string { return string(kind) + "\x00" + id }

func resourceURL(filename string) string {
	return (&url.URL{Scheme: "file", Path: "/addon/" + filename}).String()
}

func schemaClosureDigest(root string, resources map[string][]byte) (string, error) {
	visited := make(map[string]struct{})
	var visit func(string) error
	visit = func(filename string) error {
		if _, seen := visited[filename]; seen {
			return nil
		}
		body, ok := resources[filename]
		if !ok {
			return fmt.Errorf("%w: referenced schema %q is missing", ErrInvalidDeclaration, filename)
		}
		visited[filename] = struct{}{}
		var document any
		if err := json.Unmarshal(body, &document); err != nil {
			return fmt.Errorf("%w: decode schema %q: %v", ErrInvalidDeclaration, filename, err)
		}
		for _, reference := range schemaReferences(document) {
			target, external, err := resolveSchemaReference(filename, reference)
			if err != nil {
				return err
			}
			if !external && target != filename {
				if err := visit(target); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := visit(root); err != nil {
		return "", err
	}
	filenames := make([]string, 0, len(visited))
	for filename := range visited {
		filenames = append(filenames, filename)
	}
	sort.Strings(filenames)
	hash := sha256.New()
	for _, filename := range filenames {
		bodyDigest := sha256.Sum256(resources[filename])
		hash.Write([]byte(filename))
		hash.Write([]byte{0})
		hash.Write([]byte(hex.EncodeToString(bodyDigest[:])))
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func schemaReferences(value any) []string {
	result := make([]string, 0)
	var walk func(any)
	walk = func(current any) {
		switch typed := current.(type) {
		case map[string]any:
			for key, child := range typed {
				if key == "$ref" || key == "$dynamicRef" {
					if reference, ok := child.(string); ok {
						result = append(result, reference)
					}
				}
				walk(child)
			}
		case []any:
			for _, child := range typed {
				walk(child)
			}
		}
	}
	walk(value)
	return result
}

func resolveSchemaReference(current, reference string) (string, bool, error) {
	parsed, err := url.Parse(reference)
	if err != nil {
		return "", false, fmt.Errorf("%w: invalid schema reference %q", ErrInvalidDeclaration, reference)
	}
	if parsed.Scheme != "" {
		if parsed.Scheme == "file" && strings.HasPrefix(parsed.Path, "/addon/contracts/") {
			return strings.TrimPrefix(parsed.Path, "/addon/"), false, nil
		}
		return "", true, nil
	}
	if parsed.Path == "" {
		return current, false, nil
	}
	resolved := path.Clean(path.Join(path.Dir(current), parsed.Path))
	if !validSchemaPath(resolved) {
		return "", false, fmt.Errorf("%w: schema reference %q escapes contracts", ErrInvalidDeclaration, reference)
	}
	return resolved, false, nil
}

func cloneDescription(value Description) Description {
	value.Indexes = cloneIndexes(value.Indexes)
	return value
}

func cloneIndexes(values []Index) []Index {
	if len(values) == 0 {
		return []Index{}
	}
	return append([]Index(nil), values...)
}

type offlineLoader struct{}

func (offlineLoader) Load(location string) (any, error) {
	return nil, fmt.Errorf("external schema resource %q is unavailable", location)
}
