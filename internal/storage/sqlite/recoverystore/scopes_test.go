package recoverystore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func recoveryBlobID(id string) string {
	digest := sha256.Sum256([]byte(id))
	return "b_" + hex.EncodeToString(digest[:16])
}

func seedOwnedRecovery(t *testing.T, s *Store, id string) string {
	t.Helper()
	hash := strings.Repeat("a", 64)
	execute(t, s.DB, `INSERT INTO addon_package_generations(addon_id,generation_id,addon_version,archive_sha256,manifest_json,installed_at) VALUES(?,?,'1.0.0',?,'{}','now')`, id, hash, hash)
	execute(t, s.DB, `INSERT INTO addon_package_states(addon_id,active_generation_id,updated_at) VALUES(?,?,'now')`, id, hash)
	execute(t, s.DB, `INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized,schema_version,schema_sha256,keyed) VALUES(?,'collection','notes',1,'1.0.0',?,1)`, id, hash)
	execute(t, s.DB, `INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at) VALUES(?,'collection','notes','one',0,'{"text":"before","future":{"keep":true}}','1.0.0',?,1,'then','then')`, id, hash)
	execute(t, s.DB, `INSERT INTO addon_document_versions VALUES(?,'collection','notes','one',1,0,'then')`, id)
	execute(t, s.DB, `INSERT OR IGNORE INTO blob_objects VALUES (?,1,'now')`, hash)
	execute(t, s.DB, `INSERT INTO blobs VALUES (?,?,'addon',?,'files','image/png','map.png','public',1,0,'now','now')`, recoveryBlobID(id), hash, id)
	return hash
}

func restoreScope(t *testing.T, s *Store, id int64, scope Scope) {
	t.Helper()
	if err := s.Restore(context.Background(), RestoreRequest{Scope: scope, ID: id, ExpectedRevision: listing(t, s).Revision}, "dm"); err != nil {
		t.Fatal(err)
	}
}

func assertOwnedRecovery(t *testing.T, s *Store, id, text string, revision, deleted int) {
	t.Helper()
	var body string
	var gotRevision, gotDeleted int
	if err := s.DB.QueryRow(`SELECT body_json,revision FROM addon_documents WHERE addon_id=? AND data_kind='collection'`, id).Scan(&body, &gotRevision); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.QueryRow(`SELECT deleted FROM blobs WHERE blob_id=?`, recoveryBlobID(id)).Scan(&gotDeleted); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, text) || gotRevision != revision || gotDeleted != deleted {
		t.Fatalf("%s changed outside its recovery scope: %s revision=%d deleted=%d", id, body, gotRevision, gotDeleted)
	}
}

