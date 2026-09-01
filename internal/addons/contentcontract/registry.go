// Package contentcontract validates and indexes immutable JSON records shipped
// in an add-on package. A registry belongs to one inspected generation and is
// safe to share because every returned value is cloned.
package contentcontract

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
)

const (
	MaximumRecords       = 100_000
	MaximumQueryRecords  = 200
	MaximumIdentityBytes = 200
)

var (
	ErrInvalidDeclaration = errors.New("invalid add-on content declaration")
	ErrInvalidRecord      = errors.New("invalid add-on content record")
	ErrSetNotFound        = errors.New("add-on content set not found")
	ErrRecordNotFound     = errors.New("add-on content record not found")
	ErrInvalidQuery       = errors.New("invalid add-on content query")
)

type Declaration struct {
	ID       string
	Root     string
	Schema   string
	Revision string
	Groups   *Groups
}

type Groups struct {
	Field           string `json:"field"`
	AdditionalField string `json:"additionalField,omitempty"`
	Label           string `json:"label"`
}

type File struct {
	Path string
	Body json.RawMessage
}

type Description struct {
	ID           string         `json:"id"`
	Root         string         `json:"root"`
	Schema       string         `json:"schema"`
	Revision     string         `json:"revision"`
	Groups       *Groups        `json:"groups,omitempty"`
	SchemaSHA256 string         `json:"schemaSha256"`
	RecordCount  int            `json:"recordCount"`
	Kinds        map[string]int `json:"kinds"`
}

type Record struct {
	Kind  string          `json:"kind"`
	ID    string          `json:"id"`
	Value json.RawMessage `json:"value"`
}

type Query struct {
	SetID         string
	Kind          string
	AfterPosition int
	Limit         int
}

type QueryResult struct {
	Records      []Record
	NextPosition *int
}

type set struct {
	description Description
	records     []Record
	byIdentity  map[string]int
}

type Registry struct {
	sets         map[string]set
	descriptions []Description
}

