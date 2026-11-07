package sqlite

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestSingleSessionRoleMigrationSignsOutSwitchedSessions(t *testing.T) {
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
		if entry.Name() >= "0030" {
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
	csrf := strings.Repeat("c", 32)
	for _, roles := range [][2]string{{"dm", "dm"}, {"player", "player"}, {"dm", "player"}} {
		execute(t, db, `INSERT INTO host_sessions(token_digest, real_role, role, csrf_token, created_at, expires_at)
			VALUES (randomblob(32), ?, ?, ?, 'then', 'later')`, roles[0], roles[1], csrf)
	}

	if _, err := Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}

	rows, err := db.Query(`SELECT role FROM host_sessions ORDER BY role`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var kept []string
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			t.Fatal(err)
		}
		kept = append(kept, role)
	}
	if err := rows.Err(); err != nil || strings.Join(kept, ",") != "dm,player" {
		t.Fatalf("kept sessions = %v, %v", kept, err)
	}
}
