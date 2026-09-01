package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestCreateTwinClonesOppositeVisibilityAndLinksBothSides(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{{
		Collection: campaign.Characters, Key: "alice", Revision: 2,
		Visibility: campaign.VisibilityPublic,
		Value:      raw(`{"id":"alice","name":"Alice","visibility":"public","secrets":{"old":true}}`),
	}}}}
	service, _ := New(repository)
	service.now = func() time.Time { return time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC) }
	service.generateTwinID = func() (string, error) { return "twin-alice", nil }
	result, err := service.MutateTwin(context.Background(), MutationAuthority{
		ActorID: "session:dm", Role: WriteDM,
	}, TwinRequest{
		Action: TwinCreate, Collection: campaign.Characters,
		SourceKey: "alice", SourceExpectedRevision: 2,
	})
	if err != nil || result.TwinKey != "twin-alice" || len(repository.writes) != 1 {
		t.Fatalf("create twin = %+v, %v; writes = %+v", result, err, repository.writes)
	}
	writes := repository.writes[0].Mutations
	source := mutationObject(t, writes, campaign.Characters, "alice")
	twin := mutationObject(t, writes, campaign.Characters, "twin-alice")
	if source["linkedTwinId"] != "twin-alice" || twin["linkedTwinId"] != "alice" ||
		twin["id"] != "twin-alice" || twin["visibility"] != "dm" {
		t.Fatalf("twin pair = source %#v, twin %#v", source, twin)
	}
	if _, exists := twin["secrets"]; exists {
		t.Fatalf("retired secrets were cloned: %#v", twin)
	}
}

func TestLinkAndUnlinkTwinsUseOppositeRevisionedRecords(t *testing.T) {
	t.Parallel()
	snapshot := campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Locations, Key: "town", Revision: 3, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"town","visibility":"public"}`)},
		{Collection: campaign.Locations, Key: "secret-town", Revision: 4, Visibility: campaign.VisibilityDM, Value: raw(`{"id":"secret-town","visibility":"dm"}`)},
	}}
	repository := &fakeRepository{snapshot: snapshot}
	service, _ := New(repository)
	result, err := service.MutateTwin(context.Background(), MutationAuthority{
		ActorID: "session:dm", Role: WriteDM,
	}, TwinRequest{
		Action: TwinLink, Collection: campaign.Locations,
		SourceKey: "town", SourceExpectedRevision: 3,
		TargetKey: "secret-town", TargetExpectedRevision: 4,
	})
	if err != nil || result.TwinKey != "secret-town" {
		t.Fatalf("link twin = %+v, %v", result, err)
	}
	linkedWrites := repository.writes[0].Mutations
	linkedSource := mutationObject(t, linkedWrites, campaign.Locations, "town")
	linkedTarget := mutationObject(t, linkedWrites, campaign.Locations, "secret-town")
	if linkedSource["linkedTwinId"] != "secret-town" || linkedTarget["linkedTwinId"] != "town" {
		t.Fatalf("linked values = %#v %#v", linkedSource, linkedTarget)
	}

	sourceBody, _ := json.Marshal(linkedSource)
	targetBody, _ := json.Marshal(linkedTarget)
	repository.snapshot = campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Locations, Key: "town", Revision: 5, Visibility: campaign.VisibilityPublic, Value: sourceBody},
		{Collection: campaign.Locations, Key: "secret-town", Revision: 5, Visibility: campaign.VisibilityDM, Value: targetBody},
	}}
	_, err = service.MutateTwin(context.Background(), MutationAuthority{
		ActorID: "session:dm", Role: WriteDM,
	}, TwinRequest{
		Action: TwinUnlink, Collection: campaign.Locations,
		SourceKey: "town", SourceExpectedRevision: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	unlinked := repository.writes[1].Mutations
	if _, exists := mutationObject(t, unlinked, campaign.Locations, "town")["linkedTwinId"]; exists {
		t.Fatalf("source link survived: %+v", unlinked)
	}
	if unlinked[1].ExpectedRevision != 5 {
		t.Fatalf("derived target revision = %+v", unlinked[1])
	}
}

func TestTwinMutationRequiresDMAndOppositeUnlinkedRecords(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
		{Collection: campaign.Events, Key: "one", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"one"}`)},
		{Collection: campaign.Events, Key: "two", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"two"}`)},
	}}}
	service, _ := New(repository)
	request := TwinRequest{
		Action: TwinLink, Collection: campaign.Events,
		SourceKey: "one", SourceExpectedRevision: 1,
		TargetKey: "two", TargetExpectedRevision: 1,
	}
	if _, err := service.MutateTwin(context.Background(), MutationAuthority{
		ActorID: "player", Role: WritePlayer,
	}, request); !errors.Is(err, ErrInvalidAuthority) {
		t.Fatalf("player twin error = %v", err)
	}
	if _, err := service.MutateTwin(context.Background(), MutationAuthority{
		ActorID: "dm", Role: WriteDM,
	}, request); !errors.Is(err, ErrTwinVisibility) {
		t.Fatalf("same-visibility error = %v", err)
	}
	request.Collection = campaign.Relationships
	if _, err := service.MutateTwin(context.Background(), MutationAuthority{
		ActorID: "dm", Role: WriteDM,
	}, request); !errors.Is(err, campaign.ErrInvalidTransaction) {
		t.Fatalf("unsupported collection error = %v", err)
	}
	if len(repository.writes) != 0 {
		t.Fatalf("invalid twin request wrote: %+v", repository.writes)
	}
}
