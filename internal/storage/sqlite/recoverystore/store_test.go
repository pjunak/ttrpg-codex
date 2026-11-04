package recoverystore

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"log/slog"
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

var campaignPart = Scope{Scope: "campaign"}

func addonPart(id string) Scope { return Scope{Scope: "addon", AddonID: id} }

// points returns one part's points, newest first.
func points(t *testing.T, store *Store, part Scope) []Point {
	t.Helper()
	for _, listed := range listing(t, store).Parts {
		if listed.Scope == part {
			return listed.Points
		}
	}
	return nil
}
func put(t *testing.T, records *campaignstore.Store, key, name string, revision int64) {
	t.Helper()
	_, err := records.Transact(context.Background(), campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{Kind: campaign.Put, Collection: campaign.Characters, Key: key, ExpectedRevision: revision, Value: []byte(`{"id":"` + key + `","name":"` + name + `","future":{"kept":true}}`)}}})
	if err != nil {
		t.Fatal(err)
	}
}
func registerPackage(t *testing.T, store *Store, addonID, generation string) {
	t.Helper()
	execute(t, store.DB, `INSERT INTO addon_package_generations(addon_id,generation_id,addon_version,archive_sha256,manifest_json,installed_at) VALUES(?,?,'1.0.0',?,'{}','now')`, addonID, generation, generation)
	execute(t, store.DB, `INSERT INTO addon_package_states(addon_id,active_generation_id,updated_at) VALUES(?,?,'now')`, addonID, generation)
}

func restore(t *testing.T, store *Store, id int64) {
	t.Helper()
	if err := store.Restore(context.Background(), RestoreRequest{Scope: campaignPart, ID: id, ExpectedRevision: listing(t, store).Revision}, "dm"); err != nil {
		t.Fatal(err)
	}
}

