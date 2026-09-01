package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestPlayerMutationSanitizesAuthorityAndPrivateMetadata(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{{
		Collection: campaign.Characters, Key: "alice", Revision: 4,
		Visibility: campaign.VisibilityPublic,
		Value:      raw(`{"id":"alice","visibility":"public","linkedTwinId":"alice-dm","addonData":{"sheet":{"hp":8},"notes":{"color":"blue"}}}`),
	}}}, commit: campaign.Commit{ID: 9}}
	service, err := New(repository)
	if err != nil {
		t.Fatal(err)
	}
	commit, err := service.Mutate(context.Background(), MutationAuthority{
		ActorID: "session-player", Role: WritePlayer,
	}, []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.Characters, Key: "alice", ExpectedRevision: 4,
		Value: raw(`{"id":"alice","name":"Alice","visibility":"dm","secrets":{"name":true},"addonData":{"sheet":{"hp":9}}}`),
	}})
	if err != nil || commit.ID != 9 || len(repository.writes) != 1 {
		t.Fatalf("mutation = %+v, %v; writes = %d", commit, err, len(repository.writes))
	}
	write := repository.writes[0]
	if write.ActorID != "session-player" || len(write.Mutations) != 1 {
		t.Fatalf("write authority = %+v", write)
	}
	var value map[string]any
	if err := json.Unmarshal(write.Mutations[0].Value, &value); err != nil {
		t.Fatal(err)
	}
	if value["visibility"] != "public" || value["linkedTwinId"] != "alice-dm" {
		t.Fatalf("managed fields = %#v", value)
	}
	if _, exists := value["secrets"]; exists {
		t.Fatalf("legacy secrets survived: %#v", value)
	}
	addonData := value["addonData"].(map[string]any)
	if len(addonData) != 2 || addonData["notes"] == nil ||
		addonData["sheet"].(map[string]any)["hp"] != float64(9) {
		t.Fatalf("addon data was not merged: %#v", addonData)
	}
}

