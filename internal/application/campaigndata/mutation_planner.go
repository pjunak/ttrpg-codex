package campaigndata

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

type plannedChange struct {
	expected  int64
	requested bool
	kind      campaign.OperationKind
	role      WriteRole
}

type mutationPlanner struct {
	original       map[string]campaign.Record
	current        map[string]campaign.Record
	recordOrder    []string
	changes        map[string]plannedChange
	changeOrder    []string
	requestedOrder []string
	updatedAt      int64
}

func newMutationPlanner(snapshot campaign.Snapshot, now func() time.Time) *mutationPlanner {
	original := make(map[string]campaign.Record, len(snapshot.Records))
	current := make(map[string]campaign.Record, len(snapshot.Records))
	order := make([]string, 0, len(snapshot.Records))
	for _, record := range snapshot.Records {
		target := mutationTarget(record.Collection, record.Key)
		cloned := record
		cloned.Value = append(json.RawMessage(nil), record.Value...)
		original[target] = cloned
		current[target] = cloned
		order = append(order, target)
	}
	return &mutationPlanner{
		original: original, current: current, recordOrder: order,
		changes: make(map[string]plannedChange), updatedAt: now().UTC().UnixMilli(),
	}
}

func (planner *mutationPlanner) applyRequested(role WriteRole, mutation campaign.Mutation) error {
	target := mutationTarget(mutation.Collection, mutation.Key)
	if change, duplicate := planner.changes[target]; duplicate && change.requested {
		return fmt.Errorf("%w: duplicate mutation target", campaign.ErrInvalidTransaction)
	}
	descriptor, ok := campaign.Describe(mutation.Collection)
	if !ok {
		return campaign.ErrInvalidCollection
	}
	if err := campaign.ValidateKey(descriptor, mutation.Key); err != nil {
		return err
	}
	if mutation.ExpectedRevision < 0 {
		return campaign.ErrInvalidTransaction
	}
	existing, found := planner.current[target]
	if role == WritePlayer && descriptor.DMOnlyWrite {
		return forbiddenMutation(mutation)
	}
	if role == WritePlayer && found && existing.Visibility == campaign.VisibilityDM {
		return campaign.ErrNotFound
	}

	switch mutation.Kind {
	case campaign.Put:
		requestedValue := mutation.Value
		if role == WritePlayer && found {
			var err error
			requestedValue, err = planner.preserveUnavailablePlayerReferences(existing, requestedValue)
			if err != nil {
				return fmt.Errorf("preserve %s:%s references: %w", mutation.Collection, mutation.Key, err)
			}
		}
		value, err := prepareRecordWrite(role, descriptor, existing, found, requestedValue)
		if err != nil {
			return fmt.Errorf("prepare %s:%s: %w", mutation.Collection, mutation.Key, err)
		}
		if descriptor.VisibilityBearing {
			object, err := objectValue(value)
			if err != nil {
				return err
			}
			// All record editors share the server clock, including player writes.
			object["updatedAt"] = planner.updatedAt
			value, err = json.Marshal(object)
			if err != nil {
				return err
			}
		}
		normalized, visibility, err := campaign.NormalizeRecord(descriptor, mutation.Key, value)
		if err != nil {
			return err
		}
		record := existing
		if !found {
			record = campaign.Record{Collection: mutation.Collection, Key: mutation.Key}
			planner.recordOrder = append(planner.recordOrder, target)
		}
		record.Value = normalized
		record.Visibility = visibility
		planner.current[target] = record
	case campaign.Delete:
		if len(mutation.Value) != 0 || mutation.ExpectedRevision == 0 {
			return campaign.ErrInvalidTransaction
		}
		if !found {
			return campaign.ErrNotFound
		}
		delete(planner.current, target)
	default:
		return campaign.ErrInvalidTransaction
	}
	planner.markRequested(target, mutation, role)
	return nil
}