// writeAddon runs the add-on data store's write hook in its own transaction,
// as an add-on document write does.
func writeAddon(t *testing.T, store *Store, addonID, text string) {
	t.Helper()
	tx, err := store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := store.BeforeWrite(context.Background(), tx, addonID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`UPDATE addon_documents SET body_json = json_object('text', ?), revision = revision + 1 WHERE addon_id = ?`, text, addonID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
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
	registerPackage(t, store, "sheets", strings.Repeat("a", 64))
	if err := store.Create(ctx); err != nil {
		t.Fatal(err)
	}
	point := points(t, store, campaignPart)[0]
	sheets := points(t, store, addonPart("sheets"))[0]
	if planner := points(t, store, addonPart("planner")); len(planner) != 1 || planner[0].Documents != 0 {
		t.Fatalf("manual point skipped an add-on part: %+v", planner)
	}
	if point.Documents != 0 || sheets.Records != 0 || sheets.Documents != 1 || sheets.GenerationID != digest {
		t.Fatalf("parts share data: campaign %+v sheets %+v", point, sheets)
	}
	put(t, records, "keeper", "After", 1)
	put(t, records, "newcomer", "New", 0)
	execute(t, store.DB, `UPDATE addon_documents SET body_json='{"notes":"after"}',revision=2`)
	execute(t, store.DB, `UPDATE addon_document_versions SET revision=2`)
	stale := listing(t, store).Revision
	restore(t, store, point.ID)
	safety := points(t, store, campaignPart)[0]
	restoreScope(t, store, sheets.ID, addonPart("sheets"))
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
	if err := store.Restore(ctx, RestoreRequest{Scope: campaignPart, ID: point.ID, ExpectedRevision: stale}, "dm"); !errors.Is(err, ErrConflict) {
		t.Fatalf("accepted stale review: %v", err)
	}
	if safety.Reason != "pre-restore" || safety.Documents != 0 {
		t.Fatalf("wrong safety point: %+v", safety)
	}
	restore(t, store, safety.ID)
	got, err = records.Get(ctx, campaign.Characters, "newcomer")
	if err != nil || got.Revision != 3 {
		t.Fatalf("safety restore failed: %+v %v", got, err)
	}
	var audits int
	if err := store.DB.QueryRow(`SELECT count(*) FROM recovery_restores`).Scan(&audits); err != nil || audits != 3 {
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

func TestWritesCaptureOnlyTheirOwnPart(t *testing.T) {
	store, records := fixture(t)
	ctx := context.Background()
	hash := seedOwnedRecovery(t, store, "sheets")
	execute(t, store.DB, `DELETE FROM recovery_points`)
	put(t, records, "hero", "First", 0)
	if got := listing(t, store).Parts; len(got) != 1 || len(got[0].Points) != 1 {
		t.Fatalf("campaign edit captured other parts: %+v", got)
	}
	// The campaign's throttle does not delay the add-on's first point.
	writeAddon(t, store, "sheets", "second")
	sheets := points(t, store, addonPart("sheets"))
	if len(sheets) != 1 || sheets[0].Reason != "save" || sheets[0].Records != 0 || sheets[0].Documents != 1 || sheets[0].GenerationID != hash {
		t.Fatalf("add-on edit not captured on its own: %+v", sheets)
	}
	if len(points(t, store, campaignPart)) != 1 {
		t.Fatal("add-on edit captured the campaign")
	}
	writeAddon(t, store, "sheets", "third")
	if len(points(t, store, addonPart("sheets"))) != 1 {
		t.Fatal("add-on edits within a minute were not coalesced")
	}
	// One transaction that changes both parts captures each once.
	execute(t, store.DB, `DELETE FROM recovery_capture`)
	tx, err := store.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, addonID := range []string{"", "sheets", "", "sheets"} {
		if err := store.BeforeWrite(ctx, tx, addonID); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if campaignPoints, sheetsPoints := points(t, store, campaignPart), points(t, store, addonPart("sheets")); len(campaignPoints) != 2 || len(sheetsPoints) != 2 {
		t.Fatalf("composed write captured %d campaign and %d add-on points", len(campaignPoints), len(sheetsPoints))
	}
	// Reverting the add-on's last edit group leaves the campaign untouched.
	saved := listing(t, store)
	if err := store.Restore(ctx, RestoreRequest{Scope: addonPart("sheets"), Count: 2, ExpectedRevision: saved.Revision}, "dm"); err != nil {
		t.Fatal(err)
	}
	assertOwnedRecovery(t, store, "sheets", "before", 2, 0)
	hero, err := records.Get(ctx, campaign.Characters, "hero")
	if err != nil || hero.Revision != 1 {
		t.Fatalf("add-on revert changed the campaign: %+v %v", hero, err)
	}
	if got := points(t, store, campaignPart); len(got) != 2 {
		t.Fatalf("add-on revert saved a campaign safety point: %+v", got)
	}
}

func TestLatestReusesCurrentPointsAndSavesChangedParts(t *testing.T) {
	store, records := fixture(t)
	ctx := context.Background()
	put(t, records, "hero", "First", 0)
	hash := seedOwnedRecovery(t, store, "sheets")
	execute(t, store.DB, `UPDATE addon_package_generations SET addon_version = '2.1.0'`)
	first, err := store.Latest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].Scope != campaignPart || first[0].Reason != "download" || first[1].Scope != addonPart("sheets") ||
		first[1].GenerationID != hash || first[1].AddonVersion != "2.1.0" || !strings.Contains(first[1].Image, "before") {
		t.Fatalf("wrong snapshots: %+v", first)
	}
	again, err := store.Latest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if again[0].PointID != first[0].PointID || again[1].PointID != first[1].PointID {
		t.Fatal("unchanged parts saved new points")
	}
	writeAddon(t, store, "sheets", "changed")
	changed, err := store.Latest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if changed[0].PointID != first[0].PointID || changed[1].PointID == first[1].PointID || changed[1].Reason != "download" || !strings.Contains(changed[1].Image, "changed") {
		t.Fatalf("changed add-on not saved: %+v", changed)
	}
	// The automatic point before that edit is reused when nothing changed since.
	execute(t, store.DB, `DELETE FROM recovery_capture`)
	put(t, records, "hero", "Second", 1)
	newest := points(t, store, campaignPart)[0]
	execute(t, store.DB, `UPDATE campaign_records SET body_json = (SELECT value ->> 'body_json' FROM recovery_points, json_each(image_json, '$.records') WHERE point_id = ?)`, newest.ID)
	reused, err := store.Latest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if reused[0].PointID != newest.ID || reused[0].Reason != "save" {
		t.Fatalf("identical newest point not reused: %+v", reused[0])
	}
}

func TestImportedPointsJoinTheirPartAndRestore(t *testing.T) {
	store, records := fixture(t)
	ctx := context.Background()
	put(t, records, "hero", "Before", 0)
	snapshots, err := store.Latest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	put(t, records, "hero", "After", 1)
	tx, err := store.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := InsertImported(ctx, tx, addonPart("../escape"), "2026-01-01T00:00:00Z", snapshots[0].Image); !errors.Is(err, ErrInvalid) {
		t.Fatalf("imported an invalid part: %v", err)
	}
	if err := InsertImported(ctx, tx, campaignPart, "2026-01-01T00:00:00Z", snapshots[0].Image); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	imported := points(t, store, campaignPart)[0]
	if imported.Reason != "imported" || imported.CreatedAt != "2026-01-01T00:00:00Z" {
		t.Fatalf("wrong imported point: %+v", imported)
	}
	restore(t, store, imported.ID)
	hero, err := records.Get(ctx, campaign.Characters, "hero")
	if err != nil || !strings.Contains(string(hero.Value), "Before") {
		t.Fatalf("imported point not restored: %+v %v", hero, err)
	}
}

func TestCampaignRestoreOfAPointWithoutACollectionLeavesItUnmaterialized(t *testing.T) {
	store, records := fixture(t)
	put(t, records, "keeper", "Before", 0)
	if err := store.Create(context.Background()); err != nil {
		t.Fatal(err)
	}
	point := points(t, store, campaignPart)[0]
	// A point captured before a core collection existed does not list it.
	execute(t, store.DB, `UPDATE recovery_points SET image_json = json_set(image_json, '$.collections', json((
		SELECT json_group_array(item.value) FROM json_each(image_json, '$.collections') AS item WHERE item.value ->> 'name' <> 'companions'))) WHERE point_id = ?`, point.ID)
	execute(t, store.DB, `UPDATE campaign_collections SET materialized = 1 WHERE name IN ('characters', 'companions')`)
	restore(t, store, point.ID)
	var characters, companions int
	if err := store.DB.QueryRow(`SELECT
		(SELECT materialized FROM campaign_collections WHERE name = 'characters'),
		(SELECT materialized FROM campaign_collections WHERE name = 'companions')`).Scan(&characters, &companions); err != nil {
		t.Fatal(err)
	}
	if characters != 1 || companions != 0 {
		t.Fatalf("materialized characters = %d, companions = %d", characters, companions)
	}
}

func TestOversizedCampaignSkipsAutomaticPointsWithoutFailingWrites(t *testing.T) {
	store, records := fixture(t)
	ctx := context.Background()
	var logged bytes.Buffer
	store.Logger = slog.New(slog.NewTextHandler(&logged, nil))
	put(t, records, "keeper", "Before", 0)
	small := points(t, store, campaignPart)
	// Grow the campaign past the point limit without going through the store.
	execute(t, store.DB, `INSERT INTO campaign_records(collection_name, record_key, position, body_json, visibility, revision, created_at, updated_at)
		VALUES ('characters', 'giant', 1, json_object('id', 'giant', 'notes', hex(zeroblob(?))), 'public', 1, 'now', 'now')`, MaxImageBytes/2)
	execute(t, store.DB, `DELETE FROM recovery_capture`)
	put(t, records, "keeper", "After", 1)
	put(t, records, "keeper", "Again", 2)
	record, err := records.Get(ctx, campaign.Characters, "keeper")
	if err != nil || !strings.Contains(string(record.Value), "Again") {
		t.Fatalf("write failed: %+v %v", record, err)
	}
	if got := points(t, store, campaignPart); len(got) != len(small) {
		t.Fatalf("captured an oversized point: %+v", got)
	}
	if count := strings.Count(logged.String(), "automatic recovery point skipped"); count != 1 {
		t.Fatalf("logged %d skips within a minute:\n%s", count, logged.String())
	}
	if err := store.Create(ctx); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("manual point error = %v", err)
	}
	if _, err := store.Latest(ctx); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("download point error = %v", err)
	}
	before := listing(t, store)
	err = store.Restore(ctx, RestoreRequest{Scope: campaignPart, ID: small[0].ID, ExpectedRevision: before.Revision}, "dm")
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("restore without a safety point error = %v", err)
	}
	if after := listing(t, store); after.Revision != before.Revision || len(after.Parts[0].Points) != len(before.Parts[0].Points) {
		t.Fatal("refused restore changed the recovery list")
	}
}

