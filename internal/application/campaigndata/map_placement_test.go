package campaigndata

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestMapPlacementProjectionAndPlayerRoundTrip(t *testing.T) {
	t.Parallel()
	for _, target := range []struct {
		collection   campaign.Collection
		parent, x, y string
	}{
		{campaign.Locations, "parentId", "x", "y"},
		{campaign.Events, "mapParentId", "mapX", "mapY"},
	} {
		for _, parent := range []string{"", "visible", "hidden", "missing"} {
			t.Run(string(target.collection)+"/"+parent, func(t *testing.T) {
				t.Parallel()
				value := map[string]any{"id": "pin", "name": "Original", target.parent: parent, target.x: .2, target.y: .3}
				body, _ := json.Marshal(value)
				repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
					{Collection: target.collection, Key: "pin", Revision: 1, Visibility: campaign.VisibilityPublic, Value: body},
					{Collection: campaign.Locations, Key: "visible", Revision: 1, Visibility: campaign.VisibilityPublic, Value: raw(`{"id":"visible"}`)},
					{Collection: campaign.Locations, Key: "hidden", Revision: 1, Visibility: campaign.VisibilityDM, Value: raw(`{"id":"hidden","visibility":"dm"}`)},
				}}}
				service, _ := New(repository)
				public, err := service.Dataset(context.Background(), ViewPublic)
				if err != nil {
					t.Fatal(err)
				}
				projected := recordObject(t, public, target.collection, "pin")
				if parent == "hidden" || parent == "missing" {
					assertMissing(t, projected, target.parent, target.x, target.y)
				} else if projected[target.x] != .2 || projected[target.y] != .3 {
					t.Fatalf("visible placement changed: %#v", projected)
				}
				dm, err := service.Dataset(context.Background(), ViewDM)
				if err != nil {
					t.Fatal(err)
				}
				stored := recordObject(t, dm, target.collection, "pin")
				if stored[target.parent] != parent || stored[target.x] != .2 || stored[target.y] != .3 {
					t.Fatalf("DM placement changed: %#v", stored)
				}
				projected["name"] = "Renamed"
				updated, _ := json.Marshal(projected)
				_, err = service.Mutate(context.Background(), MutationAuthority{ActorID: "player", Role: WritePlayer}, []campaign.Mutation{
					{Kind: campaign.Put, Collection: target.collection, Key: "pin", ExpectedRevision: 1, Value: updated},
				})
				if err != nil {
					t.Fatal(err)
				}
				saved := mutationObject(t, repository.writes[0].Mutations, target.collection, "pin")
				if saved["name"] != "Renamed" || saved[target.parent] != parent || saved[target.x] != .2 || saved[target.y] != .3 {
					t.Fatalf("player save lost the original placement: %#v", saved)
				}
			})
		}
	}
}

func TestPlayerCannotReplaceUnavailableMapPlacement(t *testing.T) {
	t.Parallel()
	for _, placed := range []bool{false, true} {
		current := map[string]any{"id": "pin", "parentId": "hidden"}
		if placed {
			current["x"], current["y"] = .2, .3
		}
		body, _ := json.Marshal(current)
		repository := &fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{
			{Collection: campaign.Locations, Key: "pin", Revision: 1, Visibility: campaign.VisibilityPublic, Value: body},
			{Collection: campaign.Locations, Key: "hidden", Revision: 1, Visibility: campaign.VisibilityDM, Value: raw(`{"id":"hidden","visibility":"dm"}`)},
		}}}
		service, _ := New(repository)
		_, err := service.Mutate(context.Background(), MutationAuthority{ActorID: "player", Role: WritePlayer}, []campaign.Mutation{
			{Kind: campaign.Put, Collection: campaign.Locations, Key: "pin", ExpectedRevision: 1, Value: raw(`{"id":"pin","parentId":null,"x":0.8,"y":0.9}`)},
		})
		if err != nil {
			t.Fatal(err)
		}
		saved := mutationObject(t, repository.writes[0].Mutations, campaign.Locations, "pin")
		if saved["parentId"] != "hidden" || saved["x"] != current["x"] || saved["y"] != current["y"] {
			t.Fatalf("player overwrote an unavailable placement: %#v", saved)
		}
	}
}