func (planner *mutationPlanner) applyDerivedPolicies() error {
	if err := planner.validatePlayerReferences(); err != nil {
		return err
	}
	for _, target := range planner.requestedOrder {
		change := planner.changes[target]
		if change.kind != campaign.Delete {
			continue
		}
		deleted := planner.original[target]
		if err := planner.clearTwin(deleted); err != nil {
			return err
		}
		switch deleted.Collection {
		case campaign.Characters:
			if err := planner.deleteCharacterReferences(deleted.Key); err != nil {
				return err
			}
		case campaign.Locations:
			if err := planner.deleteLocationReferences(deleted.Key); err != nil {
				return err
			}
		case campaign.Factions:
			if err := planner.deleteFactionReferences(deleted.Key); err != nil {
				return err
			}
		}
	}
	for _, target := range planner.requestedOrder {
		change := planner.changes[target]
		record, exists := planner.current[target]
		if change.kind == campaign.Put && exists && record.Collection == campaign.Locations {
			if err := planner.synchronizeLocation(record.Key, change.role); err != nil {
				return err
			}
		}
	}
	return nil
}

func (planner *mutationPlanner) validatePlayerReferences() error {
	ids, err := planner.visibleIdentityIDs()
	if err != nil {
		return err
	}
	targetKinds, err := planner.relationshipTargetKinds()
	if err != nil {
		return err
	}
	for _, target := range planner.requestedOrder {
		change := planner.changes[target]
		record, exists := planner.current[target]
		if !exists || change.kind != campaign.Put || change.role != WritePlayer {
			continue
		}
		if record.Collection == campaign.DeletedDefaults {
			continue
		}
		value, err := objectValue(record.Value)
		if err != nil {
			return err
		}
		originalValue := map[string]any{}
		if original, found := planner.original[target]; found {
			originalValue, err = objectValue(original.Value)
			if err != nil {
				return err
			}
		}
		valid := true
		switch record.Collection {
		case campaign.Characters:
			valid = validScalarReference(value["faction"], preservedReferenceIDs(ids[campaign.Factions], originalValue["faction"]), "neutral", "party") &&
				validScalarReference(value["location"], preservedReferenceIDs(ids[campaign.Locations], originalValue["location"])) &&
				validObjectReferences(value["locationRoles"], "locationId", preservedObjectReferenceIDs(ids[campaign.Locations], originalValue["locationRoles"], "locationId"))
		case campaign.Locations:
			valid = validScalarReference(value["parentId"], preservedReferenceIDs(ids[campaign.Locations], originalValue["parentId"])) &&
				validStringReferences(value["characters"], preservedStringReferenceIDs(ids[campaign.Characters], originalValue["characters"]))
		case campaign.Events, campaign.Mysteries, campaign.HistoricalEvents:
			valid = validStringReferences(value["characters"], preservedStringReferenceIDs(ids[campaign.Characters], originalValue["characters"])) &&
				validStringReferences(value["locations"], preservedStringReferenceIDs(ids[campaign.Locations], originalValue["locations"]))
			if record.Collection == campaign.Events {
				valid = valid && validScalarReference(value["mapParentId"], preservedReferenceIDs(ids[campaign.Locations], originalValue["mapParentId"]))
			}
		case campaign.Artifacts:
			valid = validScalarReference(value["ownerCharacterId"], preservedReferenceIDs(ids[campaign.Characters], originalValue["ownerCharacterId"])) &&
				validScalarReference(value["locationId"], preservedReferenceIDs(ids[campaign.Locations], originalValue["locationId"]))
		case campaign.Pets:
			ownerType, _ := value["ownerType"].(string)
			originalOwnerType, _ := originalValue["ownerType"].(string)
			originalOwnerID := any(nil)
			if ownerType == originalOwnerType {
				originalOwnerID = originalValue["ownerId"]
			}
			switch ownerType {
			case "", "none", "party":
			case "character":
				valid = validScalarReference(value["ownerId"], preservedReferenceIDs(ids[campaign.Characters], originalOwnerID))
			case "faction":
				valid = validScalarReference(value["ownerId"], preservedReferenceIDs(ids[campaign.Factions], originalOwnerID))
			default:
				valid = false
			}
		case campaign.Relationships:
			typeID, _ := value["type"].(string)
			targetCollection := targetKinds[typeID]
			if targetCollection == "" {
				targetCollection = campaign.Characters
			}
			valid = validScalarReference(value["source"], ids[campaign.Characters]) &&
				validScalarReference(value["target"], ids[targetCollection])
		}
		if !valid {
			return fmt.Errorf(
				"%w: player %s record contains an unavailable reference",
				campaign.ErrInvalidRecord,
				record.Collection,
			)
		}
	}
	return nil
}

