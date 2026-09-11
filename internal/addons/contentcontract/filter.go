package contentcontract

import (
	"encoding/json"
	"sort"
	"strings"
)

// SourceCatalog resolves declared group identities and names from the immutable
// index. Membership may name several sources without duplicating record identity.
func (registry *Registry) SourceCatalog(setID, catalogKind string) (map[string]string, error) {
	current, exists := registry.sets[setID]
	if !exists {
		return nil, ErrSetNotFound
	}
	result := make(map[string]string)
	for _, record := range current.records {
		for _, id := range recordSources(record, current.description.Groups) {
			result[id] = id
		}
	}
	for _, record := range current.records {
		if catalogKind == "" || record.Kind != catalogKind {
			continue
		}
		var value map[string]any
		if json.Unmarshal(record.Value, &value) != nil {
			return nil, ErrInvalidRecord
		}
		if name, ok := value["name"].(string); ok && name != "" {
			result[record.ID] = name
		} else {
			result[record.ID] = record.ID
		}
	}
	return result, nil
}

func recordSources(record Record, groups *Groups) []string {
	if groups == nil {
		return nil
	}
	var value map[string]any
	if json.Unmarshal(record.Value, &value) != nil {
		return nil
	}
	result := make([]string, 0)
	if primary, ok := sourceValue(value, groups.Field).(string); ok && primary != "" {
		result = append(result, primary)
	}
	if additional, ok := sourceValue(value, groups.AdditionalField).([]any); ok {
		for _, candidate := range additional {
			if id, ok := candidate.(string); ok && id != "" {
				result = append(result, id)
			}
		}
	}
	return result
}

func sourceValue(value map[string]any, path string) any {
	var current any = value
	for _, key := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	return current
}

func (registry *Registry) RecordSources(setID, kind, id string) ([]string, error) {
	record, err := registry.Get(setID, kind, id)
	if err != nil {
		return nil, err
	}
	return recordSources(record, registry.sets[setID].description.Groups), nil
}

type SourceSelection struct {
	Revision    string
	CatalogKind string
	Enabled     map[string]bool
}

// SelectSources creates an immutable effective index. Ungrouped metadata stays
// available; grouped records require at least one enabled source. The archive
// index and its schema-validated records are never modified.
func (registry *Registry) SelectSources(selections map[string]SourceSelection) *Registry {
	result := &Registry{sets: make(map[string]set, len(registry.sets)), descriptions: make([]Description, 0, len(registry.sets))}
	for setID, original := range registry.sets {
		selection, selected := selections[setID]
		if !selected {
			result.sets[setID] = original
			result.descriptions = append(result.descriptions, cloneDescription(original.description))
			continue
		}
		current := set{description: cloneDescription(original.description), byIdentity: make(map[string]int)}
		current.description.Revision = selection.Revision
		current.description.Kinds = make(map[string]int)
		for _, record := range original.records {
			sources := recordSources(record, original.description.Groups)
			if selection.CatalogKind != "" && record.Kind == selection.CatalogKind {
				sources = []string{record.ID}
			}
			enabled := len(sources) == 0
			for _, source := range sources {
				enabled = enabled || selection.Enabled[source]
			}
			if !enabled {
				continue
			}
			current.byIdentity[recordIdentity(record.Kind, record.ID)] = len(current.records)
			current.records = append(current.records, record)
			current.description.Kinds[record.Kind]++
		}
		current.description.RecordCount = len(current.records)
		result.sets[setID] = current
		result.descriptions = append(result.descriptions, cloneDescription(current.description))
	}
	sort.Slice(result.descriptions, func(i, j int) bool { return result.descriptions[i].ID < result.descriptions[j].ID })
	return result
}
