package campaigndata

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func activityFixtureRecord(collection campaign.Collection, key, body string, visibility campaign.Visibility) campaign.Record {
	return campaign.Record{Collection: collection, Key: key, Revision: 1, Visibility: visibility, Value: raw(body)}
}

func activityPlan(t *testing.T, records []campaign.Record, mutations ...campaign.Mutation) *mutationPlanner {
	t.Helper()
	planner := newMutationPlanner(campaign.Snapshot{Records: records}, func() time.Time { return time.UnixMilli(2000) })
	for _, mutation := range mutations {
		if err := planner.applyRequested(WriteDM, mutation); err != nil {
			t.Fatal(err)
		}
	}
	if err := planner.applyDerivedPolicies(); err != nil {
		t.Fatal(err)
	}
	if _, err := planner.transaction("dm"); err != nil {
		t.Fatal(err)
	}
	return planner
}

func TestActivityHidesPrivateReferenceEditsAndIgnoresForgedSummaries(t *testing.T) {
	public := campaign.VisibilityPublic
	previous := `"lastChange":{"contractVersion":"activity.v1","dm":{"kind":"created","fields":[],"at":1000},"public":{"kind":"created","fields":[],"at":1000}}`
	alice := activityFixtureRecord(campaign.Characters, "alice", `{"id":"alice","name":"Alice",`+previous+`}`, public)
	hidden := activityFixtureRecord(campaign.Locations, "secret", `{"id":"secret","name":"Private vault"}`, campaign.VisibilityDM)
	planner := activityPlan(t, []campaign.Record{alice, hidden}, campaign.Mutation{Kind: campaign.Put, Collection: campaign.Characters, Key: "alice", ExpectedRevision: 1,
		Value: raw(`{"id":"alice","name":"Alice","location":"secret","lastChange":{"contractVersion":"activity.v1","public":{"kind":"created","fields":["forged"],"at":9999}}}`)})
	stored := readStoredActivity(planner.current[mutationTarget(campaign.Characters, "alice")].Value)
	if stored.DM.At != 2000 || !reflect.DeepEqual(stored.DM.Fields, []string{"location"}) || stored.Public.At != 1000 {
		t.Fatalf("activity = %+v, %+v", stored.DM, stored.Public)
	}
	snapshot := activitySnapshot(planner.current)
	original := string(snapshot.Records[0].Value)
	service, _ := New(&fakeRepository{snapshot: snapshot})
	for _, role := range []ViewRole{ViewPublic, ViewDM} {
		data, err := service.Dataset(context.Background(), role)
		if err != nil {
			t.Fatal(err)
		}
		value := recordObject(t, data, campaign.Characters, "alice")
		metadata, _ := json.Marshal(value["lastChange"])
		if strings.Contains(string(metadata), `"dm"`) || strings.Contains(string(metadata), `"public"`) || strings.Contains(string(metadata), "secret") {
			t.Fatalf("unprojected activity: %s", metadata)
		}
		if role == ViewPublic && strings.Contains(string(metadata), "location") {
			t.Fatalf("private change leaked: %s", metadata)
		}
	}
	if string(snapshot.Records[0].Value) != original {
		t.Fatal("dataset changed the stored snapshot")
	}
}