// preserveUnavailablePlayerReferences puts role-filtered references back before
// a full-record player write. A player can edit the visible part of a record,
// but cannot intentionally clear, replace, or probe a reference they were not
// allowed to receive in the campaign projection.
func (planner *mutationPlanner) preserveUnavailablePlayerReferences(
	existing campaign.Record,
	incomingRaw json.RawMessage,
) (json.RawMessage, error) {
	incoming, err := objectValue(incomingRaw)
	if err != nil {
		return nil, err
	}
	current, err := objectValue(existing.Value)
	if err != nil {
		return nil, err
	}
	ids, err := planner.visibleIdentityIDs()
	if err != nil {
		return nil, err
	}

	switch existing.Collection {
	case campaign.Characters:
		preserveUnavailableScalar(incoming, current, "faction", ids[campaign.Factions], "neutral", "party")
		preserveUnavailableScalar(incoming, current, "location", ids[campaign.Locations])
		preserveUnavailableObjects(incoming, current, "locationRoles", "locationId", ids[campaign.Locations])
	case campaign.Locations:
		preserveUnavailableMapPlacement(incoming, current, "parentId", "x", "y", ids[campaign.Locations])
		preserveUnavailableStrings(incoming, current, "characters", ids[campaign.Characters])
	case campaign.Events, campaign.Mysteries, campaign.HistoricalEvents:
		preserveUnavailableStrings(incoming, current, "characters", ids[campaign.Characters])
		preserveUnavailableStrings(incoming, current, "locations", ids[campaign.Locations])
		if existing.Collection == campaign.Events {
			preserveUnavailableMapPlacement(incoming, current, "mapParentId", "mapX", "mapY", ids[campaign.Locations])
		}
	case campaign.Artifacts:
		preserveUnavailableScalar(incoming, current, "ownerCharacterId", ids[campaign.Characters])
		preserveUnavailableScalar(incoming, current, "locationId", ids[campaign.Locations])
	case campaign.Pets:
		preserveUnavailableOwner(incoming, current, ids)
	}

	body, err := json.Marshal(incoming)
	if err != nil {
		return nil, campaign.ErrInvalidRecord
	}
	return body, nil
}

func (planner *mutationPlanner) visibleIdentityIDs() (
	map[campaign.Collection]map[string]struct{},
	error,
) {
	collections := []campaign.Collection{
		campaign.Characters, campaign.Locations, campaign.Events,
		campaign.Mysteries, campaign.Factions, campaign.Pantheon,
		campaign.Artifacts, campaign.HistoricalEvents,
	}
	result := make(map[campaign.Collection]map[string]struct{}, len(collections))
	for _, collection := range collections {
		result[collection] = make(map[string]struct{})
		for _, record := range planner.records(collection) {
			if record.Visibility != campaign.VisibilityPublic {
				continue
			}
			result[collection][record.Key] = struct{}{}
			if collection == campaign.Factions {
				value, err := objectValue(record.Value)
				if err != nil {
					return nil, err
				}
				if id, ok := value["id"].(string); ok && id != "" {
					result[collection][id] = struct{}{}
				}
			}
		}
	}
	return result, nil
}

func (planner *mutationPlanner) transaction(actorID string) (campaign.Transaction, error) {
	if err := planner.prepareActivity(); err != nil {
		return campaign.Transaction{}, err
	}
	mutations := make([]campaign.Mutation, 0, len(planner.changes))
	for _, target := range planner.changeOrder {
		change := planner.changes[target]
		original, originallyExists := planner.original[target]
		current, currentlyExists := planner.current[target]
		if !originallyExists && !currentlyExists {
			if change.requested {
				return campaign.Transaction{}, fmt.Errorf(
					"%w: requested record was removed by compound policy",
					campaign.ErrInvalidTransaction,
				)
			}
			continue
		}
		if originallyExists && currentlyExists && !change.requested && bytes.Equal(original.Value, current.Value) {
			continue
		}
		mutation := campaign.Mutation{
			Collection: current.Collection, Key: current.Key,
			ExpectedRevision: change.expected,
		}
		if !currentlyExists {
			mutation.Kind = campaign.Delete
			mutation.Collection = original.Collection
			mutation.Key = original.Key
		} else {
			mutation.Kind = campaign.Put
			mutation.Value = append(json.RawMessage(nil), current.Value...)
		}
		mutations = append(mutations, mutation)
	}
	if len(mutations) == 0 || len(mutations) > MaximumRequestedMutations {
		return campaign.Transaction{}, fmt.Errorf(
			"%w: compound plan contains %d mutations",
			campaign.ErrInvalidTransaction,
			len(mutations),
		)
	}
	return campaign.Transaction{ActorID: actorID, Mutations: mutations}, nil
}

