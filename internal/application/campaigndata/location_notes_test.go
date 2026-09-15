package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"reflect"
	"strings"
	"testing"
)

func TestLocationNotesRemainDMOnlyAndPlayerEditsPreserveThem(t *testing.T) {
	t.Parallel()
	descriptor, _ := campaign.Describe(campaign.Locations)
	for _, notes := range []any{"", "# Secret\n\nKeep  spacing  \n" + strings.Repeat("č", 10000), map[string]any{"unrecognized": "preserve"}} {
		original := map[string]any{"id": "town", "name": "Town", "notes": notes, "description": "Public prose", "mapNotes": "Map prose", "lastChange": map[string]any{"fields": []any{map[string]any{"field": "notes", "from": "old secret", "to": "new secret"}}}}
		body, _ := json.Marshal(original)
		record := campaign.Record{Collection: campaign.Locations, Key: "town", Revision: 1, Visibility: campaign.VisibilityPublic, Value: body}
		service, _ := New(&fakeRepository{snapshot: campaign.Snapshot{Records: []campaign.Record{record}}})
		public, err := service.Dataset(context.Background(), ViewPublic)
		if err != nil {
			t.Fatal(err)
		}
		visible := recordObject(t, public, campaign.Locations, "town")
		assertMissing(t, visible, "notes")
		if len(visible["lastChange"].(map[string]any)["fields"].([]any)) != 0 {
			t.Fatal("private activity survived")
		}
		visible["name"] = "Updated"
		incoming, _ := json.Marshal(visible)
		saved, err := prepareRecordWrite(WritePlayer, descriptor, record, true, incoming)
		if err != nil {
			t.Fatal(err)
		}
		value, _ := objectValue(saved)
		if !reflect.DeepEqual(value["notes"], notes) || value["name"] != "Updated" || value["description"] != "Public prose" || value["mapNotes"] != "Map prose" {
			t.Fatalf("player save lost fields: %v", value)
		}
		for _, forged := range []string{`{"id":"town","notes":"replacement"}`, `{"id":"town","notes":null}`} {
			if _, err := prepareRecordWrite(WritePlayer, descriptor, record, true, raw(forged)); !errors.Is(err, ErrManagedCampaignField) {
				t.Fatalf("forged notes accepted: %v", err)
			}
		}
		dm, err := service.Dataset(context.Background(), ViewDM)
		if err != nil || !reflect.DeepEqual(recordObject(t, dm, campaign.Locations, "town")["notes"], notes) {
			t.Fatal("DM notes changed")
		}
	}
	if _, err := prepareRecordWrite(WritePlayer, descriptor, campaign.Record{}, false, raw(`{"id":"new","notes":"forged"}`)); !errors.Is(err, ErrManagedCampaignField) {
		t.Fatal("player created private notes")
	}
	dm, err := prepareRecordWrite(WriteDM, descriptor, campaign.Record{}, false, raw(`{"id":"new","notes":"authored"}`))
	if err != nil || !strings.Contains(string(dm), "authored") {
		t.Fatal("DM cannot author notes")
	}
}