func TestAutomaticPointsCoalesceAndRollbackWithWrites(t *testing.T) {
	store, records := fixture(t)
	put(t, records, "keeper", "First", 0)
	put(t, records, "keeper", "Second", 1)
	saved := listing(t, store)
	if len(saved.Parts) != 1 || len(saved.Parts[0].Points) != 1 || saved.Parts[0].Points[0].Records != 0 {
		t.Fatalf("not captured before write: %+v", saved)
	}
	execute(t, store.DB, `DELETE FROM recovery_capture`)
	_, err := records.Transact(context.Background(), campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{
		{Kind: campaign.Put, Collection: campaign.Characters, Key: "temporary", ExpectedRevision: 0, Value: []byte(`{"id":"temporary"}`)},
		{Kind: campaign.Put, Collection: campaign.Characters, Key: "keeper", ExpectedRevision: 99, Value: []byte(`{"id":"keeper"}`)},
	}})
	if err == nil {
		t.Fatal("invalid write accepted")
	}
	if got := listing(t, store); len(got.Parts[0].Points) != 1 || got.Revision != saved.Revision {
		t.Fatalf("failed write left a snapshot: %+v", got)
	}
	put(t, records, "keeper", "Third", 2)
	saved = listing(t, store)
	if len(saved.Parts[0].Points) != 2 || saved.Parts[0].Points[0].Records != 1 {
		t.Fatal("second edit group missing")
	}
	if err := store.Restore(context.Background(), RestoreRequest{Scope: campaignPart, Count: 1, ExpectedRevision: saved.Revision}, "dm"); err != nil {
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
	point := points(t, store, campaignPart)[0]
	if point.Media != 1 {
		t.Fatalf("media not counted: %+v", point)
	}
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
	restore(t, store, points(t, store, campaignPart)[0].ID)
	if err := store.DB.QueryRow(`SELECT deleted FROM blobs WHERE blob_id=?`, second).Scan(&deleted); err != nil || deleted != 0 {
		t.Fatal("safety image lost")
	}
}