func (planner *mutationPlanner) receipt(commit campaign.Commit) campaign.Commit {
	results := make([]campaign.MutationResult, 0, len(planner.requestedOrder))
	requested := make(map[string]struct{}, len(planner.requestedOrder))
	for _, target := range planner.requestedOrder {
		requested[target] = struct{}{}
	}
	for _, result := range commit.Results {
		if _, ok := requested[mutationTarget(result.Collection, result.Key)]; ok {
			results = append(results, result)
		}
	}
	commit.Results = results
	return commit
}

func (planner *mutationPlanner) markRequested(
	target string,
	mutation campaign.Mutation,
	role WriteRole,
) {
	if _, exists := planner.changes[target]; !exists {
		planner.changeOrder = append(planner.changeOrder, target)
	}
	planner.changes[target] = plannedChange{
		expected: mutation.ExpectedRevision, requested: true,
		kind: mutation.Kind, role: role,
	}
	planner.requestedOrder = append(planner.requestedOrder, target)
}

func (planner *mutationPlanner) markDerived(target string) {
	if _, exists := planner.changes[target]; exists {
		return
	}
	original, exists := planner.original[target]
	if !exists {
		return
	}
	planner.changes[target] = plannedChange{expected: original.Revision}
	planner.changeOrder = append(planner.changeOrder, target)
}

func (planner *mutationPlanner) clearTwin(deleted campaign.Record) error {
	value, err := objectValue(deleted.Value)
	if err != nil {
		return nil
	}
	twinID, ok := value["linkedTwinId"].(string)
	if !ok || twinID == "" {
		return nil
	}
	twin, exists := planner.record(deleted.Collection, twinID)
	if !exists {
		return nil
	}
	twinValue, err := objectValue(twin.Value)
	if err != nil {
		return err
	}
	if linkedID, linked := twinValue["linkedTwinId"].(string); linked &&
		linkedID != "" && linkedID != deleted.Key {
		return fmt.Errorf("%w: twin link is not reciprocal", ErrManagedCampaignField)
	}
	return planner.updateObject(twin.Collection, twin.Key, true, func(value map[string]any) bool {
		if _, exists := value["linkedTwinId"]; !exists {
			return false
		}
		delete(value, "linkedTwinId")
		return true
	})
}

func (planner *mutationPlanner) deleteCharacterReferences(id string) error {
	targetKinds, err := planner.relationshipTargetKinds()
	if err != nil {
		return err
	}
	for _, record := range planner.records(campaign.Relationships) {
		value, err := objectValue(record.Value)
		if err != nil {
			return err
		}
		source, _ := value["source"].(string)
		target, _ := value["target"].(string)
		typeID, _ := value["type"].(string)
		if source == id || targetKinds[typeID] != campaign.Locations && target == id {
			if err := planner.deleteDerived(record); err != nil {
				return err
			}
		}
	}
	for _, collection := range []campaign.Collection{
		campaign.Events, campaign.Mysteries, campaign.HistoricalEvents,
	} {
		if err := planner.updateEachObject(collection, true, func(value map[string]any) bool {
			return removeString(value, "characters", id)
		}); err != nil {
			return err
		}
	}
	if err := planner.updateEachObject(campaign.Locations, true, func(value map[string]any) bool {
		return removeString(value, "characters", id)
	}); err != nil {
		return err
	}
	if err := planner.updateEachObject(campaign.Artifacts, true, func(value map[string]any) bool {
		if value["ownerCharacterId"] != id {
			return false
		}
		value["ownerCharacterId"] = ""
		return true
	}); err != nil {
		return err
	}
	return planner.updateEachObject(campaign.Pets, false, func(value map[string]any) bool {
		if value["ownerType"] != "character" || value["ownerId"] != id {
			return false
		}
		value["ownerType"] = "none"
		value["ownerId"] = ""
		return true
	})
}

