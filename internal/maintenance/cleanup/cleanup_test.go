package cleanup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/events"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func database(t *testing.T) (*sql.DB, string) {
	t.Helper()
	directory := t.TempDir()
	db, err := storage.Open(context.Background(), filepath.Join(directory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err = storage.Migrate(context.Background(), db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	return db, directory
}
func execute(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
func count(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var result int
	if err := db.QueryRow(query, args...).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}
func document(t *testing.T, db *sql.DB, addon string) {
	t.Helper()
	execute(t, db, "INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized,revision) VALUES(?,'collection','notes',1,1)", addon)
	execute(t, db, `INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at)
 VALUES(?,'collection','notes','entry',0,'{"note":"authored"}','1.0.0',?,1,'now','now')`, addon, strings.Repeat("a", 64))
}

func TestNamespaceDeletionIsReviewedAtomicAndCannotBeUndoneByLocalRecovery(t *testing.T) {
	db, _ := database(t)
	ctx := context.Background()
	for _, id := range []string{"retired-addon", "kept-addon"} {
		document(t, db, id)
	}
	execute(t, db, "INSERT INTO recovery_points(created_at,reason,image_json) SELECT 'now','manual',image_json FROM recovery_image")
	options := Options{Kind: "delete-addon-data", AddonID: "retired-addon"}
	report, err := Inspect(ctx, db, options)
	if err != nil {
		t.Fatal(err)
	}
	if report.RecoveryPoints != 1 {
		t.Fatalf("recovery preview: %+v", report)
	}
	execute(t, db, `UPDATE addon_documents SET body_json='{"note":"changed"}' WHERE addon_id='retired-addon'`)
	if _, err = Apply(ctx, db, options, report.Review); !errors.Is(err, ErrStale) {
		t.Fatalf("stale apply: %v", err)
	}
	report, err = Inspect(ctx, db, options)
	if err != nil {
		t.Fatal(err)
	}
	execute(t, db, `CREATE TRIGGER fail_cleanup BEFORE DELETE ON addon_data_sets BEGIN SELECT RAISE(ABORT,'injected failure'); END`)
	if _, err = Apply(ctx, db, options, report.Review); err == nil {
		t.Fatal("injected delete succeeded")
	}
	if count(t, db, `SELECT count(*) FROM recovery_points,json_each(image_json,'$.documents') WHERE value ->> 'addon_id'='retired-addon'`) != 1 {
		t.Fatal("failure altered recovery")
	}
	execute(t, db, "DROP TRIGGER fail_cleanup")
	if _, err = Apply(ctx, db, options, report.Review); err != nil {
		t.Fatal(err)
	}
	if count(t, db, "SELECT count(*) FROM addon_documents WHERE addon_id='retired-addon'") != 0 {
		t.Fatal("namespace survived")
	}
	if count(t, db, "SELECT count(*) FROM addon_documents WHERE addon_id='kept-addon'") != 1 {
		t.Fatal("unrelated data changed")
	}
	if count(t, db, `SELECT count(*) FROM recovery_points,json_each(image_json,'$.documents') WHERE value ->> 'addon_id'='retired-addon'`) != 0 {
		t.Fatal("recovery can recreate namespace")
	}
	if count(t, db, `SELECT count(*) FROM recovery_points,json_each(image_json,'$.documents') WHERE value ->> 'addon_id'='kept-addon'`) != 1 {
		t.Fatal("unrelated recovery changed")
	}
}

func TestNamespaceDeletionProtectsSharedRetainedPayloads(t *testing.T) {
	db, _ := database(t)
	ctx := context.Background()
	shared := strings.Repeat("a", 64)
	unique := strings.Repeat("b", 64)
	execute(t, db, "INSERT INTO addon_history_payloads VALUES(?,'1'),(?,'2')", shared, unique)
	for i, id := range []string{"retired-addon", "kept-addon"} {
		fields := `{"shared":"` + shared + `"}`
		if i == 0 {
			fields = `{"shared":"` + shared + `","unique":"` + unique + `"}`
		}
		execute(t, db, `INSERT INTO addon_history_revisions VALUES(?,'record-extension','sheet','hero',1,'now','generation','dm','now','op','edit','save',0,?)`, id, fields)
	}
	options := Options{Kind: "delete-addon-data", AddonID: "retired-addon"}
	report, err := Inspect(ctx, db, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Apply(ctx, db, options, report.Review); err != nil {
		t.Fatal(err)
	}
	if count(t, db, "SELECT count(*) FROM addon_history_payloads WHERE sha256=?", shared) != 1 {
		t.Fatal("shared retained history lost")
	}
	if count(t, db, "SELECT count(*) FROM addon_history_payloads WHERE sha256=?", unique) != 0 {
		t.Fatal("deleted namespace payload retained")
	}
	if count(t, db, "SELECT count(*) FROM addon_history_revisions") != 1 {
		t.Fatal("wrong history deletion")
	}
}

func TestReviewedLogRetentionPreservesRoleScopedReplayAndAuthoredHistory(t *testing.T) {
	db, _ := database(t)
	ctx := context.Background()
	broker, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	sequence := map[events.Audience]int64{}
	for i := 0; i < 3; i++ {
		for _, audience := range []events.Audience{events.AudiencePublic, events.AudienceDM, events.AudienceSystem} {
			event, err := broker.Publish(ctx, events.Publication{Audience: audience, Topic: "data-changed", Revision: "1"})
			if err != nil {
				t.Fatal(err)
			}
			sequence[audience] = event.Sequence
		}
	}
	document(t, db, "kept-addon")
	execute(t, db, "INSERT INTO recovery_points(created_at,reason,image_json) SELECT 'now','manual',image_json FROM recovery_image")
	for i := 0; i < 3; i++ {
		execute(t, db, "INSERT INTO campaign_commits(actor_id,occurred_at,mutation_count) VALUES('dm','now',1)")
		execute(t, db, "INSERT INTO campaign_commit_records VALUES(?,0,'characters','hero','put',0,1,'dm')", i+1)
	}
	options := Options{Kind: "prune-logs", Events: 1, Lifecycle: 1, Audit: 1}
	report, err := Inspect(ctx, db, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Apply(ctx, db, options, report.Review); err != nil {
		t.Fatal(err)
	}
	for _, audience := range []events.Audience{events.AudiencePublic, events.AudienceDM} {
		replay, err := broker.Replay(ctx, audience, 0, 10)
		if err != nil || !replay.Expired || replay.Latest != sequence[audience] {
			t.Fatalf("expired %s: %+v %v", audience, replay, err)
		}
	}
	if count(t, db, "SELECT count(*) FROM campaign_commits") != 1 || count(t, db, "SELECT count(*) FROM campaign_commit_records") != 1 {
		t.Fatal("audit children not bounded")
	}
	if count(t, db, "SELECT count(*) FROM addon_documents") != 1 || count(t, db, "SELECT count(*) FROM recovery_points") != 1 {
		t.Fatal("authored data expired")
	}
	options.Events = 0
	report, err = Inspect(ctx, db, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Apply(ctx, db, options, report.Review); err != nil {
		t.Fatal(err)
	}
	latest, err := broker.Latest(ctx, events.AudiencePublic)
	if err != nil || latest != sequence[events.AudiencePublic] {
		t.Fatal("cursor regressed or leaked", latest, err)
	}
	replay, err := broker.Replay(ctx, events.AudiencePublic, latest, 10)
	if err != nil || replay.Expired || len(replay.Events) != 0 {
		t.Fatalf("boundary %+v %v", replay, err)
	}
	event, err := broker.Publish(ctx, events.Publication{Audience: events.AudiencePublic, Topic: "data-changed", Revision: "2"})
	if err != nil || event.Sequence <= sequence[events.AudienceSystem] {
		t.Fatal("sequence was reused", event, err)
	}
	replay, err = broker.Replay(ctx, events.AudiencePublic, latest, 10)
	if err != nil || len(replay.Events) != 1 || replay.Events[0].Sequence != event.Sequence {
		t.Fatalf("resume: %+v %v", replay, err)
	}
}

func object(t *testing.T, db *sql.DB, directory, body string, ids ...string) string {
	t.Helper()
	digest := sha256.Sum256([]byte(body))
	hash := hex.EncodeToString(digest[:])
	path := filepath.Join(directory, "blobs", "sha256", hash[:2], hash)
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if len(ids) > 0 {
		execute(t, db, "INSERT INTO blob_objects VALUES(?,?,'now')", hash, len(body))
		for _, id := range ids {
			execute(t, db, "INSERT INTO blobs VALUES (?,?,'core','main','portrait','image/png','','public',1,1,'now','now')", id, hash)
		}
	}
	return hash
}
func TestBlobCollectionProtectsSharedRecoveryAndAuthoredReferencesAndResumes(t *testing.T) {
	db, directory := database(t)
	ctx := context.Background()
	ids := []string{}
	for _, char := range []string{"1", "2", "3", "4", "5"} {
		ids = append(ids, "b_"+strings.Repeat(char, 32))
	}
	shared := object(t, db, directory, "shared", ids[0], ids[1])
	execute(t, db, "UPDATE blobs SET deleted=0 WHERE blob_id=?", ids[0])
	recovery := object(t, db, directory, "recovery", ids[2])
	execute(t, db, "UPDATE blobs SET deleted=0 WHERE blob_id=?", ids[2])
	execute(t, db, "INSERT INTO recovery_points(created_at,reason,image_json) SELECT 'now','manual',image_json FROM recovery_image")
	execute(t, db, "UPDATE blobs SET deleted=1 WHERE blob_id=?", ids[2])
	history := object(t, db, directory, "history", ids[3])
	execute(t, db, "INSERT INTO addon_history_payloads VALUES(?,json_object('image',?))", strings.Repeat("f", 64), ids[3])
	removed := object(t, db, directory, "unused", ids[4])
	orphan := object(t, db, directory, "orphan")
	report, err := InspectBlobs(ctx, db, directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Objects) != 2 || report.ProtectedObjects != 3 {
		t.Fatalf("preview: %+v", report)
	}
	execute(t, db, "UPDATE blobs SET deleted=0 WHERE blob_id=?", ids[4])
	if _, err = QueueBlobs(ctx, db, directory, report.Review); !errors.Is(err, ErrStale) {
		t.Fatal("stale candidate accepted", err)
	}
	execute(t, db, "UPDATE blobs SET deleted=1 WHERE blob_id=?", ids[4])
	report, err = InspectBlobs(ctx, db, directory)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = QueueBlobs(ctx, db, directory, report.Review); err != nil {
		t.Fatal(err)
	}
	// Simulate a stop after one unlink, then recreation of that content by the host.
	if err = os.Remove(filepath.Join(directory, "blobs", "sha256", removed[:2], removed)); err != nil {
		t.Fatal(err)
	}
	execute(t, db, "INSERT INTO blob_objects VALUES(?,6,'now')", orphan)
	if err = ResumeBlobs(ctx, db, directory); err != nil {
		t.Fatal(err)
	}
	if err = ResumeBlobs(ctx, db, directory); err != nil {
		t.Fatal("resume not idempotent", err)
	}
	for _, hash := range []string{shared, recovery, history, orphan} {
		if _, err = os.Stat(filepath.Join(directory, "blobs", "sha256", hash[:2], hash)); err != nil {
			t.Fatal("protected object lost", hash, err)
		}
	}
	if count(t, db, "SELECT count(*) FROM blob_collection_pending") != 0 {
		t.Fatal("pending intents remained")
	}
	if count(t, db, "SELECT count(*) FROM blobs WHERE blob_id=?", ids[4]) != 0 {
		t.Fatal("unused handle remained")
	}
}

func TestBlobCollectionRefusesCorruptObject(t *testing.T) {
	db, directory := database(t)
	hash := object(t, db, directory, "orphan")
	if err := os.WriteFile(filepath.Join(directory, "blobs", "sha256", hash[:2], hash), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectBlobs(context.Background(), db, directory); err == nil {
		t.Fatal("corrupt file eligible for deletion")
	}
}
