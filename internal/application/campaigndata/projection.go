package campaigndata

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

var identityCollections = []campaign.Collection{
	campaign.Characters,
	campaign.Locations,
	campaign.Events,
	campaign.Mysteries,
	campaign.Factions,
	campaign.Pantheon,
	campaign.Artifacts,
	campaign.HistoricalEvents,
}

func projectPublic(snapshot campaign.Snapshot) (campaign.Snapshot, error) {
	originalIDs, err := recordIDs(snapshot.Records)
	if err != nil {
		return campaign.Snapshot{}, err
	}
	visible := make([]campaign.Record, 0, len(snapshot.Records))
	for _, record := range snapshot.Records {
		descriptor, ok := campaign.Describe(record.Collection)
		if !ok {
			return campaign.Snapshot{}, fmt.Errorf("project campaign record: unknown collection %q", record.Collection)
		}
		if descriptor.VisibilityBearing && record.Visibility == campaign.VisibilityDM {
			continue
		}
		cloned := record
		cloned.Value = append(json.RawMessage(nil), record.Value...)
		if descriptor.VisibilityBearing {
			cloned.Value, err = transformObject(cloned.Value, func(value map[string]any) {
				delete(value, "linkedTwinId")
				if record.Collection == campaign.Locations {
					delete(value, "notes")
				}
			})
			if err != nil {
				return campaign.Snapshot{}, projectionError(record, err)
			}
		}
		visible = append(visible, cloned)
	}

	visibleIDs, err := recordIDs(visible)
	if err != nil {
		return campaign.Snapshot{}, err
	}
	visibleIDs[campaign.Factions]["neutral"] = struct{}{}
	visibleIDs[campaign.Factions]["party"] = struct{}{}
	hiddenIDs := make(map[string]struct{})
	for _, collection := range identityCollections {
		for id := range originalIDs[collection] {
			if _, exists := visibleIDs[collection][id]; !exists {
				hiddenIDs[id] = struct{}{}
			}
		}
	}

	relationshipTargets, err := relationshipTargetKinds(visible)
	if err != nil {
		return campaign.Snapshot{}, err
	}
	projected := make([]campaign.Record, 0, len(visible))
	for _, record := range visible {
		keep := true
		record.Value, keep, err = closeRecord(
			record,
			visibleIDs,
			hiddenIDs,
			relationshipTargets,
		)
		if err != nil {
			return campaign.Snapshot{}, projectionError(record, err)
		}
		if keep {
			projected = append(projected, record)
		}
	}
	return campaign.Snapshot{States: snapshot.States, Records: projected}, nil
}

func recordIDs(records []campaign.Record) (map[campaign.Collection]map[string]struct{}, error) {
	result := make(map[campaign.Collection]map[string]struct{}, len(identityCollections))
	for _, collection := range identityCollections {
		result[collection] = make(map[string]struct{})
	}
	for _, record := range records {
		ids, exists := result[record.Collection]
		if !exists {
			continue
		}
		ids[record.Key] = struct{}{}
		if record.Collection == campaign.Factions {
			value, err := objectValue(record.Value)
			if err != nil {
				return nil, projectionError(record, err)
			}
			if id, ok := value["id"].(string); ok && id != "" {
				ids[id] = struct{}{}
			}
		}
	}
	return result, nil
}

func relationshipTargetKinds(records []campaign.Record) (map[string]campaign.Collection, error) {
	result := map[string]campaign.Collection{"mission": campaign.Locations}
	for _, record := range records {
		if record.Collection != campaign.Settings || record.Key != "relationshipTypes" {
			continue
		}
		var values []any
		if err := json.Unmarshal(record.Value, &values); err != nil {
			return nil, projectionError(record, fmt.Errorf("relationshipTypes must be an array: %w", err))
		}
		for _, candidate := range values {
			value, ok := candidate.(map[string]any)
			if !ok {
				continue
			}
			id, ok := value["id"].(string)
			if !ok || id == "" {
				continue
			}
			if value["target"] == "location" {
				result[id] = campaign.Locations
			} else {
				result[id] = campaign.Characters
			}
		}
	}
	return result, nil
}

