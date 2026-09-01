package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

var (
	ErrEnumInUse              = errors.New("campaign enum item is in use")
	ErrEnumItemMissing        = errors.New("campaign enum item does not exist")
	ErrEnumReplacementMissing = errors.New("campaign enum replacement does not exist")
)

type EnumDeleteMode string

const (
	EnumRejectIfUsed EnumDeleteMode = "reject-if-used"
	EnumReplace      EnumDeleteMode = "replace"
	EnumClear        EnumDeleteMode = "clear"
)

type EnumDeleteRequest struct {
	Category         string
	ItemID           string
	ExpectedRevision int64
	Mode             EnumDeleteMode
	ReplacementID    string
}

type EnumDeleteResult struct {
	UsageCount int
	Commit     campaign.Commit
}

type enumBinding struct {
	collection campaign.Collection
	field      string
	array      bool
}

var enumBindings = map[string][]enumBinding{
	"relationshipTypes": {{collection: campaign.Relationships, field: "type"}},
	"genders":           {{collection: campaign.Characters, field: "gender"}},
	"pinTypes":          {{collection: campaign.Locations, field: "pinType"}},
	"characterStatuses": {{collection: campaign.Characters, field: "status"}},
	"eventPriorities":   {{collection: campaign.Events, field: "priority"}},
	"attitudes": {
		{collection: campaign.Characters, field: "attitudes", array: true},
		{collection: campaign.Locations, field: "attitudes", array: true},
		{collection: campaign.Factions, field: "attitudes", array: true},
	},
}

func (service *Service) DeleteEnumItem(
	ctx context.Context,
	authority MutationAuthority,
	request EnumDeleteRequest,
) (EnumDeleteResult, error) {
	if service == nil || service.repository == nil || authority.Role != WriteDM || authority.ActorID == "" {
		return EnumDeleteResult{}, ErrInvalidAuthority
	}
	bindings, supported := enumBindings[request.Category]
	if !supported || request.ItemID == "" || request.ExpectedRevision < 1 {
		return EnumDeleteResult{}, campaign.ErrInvalidTransaction
	}
	if request.Mode != EnumRejectIfUsed && request.Mode != EnumReplace && request.Mode != EnumClear {
		return EnumDeleteResult{}, campaign.ErrInvalidTransaction
	}
	if request.Mode == EnumReplace {
		if request.ReplacementID == "" || request.ReplacementID == request.ItemID {
			return EnumDeleteResult{}, campaign.ErrInvalidTransaction
		}
	} else if request.ReplacementID != "" {
		return EnumDeleteResult{}, campaign.ErrInvalidTransaction
	}

	snapshot, err := service.repository.Snapshot(ctx, true)
	if err != nil {
		return EnumDeleteResult{}, fmt.Errorf("read enum mutation snapshot: %w", err)
	}
	planner := newMutationPlanner(snapshot, service.now)
	settings, found := planner.record(campaign.Settings, request.Category)
	if !found {
		return EnumDeleteResult{}, ErrEnumItemMissing
	}
	if settings.Revision != request.ExpectedRevision {
		return EnumDeleteResult{}, &campaign.ConflictError{
			Collection: campaign.Settings, Key: request.Category,
			Expected: request.ExpectedRevision, Actual: settings.Revision,
		}
	}
	definitions, err := enumDefinitions(settings.Value)
	if err != nil {
		return EnumDeleteResult{}, err
	}
	if !containsEnumDefinition(definitions, request.ItemID) {
		return EnumDeleteResult{}, ErrEnumItemMissing
	}
	if request.Mode == EnumReplace && !containsEnumDefinition(definitions, request.ReplacementID) {
		return EnumDeleteResult{}, ErrEnumReplacementMissing
	}

	usageCount, err := countEnumUsages(planner, bindings, request.ItemID)
	if err != nil {
		return EnumDeleteResult{}, err
	}
	if usageCount > 0 && request.Mode == EnumRejectIfUsed {
		return EnumDeleteResult{}, fmt.Errorf("%w: %d record(s)", ErrEnumInUse, usageCount)
	}
	if request.Mode == EnumReplace || request.Mode == EnumClear {
		replacement := request.ReplacementID
		for _, binding := range bindings {
			if err := planner.updateEachObject(binding.collection, true, func(value map[string]any) bool {
				if binding.array {
					return replaceEnumArray(value, binding.field, request.ItemID, replacement)
				}
				if value[binding.field] != request.ItemID {
					return false
				}
				value[binding.field] = replacement
				return true
			}); err != nil {
				return EnumDeleteResult{}, err
			}
		}
	}

	filtered := make([]any, 0, len(definitions)-1)
	for _, definition := range definitions {
		value, _ := definition.(map[string]any)
		if value["id"] != request.ItemID {
			filtered = append(filtered, definition)
		}
	}
	settingsBody, _ := json.Marshal(filtered)
	if err := planner.applyRequested(WriteDM, campaign.Mutation{
		Kind: campaign.Put, Collection: campaign.Settings, Key: request.Category,
		Value: settingsBody, ExpectedRevision: request.ExpectedRevision,
	}); err != nil {
		return EnumDeleteResult{}, err
	}

	tombstoneKey := "settings:" + request.Category + ":" + request.ItemID
	tombstoneRevision := int64(0)
	if tombstone, exists := planner.record(campaign.DeletedDefaults, tombstoneKey); exists {
		tombstoneRevision = tombstone.Revision
	}
	if err := planner.applyRequested(WriteDM, campaign.Mutation{
		Kind: campaign.Put, Collection: campaign.DeletedDefaults, Key: tombstoneKey,
		Value: json.RawMessage("true"), ExpectedRevision: tombstoneRevision,
	}); err != nil {
		return EnumDeleteResult{}, err
	}

	transaction, err := planner.transaction(authority.ActorID)
	if err != nil {
		return EnumDeleteResult{}, err
	}
	commit, err := service.repository.Transact(ctx, transaction)
	if err != nil {
		return EnumDeleteResult{}, err
	}
	return EnumDeleteResult{UsageCount: usageCount, Commit: commit}, nil
}

