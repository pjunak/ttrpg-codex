package sqlite

import (
	"context"
	"encoding/json"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestFactionPictureMigrationKeepsMediaAndRecovery(t *testing.T) {
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
		if entry.Name() >= "0028" {
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

	sha := strings.Repeat("a", 64)
	execute(t, db, `INSERT INTO blob_objects(sha256, bytes, created_at) VALUES (?, 5, 'then')`, sha)
	for _, blob := range []string{"b_" + strings.Repeat("1", 32), "b_" + strings.Repeat("2", 32), "b_" + strings.Repeat("3", 32)} {
		execute(t, db, `INSERT INTO blobs(blob_id, object_sha256, owner_kind, owner_id, purpose, media_type, original_name, visibility, created_at, updated_at)
			VALUES (?, ?, 'core', 'campaign', 'media', 'image/png', 'a.png', 'public', 'then', 'then')`, blob, sha)
	}
	execute(t, db, `INSERT INTO core_media_assets(sequence, blob_id, kind, target_key, created_at) VALUES (7, ?, 'character-portrait', 'hero', 'then')`,
		"b_"+strings.Repeat("1", 32))

	if _, err := Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}

	var sequence int
	var kind, target string
	if err := db.QueryRow(`SELECT sequence, kind, target_key FROM core_media_assets`).Scan(&sequence, &kind, &target); err != nil {
		t.Fatal(err)
	}
	if sequence != 7 || kind != "character-portrait" || target != "hero" {
		t.Fatalf("kept asset = %d %s %s", sequence, kind, target)
	}
	var revision int
	if err := db.QueryRow(`SELECT revision FROM recovery_control`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	// A faction picture is now accepted, numbered after the kept asset, and
	// still counts as a recoverable change.
	execute(t, db, `INSERT INTO core_media_assets(blob_id, kind, target_key, created_at) VALUES (?, 'faction-picture', 'guild', 'now')`,
		"b_"+strings.Repeat("2", 32))
	var after int
	if err := db.QueryRow(`SELECT revision FROM recovery_control`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != revision+1 {
		t.Fatalf("recovery revision %d -> %d", revision, after)
	}
	var image string
	if err := db.QueryRow(`SELECT image_json FROM recovery_image`).Scan(&image); err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Assets []struct {
			Sequence int    `json:"sequence"`
			Kind     string `json:"kind"`
		} `json:"assets"`
	}
	if err := json.Unmarshal([]byte(image), &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Assets) != 2 || parsed.Assets[0].Sequence != 7 || parsed.Assets[1].Sequence != 8 || parsed.Assets[1].Kind != "faction-picture" {
		t.Fatalf("recovery image assets = %+v", parsed.Assets)
	}
	if _, err := db.Exec(`INSERT INTO core_media_assets(blob_id, kind, target_key, created_at) VALUES (?, 'unknown-kind', 'x', 'now')`,
		"b_"+strings.Repeat("3", 32)); err == nil || !strings.Contains(err.Error(), "CHECK") {
		t.Fatalf("unknown media kind: %v", err)
	}
}
