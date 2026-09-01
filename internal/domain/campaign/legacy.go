package campaign

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

const MaximumLegacyDatasetBytes = 256 << 20

type LegacyRecord struct {
	Collection Collection
	Key        string
	Value      json.RawMessage
	Position   int64
}

type LegacyDataset struct {
	Present     []Collection
	Records     []LegacyRecord
	Passthrough map[string]json.RawMessage
}

// DecodeLegacyDataset reads the v1 Store.exportJSON shape without interpreting
// record-owned fields. Known core collections become revision-ready records;
// unknown top-level values are retained for the later add-on import phase.
func DecodeLegacyDataset(body []byte) (LegacyDataset, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || len(trimmed) > MaximumLegacyDatasetBytes || !json.Valid(trimmed) {
		return LegacyDataset{}, fmt.Errorf("%w: legacy dataset must be bounded JSON", ErrInvalidRecord)
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return LegacyDataset{Passthrough: map[string]json.RawMessage{}}, nil
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &root); err != nil || root == nil {
		return LegacyDataset{}, fmt.Errorf("%w: legacy dataset must be a JSON object", ErrInvalidRecord)
	}

	result := LegacyDataset{Passthrough: make(map[string]json.RawMessage)}
	for name, container := range root {
		collection, err := ParseCollection(name)
		if err != nil {
			result.Passthrough[name] = append(json.RawMessage(nil), container...)
			continue
		}
		descriptor, _ := Describe(collection)
		result.Present = append(result.Present, collection)
		records, err := decodeLegacyCollection(descriptor, container)
		if err != nil {
			return LegacyDataset{}, fmt.Errorf("decode legacy collection %s: %w", collection, err)
		}
		result.Records = append(result.Records, records...)
	}
	sort.Slice(result.Present, func(left, right int) bool {
		return result.Present[left] < result.Present[right]
	})
	return result, nil
}

func EncodeLegacyDataset(dataset LegacyDataset) ([]byte, error) {
	root := make(map[string]json.RawMessage, len(dataset.Present)+len(dataset.Passthrough))
	for name, value := range dataset.Passthrough {
		if _, err := ParseCollection(name); err == nil || name == "" || !json.Valid(value) {
			return nil, fmt.Errorf("%w: invalid passthrough collection %q", ErrInvalidRecord, name)
		}
		root[name] = append(json.RawMessage(nil), value...)
	}

	present := make(map[Collection]struct{}, len(dataset.Present))
	for _, collection := range dataset.Present {
		if _, duplicate := present[collection]; duplicate {
			return nil, fmt.Errorf("%w: duplicate present collection %s", ErrInvalidRecord, collection)
		}
		if _, ok := Describe(collection); !ok {
			return nil, fmt.Errorf("%w: %s", ErrInvalidCollection, collection)
		}
		present[collection] = struct{}{}
	}

	grouped := make(map[Collection][]LegacyRecord)
	for _, record := range dataset.Records {
		if _, ok := present[record.Collection]; !ok {
			return nil, fmt.Errorf(
				"%w: record belongs to non-materialized collection %s",
				ErrInvalidRecord,
				record.Collection,
			)
		}
		descriptor, _ := Describe(record.Collection)
		normalized, _, err := NormalizeRecord(descriptor, record.Key, record.Value)
		if err != nil || record.Position < 0 {
			if err == nil {
				err = fmt.Errorf("negative position")
			}
			return nil, fmt.Errorf("encode %s:%s: %w", record.Collection, record.Key, err)
		}
		record.Value = normalized
		grouped[record.Collection] = append(grouped[record.Collection], record)
	}

	for collection := range present {
		descriptor, _ := Describe(collection)
		records := grouped[collection]
		sort.Slice(records, func(left, right int) bool {
			if records[left].Position == records[right].Position {
				return records[left].Key < records[right].Key
			}
			return records[left].Position < records[right].Position
		})
		seenKeys := make(map[string]struct{}, len(records))
		seenPositions := make(map[int64]struct{}, len(records))
		for _, record := range records {
			if _, exists := seenKeys[record.Key]; exists {
				return nil, fmt.Errorf("%w: duplicate record key %s:%s", ErrInvalidRecord, collection, record.Key)
			}
			if _, exists := seenPositions[record.Position]; exists {
				return nil, fmt.Errorf("%w: duplicate record position in %s", ErrInvalidRecord, collection)
			}
			seenKeys[record.Key] = struct{}{}
			seenPositions[record.Position] = struct{}{}
		}
		encoded, err := encodeLegacyCollection(descriptor, records)
		if err != nil {
			return nil, err
		}
		root[string(collection)] = encoded
	}
	return json.Marshal(root)
}

