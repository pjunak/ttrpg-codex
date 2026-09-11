package campaigndata

import (
	"encoding/json"
	"reflect"
	"sort"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

const activityContract = "activity.v1"

type recordActivity struct {
	Kind   string   `json:"kind"`
	Fields []string `json:"fields"`
	At     int64    `json:"at"`
}

type storedActivity struct {
	Contract string          `json:"contractVersion"`
	DM       *recordActivity `json:"dm"`
	Public   *recordActivity `json:"public"`
}

// Summaries contain field identities only. Values and names are resolved from
// the reader's current projection, never retained in historical display text.
func (planner *mutationPlanner) prepareActivity() error {
	applicable := false
	for target := range planner.changes {
		for _, record := range []campaign.Record{planner.original[target], planner.current[target]} {
			descriptor, _ := campaign.Describe(record.Collection)
			applicable = applicable || descriptor.VisibilityBearing || record.Collection == campaign.Relationships
		}
	}
	if !applicable {
		return nil
	}
	sources := make(map[string]struct{})
	for target := range planner.changes {
		before, after := planner.original[target], planner.current[target]
		if before.Collection != campaign.Relationships && after.Collection != campaign.Relationships {
			continue
		}
		if reflect.DeepEqual(activityObject(before), activityObject(after)) {
			continue
		}
		for _, record := range []campaign.Record{before, after} {
			if source, ok := activityObject(record)["source"].(string); ok && source != "" {
				sources[source] = struct{}{}
			}
		}
	}
	ordered := make([]string, 0, len(sources))
	for source := range sources {
		ordered = append(ordered, source)
	}
	sort.Strings(ordered)
	for _, source := range ordered {
		if err := planner.updateObject(campaign.Characters, source, false, func(value map[string]any) bool { return true }); err != nil {
			return err
		}
	}
	beforePublic, err := projectPublic(activitySnapshot(planner.original))
	if err != nil {
		return err
	}
	afterPublic, err := projectPublic(activitySnapshot(planner.current))
	if err != nil {
		return err
	}
	publicBefore, publicAfter := activityRecords(beforePublic), activityRecords(afterPublic)
	dmRelationsBefore, dmRelationsAfter := activityRelationships(planner.original), activityRelationships(planner.current)
	publicRelationsBefore, publicRelationsAfter := activityRelationships(publicBefore), activityRelationships(publicAfter)
	for _, target := range planner.changeOrder {
		current, exists := planner.current[target]
		descriptor, _ := campaign.Describe(current.Collection)
		if !exists || !descriptor.VisibilityBearing {
			continue
		}
		original := planner.original[target]
		previous := readStoredActivity(original.Value)
		dmRelations := current.Collection == campaign.Characters && !reflect.DeepEqual(dmRelationsBefore[current.Key], dmRelationsAfter[current.Key])
		publicRelations := current.Collection == campaign.Characters && !reflect.DeepEqual(publicRelationsBefore[current.Key], publicRelationsAfter[current.Key])
		activity := storedActivity{Contract: activityContract,
			DM:     nextActivity(original, current, previous.DM, dmRelations, planner.updatedAt),
			Public: nextActivity(publicBefore[target], publicAfter[target], previous.Public, publicRelations, planner.updatedAt)}
		value, err := objectValue(current.Value)
		if err != nil {
			return err
		}
		value["lastChange"] = activity
		current.Value, err = json.Marshal(value)
		if err != nil {
			return err
		}
		planner.current[target] = current
	}
	return nil
}

func activitySnapshot(records map[string]campaign.Record) campaign.Snapshot {
	snapshot := campaign.Snapshot{Records: make([]campaign.Record, 0, len(records))}
	for _, record := range records {
		snapshot.Records = append(snapshot.Records, record)
	}
	return snapshot
}

func activityRecords(snapshot campaign.Snapshot) map[string]campaign.Record {
	records := make(map[string]campaign.Record, len(snapshot.Records))
	for _, record := range snapshot.Records {
		records[mutationTarget(record.Collection, record.Key)] = record
	}
	return records
}

func activityObject(record campaign.Record) map[string]any {
	value, _ := objectValue(record.Value)
	for _, key := range []string{"id", "updatedAt", "lastChange", "linkedTwinId"} {
		delete(value, key)
	}
	for key, item := range value {
		if item == nil || item == "" || item == false {
			delete(value, key)
			continue
		}
		switch typed := item.(type) {
		case []any:
			if len(typed) == 0 {
				delete(value, key)
			}
		case map[string]any:
			if len(typed) == 0 {
				delete(value, key)
			}
		}
	}
	return value
}

func activityRelationships(records map[string]campaign.Record) map[string]map[string]any {
	result := make(map[string]map[string]any)
	for _, record := range records {
		if record.Collection != campaign.Relationships {
			continue
		}
		value := activityObject(record)
		source, _ := value["source"].(string)
		if result[source] == nil {
			result[source] = make(map[string]any)
		}
		result[source][record.Key] = value
	}
	return result
}

func nextActivity(before, after campaign.Record, previous *recordActivity, relationships bool, at int64) *recordActivity {
	if after.Key == "" {
		return nil
	}
	if before.Key == "" {
		return &recordActivity{Kind: "created", Fields: []string{}, At: at}
	}
	old, current := activityObject(before), activityObject(after)
	keys := make(map[string]struct{})
	for key := range old {
		keys[key] = struct{}{}
	}
	for key := range current {
		keys[key] = struct{}{}
	}
	fields := make([]string, 0)
	for key := range keys {
		if len(key) <= 100 && !reflect.DeepEqual(old[key], current[key]) {
			fields = append(fields, key)
		}
	}
	if relationships {
		fields = append(fields, "relationships")
	}
	if len(fields) == 0 {
		if previous == nil && readStoredActivity(before.Value).Contract != activityContract {
			return activityFromSaveTime(before)
		}
		return previous
	}
	sort.Strings(fields)
	if len(fields) > 24 {
		fields = fields[:24]
	}
	return &recordActivity{Kind: "updated", Fields: fields, At: at}
}

// Preserve the existing generic activity row when a record first receives
// summary metadata through a no-op or a change invisible to this reader.
func activityFromSaveTime(record campaign.Record) *recordActivity {
	value, _ := objectValue(record.Value)
	var at int64
	switch timestamp := value["updatedAt"].(type) {
	case float64:
		if timestamp > 0 && timestamp <= 8_640_000_000_000_000 && timestamp == float64(int64(timestamp)) {
			at = int64(timestamp)
		}
	case string:
		if parsed, err := time.Parse(time.RFC3339Nano, timestamp); err == nil {
			at = parsed.UnixMilli()
		}
	}
	if at <= 0 {
		return nil
	}
	return &recordActivity{Kind: "updated", Fields: []string{}, At: at}
}

func readStoredActivity(raw json.RawMessage) storedActivity {
	var envelope struct {
		LastChange storedActivity `json:"lastChange"`
	}
	if json.Unmarshal(raw, &envelope) != nil || envelope.LastChange.Contract != activityContract {
		return storedActivity{}
	}
	return envelope.LastChange
}

func projectActivity(value map[string]any, role ViewRole) {
	stored, ok := value["lastChange"].(map[string]any)
	if !ok || stored["contractVersion"] != activityContract {
		return
	}
	key := "public"
	if role == ViewDM {
		key = "dm"
	}
	value["lastChange"] = map[string]any{"contractVersion": activityContract, "change": stored[key]}
}