func (planner *mutationPlanner) deleteLocationReferences(id string) error {
	targetKinds, err := planner.relationshipTargetKinds()
	if err != nil {
		return err
	}
	for _, record := range planner.records(campaign.Relationships) {
		value, err := objectValue(record.Value)
		if err != nil {
			return err
		}
		target, _ := value["target"].(string)
		typeID, _ := value["type"].(string)
		if targetKinds[typeID] == campaign.Locations && target == id {
			if err := planner.deleteDerived(record); err != nil {
				return err
			}
		}
	}
	if err := planner.updateEachObject(campaign.Locations, true, func(value map[string]any) bool {
		changed := removeString(value, "connections", id)
		if value["parentId"] == id {
			value["parentId"] = ""
			changed = true
		}
		return changed
	}); err != nil {
		return err
	}
	if err := planner.updateEachObject(campaign.Characters, true, func(value map[string]any) bool {
		changed := false
		if value["location"] == id {
			value["location"] = ""
			changed = true
		}
		return filterObjectArray(value, "locationRoles", "locationId", id) || changed
	}); err != nil {
		return err
	}
	for _, collection := range []campaign.Collection{
		campaign.Events, campaign.Mysteries, campaign.HistoricalEvents,
	} {
		current := collection
		if err := planner.updateEachObject(collection, true, func(value map[string]any) bool {
			changed := removeString(value, "locations", id)
			if current == campaign.Events && value["mapParentId"] == id {
				delete(value, "mapParentId")
				delete(value, "mapX")
				delete(value, "mapY")
				changed = true
			}
			return changed
		}); err != nil {
			return err
		}
	}
	if err := planner.updateEachObject(campaign.Artifacts, true, func(value map[string]any) bool {
		if value["locationId"] != id {
			return false
		}
		value["locationId"] = ""
		return true
	}); err != nil {
		return err
	}
	return planner.removeLocationSettings(id)
}

func (planner *mutationPlanner) deleteFactionReferences(id string) error {
	if err := planner.updateEachObject(campaign.Characters, true, func(value map[string]any) bool {
		if value["faction"] != id {
			return false
		}
		value["faction"] = "neutral"
		value["rank"] = ""
		value["rankChain"] = ""
		return true
	}); err != nil {
		return err
	}
	return planner.updateEachObject(campaign.Pets, false, func(value map[string]any) bool {
		if value["ownerType"] != "faction" || value["ownerId"] != id {
			return false
		}
		value["ownerType"] = "none"
		value["ownerId"] = ""
		return true
	})
}

func (planner *mutationPlanner) synchronizeLocation(id string, role WriteRole) error {
	record, exists := planner.record(campaign.Locations, id)
	if !exists {
		return nil
	}
	value, err := objectValue(record.Value)
	if err != nil {
		return err
	}
	desired := stringSet(value["connections"])
	delete(desired, id)
	existingConnections := map[string]struct{}{}
	if original, exists := planner.original[mutationTarget(campaign.Locations, id)]; exists {
		originalValue, err := objectValue(original.Value)
		if err != nil {
			return err
		}
		existingConnections = stringSet(originalValue["connections"])
	}
	valid := make(map[string]struct{})
	for _, peer := range planner.records(campaign.Locations) {
		if peer.Key == id {
			continue
		}
		editable := role == WriteDM || peer.Visibility == campaign.VisibilityPublic
		_, requested := desired[peer.Key]
		_, preserved := existingConnections[peer.Key]
		connected := requested
		if !editable {
			connected = preserved
		}
		if connected {
			valid[peer.Key] = struct{}{}
		}
		if !editable {
			continue
		}
		if err := planner.updateObject(campaign.Locations, peer.Key, true, func(peerValue map[string]any) bool {
			return setStringMembership(peerValue, "connections", id, connected)
		}); err != nil {
			return err
		}
	}
	ordered := make([]any, 0, len(valid))
	for _, peer := range planner.records(campaign.Locations) {
		if _, ok := valid[peer.Key]; ok {
			ordered = append(ordered, peer.Key)
		}
	}
	if !equalStringArray(value["connections"], ordered) {
		value["connections"] = ordered
		return planner.storeObject(record, value, false)
	}
	return nil
}