func closeRecord(
	record campaign.Record,
	ids map[campaign.Collection]map[string]struct{},
	hiddenIDs map[string]struct{},
	relationshipTargets map[string]campaign.Collection,
) (json.RawMessage, bool, error) {
	if record.Collection == campaign.Relationships {
		value, err := objectValue(record.Value)
		if err != nil {
			return nil, false, err
		}
		source, _ := value["source"].(string)
		target, _ := value["target"].(string)
		relationType, _ := value["type"].(string)
		targetCollection := relationshipTargets[relationType]
		if targetCollection == "" {
			targetCollection = campaign.Characters
		}
		_, sourceVisible := ids[campaign.Characters][source]
		_, targetVisible := ids[targetCollection][target]
		if !sourceVisible || !targetVisible {
			return nil, false, nil
		}
	}

	if record.Collection == campaign.Settings {
		value, err := closeSetting(record, ids[campaign.Locations])
		return value, true, err
	}
	if record.Collection == campaign.DeletedDefaults {
		return append(json.RawMessage(nil), record.Value...), true, nil
	}

	value, err := transformObject(record.Value, func(value map[string]any) {
		switch record.Collection {
		case campaign.Characters:
			removeInvalidScalar(value, "faction", ids[campaign.Factions])
			removeInvalidScalar(value, "location", ids[campaign.Locations])
			filterObjectArrayByID(value, "locationRoles", "locationId", ids[campaign.Locations])
		case campaign.Locations:
			removeUnavailableMapPlacement(value, "parentId", "x", "y", ids[campaign.Locations])
			filterStringArray(value, "connections", ids[campaign.Locations])
			filterStringArray(value, "characters", ids[campaign.Characters])
		case campaign.Events:
			filterStringArray(value, "characters", ids[campaign.Characters])
			filterStringArray(value, "locations", ids[campaign.Locations])
			removeUnavailableMapPlacement(value, "mapParentId", "mapX", "mapY", ids[campaign.Locations])
		case campaign.Mysteries, campaign.HistoricalEvents:
			filterStringArray(value, "characters", ids[campaign.Characters])
			filterStringArray(value, "locations", ids[campaign.Locations])
		case campaign.Artifacts:
			removeInvalidScalar(value, "ownerCharacterId", ids[campaign.Characters])
			removeInvalidScalar(value, "locationId", ids[campaign.Locations])
		case campaign.Pets:
			closePetOwner(value, ids)
		}
		closeAuditReferences(value, hiddenIDs)
		projectActivity(value, ViewPublic)
		if record.Collection == campaign.Locations {
			closeLocationNoteActivity(value)
		}
	})
	return value, true, err
}

// Coordinates are meaningful only in their owning map. Removing just a hidden
// parent would reinterpret a local pin as a world-map pin in public clients.
func removeUnavailableMapPlacement(value map[string]any, parent, x, y string, visible map[string]struct{}) {
	id, _ := value[parent].(string)
	removeInvalidScalar(value, parent, visible)
	if id != "" {
		if _, available := visible[id]; !available {
			delete(value, x)
			delete(value, y)
		}
	}
}

func closeSetting(record campaign.Record, locationIDs map[string]struct{}) (json.RawMessage, error) {
	switch record.Key {
	case "mapViews":
		var values []any
		if err := json.Unmarshal(record.Value, &values); err != nil {
			return nil, fmt.Errorf("mapViews must be an array: %w", err)
		}
		filtered := values[:0]
		for _, candidate := range values {
			value, ok := candidate.(map[string]any)
			if !ok {
				filtered = append(filtered, candidate)
				continue
			}
			parentID, _ := value["parentId"].(string)
			if parentID == "" {
				filtered = append(filtered, candidate)
				continue
			}
			if _, visible := locationIDs[parentID]; visible {
				filtered = append(filtered, candidate)
			}
		}
		return json.Marshal(filtered)
	case "mapConfigs":
		var values map[string]json.RawMessage
		if err := json.Unmarshal(record.Value, &values); err != nil || values == nil {
			return nil, fmt.Errorf("mapConfigs must be an object")
		}
		for mapID := range values {
			const prefix = "local-"
			if !strings.HasPrefix(mapID, prefix) {
				continue
			}
			if _, visible := locationIDs[mapID[len(prefix):]]; !visible {
				delete(values, mapID)
			}
		}
		return json.Marshal(values)
	default:
		return append(json.RawMessage(nil), record.Value...), nil
	}
}