func TestRelationshipActivityTouchesSourceAndUsesVisibleRelationshipSets(t *testing.T) {
	for _, visibility := range []campaign.Visibility{campaign.VisibilityPublic, campaign.VisibilityDM} {
		t.Run(string(visibility), func(t *testing.T) {
			alice := activityFixtureRecord(campaign.Characters, "alice", `{"id":"alice","name":"Alice"}`, campaign.VisibilityPublic)
			friend := activityFixtureRecord(campaign.Characters, "friend", `{"id":"friend","name":"Friend"}`, visibility)
			body := raw(`{"source":"alice","target":"friend","type":"friend","visibility":"public"}`)
			key, err := campaign.ListRecordKey(campaign.Relationships, body)
			if err != nil {
				t.Fatal(err)
			}
			planner := activityPlan(t, []campaign.Record{alice, friend}, campaign.Mutation{Kind: campaign.Put, Collection: campaign.Relationships, Key: key, Value: body})
			stored := readStoredActivity(planner.current[mutationTarget(campaign.Characters, "alice")].Value)
			if stored.DM == nil || !reflect.DeepEqual(stored.DM.Fields, []string{"relationships"}) {
				t.Fatalf("source activity = %+v", stored)
			}
			if (stored.Public != nil) != (visibility == campaign.VisibilityPublic) {
				t.Fatalf("public activity = %+v", stored.Public)
			}
			if planner.changes[mutationTarget(campaign.Characters, "alice")].expected != 1 {
				t.Fatal("derived activity lost source revision")
			}
			relation := activityFixtureRecord(campaign.Relationships, key, string(body), campaign.VisibilityPublic)
			removed := activityPlan(t, []campaign.Record{alice, friend, relation}, campaign.Mutation{Kind: campaign.Delete, Collection: campaign.Relationships, Key: key, ExpectedRevision: 1})
			removal := readStoredActivity(removed.current[mutationTarget(campaign.Characters, "alice")].Value)
			if removal.DM == nil || !reflect.DeepEqual(removal.DM.Fields, []string{"relationships"}) || (removal.Public != nil) != (visibility == campaign.VisibilityPublic) {
				t.Fatalf("relationship removal activity = %+v", removal)
			}
		})
	}
}

func TestActivitySuppressesNormalizationNoiseAndPreservesOriginalFields(t *testing.T) {
	old := activityFixtureRecord(campaign.Locations, "town", `{"id":"town","name":"Town","extension":{"keep":true},"lastChange":{"contractVersion":"activity.v1","dm":{"kind":"created","fields":[],"at":1000},"public":{"kind":"created","fields":[],"at":1000}}}`, campaign.VisibilityPublic)
	planner := activityPlan(t, []campaign.Record{old}, campaign.Mutation{Kind: campaign.Put, Collection: campaign.Locations, Key: "town", ExpectedRevision: 1,
		Value: raw(`{"id":"town","name":"Town","region":"","attitudes":[],"extension":{"keep":true}}`)})
	current := planner.current[mutationTarget(campaign.Locations, "town")]
	stored := readStoredActivity(current.Value)
	if stored.DM.At != 1000 || stored.Public.At != 1000 {
		t.Fatal("normalization replaced meaningful activity")
	}
	if !strings.Contains(string(current.Value), `"extension":{"keep":true}`) {
		t.Fatal("authored extension lost")
	}
	for _, timestamp := range []string{`1000`, `"1970-01-01T00:00:01Z"`} {
		withoutSummary := activityFixtureRecord(campaign.Locations, "town", `{"id":"town","name":"Town","updatedAt":`+timestamp+`}`, campaign.VisibilityPublic)
		first := activityPlan(t, []campaign.Record{withoutSummary}, campaign.Mutation{Kind: campaign.Put, Collection: campaign.Locations, Key: "town", ExpectedRevision: 1, Value: raw(`{"id":"town","name":"Town"}`)})
		activity := readStoredActivity(first.current[mutationTarget(campaign.Locations, "town")].Value)
		if activity.Public == nil || activity.Public.At != 1000 || activity.Public.Kind != "updated" || len(activity.Public.Fields) != 0 {
			t.Fatalf("no-op lost original generic activity: %+v", activity.Public)
		}
	}
	noPublicChange := activityFixtureRecord(campaign.Locations, "town", `{"id":"town","name":"Town","updatedAt":1000,"lastChange":{"contractVersion":"activity.v1","dm":null,"public":null}}`, campaign.VisibilityPublic)
	noop := activityPlan(t, []campaign.Record{noPublicChange}, campaign.Mutation{Kind: campaign.Put, Collection: campaign.Locations, Key: "town", ExpectedRevision: 1, Value: raw(`{"id":"town","name":"Town"}`)})
	if readStoredActivity(noop.current[mutationTarget(campaign.Locations, "town")].Value).Public != nil {
		t.Fatal("no-op invented public activity for a private-only timestamp")
	}
}