func (planner *mutationPlanner) removeLocationSettings(id string) error {
	if record, exists := planner.record(campaign.Settings, "mapViews"); exists {
		var values []any
		if err := json.Unmarshal(record.Value, &values); err != nil {
			return fmt.Errorf("settings:mapViews is invalid")
		}
		filtered := make([]any, 0, len(values))
		for _, candidate := range values {
			value, ok := candidate.(map[string]any)
			if ok && value["parentId"] == id {
				continue
			}
			filtered = append(filtered, candidate)
		}
		if len(filtered) != len(values) {
			body, _ := json.Marshal(filtered)
			if err := planner.storeRaw(record, body); err != nil {
				return err
			}
		}
	}
	if record, exists := planner.record(campaign.Settings, "mapConfigs"); exists {
		var values map[string]any
		if err := json.Unmarshal(record.Value, &values); err != nil || values == nil {
			return fmt.Errorf("settings:mapConfigs is invalid")
		}
		key := "local-" + id
		if _, exists := values[key]; exists {
			delete(values, key)
			body, _ := json.Marshal(values)
			return planner.storeRaw(record, body)
		}
	}
	return nil
}

func (planner *mutationPlanner) relationshipTargetKinds() (map[string]campaign.Collection, error) {
	result := map[string]campaign.Collection{"mission": campaign.Locations}
	record, exists := planner.record(campaign.Settings, "relationshipTypes")
	if !exists {
		return result, nil
	}
	var values []any
	if err := json.Unmarshal(record.Value, &values); err != nil {
		return nil, fmt.Errorf("settings:relationshipTypes is invalid")
	}
	for _, candidate := range values {
		value, ok := candidate.(map[string]any)
		if !ok {
			continue
		}
		id, _ := value["id"].(string)
		if id == "" {
			continue
		}
		if value["target"] == "location" {
			result[id] = campaign.Locations
		} else {
			result[id] = campaign.Characters
		}
	}
	return result, nil
}

func (planner *mutationPlanner) updateEachObject(
	collection campaign.Collection,
	audit bool,
	update func(map[string]any) bool,
) error {
	for _, record := range planner.records(collection) {
		if err := planner.updateObject(collection, record.Key, audit, update); err != nil {
			return err
		}
	}
	return nil
}

func (planner *mutationPlanner) updateObject(
	collection campaign.Collection,
	key string,
	audit bool,
	update func(map[string]any) bool,
) error {
	record, exists := planner.record(collection, key)
	if !exists {
		return nil
	}
	value, err := objectValue(record.Value)
	if err != nil {
		return err
	}
	if !update(value) {
		return nil
	}
	return planner.storeObject(record, value, audit)
}