func Compile(
	declarations []Declaration,
	files []File,
	schemas *datacontract.Registry,
) (*Registry, error) {
	if schemas == nil {
		return nil, fmt.Errorf("%w: schema registry is required", ErrInvalidDeclaration)
	}
	registry := &Registry{
		sets:         make(map[string]set, len(declarations)),
		descriptions: make([]Description, 0, len(declarations)),
	}
	for _, declaration := range declarations {
		if !validDeclaration(declaration) {
			return nil, fmt.Errorf("%w: malformed content set %q", ErrInvalidDeclaration, declaration.ID)
		}
		if _, duplicate := registry.sets[declaration.ID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate content set %q", ErrInvalidDeclaration, declaration.ID)
		}
		schema, err := schemas.Description(datacontract.Collection, declaration.ID)
		if err != nil || schema.Schema != declaration.Schema {
			return nil, fmt.Errorf("%w: schema for content set %q is unavailable", ErrInvalidDeclaration, declaration.ID)
		}
		compiled := set{
			description: Description{
				ID: declaration.ID, Root: declaration.Root, Schema: declaration.Schema,
				Revision: declaration.Revision, Groups: cloneGroups(declaration.Groups),
				SchemaSHA256: schema.SchemaSHA256,
				Kinds:        make(map[string]int),
			},
			byIdentity: make(map[string]int),
		}
		prefix := declaration.Root + "/"
		for _, file := range files {
			if !strings.HasPrefix(file.Path, prefix) || !strings.HasSuffix(file.Path, ".json") {
				continue
			}
			if len(compiled.records) >= MaximumRecords {
				return nil, fmt.Errorf("%w: content set %q exceeds %d records", ErrInvalidRecord, declaration.ID, MaximumRecords)
			}
			if err := schemas.Validate(datacontract.Collection, declaration.ID, file.Body); err != nil {
				return nil, fmt.Errorf("%w: %s: %v", ErrInvalidRecord, file.Path, err)
			}
			record, err := decodeRecord(file.Body)
			if err != nil {
				return nil, fmt.Errorf("%w: %s: %v", ErrInvalidRecord, file.Path, err)
			}
			identity := recordIdentity(record.Kind, record.ID)
			if _, duplicate := compiled.byIdentity[identity]; duplicate {
				return nil, fmt.Errorf("%w: duplicate identity %s:%s", ErrInvalidRecord, record.Kind, record.ID)
			}
			compiled.byIdentity[identity] = len(compiled.records)
			compiled.records = append(compiled.records, record)
			compiled.description.Kinds[record.Kind]++
		}
		if len(compiled.records) == 0 {
			return nil, fmt.Errorf("%w: content set %q contains no JSON records", ErrInvalidDeclaration, declaration.ID)
		}
		sort.Slice(compiled.records, func(left, right int) bool {
			if compiled.records[left].Kind != compiled.records[right].Kind {
				return compiled.records[left].Kind < compiled.records[right].Kind
			}
			return compiled.records[left].ID < compiled.records[right].ID
		})
		for index, record := range compiled.records {
			compiled.byIdentity[recordIdentity(record.Kind, record.ID)] = index
		}
		compiled.description.RecordCount = len(compiled.records)
		registry.descriptions = append(registry.descriptions, cloneDescription(compiled.description))
		registry.sets[declaration.ID] = compiled
	}
	sort.Slice(registry.descriptions, func(left, right int) bool {
		return registry.descriptions[left].ID < registry.descriptions[right].ID
	})
	return registry, nil
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

func (registry *Registry) Description(id string) (Description, error) {
	if registry == nil {
		return Description{}, ErrSetNotFound
	}
	contentSet, exists := registry.sets[id]
	if !exists {
		return Description{}, ErrSetNotFound
	}
	return cloneDescription(contentSet.description), nil
}

func (registry *Registry) Get(setID, kind, id string) (Record, error) {
	if registry == nil {
		return Record{}, ErrSetNotFound
	}
	contentSet, exists := registry.sets[setID]
	if !exists {
		return Record{}, ErrSetNotFound
	}
	index, exists := contentSet.byIdentity[recordIdentity(kind, id)]
	if !exists {
		return Record{}, ErrRecordNotFound
	}
	return cloneRecord(contentSet.records[index]), nil
}

func (registry *Registry) Query(query Query) (QueryResult, error) {
	if registry == nil {
		return QueryResult{}, ErrSetNotFound
	}
	contentSet, exists := registry.sets[query.SetID]
	if !exists {
		return QueryResult{}, ErrSetNotFound
	}
	if query.Kind != "" && !validIdentity(query.Kind) || query.AfterPosition < -1 ||
		query.Limit < 1 || query.Limit > MaximumQueryRecords {
		return QueryResult{}, ErrInvalidQuery
	}
	result := QueryResult{Records: make([]Record, 0, query.Limit)}
	lastPosition := -1
	for position := query.AfterPosition + 1; position < len(contentSet.records); position++ {
		record := contentSet.records[position]
		if query.Kind != "" && record.Kind != query.Kind {
			continue
		}
		if len(result.Records) == query.Limit {
			next := lastPosition
			result.NextPosition = &next
			break
		}
		result.Records = append(result.Records, cloneRecord(record))
		lastPosition = position
	}
	return result, nil
}

func decodeRecord(body json.RawMessage) (Record, error) {
	var envelope struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var object map[string]json.RawMessage
	if err := decoder.Decode(&object); err != nil {
		return Record{}, errors.New("record must be a JSON object")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Record{}, errors.New("record contains trailing JSON")
	}
	identity, err := json.Marshal(object)
	if err != nil || json.Unmarshal(identity, &envelope) != nil ||
		!validIdentity(envelope.Kind) || !validIdentity(envelope.ID) {
		return Record{}, errors.New("record requires bounded kind and id strings")
	}
	return Record{
		Kind: envelope.Kind, ID: envelope.ID,
		Value: append(json.RawMessage(nil), body...),
	}, nil
}

func validDeclaration(declaration Declaration) bool {
	return validIdentity(declaration.ID) && declaration.Root != "" && declaration.Schema != "" &&
		declaration.Revision != "" && !strings.HasSuffix(declaration.Root, "/")
}

func validIdentity(value string) bool {
	if value == "" || len(value) > MaximumIdentityBytes || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func recordIdentity(kind, id string) string { return kind + "\x00" + id }

func cloneRecord(record Record) Record {
	record.Value = append(json.RawMessage(nil), record.Value...)
	return record
}

func cloneDescription(description Description) Description {
	kinds := make(map[string]int, len(description.Kinds))
	for kind, count := range description.Kinds {
		kinds[kind] = count
	}
	description.Kinds = kinds
	description.Groups = cloneGroups(description.Groups)
	return description
}

func cloneGroups(groups *Groups) *Groups {
	if groups == nil {
		return nil
	}
	copy := *groups
	return &copy
}
