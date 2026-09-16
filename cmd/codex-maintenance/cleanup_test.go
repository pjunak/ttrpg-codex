package main

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/cleanup"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestNamespaceCleanupRequiresStoppedHostExactReviewAndVerifiedBackup(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	directory := filepath.Join(root, "source")
	db, err := sqlite.Open(ctx, filepath.Join(directory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized,revision,schema_version,schema_sha256,keyed)
 VALUES('retired-addon','collection','notes',1,1,'1.0.0',?,1)`, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at)
 VALUES('retired-addon','collection','notes','note',0,'{"note":"preserved"}','1.0.0',?,1,'now','now')`, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	args := []string{"delete-addon-data", "-data-dir", directory, "-addon", "retired-addon"}
	var out, diagnostics bytes.Buffer
	lock, err := processlock.AcquireHost(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err = run(ctx, args, &out, &diagnostics); err == nil {
		t.Fatal("maintenance allowed while host running")
	}
	lock.Close()
	out.Reset()
	if err = run(ctx, args, &out, &diagnostics); err != nil {
		t.Fatal(err)
	}
	var report cleanup.Report
	if err = json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "before-delete.zip")
	if err = run(ctx, append(args, "-apply", "incorrect", "-backup", archive), &out, &diagnostics); err == nil {
		t.Fatal("unreviewed deletion allowed")
	}
	out.Reset()
	if err = run(ctx, append(args, "-apply", report.Review, "-backup", archive), &out, &diagnostics); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.QueryRow("SELECT count(*) FROM addon_documents").Scan(&count); err != nil || count != 0 {
		t.Fatal("namespace not removed", count, err)
	}
	restored := filepath.Join(root, "restored")
	if _, err = backuparchive.Restore(ctx, backuparchive.RestoreConfig{ArchivePath: archive, DataDirectory: restored, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	copy, err := sqlite.Open(ctx, filepath.Join(restored, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	var body string
	if err = copy.QueryRow("SELECT body_json FROM addon_documents").Scan(&body); err != nil || body != `{"note":"preserved"}` {
		t.Fatal("backup lost namespace", body, err)
	}
}
