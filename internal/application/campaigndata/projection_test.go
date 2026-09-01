package campaigndata

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestPublicDatasetClosesReferencesWithoutChangingDMSnapshot(t *testing.T) {
	t.Parallel()
	snapshot := projectionFixture()
	service, err := New(&fakeRepository{snapshot: snapshot})
	if err != nil {
		t.Fatal(err)
	}

	public, err := service.Dataset(context.Background(), ViewPublic)
	if err != nil {
		t.Fatal(err)
	}
	assertRecordKeys(t, public, campaign.Characters, "alice")
	assertRecordKeys(t, public, campaign.Factions, "guild")
	assertRecordKeys(t, public, campaign.Locations, "town")
	assertRecordKeys(t, public, campaign.Relationships, "mission-visible", "custom-visible")

	alice := recordObject(t, public, campaign.Characters, "alice")
	assertMissing(t, alice, "linkedTwinId", "faction", "location")
	if roles := alice["locationRoles"].([]any); len(roles) != 1 ||
		roles[0].(map[string]any)["locationId"] != "town" {
		t.Fatalf("location roles were not closed: %#v", roles)
	}
	if fields := alice["lastChange"].(map[string]any)["fields"].([]any); len(fields) != 1 {
		t.Fatalf("hidden audit reference survived: %#v", fields)
	}

	town := recordObject(t, public, campaign.Locations, "town")
	assertMissing(t, town, "parentId")
	assertStrings(t, town["connections"], "town")
	assertStrings(t, town["characters"], "alice")

	event := recordObject(t, public, campaign.Events, "arrival")
	assertStrings(t, event["characters"], "alice")
	assertStrings(t, event["locations"], "town")
	assertMissing(t, event, "mapParentId")

	artifact := recordObject(t, public, campaign.Artifacts, "crown")
	assertMissing(t, artifact, "ownerCharacterId", "locationId")

	pet := recordObject(t, public, campaign.Pets, "owl")
	if pet["ownerType"] != "none" || pet["ownerId"] != "" {
		t.Fatalf("hidden pet owner survived: %#v", pet)
	}

	mapViews := recordValue(t, public, campaign.Settings, "mapViews").([]any)
	if len(mapViews) != 1 || mapViews[0].(map[string]any)["parentId"] != "town" {
		t.Fatalf("map views were not closed: %#v", mapViews)
	}
	mapConfigs := recordValue(t, public, campaign.Settings, "mapConfigs").(map[string]any)
	if len(mapConfigs) != 2 || mapConfigs["local-town"] == nil || mapConfigs["world"] == nil {
		t.Fatalf("map configs were not closed: %#v", mapConfigs)
	}

	dm, err := service.Dataset(context.Background(), ViewDM)
	if err != nil {
		t.Fatal(err)
	}
	assertRecordKeys(t, dm, campaign.Characters, "alice", "secret")
	if dmAlice := recordObject(t, dm, campaign.Characters, "alice"); dmAlice["linkedTwinId"] != "secret" || dmAlice["faction"] != "secret-faction" {
		t.Fatalf("DM record was projected: %#v", dmAlice)
	}
	if source := string(snapshot.Records[0].Value); source != string(raw(
		`{"id":"alice","visibility":"public","linkedTwinId":"secret","faction":"secret-faction","location":"hidden-cave","locationRoles":[{"locationId":"town"},{"locationId":"hidden-cave"}],"lastChange":{"fields":[{"key":"location","from":"hidden-cave"},{"key":"name","from":"Old"}]}}`,
	)) {
		t.Fatalf("source snapshot was mutated: %s", source)
	}
}

func TestPublicDatasetRejectsMalformedStoredProjectionData(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{
		Records: []campaign.Record{{
			Collection: campaign.Settings, Key: "relationshipTypes",
			Value: raw(`{"not":"an array"}`), Visibility: campaign.VisibilityPublic,
		}},
	}}
	service, err := New(repository)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Dataset(context.Background(), ViewPublic); err == nil {
		t.Fatal("malformed stored relationship types were accepted")
	}
}