func TestMutationRejectsManagedTwinChangesAndHiddenPlayerTargets(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Characters, Key: "alice", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"alice","visibility":"public","linkedTwinId":"secret"}`)},
		{Collection: campaign.Characters, Key: "secret", Revision: 1, Visibility: campaign.VisibilityDM, Value: raw(`{"id":"secret","visibility":"dm","linkedTwinId":"alice"}`)},
	}}}
	service, _ := New(repository)

	_, err := service.Mutate(context.Background(), MutationAuthority{ActorID: "dm", Role: WriteDM}, []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.Characters, Key: "alice", ExpectedRevision: 1,
		Value: raw(`{"id":"alice","visibility":"public","linkedTwinId":"other"}`),
	}})
	if !errors.Is(err, ErrManagedCampaignField) {
		t.Fatalf("managed twin error = %v", err)
	}
	_, err = service.Mutate(context.Background(), MutationAuthority{ActorID: "player", Role: WritePlayer}, []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.Characters, Key: "secret", ExpectedRevision: 1,
		Value: raw(`{"id":"secret","name":"guessed"}`),
	}})
	if !errors.Is(err, campaign.ErrNotFound) {
		t.Fatalf("hidden player write error = %v", err)
	}
	_, err = service.Mutate(context.Background(), MutationAuthority{ActorID: "player", Role: WritePlayer}, []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.Campaign, Key: "main", ExpectedRevision: 0,
		Value: raw(`{"name":"Renamed"}`),
	}})
	if !errors.Is(err, ErrMutationForbidden) {
		t.Fatalf("DM-only collection error = %v", err)
	}
	if len(repository.writes) != 0 {
		t.Fatalf("rejected writes reached storage: %+v", repository.writes)
	}
}

func TestMutationPlansReferenceOwningDeleteAtomically(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Characters, Key: "alice", Revision: 2, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"alice","visibility":"public","linkedTwinId":"alice-dm"}`)},
		{Collection: campaign.Characters, Key: "alice-dm", Revision: 3, Visibility: campaign.VisibilityDM, Value: raw(`{"id":"alice-dm","visibility":"dm","linkedTwinId":"alice"}`)},
		{Collection: campaign.Relationships, Key: relationshipKey("alice", "bob", "ally"), Revision: 4, Visibility: campaign.VisibilityPublic, Value: raw(`{"source":"alice","target":"bob","type":"ally","visibility":"public"}`)},
		{Collection: campaign.Events, Key: "arrival", Revision: 5, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"arrival","characters":["alice","bob"]}`)},
		{Collection: campaign.Artifacts, Key: "crown", Revision: 6, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"crown","ownerCharacterId":"alice"}`)},
		{Collection: campaign.Pets, Key: "owl", Revision: 7, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"owl","ownerType":"character","ownerId":"alice"}`)},
	}}}
	service, _ := New(repository)
	service.now = func() time.Time { return time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC) }
	_, err := service.Mutate(context.Background(), MutationAuthority{ActorID: "dm", Role: WriteDM}, []campaign.Mutation{{
		Kind: campaign.Delete, Collection: campaign.Characters, Key: "alice", ExpectedRevision: 2,
	}})
	if err != nil || len(repository.writes) != 1 {
		t.Fatalf("compound delete = %v; writes = %+v", err, repository.writes)
	}
	writes := repository.writes[0].Mutations
	if len(writes) != 6 || writes[0].Kind != campaign.Delete || writes[0].Key != "alice" ||
		writes[1].Key != "alice-dm" || writes[1].ExpectedRevision != 3 {
		t.Fatalf("compound write plan = %+v", writes)
	}
	twin := mutationObject(t, writes, campaign.Characters, "alice-dm")
	if _, exists := twin["linkedTwinId"]; exists {
		t.Fatalf("twin link survived: %#v", twin)
	}
	event := mutationObject(t, writes, campaign.Events, "arrival")
	if characters := event["characters"].([]any); len(characters) != 1 || characters[0] != "bob" {
		t.Fatalf("event reference survived: %#v", event)
	}
	artifact := mutationObject(t, writes, campaign.Artifacts, "crown")
	pet := mutationObject(t, writes, campaign.Pets, "owl")
	if artifact["ownerCharacterId"] != "" || pet["ownerType"] != "none" || pet["ownerId"] != "" {
		t.Fatalf("owned references survived: artifact=%#v pet=%#v", artifact, pet)
	}
}

func TestMutationAllowsSimpleDeletesAndRejectsInvalidAuthority(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{{
		Collection: campaign.Pets, Key: "owl", Revision: 2,
		Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"owl"}`),
	}}}}
	service, _ := New(repository)
	if _, err := service.Mutate(context.Background(), MutationAuthority{}, []campaign.Mutation{{
		Kind: campaign.Delete, Collection: campaign.Pets, Key: "owl", ExpectedRevision: 2,
	}}); !errors.Is(err, ErrInvalidAuthority) {
		t.Fatalf("authority error = %v", err)
	}
	if _, err := service.Mutate(context.Background(), MutationAuthority{
		ActorID: "player", Role: WritePlayer,
	}, []campaign.Mutation{{
		Kind: campaign.Delete, Collection: campaign.Pets, Key: "owl", ExpectedRevision: 2,
	}}); err != nil {
		t.Fatalf("simple delete failed: %v", err)
	}
	if len(repository.writes) != 1 || repository.writes[0].Mutations[0].Kind != campaign.Delete {
		t.Fatalf("simple delete write = %+v", repository.writes)
	}
	if _, err := service.Mutate(context.Background(), MutationAuthority{
		ActorID: "player", Role: WritePlayer,
	}, []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.DeletedDefaults,
		Key: "example", Value: raw(`true`), ExpectedRevision: 0,
	}}); err != nil {
		t.Fatalf("keyed tombstone write failed: %v", err)
	}
}