func TestCampaignAndAddonRecoveryAreIndependent(t *testing.T) {
	s, records := fixture(t)
	ctx := context.Background()
	put(t, records, "hero", "Before", 0)
	hash := seedOwnedRecovery(t, s, "sheets")
	seedOwnedRecovery(t, s, "planner")
	execute(t, s.DB, `INSERT INTO blobs VALUES (?,?,'core','main','world-map','image/png','map.png','public',1,0,'now','now')`, recoveryBlobID("core"), hash)
	if err := s.Create(ctx); err != nil {
		t.Fatal(err)
	}
	id := listing(t, s).Points[0].ID
	put(t, records, "hero", "After", 1)
	execute(t, s.DB, `UPDATE addon_documents SET body_json='{"text":"after"}',revision=2`)
	execute(t, s.DB, `UPDATE addon_document_versions SET revision=2`)
	execute(t, s.DB, `UPDATE blobs SET deleted=1,revision=2`)
	// An unrelated missing provider cannot block restoring this add-on.
	execute(t, s.DB, `UPDATE addon_package_states SET active_generation_id=NULL WHERE addon_id='planner'`)
	// An unrelated owner can have older retained history than its current head.
	// Restoring sheets must neither inspect nor append that owner's history.
	execute(t, s.DB, `INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized,schema_version,schema_sha256,target_collection,keyed) VALUES('planner','record-extension','history-sheet',1,'1.0.0',?,'characters',1)`, hash)
	execute(t, s.DB, `INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at,target_created_at) SELECT 'planner','record-extension','history-sheet','hero',0,'{}','1.0.0',?,2,created_at,created_at,created_at FROM campaign_records WHERE record_key='hero'`, hash)
	execute(t, s.DB, `INSERT INTO addon_document_versions VALUES('planner','record-extension','history-sheet','hero',2,0,'2026-09-01T00:00:00Z')`)
	execute(t, s.DB, `INSERT INTO addon_history_revisions SELECT 'planner','record-extension','history-sheet','hero',1,created_at,?,'dm','2026-09-01T00:00:00Z','before','edit','Saved note',0,'{}' FROM campaign_records WHERE record_key='hero'`, hash)
	restoreScope(t, s, id, Scope{Scope: "addon", AddonID: "sheets"})
	assertOwnedRecovery(t, s, "sheets", "future", 3, 0)
	assertOwnedRecovery(t, s, "planner", "after", 2, 1)
	var historyCount int
	if err := s.DB.QueryRow(`SELECT count(*) FROM addon_history_revisions WHERE addon_id='planner'`).Scan(&historyCount); err != nil || historyCount != 1 {
		t.Fatal("unrelated history changed", historyCount, err)
	}
	core, err := records.Get(ctx, campaign.Characters, "hero")
	if err != nil || core.Revision != 2 || !strings.Contains(string(core.Value), "After") {
		t.Fatal("add-on restore changed core", core, err)
	}
	// No add-on package is now compatible. Campaign recovery must still work.
	execute(t, s.DB, `UPDATE addon_package_states SET active_generation_id=NULL`)
	restoreScope(t, s, id, Scope{Scope: "campaign"})
	core, err = records.Get(ctx, campaign.Characters, "hero")
	if err != nil || core.Revision != 3 || !strings.Contains(string(core.Value), "Before") {
		t.Fatal("campaign restore failed", core, err)
	}
	assertOwnedRecovery(t, s, "sheets", "future", 3, 0)
	assertOwnedRecovery(t, s, "planner", "after", 2, 1)
	var deleted int
	if err := s.DB.QueryRow(`SELECT deleted FROM blobs WHERE blob_id=?`, recoveryBlobID("core")).Scan(&deleted); err != nil || deleted != 0 {
		t.Fatal("campaign media not restored", deleted, err)
	}
	var scope, addon string
	if err := s.DB.QueryRow(`SELECT scope,addon_id FROM recovery_restores ORDER BY restore_id DESC LIMIT 1`).Scan(&scope, &addon); err != nil || scope != "campaign" || addon != "" {
		t.Fatal("scope missing from audit", scope, addon, err)
	}
}

func TestRetiringAndDeletingContextsPreservesOtherRecovery(t *testing.T) {
	s, records := fixture(t)
	ctx := context.Background()
	put(t, records, "hero", "Before", 0)
	hash := seedOwnedRecovery(t, s, "sheets")
	seedOwnedRecovery(t, s, "planner")
	if err := s.Create(ctx); err != nil {
		t.Fatal(err)
	}
	id := listing(t, s).Points[0].ID
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := RetireAddonContext(ctx, tx, "sheets", hash); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	point := listing(t, s).Points[0]
	if point.ID != id || !point.CampaignAvailable || point.Records != 1 || len(point.Addons) != 1 || point.Addons[0].AddonID != "planner" {
		t.Fatalf("wrong context retirement: %+v", point)
	}
	assertOwnedRecovery(t, s, "sheets", "future", 1, 0)
	restoreScope(t, s, id, Scope{Scope: "campaign"})
	if err := s.DeleteContext(ctx, DeleteRequest{Scope: Scope{Scope: "campaign"}, ID: id, ExpectedRevision: listing(t, s).Revision}); err != nil {
		t.Fatal(err)
	}
	var remaining Point
	for _, p := range listing(t, s).Points {
		if p.ID == id {
			remaining = p
		}
	}
	if remaining.CampaignAvailable || len(remaining.Addons) != 1 {
		t.Fatal("campaign deletion lost add-on context", remaining)
	}
	restoreScope(t, s, id, Scope{Scope: "addon", AddonID: "planner"})
	if err := s.DeleteContext(ctx, DeleteRequest{Scope: Scope{Scope: "addon", AddonID: "planner"}, ID: id, ExpectedRevision: listing(t, s).Revision}); err != nil {
		t.Fatal(err)
	}
	for _, p := range listing(t, s).Points {
		if p.ID == id {
			t.Fatal("empty recovery envelope retained")
		}
	}
}