func decodeLegacyCollection(descriptor Descriptor, container json.RawMessage) ([]LegacyRecord, error) {
	if descriptor.Shape == List {
		var values []json.RawMessage
		if err := json.Unmarshal(container, &values); err != nil || values == nil {
			return nil, fmt.Errorf("list collection must be an array")
		}
		result := make([]LegacyRecord, 0, len(values))
		seen := make(map[string]struct{}, len(values))
		for index, value := range values {
			key, err := ListRecordKey(descriptor.Name, value)
			if err != nil {
				return nil, fmt.Errorf("record %d: %w", index, err)
			}
			normalized, _, err := NormalizeRecord(descriptor, key, value)
			if err != nil {
				return nil, fmt.Errorf("record %d: %w", index, err)
			}
			if _, duplicate := seen[key]; duplicate {
				return nil, fmt.Errorf("%w: duplicate key %q", ErrInvalidRecord, key)
			}
			seen[key] = struct{}{}
			result = append(result, LegacyRecord{
				Collection: descriptor.Name,
				Key:        key,
				Value:      normalized,
				Position:   int64(index),
			})
		}
		return result, nil
	}

	trimmed := bytes.TrimSpace(container)
	if descriptor.Name == DeletedDefaults && len(trimmed) > 0 && trimmed[0] == '[' {
		var keys []string
		if err := json.Unmarshal(trimmed, &keys); err != nil {
			return nil, fmt.Errorf("legacy deletedDefaults must contain strings")
		}
		result := make([]LegacyRecord, 0, len(keys))
		seen := make(map[string]struct{}, len(keys))
		for index, key := range keys {
			if err := ValidateKey(descriptor, key); err != nil {
				return nil, err
			}
			if _, duplicate := seen[key]; duplicate {
				continue
			}
			seen[key] = struct{}{}
			result = append(result, LegacyRecord{
				Collection: descriptor.Name,
				Key:        key,
				Value:      json.RawMessage("true"),
				Position:   int64(index),
			})
		}
		return result, nil
	}

	var values map[string]json.RawMessage
	if err := json.Unmarshal(container, &values); err != nil || values == nil {
		return nil, fmt.Errorf("keyed collection must be an object")
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]LegacyRecord, 0, len(keys))
	for index, key := range keys {
		normalized, _, err := NormalizeRecord(descriptor, key, values[key])
		if err != nil {
			return nil, fmt.Errorf("record %q: %w", key, err)
		}
		result = append(result, LegacyRecord{
			Collection: descriptor.Name,
			Key:        key,
			Value:      normalized,
			Position:   int64(index),
		})
	}
	return result, nil
}

func encodeLegacyCollection(descriptor Descriptor, records []LegacyRecord) (json.RawMessage, error) {
	if descriptor.Shape == List {
		values := make([]json.RawMessage, 0, len(records))
		for _, record := range records {
			values = append(values, record.Value)
		}
		return json.Marshal(values)
	}
	values := make(map[string]json.RawMessage, len(records))
	for _, record := range records {
		values[record.Key] = record.Value
	}
	return json.Marshal(values)
}
