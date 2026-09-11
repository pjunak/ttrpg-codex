package main

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/backuparchive"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/processlock"
	"github.com/pjunak/ttrpg-codex/internal/maintenance/sheetretirement"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestRetireSheetsRequiresStoppedHostAndVerifiedRecoverableBackup(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	directory := filepath.Join(root, "source")
	db, err := sqlite.Open(ctx, filepath.Join(directory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"dnd-sheets", "dm-tools"} {
		if _, err := db.Exec(`INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized,revision,schema_version,schema_sha256,target_collection,keyed) VALUES(?,'record-extension',?,1,1,'3.0.0',?,'characters',1)`, id, id, strings.Repeat("a", 64)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at) VALUES(?,'record-extension',?,'hero',0,'{"kept":"original"}','3.0.0',?,1,'now','now')`, id, id, strings.Repeat("a", 64)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO campaign_records(collection_name,record_key,position,body_json,visibility,revision,created_at,updated_at) VALUES('characters','hero',0,'{"name":"Hero","notes":"Core notes"}','public',1,'now','now')`); err != nil {
		t.Fatal(err)
	}
	var out, diagnostic bytes.Buffer
	lock, err := processlock.AcquireHost(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := runRetireSheets(ctx, []string{"-data-dir", directory}, &out, &diagnostic); err == nil {
		t.Fatal("retired with host running")
	}
	lock.Close()
	out.Reset()
	if err := runRetireSheets(ctx, []string{"-data-dir", directory}, &out, &diagnostic); err != nil {
		t.Fatal(err)
	}
	var report sheetretirement.Report
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Keys) != 1 || report.Keys[0] != "hero" {
		t.Fatalf("preview: %+v", report)
	}
	archive := filepath.Join(root, "before-retirement.zip")
	if err := runRetireSheets(ctx, []string{"-data-dir", directory, "-apply", report.Review, "-backup", archive}, &out, &diagnostic); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM addon_documents`).Scan(&count); err != nil || count != 1 {
		t.Fatal("unrelated document changed", err)
	}
	var core string
	if err := db.QueryRow(`SELECT body_json FROM campaign_records WHERE record_key='hero'`).Scan(&core); err != nil || core != `{"name":"Hero","notes":"Core notes"}` {
		t.Fatal("core profile changed", err)
	}
	restored := filepath.Join(root, "restored")
	if _, err := backuparchive.Restore(ctx, backuparchive.RestoreConfig{ArchivePath: archive, DataDirectory: restored, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	copy, err := sqlite.Open(ctx, filepath.Join(restored, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	var sheet string
	if err := copy.QueryRow(`SELECT body_json FROM addon_documents WHERE addon_id='dnd-sheets'`).Scan(&sheet); err != nil || sheet != `{"kept":"original"}` {
		t.Fatal("backup lost retired sheet", err)
	}
}
