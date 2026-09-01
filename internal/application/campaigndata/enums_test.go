package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestDeleteEnumItemReplacesUsagesAndWritesTombstoneAtomically(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Settings, Key: "attitudes", Revision: 4, Value: raw(`[{"id":"old"},{"id":"new"}]`)},
		{Collection: campaign.Characters, Key: "alice", Revision: 2, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"alice","attitudes":[{"id":"old"},{"id":"new"}]}`)},
		{Collection: campaign.Locations, Key: "town", Revision: 3, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"town","attitudes":[{"id":"old"}]}`)},
		{Collection: campaign.Factions, Key: "guild", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"attitudes":[{"id":"old"}]}`)},
	}}}
	service, _ := New(repository)
	result, err := service.DeleteEnumItem(context.Background(), MutationAuthority{
		ActorID: "session:dm", Role: WriteDM,
	}, EnumDeleteRequest{
		Category: "attitudes", ItemID: "old", ExpectedRevision: 4,
		Mode: EnumReplace, ReplacementID: "new",
	})
	if err != nil || result.UsageCount != 3 || len(repository.writes) != 1 {
		t.Fatalf("delete enum = %+v, %v; writes = %+v", result, err, repository.writes)
	}
	writes := repository.writes[0].Mutations
	if len(writes) != 5 {
		t.Fatalf("mutations = %+v", writes)
	}
	character := mutationObject(t, writes, campaign.Characters, "alice")
	attitudes, _ := character["attitudes"].([]any)
	if len(attitudes) != 1 || attitudes[0].(map[string]any)["id"] != "new" {
		t.Fatalf("character attitudes = %#v", attitudes)
	}
	settings := mutationRaw(t, writes, campaign.Settings, "attitudes")
	if string(settings) != `[{"id":"new"}]` {
		t.Fatalf("settings = %s", settings)
	}
	if string(mutationRaw(t, writes, campaign.DeletedDefaults, "settings:attitudes:old")) != "true" {
		t.Fatalf("tombstone missing: %+v", writes)
	}
}

func TestDeleteEnumItemRejectsUsageWithoutWriting(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Settings, Key: "genders", Revision: 2, Value: raw(`[{"id":"old"}]`)},
		{Collection: campaign.Characters, Key: "alice", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"alice","gender":"old"}`)},
	}}}
	service, _ := New(repository)
	_, err := service.DeleteEnumItem(context.Background(), MutationAuthority{
		ActorID: "session:dm", Role: WriteDM,
	}, EnumDeleteRequest{
		Category: "genders", ItemID: "old", ExpectedRevision: 2, Mode: EnumRejectIfUsed,
	})
	if !errors.Is(err, ErrEnumInUse) || len(repository.writes) != 0 {
		t.Fatalf("error = %v; writes = %+v", err, repository.writes)
	}
}

func TestDeleteEnumItemClearRemovesScalarUsage(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Settings, Key: "eventPriorities", Revision: 2, Value: raw(`[{"id":"old"}]`)},
		{Collection: campaign.Events, Key: "event", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"event","priority":"old"}`)},
	}}}
	service, _ := New(repository)
	_, err := service.DeleteEnumItem(context.Background(), MutationAuthority{
		ActorID: "session:dm", Role: WriteDM,
	}, EnumDeleteRequest{
		Category: "eventPriorities", ItemID: "old", ExpectedRevision: 2, Mode: EnumClear,
	})
	if err != nil {
		t.Fatal(err)
	}
	if event := mutationObject(t, repository.writes[0].Mutations, campaign.Events, "event"); event["priority"] != "" {
		t.Fatalf("event = %#v", event)
	}
}

func mutationRaw(
	t *testing.T,
	mutations []campaign.Mutation,
	collection campaign.Collection,
	key string,
) json.RawMessage {
	t.Helper()
	for _, mutation := range mutations {
		if mutation.Collection == collection && mutation.Key == key {
			return mutation.Value
		}
	}
	t.Fatalf("mutation %s:%s not found", collection, key)
	return nil
}