func projectionFixture() campaign.Snapshot {
	return campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Characters, Key: "alice", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"id":"alice","visibility":"public","linkedTwinId":"secret","faction":"secret-faction","location":"hidden-cave","locationRoles":[{"locationId":"town"},{"locationId":"hidden-cave"}],"lastChange":{"fields":[{"key":"location","from":"hidden-cave"},{"key":"name","from":"Old"}]}}`)},
		{Collection: campaign.Characters, Key: "secret", Visibility: campaign.VisibilityDM, Revision: 1, Value: raw(`{"id":"secret","visibility":"dm"}`)},
		{Collection: campaign.Factions, Key: "guild", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"name":"Guild","visibility":"public"}`)},
		{Collection: campaign.Factions, Key: "secret-faction", Visibility: campaign.VisibilityDM, Revision: 1, Value: raw(`{"id":"private-faction-id","visibility":"dm"}`)},
		{Collection: campaign.Locations, Key: "town", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"id":"town","visibility":"public","parentId":"hidden-cave","connections":["town","hidden-cave"],"characters":["alice","secret"]}`)},
		{Collection: campaign.Locations, Key: "hidden-cave", Visibility: campaign.VisibilityDM, Revision: 1, Value: raw(`{"id":"hidden-cave","visibility":"dm"}`)},
		{Collection: campaign.Events, Key: "arrival", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"id":"arrival","visibility":"public","characters":["alice","secret"],"locations":["town","hidden-cave"],"mapParentId":"hidden-cave"}`)},
		{Collection: campaign.Artifacts, Key: "crown", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"id":"crown","visibility":"public","ownerCharacterId":"secret","locationId":"hidden-cave"}`)},
		{Collection: campaign.Pets, Key: "owl", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"id":"owl","ownerType":"character","ownerId":"secret"}`)},
		{Collection: campaign.Relationships, Key: "hidden-target", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"source":"alice","target":"secret","type":"ally","visibility":"public"}`)},
		{Collection: campaign.Relationships, Key: "hidden-source", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"source":"secret","target":"alice","type":"ally","visibility":"public"}`)},
		{Collection: campaign.Relationships, Key: "mission-visible", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"source":"alice","target":"town","type":"mission","visibility":"public"}`)},
		{Collection: campaign.Relationships, Key: "custom-visible", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"source":"alice","target":"town","type":"travels","visibility":"public"}`)},
		{Collection: campaign.Settings, Key: "relationshipTypes", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`[{"id":"travels","target":"location"}]`)},
		{Collection: campaign.Settings, Key: "mapViews", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`[{"id":"visible","parentId":"town"},{"id":"hidden","parentId":"hidden-cave"}]`)},
		{Collection: campaign.Settings, Key: "mapConfigs", Visibility: campaign.VisibilityPublic, Revision: 1, Value: raw(`{"world":{"zoom":1},"local-town":{"zoom":2},"local-hidden-cave":{"zoom":3},"local-":{"zoom":4}}`)},
	}}
}

func assertRecordKeys(
	t *testing.T,
	dataset Dataset,
	collection campaign.Collection,
	want ...string,
) {
	t.Helper()
	records := collectionView(t, dataset, collection).Records
	got := make([]string, 0, len(records))
	for _, record := range records {
		got = append(got, record.Key)
	}
	if len(got) != len(want) {
		t.Fatalf("%s keys = %v, want %v", collection, got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("%s keys = %v, want %v", collection, got, want)
		}
	}
}

func recordObject(
	t *testing.T,
	dataset Dataset,
	collection campaign.Collection,
	key string,
) map[string]any {
	t.Helper()
	value := recordValue(t, dataset, collection, key)
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s:%s value = %#v", collection, key, value)
	}
	return object
}

func recordValue(
	t *testing.T,
	dataset Dataset,
	collection campaign.Collection,
	key string,
) any {
	t.Helper()
	for _, record := range collectionView(t, dataset, collection).Records {
		if record.Key != key {
			continue
		}
		var value any
		if err := json.Unmarshal(record.Value, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	t.Fatalf("record %s:%s was not projected", collection, key)
	return nil
}

func assertMissing(t *testing.T, value map[string]any, fields ...string) {
	t.Helper()
	for _, field := range fields {
		if _, exists := value[field]; exists {
			t.Fatalf("field %s survived in %#v", field, value)
		}
	}
}

func assertStrings(t *testing.T, value any, want ...string) {
	t.Helper()
	values, ok := value.([]any)
	if !ok || len(values) != len(want) {
		t.Fatalf("values = %#v, want %v", value, want)
	}
	for index, expected := range want {
		if values[index] != expected {
			t.Fatalf("values = %#v, want %v", value, want)
		}
	}
}
