package addondatastore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

func schemaFixture(t *testing.T) (*Store, *sql.DB, datalifecycle.SchemaReviewRequest) {
	t.Helper()
	store, _, db := testStore(t)
	for _, query := range []string{
		`INSERT INTO addon_package_generations(addon_id,generation_id,addon_version,archive_sha256,manifest_json,installed_at) VALUES('dm-tools',?,'2.0.0',?,'{}','2026-09-01T12:00:00Z')`,
	} {
		if _, err := db.Exec(query, testGeneration, testGeneration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO addon_package_states(addon_id,revision,updated_at) VALUES('dm-tools',3,'2026-09-01T12:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	seed(t, store, testDefinition(datacontract.Collection, "notes", datacontract.VisibilityDM), "one", `{"name":"keep","n":1}`, events.AudienceDM)
	if _, err := db.Exec(`UPDATE addon_documents SET body_json=' { "name": "keep", "n": 1.00 } '`); err != nil {
		t.Fatal(err)
	}
	return store, db, datalifecycle.SchemaReviewRequest{ReviewID: "schema-1", AddonID: "dm-tools", GenerationID: testGeneration, ExpectedStateRevision: 3}
}
func schemaPlan(snapshot Snapshot) ([]datalifecycle.SchemaChange, []datalifecycle.Issue, error) {
	changes := []datalifecycle.SchemaChange{}
	for _, state := range snapshot.States {
		if !state.Materialized {
			continue
		}
		count := 0
		for _, document := range snapshot.Documents {
			if document.Kind == state.Kind && document.DataID == state.DataID {
				count++
			}
		}
		changes = append(changes, datalifecycle.SchemaChange{Kind: state.Kind, DataID: state.DataID, FromVersion: state.SchemaVersion, FromSHA256: state.SchemaSHA256, ToVersion: "2.0.0", ToSHA256: strings.Repeat("b", 64), Documents: count})
	}
	return changes, []datalifecycle.Issue{}, nil
}
func TestSchemaUpgradePreservesExactBodiesOrderingAndTombstones(t *testing.T) {
	store, db, input := schemaFixture(t)
	ctx := context.Background()
	empty := testDefinition(datacontract.Collection, "empty", datacontract.VisibilityPrivate)
	seed(t, store, empty, "removed", `{}`, events.AudienceSystem)
	if _, err := store.Transact(ctx, Transaction{AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "seed", Mutations: []Mutation{{Kind: Delete, Definition: empty, Key: "removed", ExpectedRevision: 1, Audience: events.AudienceSystem}}}); err != nil {
		t.Fatal(err)
	}
	seed(t, store, testDefinition(datacontract.Collection, "private_notes", datacontract.VisibilityPrivate), "private-key", `{"secret":"private authored value"}`, events.AudienceSystem)
	extension := testDefinition(datacontract.RecordExtension, "sheet", datacontract.VisibilityDM)
	created := time.Date(2020, 1, 1, 1, 0, 0, 0, time.UTC)
	if _, err := store.Transact(ctx, Transaction{AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "seed", Mutations: []Mutation{{Kind: Put, Definition: extension, Key: "detached", Value: json.RawMessage(`{"unknown":[1,2]}`), TargetCreatedAt: &created, Audience: events.AudienceDM}}}); err != nil {
		t.Fatal(err)
	}
	before, err := store.SnapshotAddon(ctx, "dm-tools")
	if err != nil {
		t.Fatal(err)
	}
	review, err := store.PrepareSchemaReview(ctx, input, schemaPlan)
	if err != nil {
		t.Fatal(err)
	}
	recovery, err := store.SchemaReviewRecovery(ctx, review.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	if schemaHash(recovery) != review.SnapshotSHA256 || len(review.Changes) != 4 {
		t.Fatal("missing exact review")
	}
	var envelope struct {
		Bodies [][]byte `json:"bodiesBase64"`
	}
	if err = json.Unmarshal(recovery, &envelope); err != nil {
		t.Fatal(err)
	}
	if string(envelope.Bodies[0]) != string(before.Documents[0].Value) {
		t.Fatal("recovery changed raw JSON")
	}
	applied, err := store.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256)
	if err != nil || applied.Status != "applied" {
		t.Fatalf("apply: %+v %v", applied, err)
	}
	after, err := store.SnapshotAddon(ctx, "dm-tools")
	if err != nil {
		t.Fatal(err)
	}
	for i := range before.Documents {
		actual := after.Documents[i]
		actual.SchemaVersion = before.Documents[i].SchemaVersion
		actual.SchemaSHA256 = before.Documents[i].SchemaSHA256
		if !reflect.DeepEqual(actual, before.Documents[i]) {
			t.Fatalf("rewrote record: %+v", actual)
		}
	}
	for i, state := range after.States {
		if state.Revision != before.States[i].Revision+1 || state.SchemaVersion != "2.0.0" {
			t.Fatal("set identity/revision did not advance")
		}
	}
	var version int
	var active sql.NullString
	var stateRevision int
	if err = db.QueryRow("SELECT revision FROM addon_document_versions WHERE data_id='empty'").Scan(&version); err != nil || version != 2 {
		t.Fatal("tombstone rewound", err)
	}
	if err = db.QueryRow("SELECT revision,active_generation_id FROM addon_package_states").Scan(&stateRevision, &active); err != nil || stateRevision != 4 || active.Valid {
		t.Fatal("activation authority changed", err)
	}
	// A new store instance can answer a lost response after activation and expiry.
	store.now = func() time.Time { return review.ExpiresAt.Add(time.Hour) }
	if _, err = db.Exec("UPDATE addon_package_states SET active_generation_id=?", testGeneration); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(Config{DB: db, Events: store.events, Now: store.now})
	if err != nil {
		t.Fatal(err)
	}
	retried, err := restarted.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256)
	if err != nil || retried.AppliedAt == nil || !retried.AppliedAt.Equal(*applied.AppliedAt) {
		t.Fatal("lost result not recoverable", err)
	}
	if _, err = restarted.ApplySchemaReview(ctx, review.ReviewID, strings.Repeat("c", 64)); !errors.Is(err, datalifecycle.ErrUpgradeStale) {
		t.Fatal("wrong review accepted")
	}
	again, _ := restarted.SchemaReviewRecovery(ctx, review.ReviewID)
	if string(again) != string(recovery) {
		t.Fatal("snapshot changed")
	}
}
func TestSchemaUpgradeRejectsStaleAndBlockedPlans(t *testing.T) {
	for _, scenario := range []string{"body", "tombstone", "state", "active", "expired", "generation", "blocked", "superseded"} {
		t.Run(scenario, func(t *testing.T) {
			store, db, input := schemaFixture(t)
			ctx := context.Background()
			planner := schemaPlan
			if scenario == "blocked" {
				planner = func(s Snapshot) ([]datalifecycle.SchemaChange, []datalifecycle.Issue, error) {
					c, _, e := schemaPlan(s)
					return c, []datalifecycle.Issue{{Code: "INVALID_STORED_DOCUMENT"}}, e
				}
			}
			review, err := store.PrepareSchemaReview(ctx, input, planner)
			if err != nil {
				t.Fatal(err)
			}
			var query string
			want := datalifecycle.ErrUpgradeStale
			switch scenario {
			case "body":
				query = `UPDATE addon_documents SET body_json='{"different":true}'`
			case "tombstone":
				query = "UPDATE addon_document_versions SET revision=revision+1"
			case "state":
				query = "UPDATE addon_package_states SET revision=revision+1"
			case "active":
				query = "UPDATE addon_package_states SET active_generation_id='" + testGeneration + "'"
				want = datalifecycle.ErrUpgradeActive
			case "expired":
				store.now = func() time.Time { return review.ExpiresAt }
			case "generation":
				query = "DELETE FROM addon_package_generations"
			case "blocked":
				want = datalifecycle.ErrUpgradeBlocked
			case "superseded":
				input.ReviewID = "schema-2"
				if _, err = store.PrepareSchemaReview(ctx, input, schemaPlan); err != nil {
					t.Fatal(err)
				}
				want = datalifecycle.ErrUpgradeNotFound
			}
			if query != "" {
				if _, err = db.Exec(query); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := store.SnapshotAddon(ctx, "dm-tools")
			if _, err = store.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256); !errors.Is(err, want) {
				t.Fatalf("want %v, got %v", want, err)
			}
			after, _ := store.SnapshotAddon(ctx, "dm-tools")
			if !reflect.DeepEqual(before, after) {
				t.Fatal("rejection changed data")
			}
		})
	}
}
func TestSchemaUpgradeRollsBackAndBoundsReviews(t *testing.T) {
	store, db, input := schemaFixture(t)
	ctx := context.Background()
	review, err := store.PrepareSchemaReview(ctx, input, schemaPlan)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := store.SnapshotAddon(ctx, "dm-tools")
	if _, err = db.Exec(`CREATE TRIGGER reject_schema_upgrade BEFORE UPDATE ON addon_schema_reviews BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = store.ApplySchemaReview(ctx, review.ReviewID, review.ReviewSHA256); err == nil {
		t.Fatal("injected failure ignored")
	}
	after, _ := store.SnapshotAddon(ctx, "dm-tools")
	if !reflect.DeepEqual(before, after) {
		t.Fatal("partial commit")
	}
	saved, _ := store.GetSchemaReview(ctx, review.ReviewID)
	if saved.Status != "prepared" {
		t.Fatal("receipt committed")
	}
	var revision int
	if err = db.QueryRow("SELECT revision FROM addon_package_states").Scan(&revision); err != nil || revision != 3 {
		t.Fatal("partial state commit")
	}
	if _, err = db.Exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001)
 INSERT INTO addon_document_versions(addon_id,data_kind,data_id,document_key,revision,deleted,updated_at)
 SELECT 'dm-tools','collection','notes','deleted-'||x,1,1,'2026-09-01T12:00:00Z' FROM n`); err != nil {
		t.Fatal(err)
	}
	if _, err = store.PrepareSchemaReview(ctx, input, schemaPlan); !errors.Is(err, datalifecycle.ErrUpgradeLimit) {
		t.Fatal("unbounded snapshot", err)
	}
}
