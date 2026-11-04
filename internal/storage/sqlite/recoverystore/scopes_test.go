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
	campaignPoint, sheets := points(t, s, campaignPart)[0], points(t, s, addonPart("sheets"))[0]
	if campaignPoint.Media != 1 || sheets.Media != 1 || sheets.Documents != 1 || campaignPoint.Documents != 0 {
		t.Fatalf("parts share media or documents: %+v %+v", campaignPoint, sheets)
	}
	put(t, records, "hero", "After", 1)
	execute(t, s.DB, `UPDATE addon_documents SET body_json='{"text":"after"}',revision=2`)
	execute(t, s.DB, `UPDATE addon_document_versions SET revision=2`)
	execute(t, s.DB, `UPDATE blobs SET deleted=1,revision=2`)
	// An unrelated missing provider cannot block restoring this add-on.
	execute(t, s.DB, `UPDATE addon_package_states SET active_generation_id=NULL WHERE addon_id='planner'`)
	restoreScope(t, s, sheets.ID, addonPart("sheets"))
	assertOwnedRecovery(t, s, "sheets", "future", 3, 0)
	assertOwnedRecovery(t, s, "planner", "after", 2, 1)
	core, err := records.Get(ctx, campaign.Characters, "hero")
	if err != nil || core.Revision != 2 || !strings.Contains(string(core.Value), "After") {
		t.Fatal("add-on restore changed core", core, err)
	}
	// No add-on package is now compatible. Campaign recovery must still work.
	execute(t, s.DB, `UPDATE addon_package_states SET active_generation_id=NULL`)
	restoreScope(t, s, campaignPoint.ID, campaignPart)
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

func TestRetiringAndDeletingPointsPreservesOtherParts(t *testing.T) {
	s, records := fixture(t)
	ctx := context.Background()
	put(t, records, "hero", "Before", 0)
	hash := seedOwnedRecovery(t, s, "sheets")
	seedOwnedRecovery(t, s, "planner")
	if err := s.Create(ctx); err != nil {
		t.Fatal(err)
	}
	campaignPoint := points(t, s, campaignPart)[0]
	planner := points(t, s, addonPart("planner"))[0]
	before := listing(t, s)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := RetireAddonGeneration(ctx, tx, "sheets", hash); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	after := listing(t, s)
	if after.Revision == before.Revision || points(t, s, addonPart("sheets")) != nil ||
		len(points(t, s, campaignPart)) != len(before.Parts[0].Points) || len(points(t, s, addonPart("planner"))) != 1 {
		t.Fatalf("wrong generation retirement: %+v", after.Parts)
	}
	assertOwnedRecovery(t, s, "sheets", "future", 1, 0)
	restoreScope(t, s, campaignPoint.ID, campaignPart)
	if err := s.Delete(ctx, DeleteRequest{Scope: campaignPart, ID: campaignPoint.ID, ExpectedRevision: listing(t, s).Revision}); err != nil {
		t.Fatal(err)
	}
	if got := points(t, s, campaignPart); len(got) != len(before.Parts[0].Points) || got[0].Reason != "pre-restore" || got[1].ID == campaignPoint.ID {
		t.Fatalf("campaign deletion removed the wrong point: %+v", got)
	}
	restoreScope(t, s, planner.ID, addonPart("planner"))
	if err := s.Delete(ctx, DeleteRequest{Scope: addonPart("planner"), ID: planner.ID, ExpectedRevision: listing(t, s).Revision}); err != nil {
		t.Fatal(err)
	}
	if got := points(t, s, addonPart("planner")); len(got) != 1 || got[0].Reason != "pre-restore" {
		t.Fatalf("add-on deletion removed the wrong point: %+v", got)
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
	campaignPoint, sheets := points(t, s, campaignPart)[0], points(t, s, addonPart("sheets"))[0]
	execute(t, s.DB, `UPDATE campaign_records SET created_at='different-incarnation' WHERE record_key='hero'`)
	before := listing(t, s)
	err := s.Restore(ctx, RestoreRequest{Scope: addonPart("sheets"), ID: sheets.ID, ExpectedRevision: before.Revision}, "dm")
	if !errors.Is(err, ErrCompatibility) {
		t.Fatal("attached old extension to reused ID", err)
	}
	if after := listing(t, s); after.Revision != before.Revision || len(after.Parts) != len(before.Parts) {
		t.Fatal("failed recovery left changes")
	}
	restoreScope(t, s, campaignPoint.ID, campaignPart)
	restoreScope(t, s, sheets.ID, addonPart("sheets"))
}

func TestRecoveryRejectsInvalidOrMissingScopeAndRetirementRollsBack(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	hash := seedOwnedRecovery(t, s, "sheets")
	if err := s.Create(ctx); err != nil {
		t.Fatal(err)
	}
	before := listing(t, s)
	sheets := points(t, s, addonPart("sheets"))[0]
	for _, scope := range []Scope{{Scope: "unknown"}, {Scope: "campaign", AddonID: "sheets"}, {Scope: "addon"}, {Scope: "addon", AddonID: "../sheets"}} {
		if err := s.Restore(ctx, RestoreRequest{Scope: scope, ID: sheets.ID, ExpectedRevision: before.Revision}, "dm"); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid restore scope", scope, err)
		}
		if err := s.Delete(ctx, DeleteRequest{Scope: scope, ID: sheets.ID, ExpectedRevision: before.Revision}); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid delete scope", scope, err)
		}
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := RetireAddonGeneration(ctx, tx, "sheets", hash); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if after := listing(t, s); after.Revision != before.Revision || len(points(t, s, addonPart("sheets"))) != 1 {
		t.Fatal("rolled back retirement escaped", after)
	}
	for _, scope := range []Scope{addonPart("missing"), campaignPart} {
		if err := s.Delete(ctx, DeleteRequest{Scope: scope, ID: sheets.ID, ExpectedRevision: before.Revision}); !errors.Is(err, ErrNotFound) {
			t.Fatal("deleted a point through another part", scope, err)
		}
	}
}
