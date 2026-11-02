package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"io/fs"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestDropCharacterKnowledgeMigration(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
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
		if entry.Name() >= "0027" {
			continue
		}
		body, err := fs.ReadFile(migrations.FS, entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		before[entry.Name()] = &fstest.MapFile{Data: body}
	}
	if _, err := Migrate(ctx, db, before); err != nil {
		t.Fatal(err)
	}

	records := []struct{ collection, key, body string }{
		{"characters", "known", `{"id":"known","name":"Known","knowledge":0,"tags":["a"],"extension":{"keep":true}}`},
		{"characters", "plain", `{"id":"plain","name":"Plain"}`},
		{"locations", "gate", `{"id":"gate","name":"Gate","knowledge":2}`},
	}
	for position, record := range records {
		execute(t, db, `INSERT INTO campaign_records(collection_name, record_key, position, body_json, visibility, revision, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'public', 3, 'created', 'updated')`, record.collection, record.key, position, record.body)
		execute(t, db, `INSERT INTO campaign_record_versions(collection_name, record_key, revision, deleted, updated_at)
			VALUES (?, ?, 3, 0, 'updated')`, record.collection, record.key)
	}
	execute(t, db, `UPDATE campaign_collections SET revision = 5 WHERE name IN ('characters', 'locations')`)
	image, err := json.Marshal(map[string]any{
		"version": 1,
		"records": []map[string]any{
			{"collection_name": "characters", "record_key": "known", "body_json": records[0].body},
			{"collection_name": "locations", "record_key": "gate", "body_json": records[2].body},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	execute(t, db, `INSERT INTO recovery_points(created_at, reason, image_json) VALUES ('then', 'manual', ?)`, string(image))

	if _, err := Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}

	for _, want := range []struct {
		collection, key, body string
		revision              int
	}{
		{"characters", "known", `{"id":"known","name":"Known","tags":["a"],"extension":{"keep":true}}`, 4},
		{"characters", "plain", records[1].body, 3},
		{"locations", "gate", records[2].body, 3},
	} {
		var body string
		var revision, versionRevision int
		if err := db.QueryRow(`SELECT r.body_json, r.revision, v.revision FROM campaign_records r
			JOIN campaign_record_versions v USING (collection_name, record_key)
			WHERE r.collection_name = ? AND r.record_key = ?`, want.collection, want.key).Scan(&body, &revision, &versionRevision); err != nil {
			t.Fatal(err)
		}
		if body != want.body || revision != want.revision || versionRevision != want.revision {
			t.Errorf("%s/%s = %s r%d v%d, want %s r%d", want.collection, want.key, body, revision, versionRevision, want.body, want.revision)
		}
	}
	for collection, want := range map[string]int{"characters": 6, "locations": 5} {
		var revision int
		if err := db.QueryRow(`SELECT revision FROM campaign_collections WHERE name = ?`, collection).Scan(&revision); err != nil {
			t.Fatal(err)
		}
		if revision != want {
			t.Errorf("%s collection revision = %d, want %d", collection, revision, want)
		}
	}

	var stored string
	if err := db.QueryRow(`SELECT image_json FROM recovery_points`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var point struct {
		Records []struct {
			Collection string `json:"collection_name"`
			Body       string `json:"body_json"`
		} `json:"records"`
	}
	if err := json.Unmarshal([]byte(stored), &point); err != nil {
		t.Fatal(err)
	}
	if len(point.Records) != 2 ||
		point.Records[0].Body != `{"id":"known","name":"Known","tags":["a"],"extension":{"keep":true}}` ||
		point.Records[1].Body != records[2].body {
		t.Fatalf("recovery point records = %+v", point.Records)
	}
}

func execute(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