func transformObject(
	value json.RawMessage,
	transform func(map[string]any),
) (json.RawMessage, error) {
	object, err := objectValue(value)
	if err != nil {
		return nil, err
	}
	transform(object)
	return json.Marshal(object)
}

func objectValue(value json.RawMessage) (map[string]any, error) {
	var object map[string]any
	if err := json.Unmarshal(value, &object); err != nil || object == nil {
		return nil, fmt.Errorf("record value must be an object")
	}
	return object, nil
}

func removeInvalidScalar(value map[string]any, field string, visible map[string]struct{}) {
	id, ok := value[field].(string)
	if !ok || id == "" {
		return
	}
	if _, exists := visible[id]; !exists {
		delete(value, field)
	}
}

func filterStringArray(value map[string]any, field string, visible map[string]struct{}) {
	current, ok := value[field].([]any)
	if !ok {
		return
	}
	filtered := make([]any, 0, len(current))
	for _, candidate := range current {
		id, ok := candidate.(string)
		if !ok {
			continue
		}
		if _, exists := visible[id]; exists {
			filtered = append(filtered, id)
		}
	}
	if len(filtered) != len(current) {
		value[field] = filtered
	}
}

func filterObjectArrayByID(
	value map[string]any,
	field string,
	idField string,
	visible map[string]struct{},
) {
	current, ok := value[field].([]any)
	if !ok {
		return
	}
	filtered := make([]any, 0, len(current))
	for _, candidate := range current {
		object, ok := candidate.(map[string]any)
		if !ok {
			continue
		}
		id, _ := object[idField].(string)
		if _, exists := visible[id]; exists {
			filtered = append(filtered, candidate)
		}
	}
	if len(filtered) != len(current) {
		value[field] = filtered
	}
}

func closePetOwner(
	value map[string]any,
	ids map[campaign.Collection]map[string]struct{},
) {
	ownerType, _ := value["ownerType"].(string)
	ownerID, _ := value["ownerId"].(string)
	var visible map[string]struct{}
	switch ownerType {
	case "character":
		visible = ids[campaign.Characters]
	case "faction":
		visible = ids[campaign.Factions]
	default:
		return
	}
	if ownerID == "" {
		return
	}
	if _, exists := visible[ownerID]; !exists {
		value["ownerType"] = "none"
		value["ownerId"] = ""
	}
}

func closeAuditReferences(value map[string]any, hidden map[string]struct{}) {
	lastChange, ok := value["lastChange"].(map[string]any)
	if !ok {
		return
	}
	fields, ok := lastChange["fields"].([]any)
	if !ok {
		return
	}
	filtered := make([]any, 0, len(fields))
	for _, candidate := range fields {
		change, ok := candidate.(map[string]any)
		if !ok {
			filtered = append(filtered, candidate)
			continue
		}
		from, _ := change["from"].(string)
		to, _ := change["to"].(string)
		_, hidesFrom := hidden[from]
		_, hidesTo := hidden[to]
		if !hidesFrom && !hidesTo {
			filtered = append(filtered, candidate)
		}
	}
	if len(filtered) != len(fields) {
		lastChange["fields"] = filtered
	}
}

func projectionError(record campaign.Record, err error) error {
	return fmt.Errorf("project %s:%s: %w", record.Collection, record.Key, err)
}
