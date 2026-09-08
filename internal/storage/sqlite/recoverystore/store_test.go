package recoverystore

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func fixture(t *testing.T) (*Store, *campaignstore.Store) {
	t.Helper()
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	broker, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	store := &Store{DB: db, Events: broker}
	records, err := campaignstore.New(campaignstore.Config{DB: db, Events: broker, BeforeWrite: store.BeforeWrite})
	if err != nil {
		t.Fatal(err)
	}
	return store, records
}
func execute(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
func listing(t *testing.T, store *Store) Listing {
	t.Helper()
	result, err := store.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func put(t *testing.T, records *campaignstore.Store, key, name string, revision int64) {
	t.Helper()
	_, err := records.Transact(context.Background(), campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{Kind: campaign.Put, Collection: campaign.Characters, Key: key, ExpectedRevision: revision, Value: []byte(`{"id":"` + key + `","name":"` + name + `","future":{"kept":true}}`)}}})
	if err != nil {
		t.Fatal(err)
	}
}
func restore(t *testing.T, store *Store, id int64) {
	t.Helper()
	if err := store.Restore(context.Background(), RestoreRequest{ID: id, ExpectedRevision: listing(t, store).Revision}, "dm"); err != nil {
		t.Fatal(err)
	}
}

func TestRestorePreservesDataAndAdvancesRevisions(t *testing.T) {
	store, records := fixture(t)
	ctx := context.Background()
	put(t, records, "keeper", "Before", 0)
	// An empty owned collection and a record extension both belong to recovery.
	digest := strings.Repeat("a", 64)
	execute(t, store.DB, `INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized,schema_version,schema_sha256,target_collection,keyed) VALUES ('sheets','record-extension','sheet',1,'1.0.0',?,'characters',1), ('planner','collection','empty',1,'1.0.0',?,NULL,1)`, digest, digest)
	execute(t, store.DB, `INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at,target_created_at)
        SELECT 'sheets','record-extension','sheet','keeper',0,'{"notes":"before"}','1.0.0',?,1,created_at,created_at,created_at FROM campaign_records WHERE record_key='keeper'`, digest)
	execute(t, store.DB, `INSERT INTO addon_document_versions VALUES ('sheets','record-extension','sheet','keeper',1,0,'now')`)
	execute(t, store.DB, `INSERT INTO host_credentials VALUES (1,7,'{}')`)
	if err := store.Create(ctx); err != nil {
		t.Fatal(err)
	}
	point := listing(t, store).Points[0]
	put(t, records, "keeper", "After", 1)
	put(t, records, "newcomer", "New", 0)
	execute(t, store.DB, `UPDATE addon_documents SET body_json='{"notes":"after"}',revision=2`)
	execute(t, store.DB, `UPDATE addon_document_versions SET revision=2`)
	stale := listing(t, store).Revision
	restore(t, store, point.ID)
	got, err := records.Get(ctx, campaign.Characters, "keeper")
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != 3 || !strings.Contains(string(got.Value), `"Before"`) || !strings.Contains(string(got.Value), `"future"`) {
		t.Fatalf("wrong restored record: %+v", got)
	}
	state, err := records.State(ctx, campaign.Characters, "newcomer")
	if err != nil || state.Exists || state.Revision != 2 {
		t.Fatalf("lost deletion tombstone: %+v %v", state, err)
	}
	var notes string
	var revision, materialized int
	if err := store.DB.QueryRow(`SELECT body_json,revision FROM addon_documents`).Scan(&notes, &revision); err != nil {
		t.Fatal(err)
	}
	if notes != `{"notes":"before"}` || revision != 3 {
		t.Fatalf("wrong addon restore: %s %d", notes, revision)
	}
	if err := store.DB.QueryRow(`SELECT materialized FROM addon_data_sets WHERE addon_id='planner'`).Scan(&materialized); err != nil || materialized != 1 {
		t.Fatalf("empty collection lost: %d %v", materialized, err)
	}
	if err := store.DB.QueryRow(`SELECT revision FROM host_credentials`).Scan(&revision); err != nil || revision != 7 {
		t.Fatal("credentials changed")
	}
	if err := store.Restore(ctx, RestoreRequest{ID: point.ID, ExpectedRevision: stale}, "dm"); !errors.Is(err, ErrConflict) {
		t.Fatalf("accepted stale review: %v", err)
	}
	safety := listing(t, store).Points[0]
	if safety.Reason != "pre-restore" {
		t.Fatal("missing safety point")
	}
	restore(t, store, safety.ID)
	got, err = records.Get(ctx, campaign.Characters, "newcomer")
	if err != nil || got.Revision != 3 {
		t.Fatalf("safety restore failed: %+v %v", got, err)
	}
	var audits int
	if err := store.DB.QueryRow(`SELECT count(*) FROM recovery_restores`).Scan(&audits); err != nil || audits != 2 {
		t.Fatal("missing restore audit")
	}
	var topic, audience string
	if err := store.DB.QueryRow(`SELECT topic,audience FROM change_log ORDER BY sequence DESC LIMIT 1`).Scan(&topic, &audience); err != nil || topic != "campaign-restored" || audience != "public" {
		t.Fatal("missing durable refresh")
	}
	checks, err := store.DB.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer checks.Close()
	if checks.Next() {
		t.Fatal("restore left a foreign key violation")
	}
	if err := checks.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestAutomaticPointsCoalesceAndRollbackWithWrites(t *testing.T) {
	store, records := fixture(t)
	put(t, records, "keeper", "First", 0)
	put(t, records, "keeper", "Second", 1)
	points := listing(t, store)
	if len(points.Points) != 1 || points.Points[0].Records != 0 {
		t.Fatalf("not captured before write: %+v", points)
	}
	execute(t, store.DB, `UPDATE recovery_control SET last_capture=0`)
	_, err := records.Transact(context.Background(), campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{
		{Kind: campaign.Put, Collection: campaign.Characters, Key: "temporary", ExpectedRevision: 0, Value: []byte(`{"id":"temporary"}`)},
		{Kind: campaign.Put, Collection: campaign.Characters, Key: "keeper", ExpectedRevision: 99, Value: []byte(`{"id":"keeper"}`)},
	}})
	if err == nil {
		t.Fatal("invalid write accepted")
	}
	if got := listing(t, store); len(got.Points) != 1 || got.Revision != points.Revision {
		t.Fatalf("failed write left a snapshot: %+v", got)
	}
	put(t, records, "keeper", "Third", 2)
	points = listing(t, store)
	if len(points.Points) != 2 || points.Points[0].Records != 1 {
		t.Fatal("second edit group missing")
	}
	if err := store.Restore(context.Background(), RestoreRequest{Count: 1, ExpectedRevision: points.Revision}, "dm"); err != nil {
		t.Fatal(err)
	}
	record, err := records.Get(context.Background(), campaign.Characters, "keeper")
	if err != nil || !strings.Contains(string(record.Value), "Second") {
		t.Fatalf("revert failed: %+v %v", record, err)
	}
}