func TestAddonRecoveryRejectsReusedLinkedRecordUntilCampaignIsRestored(t *testing.T) {
	s, records := fixture(t)
	ctx := context.Background()
	put(t, records, "hero", "Original", 0)
	hash := seedOwnedRecovery(t, s, "sheets")
	execute(t, s.DB, `INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized,schema_version,schema_sha256,target_collection,keyed) VALUES('sheets','record-extension','sheet',1,'1.0.0',?,'characters',1)`, hash)
	execute(t, s.DB, `INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at,target_created_at) SELECT 'sheets','record-extension','sheet','hero',0,'{}','1.0.0',?,1,created_at,created_at,created_at FROM campaign_records WHERE record_key='hero'`, hash)
	if err := s.Create(ctx); err != nil {
		t.Fatal(err)
	}
	id := listing(t, s).Points[0].ID
	execute(t, s.DB, `UPDATE campaign_records SET created_at='different-incarnation' WHERE record_key='hero'`)
	before := listing(t, s)
	err := s.Restore(ctx, RestoreRequest{Scope: Scope{Scope: "addon", AddonID: "sheets"}, ID: id, ExpectedRevision: before.Revision}, "dm")
	if !errors.Is(err, ErrCompatibility) {
		t.Fatal("attached old extension to reused ID", err)
	}
	if after := listing(t, s); after.Revision != before.Revision || len(after.Points) != len(before.Points) {
		t.Fatal("failed recovery left changes")
	}
	restoreScope(t, s, id, Scope{Scope: "campaign"})
	restoreScope(t, s, id, Scope{Scope: "addon", AddonID: "sheets"})
}

func TestRecoveryRejectsInvalidOrMissingScopeAndRetirementRollsBack(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	hash := seedOwnedRecovery(t, s, "sheets")
	if err := s.Create(ctx); err != nil {
		t.Fatal(err)
	}
	before := listing(t, s)
	for _, scope := range []Scope{{Scope: "unknown"}, {Scope: "campaign", AddonID: "sheets"}, {Scope: "addon"}, {Scope: "addon", AddonID: "../sheets"}} {
		if err := s.Restore(ctx, RestoreRequest{Scope: scope, ID: before.Points[0].ID, ExpectedRevision: before.Revision}, "dm"); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid restore scope", scope, err)
		}
		if err := s.DeleteContext(ctx, DeleteRequest{Scope: scope, ID: before.Points[0].ID, ExpectedRevision: before.Revision}); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid delete scope", scope, err)
		}
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := RetireAddonContext(ctx, tx, "sheets", hash); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	after := listing(t, s)
	if after.Revision != before.Revision || len(after.Points[0].Addons) != 1 {
		t.Fatal("rolled back retirement escaped", after)
	}
	if err := s.DeleteContext(ctx, DeleteRequest{Scope: Scope{Scope: "addon", AddonID: "missing"}, ID: before.Points[0].ID, ExpectedRevision: before.Revision}); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}
