package recoverystore

import (
	"context"
	"encoding/json"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

type partImage struct {
	Collections []json.RawMessage `json:"collections"`
	Records     []json.RawMessage `json:"records"`
	Sets        []struct {
		AddonID string `json:"addon_id"`
	} `json:"sets"`
	Documents []struct {
		AddonID string `json:"addon_id"`
		Body    string `json:"body_json"`
	} `json:"documents"`
	Blobs []struct {
		ID string `json:"blob_id"`
	} `json:"blobs"`
	Assets   []json.RawMessage `json:"assets"`
	Packages []struct {
		AddonID string `json:"addon_id"`
	} `json:"packages"`
}

func TestRecoveryPartsMigrationSplitsCombinedPoints(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	before := fstest.MapFS{}
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "0029" {
			continue
		}
		body, err := fs.ReadFile(migrations.FS, entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		before[entry.Name()] = &fstest.MapFile{Data: body}
	}
	if _, err := sqlite.Migrate(ctx, db, before); err != nil {
		t.Fatal(err)
	}

	hash := strings.Repeat("a", 64)
	coreBlob, addonBlob := "b_"+strings.Repeat("1", 32), "b_"+strings.Repeat("2", 32)
	execute(t, db, `INSERT INTO campaign_records(collection_name, record_key, position, body_json, visibility, revision, created_at, updated_at)
		VALUES ('characters', 'hero', 0, '{"id":"hero","name":"Hero"}', 'public', 1, 'then', 'then')`)
	execute(t, db, `INSERT INTO blob_objects VALUES (?, 1, 'then')`, hash)
	execute(t, db, `INSERT INTO blobs VALUES (?, ?, 'core', 'campaign', 'media', 'image/png', 'map.png', 'public', 1, 0, 'then', 'then'),
		(?, ?, 'addon', 'sheets', 'files', 'image/png', 'map.png', 'public', 1, 0, 'then', 'then')`, coreBlob, hash, addonBlob, hash)
	execute(t, db, `INSERT INTO core_media_assets(blob_id, kind, target_key, created_at) VALUES (?, 'world-map', 'main', 'then')`, coreBlob)
	execute(t, db, `INSERT INTO addon_package_generations(addon_id, generation_id, addon_version, archive_sha256, manifest_json, installed_at) VALUES ('sheets', ?, '1.0.0', ?, '{}', 'then')`, hash, hash)
	execute(t, db, `INSERT INTO addon_package_states(addon_id, active_generation_id, updated_at) VALUES ('sheets', ?, 'then')`, hash)
	for _, addon := range []string{"planner", "sheets"} {
		execute(t, db, `INSERT INTO addon_data_sets(addon_id, data_kind, data_id, materialized, schema_version, schema_sha256, keyed) VALUES (?, 'collection', 'notes', 1, '1.0.0', ?, 1)`, addon, hash)
		execute(t, db, `INSERT INTO addon_documents(addon_id, data_kind, data_id, document_key, position, body_json, schema_version, schema_sha256, revision, created_at, updated_at)
			VALUES (?, 'collection', 'notes', 'one', 0, '{"text":"first"}', '1.0.0', ?, 1, 'then', 'then')`, addon, hash)
		execute(t, db, `INSERT INTO addon_document_versions VALUES (?, 'collection', 'notes', 'one', 1, 0, 'then')`, addon)
	}
	point := func(reason string) {
		execute(t, db, `INSERT INTO recovery_points(created_at, reason, image_json) SELECT '2026-10-01T00:00:00Z', ?, image_json FROM recovery_image`, reason)
	}
	point("save")
	// Only the planner changed, but the combined point repeats every part.
	execute(t, db, `UPDATE addon_documents SET body_json = '{"text":"second"}' WHERE addon_id = 'planner'`)
	point("save")
	point("manual")
	// A point whose campaign context was deleted keeps only its add-ons.
	point("save")
	execute(t, db, `UPDATE recovery_points SET image_json = json_set(image_json, '$.campaignAvailable', json('false'),
		'$.collections', json('[]'), '$.records', json('[]'), '$.assets', json('[]')) WHERE point_id = 4`)
	var revision int64
	if err := db.QueryRow(`SELECT revision FROM recovery_control`).Scan(&revision); err != nil {
		t.Fatal(err)
	}

	if _, err := sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	broker, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	store := &Store{DB: db, Events: broker}
	result := listing(t, store)
	if result.Revision <= revision {
		t.Fatal("migration kept open reviews valid")
	}
	reasons := map[Scope][]string{}
	for _, part := range result.Parts {
		for _, point := range part.Points {
			reasons[part.Scope] = append(reasons[part.Scope], point.Reason)
		}
	}
	// Newest first. Identical consecutive automatic points collapse to the newer.
	want := map[Scope]string{
		campaignPart:         "manual save",
		addonPart("planner"): "save manual save save",
		addonPart("sheets"):  "save manual save",
	}
	if len(reasons) != len(want) {
		t.Fatalf("parts after split: %v", reasons)
	}
	for part, expected := range want {
		if got := strings.Join(reasons[part], " "); got != expected {
			t.Fatalf("%v points = %q, want %q", part, got, expected)
		}
	}
	rows, err := db.Query(`SELECT scope, addon_id, image_json FROM recovery_points`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var part Scope
		var body string
		if err := rows.Scan(&part.Scope, &part.AddonID, &body); err != nil {
			t.Fatal(err)
		}
		var image partImage
		if err := json.Unmarshal([]byte(body), &image); err != nil {
			t.Fatal(err)
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(body), &raw); err != nil || len(raw) != 8 || string(raw["version"]) != "1" {
			t.Fatalf("image keys: %s", body)
		}
		if part == campaignPart {
			if len(image.Records) != 1 || len(image.Assets) != 1 || len(image.Collections) == 0 || len(image.Blobs) != 1 || image.Blobs[0].ID != coreBlob ||
				len(image.Sets)+len(image.Documents)+len(image.Packages) != 0 {
				t.Fatalf("campaign image: %s", body)
			}
			continue
		}
		if len(image.Records)+len(image.Assets)+len(image.Collections) != 0 || len(image.Sets) != 1 || image.Sets[0].AddonID != part.AddonID ||
			len(image.Documents) != 1 || image.Documents[0].AddonID != part.AddonID {
			t.Fatalf("%s image: %s", part.AddonID, body)
		}
		if part.AddonID == "sheets" && (len(image.Packages) != 1 || len(image.Blobs) != 1 || image.Blobs[0].ID != addonBlob) ||
			part.AddonID == "planner" && len(image.Packages)+len(image.Blobs) != 0 {
			t.Fatalf("%s image owns other parts' packages or files: %s", part.AddonID, body)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	// The oldest sheets point restores that add-on's data only.
	execute(t, db, `UPDATE addon_documents SET body_json = '{"text":"third"}'`)
	sheets := points(t, store, addonPart("sheets"))
	restoreScope(t, store, sheets[len(sheets)-1].ID, addonPart("sheets"))
	var plannerText, sheetsText string
	if err := db.QueryRow(`SELECT (SELECT body_json FROM addon_documents WHERE addon_id = 'planner'), (SELECT body_json FROM addon_documents WHERE addon_id = 'sheets')`).Scan(&plannerText, &sheetsText); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plannerText, "third") || !strings.Contains(sheetsText, "first") {
		t.Fatalf("restored planner %s, sheets %s", plannerText, sheetsText)
	}
	// New points continue after the migrated ones.
	newest := points(t, store, addonPart("sheets"))[0].ID
	if err := store.Create(ctx); err != nil {
		t.Fatal(err)
	}
	if got := points(t, store, campaignPart)[0]; got.ID <= newest {
		t.Fatalf("new point id %d reuses migrated ids up to %d", got.ID, newest)
	}
}