func TestRetentionPerPartAndCompatibilityFailureAreAtomic(t *testing.T) {
	store, _ := fixture(t)
	ctx := context.Background()
	registerPackage(t, store, "sheets", strings.Repeat("a", 64))
	for i := 0; i < MaxPointsPerPart+5; i++ {
		if err := store.Create(ctx); err != nil {
			t.Fatal(err)
		}
	}
	before := listing(t, store)
	if len(before.Parts) != 2 || len(before.Parts[0].Points) != MaxPointsPerPart || len(before.Parts[1].Points) != MaxPointsPerPart {
		t.Fatalf("retention not bounded per part: %+v", before.Parts)
	}
	addon := before.Parts[1].Points[0]
	execute(t, store.DB, `UPDATE recovery_points SET image_json=json_set(image_json,'$.packages',json('[{"addon_id":"sheets","active_generation_id":"different"}]')) WHERE point_id=?`, addon.ID)
	saved := listing(t, store)
	if saved.Parts[1].Points[0].Compatible {
		t.Fatal("changed package listed as compatible")
	}
	err := store.Restore(ctx, RestoreRequest{Scope: addonPart("sheets"), ID: addon.ID, ExpectedRevision: saved.Revision}, "dm")
	if !errors.Is(err, ErrCompatibility) {
		t.Fatalf("accepted changed packages: %v", err)
	}
	// A point is found only in its own part.
	err = store.Restore(ctx, RestoreRequest{Scope: campaignPart, ID: addon.ID, ExpectedRevision: saved.Revision}, "dm")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("restored an add-on point as the campaign: %v", err)
	}
	if got := listing(t, store); got.Revision != saved.Revision || len(got.Parts[1].Points) != MaxPointsPerPart {
		t.Fatal("failed restore changed state")
	}
	if err := store.Delete(ctx, DeleteRequest{Scope: campaignPart, ID: saved.Parts[0].Points[1].ID, ExpectedRevision: saved.Revision}); err != nil {
		t.Fatal(err)
	}
	if got := listing(t, store); len(got.Parts[0].Points) != MaxPointsPerPart-1 || len(got.Parts[1].Points) != MaxPointsPerPart || got.Revision == saved.Revision {
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
	point := points(t, store, campaignPart)[0]
	put(t, records, "keeper", "After", 1)
	before := listing(t, store)
	store.Events = failingJournal{store.Events}
	if err := store.Restore(context.Background(), RestoreRequest{Scope: campaignPart, ID: point.ID, ExpectedRevision: before.Revision}, "dm"); err == nil {
		t.Fatal("failed event was ignored")
	}
	after := listing(t, store)
	if after.Revision != before.Revision || len(after.Parts[0].Points) != len(before.Parts[0].Points) {
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
	point := points(t, store, campaignPart)[0]
	put(t, records, "keeper", "After", 1)
	request := RestoreRequest{Scope: campaignPart, ID: point.ID, ExpectedRevision: listing(t, store).Revision}
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
	execute(t, store.DB, `DELETE FROM recovery_capture`)
	if err := store.Create(ctx); err != nil {
		t.Fatal(err)
	}
	manual := points(t, store, campaignPart)[0]
	put(t, records, "keeper", "Second", 1)
	if point := points(t, store, campaignPart)[0]; point.Reason != "save" || point.ID <= manual.ID {
		t.Fatal("manual point suppressed the next edit group")
	}
	restore(t, store, manual.ID)
	put(t, records, "keeper", "Third", 3)
	if point := points(t, store, campaignPart)[0]; point.Reason != "save" {
		t.Fatal("restore merged a new edit into the old group")
	}
}