func TestPlayerLocationSavePreservesHiddenLinksAndSynchronizesVisiblePeers(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Locations, Key: "town", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"town","visibility":"public","connections":["hidden"]}`)},
		{Collection: campaign.Locations, Key: "road", Revision: 2, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"road","visibility":"public","connections":[]}`)},
		{Collection: campaign.Locations, Key: "hidden", Revision: 3, Visibility: campaign.VisibilityDM, Value: raw(`{"id":"hidden","visibility":"dm","connections":["town"]}`)},
	}}}
	service, _ := New(repository)
	service.now = func() time.Time { return time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC) }
	_, err := service.Mutate(context.Background(), MutationAuthority{
		ActorID: "player", Role: WritePlayer,
	}, []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.Locations, Key: "town", ExpectedRevision: 1,
		Value: raw(`{"id":"town","visibility":"dm","connections":["road"]}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	writes := repository.writes[0].Mutations
	if len(writes) != 2 {
		t.Fatalf("location plan = %+v", writes)
	}
	town := mutationObject(t, writes, campaign.Locations, "town")
	road := mutationObject(t, writes, campaign.Locations, "road")
	if town["visibility"] != "public" {
		t.Fatalf("player changed location visibility: %#v", town)
	}
	assertStringValues(t, town["connections"], "road", "hidden")
	assertStringValues(t, road["connections"], "town")
	for _, mutation := range writes {
		if mutation.Key == "hidden" {
			t.Fatalf("player save rewrote hidden peer: %+v", mutation)
		}
	}
}

func TestPlayerReferencesCannotTargetHiddenOrMissingRecords(t *testing.T) {
	t.Parallel()
	base := campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Characters, Key: "alice", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"alice"}`)},
		{Collection: campaign.Locations, Key: "hidden", Revision: 2, Visibility: campaign.VisibilityDM, Value: raw(`{"id":"hidden","visibility":"dm"}`)},
	}}
	errorsByTarget := make([]string, 0, 2)
	for _, location := range []string{"hidden", "missing"} {
		repository := &fakeRepository{snapshot: base}
		service, _ := New(repository)
		_, err := service.Mutate(context.Background(), MutationAuthority{
			ActorID: "player", Role: WritePlayer,
		}, []campaign.Mutation{{
			Kind: campaign.Put, Collection: campaign.Characters, Key: "alice", ExpectedRevision: 1,
			Value: raw(`{"id":"alice","location":"` + location + `"}`),
		}})
		if !errors.Is(err, campaign.ErrInvalidRecord) || len(repository.writes) != 0 {
			t.Fatalf("reference %s error = %v; writes = %+v", location, err, repository.writes)
		}
		errorsByTarget = append(errorsByTarget, err.Error())
	}
	if errorsByTarget[0] != errorsByTarget[1] {
		t.Fatalf("hidden reference became an oracle: %q != %q", errorsByTarget[0], errorsByTarget[1])
	}
}

