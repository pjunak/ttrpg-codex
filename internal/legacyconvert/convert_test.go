package legacyconvert

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

type zipEntry struct {
	name string
	body string
	mode os.FileMode
}

func TestConvertCreatesFreshDatabaseAndInventoriesDeferredData(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	archive := filepath.Join(directory, "old-ui-backup.zip")
	writeLegacyZip(t, archive, []zipEntry{
		{name: "data/", mode: os.ModeDir | 0o755},
		{name: "data/characters.json", body: `[
			{"id":"hero","name":"Hero","visibility":"public"},
			{"id":"villain","name":"Villain","visibility":"dm"}
		]`},
		{name: "data/relationships.json", body: `[]`},
		{name: "data/campaign.json", body: `{"main":{"name":"Aethelara"}}`},
		{name: "data/portraits/hero/portrait.png", body: "portrait"},
		{name: "data/addon-data/demo/rules.json", body: `[{"id":"rule"}]`},
		{name: "data/addons/demo/1111111111111111/entry.js", body: "export default 1"},
		{name: "data/addons.json", body: `{"schema":1,"addons":[]}`},
		{name: "data/auth.json", body: `{"password":"not-imported"}`},
		{name: "data/unowned.json", body: `{"kept":"in-source-backup"}`},
	})
	original, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	originalHash := sha256.Sum256(original)
	convertedAt := time.Date(2026, time.September, 1, 12, 30, 0, 0, time.UTC)
	output := filepath.Join(directory, "converted")

	report, err := Convert(context.Background(), Config{
		ArchivePath: archive, OutputDirectory: output,
		Now: func() time.Time { return convertedAt },
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.ContractVersion != "codex-v1-conversion-report.v1" ||
		report.ConvertedAt != convertedAt.Format(time.RFC3339Nano) ||
		report.CommitID != 1 || report.CoreRecords != 3 {
		t.Fatalf("report = %+v", report)
	}
	if report.CoreCollections["characters"] != 2 ||
		report.CoreCollections["relationships"] != 0 ||
		report.CoreCollections["campaign"] != 1 {
		t.Fatalf("core collection counts = %#v", report.CoreCollections)
	}
	wantDeferred := map[string]InventoryGroup{
		"media":         {Files: 1, Bytes: uint64(len("portrait"))},
		"addonData":     {Files: 1, Bytes: uint64(len(`[{"id":"rule"}]`))},
		"addonPackages": {Files: 1, Bytes: uint64(len("export default 1"))},
		"metadata":      {Files: 2, Bytes: uint64(len(`{"schema":1,"addons":[]}`) + len(`{"password":"not-imported"}`))},
		"other":         {Files: 1, Bytes: uint64(len(`{"kept":"in-source-backup"}`))},
	}
	if len(report.Deferred) != len(wantDeferred) {
		t.Fatalf("deferred groups = %#v", report.Deferred)
	}
	for group, want := range wantDeferred {
		if report.Deferred[group] != want {
			t.Fatalf("deferred %s = %+v, want %+v", group, report.Deferred[group], want)
		}
	}

	database, err := sql.Open("sqlite", filepath.Join(output, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var body, visibility, occurredAt string
	if err := database.QueryRow(`
		SELECT body_json, visibility FROM campaign_records
		WHERE collection_name = 'characters' AND record_key = 'villain'
	`).Scan(&body, &visibility); err != nil {
		t.Fatal(err)
	}
	if body != `{"id":"villain","name":"Villain","visibility":"dm"}` || visibility != "dm" {
		t.Fatalf("villain = %s, %s", body, visibility)
	}
	var materialized int
	if err := database.QueryRow(`
		SELECT materialized FROM campaign_collections WHERE name = 'relationships'
	`).Scan(&materialized); err != nil {
		t.Fatal(err)
	}
	if materialized != 1 {
		t.Fatalf("empty relationships materialized = %d", materialized)
	}
	if err := database.QueryRow(`SELECT occurred_at FROM campaign_commits WHERE commit_id = 1`).Scan(&occurredAt); err != nil {
		t.Fatal(err)
	}
	if occurredAt != convertedAt.Format(time.RFC3339Nano) {
		t.Fatalf("commit occurred_at = %s", occurredAt)
	}

	after, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256(after) != originalHash {
		t.Fatal("source archive changed during conversion")
	}
	if _, err := Convert(context.Background(), Config{
		ArchivePath: archive, OutputDirectory: output,
	}); err == nil {
		t.Fatal("second conversion unexpectedly replaced the output directory")
	}
}

func TestConvertRejectsUnsafeOrSecretEntries(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		entries []zipEntry
	}{
		{
			name: "traversal",
			entries: []zipEntry{
				{name: "data/characters.json", body: `[]`},
				{name: "data/../outside", body: "bad"},
			},
		},
		{
			name: "duplicate",
			entries: []zipEntry{
				{name: "data/characters.json", body: `[]`},
				{name: "data/characters.json", body: `[]`},
			},
		},
		{
			name: "symlink",
			entries: []zipEntry{
				{name: "data/characters.json", body: `[]`},
				{name: "data/link", body: "target", mode: os.ModeSymlink | 0o777},
			},
		},
		{
			name: "live secrets",
			entries: []zipEntry{
				{name: "data/characters.json", body: `[]`},
				{name: "data/secrets.json", body: `{}`},
			},
		},
	}
	for _, item := range tests {
		item := item
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			directory := t.TempDir()
			archive := filepath.Join(directory, "backup.zip")
			writeLegacyZip(t, archive, item.entries)
			_, err := Convert(context.Background(), Config{
				ArchivePath: archive, OutputDirectory: filepath.Join(directory, "output"),
			})
			if !errors.Is(err, ErrInvalidLegacyBackup) {
				t.Fatalf("conversion error = %v", err)
			}
			if _, statErr := os.Stat(filepath.Join(directory, "output")); !os.IsNotExist(statErr) {
				t.Fatalf("rejected archive published output: %v", statErr)
			}
		})
	}
}

func writeLegacyZip(t *testing.T, filename string, entries []zipEntry) {
	t.Helper()
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		mode := entry.mode
		if mode == 0 {
			mode = 0o640
		}
		header.SetMode(mode)
		writer, err := archive.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}
