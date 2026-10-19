package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestRestoreRefusesWhileHostOwnsDataDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "data")
	lock, err := processlock.AcquireHost(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	err = runRestore(context.Background(), []string{
		"-data-dir", directory, "-in", filepath.Join(t.TempDir(), "backup.zip"),
	}, &bytes.Buffer{}, &bytes.Buffer{})
	if !errors.Is(err, processlock.ErrAlreadyLocked) {
		t.Fatalf("restore error = %v", err)
	}
}

func TestBackupVerifiesItsArchiveAndRemovesOneThatFails(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	data := filepath.Join(root, "data")
	db, err := sqlite.Open(ctx, filepath.Join(data, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	healthy := filepath.Join(root, "healthy.zip")
	if err := runBackup(ctx, []string{"-data-dir", data, "-out", healthy}, &stdout, &bytes.Buffer{}); err != nil ||
		!strings.Contains(stdout.String(), "Created and verified") {
		t.Fatalf("healthy backup = %q, %v", stdout.String(), err)
	}
	// Creation does not check what verification does: here the database lists
	// a media object whose file the archive lacks.
	digest := strings.Repeat("a", 64)
	if _, err := db.Exec(`INSERT INTO blob_objects VALUES (?,1,'now')`, digest); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO blobs VALUES (?,?,'core','main','world-map','image/png','map.png','public',1,0,'now','now')`,
		"b_"+strings.Repeat("1", 32), digest); err != nil {
		t.Fatal(err)
	}
	broken := filepath.Join(root, "broken.zip")
	err = runBackup(ctx, []string{"-data-dir", data, "-out", broken}, &bytes.Buffer{}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "failed verification") {
		t.Fatalf("unverifiable backup error = %v", err)
	}
	if _, err := os.Stat(broken); !os.IsNotExist(err) {
		t.Fatalf("unverifiable archive was kept: %v", err)
	}
}