func TestLocationAndFactionDeletesCloseCrossCollectionReferences(t *testing.T) {
	t.Parallel()
	missionKey := relationshipKey("alice", "town", "mission")
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Locations, Key: "town", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"town"}`)},
		{Collection: campaign.Locations, Key: "district", Revision: 2, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"district","parentId":"town","connections":["town"]}`)},
		{Collection: campaign.Characters, Key: "alice", Revision: 3, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"alice","location":"town","locationRoles":[{"locationId":"town"}],"faction":"guild","rank":"Captain","rankChain":"guard"}`)},
		{Collection: campaign.Events, Key: "arrival", Revision: 4, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"arrival","locations":["town"],"mapParentId":"town","mapX":0.2,"mapY":0.3}`)},
		{Collection: campaign.Relationships, Key: missionKey, Revision: 5, Visibility: campaign.VisibilityPublic, Value: raw(`{"source":"alice","target":"town","type":"mission"}`)},
		{Collection: campaign.Settings, Key: "mapViews", Revision: 6, Visibility: campaign.VisibilityPublic, Value: raw(`[{"id":"town-view","parentId":"town"}]`)},
		{Collection: campaign.Settings, Key: "mapConfigs", Revision: 7, Visibility: campaign.VisibilityPublic, Value: raw(`{"local-town":{"zoom":2},"world":{"zoom":1}}`)},
		{Collection: campaign.Factions, Key: "guild", Revision: 8, Visibility: campaign.VisibilityPublic, Value: raw(`{"name":"Guild"}`)},
		{Collection: campaign.Pets, Key: "owl", Revision: 9, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"owl","ownerType":"faction","ownerId":"guild"}`)},
	}}}
	service, _ := New(repository)
	service.now = func() time.Time { return time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC) }
	_, err := service.Mutate(context.Background(), MutationAuthority{ActorID: "dm", Role: WriteDM}, []campaign.Mutation{
		{Kind: campaign.Delete, Collection: campaign.Locations, Key: "town", ExpectedRevision: 1},
		{Kind: campaign.Delete, Collection: campaign.Factions, Key: "guild", ExpectedRevision: 8},
	})
	if err != nil {
		t.Fatal(err)
	}
	writes := repository.writes[0].Mutations
	character := mutationObject(t, writes, campaign.Characters, "alice")
	if character["location"] != "" || character["faction"] != "neutral" ||
		character["rank"] != "" || len(character["locationRoles"].([]any)) != 0 {
		t.Fatalf("character references survived: %#v", character)
	}
	district := mutationObject(t, writes, campaign.Locations, "district")
	if district["parentId"] != "" || len(district["connections"].([]any)) != 0 {
		t.Fatalf("location references survived: %#v", district)
	}
	event := mutationObject(t, writes, campaign.Events, "arrival")
	if len(event["locations"].([]any)) != 0 || event["mapParentId"] != nil ||
		event["mapX"] != nil || event["mapY"] != nil {
		t.Fatalf("event map references survived: %#v", event)
	}
	for _, mutation := range writes {
		if mutation.Collection == campaign.Relationships && mutation.Key == missionKey && mutation.Kind == campaign.Delete {
			goto relationshipDeleted
		}
	}
	t.Fatalf("location relationship was not deleted: %+v", writes)

relationshipDeleted:
	mapViews := mutationValue(t, writes, campaign.Settings, "mapViews").([]any)
	mapConfigs := mutationValue(t, writes, campaign.Settings, "mapConfigs").(map[string]any)
	pet := mutationObject(t, writes, campaign.Pets, "owl")
	if len(mapViews) != 0 || mapConfigs["local-town"] != nil || mapConfigs["world"] == nil ||
		pet["ownerType"] != "none" {
		t.Fatalf("settings or pet references survived: views=%#v configs=%#v pet=%#v", mapViews, mapConfigs, pet)
	}
}

func relationshipKey(source, target, relationType string) string {
	body, _ := json.Marshal(map[string]any{"source": source, "target": target, "type": relationType})
	key, _ := campaign.ListRecordKey(campaign.Relationships, body)
	return key
}

func mutationObject(
	t *testing.T,
	mutations []campaign.Mutation,
	collection campaign.Collection,
	key string,
) map[string]any {
	t.Helper()
	for _, mutation := range mutations {
		if mutation.Collection != collection || mutation.Key != key || mutation.Kind != campaign.Put {
			continue
		}
		var value map[string]any
		if err := json.Unmarshal(mutation.Value, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	t.Fatalf("put %s:%s was not planned: %+v", collection, key, mutations)
	return nil
}

func mutationValue(
	t *testing.T,
	mutations []campaign.Mutation,
	collection campaign.Collection,
	key string,
) any {
	t.Helper()
	for _, mutation := range mutations {
		if mutation.Collection != collection || mutation.Key != key || mutation.Kind != campaign.Put {
			continue
		}
		var value any
		if err := json.Unmarshal(mutation.Value, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	t.Fatalf("put %s:%s was not planned: %+v", collection, key, mutations)
	return nil
}

func assertStringValues(t *testing.T, value any, expected ...string) {
	t.Helper()
	values, ok := value.([]any)
	if !ok || len(values) != len(expected) {
		t.Fatalf("values = %#v, expected %v", value, expected)
	}
	for index, want := range expected {
		if values[index] != want {
			t.Fatalf("values = %#v, expected %v", value, expected)
		}
	}
}