func enumDefinitions(body json.RawMessage) ([]any, error) {
	var definitions []any
	if err := json.Unmarshal(body, &definitions); err != nil || definitions == nil {
		return nil, fmt.Errorf("%w: enum category must be an array", campaign.ErrInvalidRecord)
	}
	for _, candidate := range definitions {
		value, ok := candidate.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%w: enum definition must be an object", campaign.ErrInvalidRecord)
		}
		id, _ := value["id"].(string)
		if id == "" {
			return nil, fmt.Errorf("%w: enum definition requires an id", campaign.ErrInvalidRecord)
		}
	}
	return definitions, nil
}

func containsEnumDefinition(definitions []any, id string) bool {
	for _, candidate := range definitions {
		value, _ := candidate.(map[string]any)
		if value["id"] == id {
			return true
		}
	}
	return false
}

func countEnumUsages(planner *mutationPlanner, bindings []enumBinding, id string) (int, error) {
	count := 0
	for _, binding := range bindings {
		for _, record := range planner.records(binding.collection) {
			value, err := objectValue(record.Value)
			if err != nil {
				return 0, fmt.Errorf("read %s:%s enum usage: %w", record.Collection, record.Key, err)
			}
			if (binding.array && enumArrayContains(value[binding.field], id)) ||
				(!binding.array && value[binding.field] == id) {
				count++
			}
		}
	}
	return count, nil
}

func enumArrayContains(value any, id string) bool {
	values, _ := value.([]any)
	for _, candidate := range values {
		if candidate == id {
			return true
		}
		if object, ok := candidate.(map[string]any); ok && object["id"] == id {
			return true
		}
	}
	return false
}

func replaceEnumArray(value map[string]any, field, oldID, newID string) bool {
	values, ok := value[field].([]any)
	if !ok {
		return false
	}
	changed := false
	seen := make(map[string]struct{})
	result := make([]any, 0, len(values))
	for _, candidate := range values {
		id := ""
		switch item := candidate.(type) {
		case string:
			id = item
		case map[string]any:
			id, _ = item["id"].(string)
		}
		if id != oldID {
			if id != "" {
				if _, duplicate := seen[id]; duplicate {
					changed = true
					continue
				}
				seen[id] = struct{}{}
			}
			result = append(result, candidate)
			continue
		}
		changed = true
		if newID == "" {
			continue
		}
		if _, duplicate := seen[newID]; duplicate {
			continue
		}
		seen[newID] = struct{}{}
		if item, ok := candidate.(map[string]any); ok {
			clone := cloneObject(item)
			clone["id"] = newID
			result = append(result, clone)
		} else {
			result = append(result, newID)
		}
	}
	if changed {
		value[field] = result
	}
	return changed
}