func (planner *mutationPlanner) storeObject(
	record campaign.Record,
	value map[string]any,
	audit bool,
) error {
	value["updatedAt"] = planner.updatedAt
	if audit {
		value["lastChange"] = map[string]any{"refs": true}
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return planner.storeRaw(record, body)
}

func (planner *mutationPlanner) storeRaw(record campaign.Record, value json.RawMessage) error {
	descriptor, _ := campaign.Describe(record.Collection)
	normalized, visibility, err := campaign.NormalizeRecord(descriptor, record.Key, value)
	if err != nil {
		return err
	}
	record.Value = normalized
	record.Visibility = visibility
	target := mutationTarget(record.Collection, record.Key)
	planner.current[target] = record
	planner.markDerived(target)
	return nil
}

func (planner *mutationPlanner) deleteDerived(record campaign.Record) error {
	target := mutationTarget(record.Collection, record.Key)
	if change, requested := planner.changes[target]; requested && change.requested && change.kind == campaign.Put {
		return fmt.Errorf("%w: requested record references a deleted entity", campaign.ErrInvalidTransaction)
	}
	delete(planner.current, target)
	planner.markDerived(target)
	return nil
}

func (planner *mutationPlanner) record(
	collection campaign.Collection,
	key string,
) (campaign.Record, bool) {
	record, exists := planner.current[mutationTarget(collection, key)]
	return record, exists
}

func (planner *mutationPlanner) records(collection campaign.Collection) []campaign.Record {
	result := make([]campaign.Record, 0)
	seen := make(map[string]struct{})
	for _, target := range planner.recordOrder {
		record, exists := planner.current[target]
		if !exists || record.Collection != collection {
			continue
		}
		result = append(result, record)
		seen[target] = struct{}{}
	}
	// Defensive determinism if a future derived policy creates a record without
	// first appending it to recordOrder.
	extra := make([]string, 0)
	for target, record := range planner.current {
		if record.Collection == collection {
			if _, exists := seen[target]; !exists {
				extra = append(extra, target)
			}
		}
	}
	sort.Strings(extra)
	for _, target := range extra {
		result = append(result, planner.current[target])
	}
	return result
}

func removeString(value map[string]any, field, id string) bool {
	values, ok := value[field].([]any)
	if !ok {
		return false
	}
	filtered := make([]any, 0, len(values))
	changed := false
	for _, candidate := range values {
		if candidate == id {
			changed = true
			continue
		}
		filtered = append(filtered, candidate)
	}
	if changed {
		value[field] = filtered
	}
	return changed
}

func filterObjectArray(value map[string]any, field, idField, id string) bool {
	values, ok := value[field].([]any)
	if !ok {
		return false
	}
	filtered := make([]any, 0, len(values))
	changed := false
	for _, candidate := range values {
		object, ok := candidate.(map[string]any)
		if ok && object[idField] == id {
			changed = true
			continue
		}
		filtered = append(filtered, candidate)
	}
	if changed {
		value[field] = filtered
	}
	return changed
}

func stringSet(value any) map[string]struct{} {
	result := make(map[string]struct{})
	values, _ := value.([]any)
	for _, candidate := range values {
		if id, ok := candidate.(string); ok && id != "" {
			result[id] = struct{}{}
		}
	}
	return result
}

func setStringMembership(value map[string]any, field, id string, present bool) bool {
	values := stringSet(value[field])
	_, exists := values[id]
	if present == exists {
		return false
	}
	if present {
		values[id] = struct{}{}
	} else {
		delete(values, id)
	}
	ordered := make([]string, 0, len(values))
	for candidate := range values {
		ordered = append(ordered, candidate)
	}
	sort.Strings(ordered)
	result := make([]any, len(ordered))
	for index, candidate := range ordered {
		result[index] = candidate
	}
	value[field] = result
	return true
}

func equalStringArray(value any, expected []any) bool {
	current, ok := value.([]any)
	if !ok || len(current) != len(expected) {
		return false
	}
	for index := range current {
		if current[index] != expected[index] {
			return false
		}
	}
	return true
}

func preserveUnavailableMapPlacement(incoming, current map[string]any, parent, x, y string, visible map[string]struct{}) {
	id, _ := current[parent].(string)
	if id == "" || validScalarReference(id, visible) {
		return
	}
	// Public saves omit this entire placement, not just its hidden parent.
	// Preserve it as a unit, including absence of coordinates on unplaced pins.
	for _, field := range []string{parent, x, y} {
		if value, exists := current[field]; exists {
			incoming[field] = value
		} else {
			delete(incoming, field)
		}
	}
}

func preserveUnavailableScalar(
	incoming,
	current map[string]any,
	field string,
	visible map[string]struct{},
	reserved ...string,
) {
	id, ok := current[field].(string)
	if !ok || id == "" || validScalarReference(id, visible, reserved...) {
		return
	}
	incoming[field] = id
}

func preserveUnavailableStrings(
	incoming,
	current map[string]any,
	field string,
	visible map[string]struct{},
) {
	preserved := unavailableStringReferences(current[field], visible)
	if len(preserved) == 0 {
		return
	}
	values, ok := incoming[field].([]any)
	if !ok && incoming[field] != nil {
		return
	}
	merged := make([]any, 0, len(values)+len(preserved))
	seen := make(map[string]struct{}, len(values)+len(preserved))
	for _, candidate := range values {
		id, ok := candidate.(string)
		if !ok {
			merged = append(merged, candidate)
			continue
		}
		if _, available := visible[id]; !available {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		merged = append(merged, id)
	}
	for _, id := range preserved {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		merged = append(merged, id)
	}
	incoming[field] = merged
}

func preserveUnavailableObjects(
	incoming,
	current map[string]any,
	field,
	idField string,
	visible map[string]struct{},
) {
	preserved := unavailableObjectReferences(current[field], idField, visible)
	if len(preserved) == 0 {
		return
	}
	values, ok := incoming[field].([]any)
	if !ok && incoming[field] != nil {
		return
	}
	merged := make([]any, 0, len(values)+len(preserved))
	seen := make(map[string]struct{}, len(values)+len(preserved))
	for _, candidate := range values {
		object, objectOK := candidate.(map[string]any)
		id, idOK := object[idField].(string)
		if !objectOK || !idOK {
			merged = append(merged, candidate)
			continue
		}
		if _, available := visible[id]; !available {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		merged = append(merged, object)
	}
	for _, object := range preserved {
		id, _ := object[idField].(string)
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		merged = append(merged, object)
	}
	incoming[field] = merged
}

func preserveUnavailableOwner(
	incoming,
	current map[string]any,
	visible map[campaign.Collection]map[string]struct{},
) {
	ownerType, _ := current["ownerType"].(string)
	ownerID, _ := current["ownerId"].(string)
	var allowed map[string]struct{}
	switch ownerType {
	case "character":
		allowed = visible[campaign.Characters]
	case "faction":
		allowed = visible[campaign.Factions]
	default:
		return
	}
	if ownerID == "" {
		return
	}
	if _, available := allowed[ownerID]; available {
		return
	}
	incoming["ownerType"] = ownerType
	incoming["ownerId"] = ownerID
}

func unavailableStringReferences(value any, visible map[string]struct{}) []string {
	values, _ := value.([]any)
	result := make([]string, 0, len(values))
	for _, candidate := range values {
		id, ok := candidate.(string)
		if !ok || id == "" {
			continue
		}
		if _, available := visible[id]; !available {
			result = append(result, id)
		}
	}
	return result
}

func unavailableObjectReferences(value any, idField string, visible map[string]struct{}) []map[string]any {
	values, _ := value.([]any)
	result := make([]map[string]any, 0, len(values))
	for _, candidate := range values {
		object, ok := candidate.(map[string]any)
		if !ok {
			continue
		}
		id, ok := object[idField].(string)
		if !ok || id == "" {
			continue
		}
		if _, available := visible[id]; !available {
			result = append(result, object)
		}
	}
	return result
}

func preservedReferenceIDs(visible map[string]struct{}, original any) map[string]struct{} {
	result := cloneReferenceIDs(visible)
	if id, ok := original.(string); ok && id != "" {
		result[id] = struct{}{}
	}
	return result
}

func preservedStringReferenceIDs(visible map[string]struct{}, original any) map[string]struct{} {
	result := cloneReferenceIDs(visible)
	values, _ := original.([]any)
	for _, candidate := range values {
		if id, ok := candidate.(string); ok && id != "" {
			result[id] = struct{}{}
		}
	}
	return result
}

func preservedObjectReferenceIDs(
	visible map[string]struct{},
	original any,
	idField string,
) map[string]struct{} {
	result := cloneReferenceIDs(visible)
	values, _ := original.([]any)
	for _, candidate := range values {
		object, ok := candidate.(map[string]any)
		if !ok {
			continue
		}
		if id, ok := object[idField].(string); ok && id != "" {
			result[id] = struct{}{}
		}
	}
	return result
}

func cloneReferenceIDs(values map[string]struct{}) map[string]struct{} {
	result := make(map[string]struct{}, len(values)+1)
	for id := range values {
		result[id] = struct{}{}
	}
	return result
}

func validScalarReference(
	value any,
	visible map[string]struct{},
	reserved ...string,
) bool {
	if value == nil || value == "" {
		return true
	}
	id, ok := value.(string)
	if !ok {
		return false
	}
	for _, candidate := range reserved {
		if id == candidate {
			return true
		}
	}
	_, exists := visible[id]
	return exists
}

func validStringReferences(value any, visible map[string]struct{}) bool {
	if value == nil {
		return true
	}
	values, ok := value.([]any)
	if !ok {
		return false
	}
	for _, candidate := range values {
		id, ok := candidate.(string)
		if !ok {
			return false
		}
		if _, exists := visible[id]; !exists {
			return false
		}
	}
	return true
}

func validObjectReferences(value any, idField string, visible map[string]struct{}) bool {
	if value == nil {
		return true
	}
	values, ok := value.([]any)
	if !ok {
		return false
	}
	for _, candidate := range values {
		object, ok := candidate.(map[string]any)
		if !ok || !validScalarReference(object[idField], visible) || object[idField] == "" {
			return false
		}
	}
	return true
}