func TestRestoreMediaAndDeletedRecord(t *testing.T) {
	store, records := fixture(t)
	ctx := context.Background()
	put(t, records, "keeper", "Original", 0)
	first, second := "b_"+strings.Repeat("1", 32), "b_"+strings.Repeat("2", 32)
	digest := strings.Repeat("a", 64)
	execute(t, store.DB, `INSERT INTO blob_objects VALUES (?,1,'now')`, digest)
	addMedia := func(id string) {
		execute(t, store.DB, `INSERT INTO blobs VALUES (?,?,'core','main','world-map','image/png','map.png','public',1,0,'now','now')`, id, digest)
		execute(t, store.DB, `INSERT INTO core_media_assets(blob_id,kind,target_key,created_at) VALUES (?,'world-map','main','now')`, id)
	}
	addMedia(first)
	if err := store.Create(ctx); err != nil {
		t.Fatal(err)
	}
	point := listing(t, store).Points[0]
	addMedia(second)
	execute(t, store.DB, `UPDATE blobs SET deleted=1,revision=2 WHERE blob_id=?`, first)
	_, err := records.Transact(ctx, campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{Kind: campaign.Delete, Collection: campaign.Characters, Key: "keeper", ExpectedRevision: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	restore(t, store, point.ID)
	record, err := records.Get(ctx, campaign.Characters, "keeper")
	if err != nil || record.Revision != 3 {
		t.Fatalf("deleted record not revived: %+v %v", record, err)
	}
	var deleted, revision int
	if err := store.DB.QueryRow(`SELECT deleted,revision FROM blobs WHERE blob_id=?`, first).Scan(&deleted, &revision); err != nil || deleted != 0 || revision != 3 {
		t.Fatalf("old image not revived %d %d %v", deleted, revision, err)
	}
	if err := store.DB.QueryRow(`SELECT deleted FROM blobs WHERE blob_id=?`, second).Scan(&deleted); err != nil || deleted != 1 {
		t.Fatal("newer image remains latest")
	}
	restore(t, store, listing(t, store).Points[0].ID)
	if err := store.DB.QueryRow(`SELECT deleted FROM blobs WHERE blob_id=?`, second).Scan(&deleted); err != nil || deleted != 0 {
		t.Fatal("safety image lost")
	}
}

func TestRetentionAndCompatibilityFailureAreAtomic(t *testing.T) {
	store, _ := fixture(t)
	ctx := context.Background()
	for i := 0; i < 55; i++ {
		if err := store.Create(ctx); err != nil {
			t.Fatal(err)
		}
	}
	points := listing(t, store)
	if len(points.Points) != 50 {
		t.Fatal("retention not bounded")
	}
	execute(t, store.DB, `UPDATE recovery_points SET image_json=json_set(image_json,'$.packages',json('[{"addon_id":"different","active_generation_id":"generation"}]')) WHERE point_id=?`, points.Points[0].ID)
	err := store.Restore(ctx, RestoreRequest{ID: points.Points[0].ID, ExpectedRevision: points.Revision}, "dm")
	if !errors.Is(err, ErrCompatibility) {
		t.Fatalf("accepted changed packages: %v", err)
	}
	if got := listing(t, store); got.Revision != points.Revision || len(got.Points) != 50 {
		t.Fatal("failed restore changed state")
	}
	if err := store.Delete(ctx, points.Points[0].ID, points.Revision); err != nil {
		t.Fatal(err)
	}
	if len(listing(t, store).Points) != 49 {
		t.Fatal("delete failed")
	}
}

type failingJournal struct{ Journal }

func (f failingJournal) Append(context.Context, *sql.Tx, events.Publication) (events.Event, error) {
	return events.Event{}, errors.New("event storage failure")
}

func TestFailedRestoreRollsBackDataRevisionsAndSafetyPoint(t *testing.T) {
	store, records := fixture(t)
	put(t, records, "keeper", "Before", 0)
	if err := store.Create(context.Background()); err != nil {
		t.Fatal(err)
	}
	point := listing(t, store).Points[0]
	put(t, records, "keeper", "After", 1)
	before := listing(t, store)
	store.Events = failingJournal{store.Events}
	if err := store.Restore(context.Background(), RestoreRequest{ID: point.ID, ExpectedRevision: before.Revision}, "dm"); err == nil {
		t.Fatal("failed event was ignored")
	}
	after := listing(t, store)
	if after.Revision != before.Revision || len(after.Points) != len(before.Points) {
		t.Fatal("failed restore left a safety point or advanced revisions")
	}
	record, err := records.Get(context.Background(), campaign.Characters, "keeper")
	if err != nil || record.Revision != 2 || !strings.Contains(string(record.Value), "After") {
		t.Fatalf("failed restore changed campaign: %+v %v", record, err)
	}
	var suppressed int
	if err := store.DB.QueryRow(`SELECT suppressed FROM recovery_control`).Scan(&suppressed); err != nil || suppressed != 0 {
		t.Fatal("restore left capture disabled")
	}
}

func TestConcurrentRestoreHasOneWinner(t *testing.T) {
	store, records := fixture(t)
	put(t, records, "keeper", "Before", 0)
	if err := store.Create(context.Background()); err != nil {
		t.Fatal(err)
	}
	point := listing(t, store).Points[0]
	put(t, records, "keeper", "After", 1)
	request := RestoreRequest{ID: point.ID, ExpectedRevision: listing(t, store).Revision}
	var wait sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wait.Go(func() { results <- store.Restore(context.Background(), request, "dm") })
	}
	wait.Wait()
	close(results)
	succeeded, conflicted := 0, 0
	for err := range results {
		if err == nil {
			succeeded++
		} else if errors.Is(err, ErrConflict) {
			conflicted++
		} else {
			t.Fatal(err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("restore results: %d succeeded, %d conflicted", succeeded, conflicted)
	}
}

func TestManualPointsAndRestoresDoNotHideTheNextEditGroup(t *testing.T) {
	store, records := fixture(t)
	ctx := context.Background()
	put(t, records, "keeper", "First", 0)
	execute(t, store.DB, `UPDATE recovery_control SET last_capture=0`)
	if err := store.Create(ctx); err != nil {
		t.Fatal(err)
	}
	manual := listing(t, store).Points[0]
	put(t, records, "keeper", "Second", 1)
	if point := listing(t, store).Points[0]; point.Reason != "save" || point.ID <= manual.ID {
		t.Fatal("manual point suppressed the next edit group")
	}
	restore(t, store, manual.ID)
	put(t, records, "keeper", "Third", 3)
	if point := listing(t, store).Points[0]; point.Reason != "save" {
		t.Fatal("restore merged a new edit into the old group")
	}
}
