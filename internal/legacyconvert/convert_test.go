package legacyconvert

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
	image := string([]byte("\x89PNG\r\n\x1a\nlegacy-image"))
	writeLegacyZip(t, archive, []zipEntry{
		{name: "data/", mode: os.ModeDir | 0o755},
		{name: "data/characters.json", body: `[
			{"id":"hero","name":"Hero","visibility":"public","portrait":"/portraits/hero/portrait.png?v=old"},
			{"id":"villain","name":"Villain","visibility":"dm","portrait":"/portraits/villain/portrait.png"}
		]`},
		{name: "data/relationships.json", body: `[]`},
		{name: "data/locations.json", body: `[
			{"id":"village","name":"Village","localMap":"/maps/local/village/map.png"}
		]`},
		{name: "data/settings.json", body: `{
			"pinTypes":[{"id":"town","iconConfig":{"strategy":"single","files":[{"id":"town.png","url":"/icons/town/town.png"}]}}],
			"branding":{"logoUrl":"/branding/logo.png","title":"Codex"}
		}`},
		{name: "data/campaign.json", body: `{"main":{"name":"Aethelara"}}`},
		{name: "data/portraits/hero/portrait.png", body: image},
		{name: "data/portraits/villain/portrait.png", body: image},
		{name: "data/maps/local/village/map.png", body: image},
		{name: "data/maps/swordcoast/sword_coast.png", body: image},
		{name: "data/maps/tiles/world/0/0/0.jpg", body: "derived tile"},
		{name: "data/icons/town/town.png", body: image},
		{name: "data/branding/logo.png", body: image},
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
	if report.ContractVersion != "codex-v1-conversion-report.v2" ||
		report.ConvertedAt != convertedAt.Format(time.RFC3339Nano) ||
		report.CommitID != 1 || report.CoreRecords != 6 {
		t.Fatalf("report = %+v", report)
	}
	if report.CoreCollections["characters"] != 2 ||
		report.CoreCollections["relationships"] != 0 ||
		report.CoreCollections["campaign"] != 1 ||
		report.CoreCollections["locations"] != 1 ||
		report.CoreCollections["settings"] != 2 {
		t.Fatalf("core collection counts = %#v", report.CoreCollections)
	}
	if report.Media.Imported != (InventoryGroup{Files: 6, Bytes: uint64(6 * len(image))}) ||
		report.Media.Bindings != 6 || report.Media.RewrittenRecords != 5 ||
		report.Media.DiscardedDerived != (InventoryGroup{Files: 1, Bytes: uint64(len("derived tile"))}) {
		t.Fatalf("media report = %+v", report.Media)
	}
	wantDeferred := map[string]InventoryGroup{
		"media":         {},
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
	if !strings.Contains(body, `"portrait":"/api/media/b_`) || visibility != "dm" {
		t.Fatalf("villain = %s, %s", body, visibility)
	}
	if err := database.QueryRow(`
		SELECT body_json FROM campaign_records
		WHERE collection_name = 'characters' AND record_key = 'hero'
	`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, `"portrait":"/api/media/b_`) || strings.Contains(body, "/portraits/") {
		t.Fatalf("rewritten hero = %s", body)
	}
	var bindings, handles, objects int
	if err := database.QueryRow(`SELECT count(*) FROM core_media_assets`).Scan(&bindings); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM blobs`).Scan(&handles); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM blob_objects`).Scan(&objects); err != nil {
		t.Fatal(err)
	}
	if bindings != 6 || handles != 6 || objects != 1 {
		t.Fatalf("media persistence = bindings %d, handles %d, objects %d", bindings, handles, objects)
	}
	var hiddenPortraits int
	if err := database.QueryRow(`
		SELECT count(*)
		FROM core_media_assets AS asset
		JOIN blobs AS blob ON blob.blob_id = asset.blob_id
		WHERE asset.kind = 'character-portrait'
		  AND asset.target_key = 'villain'
		  AND blob.visibility = 'dm'
	`).Scan(&hiddenPortraits); err != nil || hiddenPortraits != 1 {
		t.Fatalf("hidden portrait bindings = %d, %v", hiddenPortraits, err)
	}
	var legacyURLs int
	if err := database.QueryRow(`
		SELECT count(*) FROM campaign_records
		WHERE body_json LIKE '%/portraits/%'
		   OR body_json LIKE '%/maps/local/%'
		   OR body_json LIKE '%/icons/%'
		   OR body_json LIKE '%/branding/%'
	`).Scan(&legacyURLs); err != nil || legacyURLs != 0 {
		t.Fatalf("remaining legacy media URLs = %d, %v", legacyURLs, err)
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
		{
			name: "missing referenced media",
			entries: []zipEntry{
				{name: "data/characters.json", body: `[{"id":"hero","portrait":"/portraits/hero/portrait.png"}]`},
			},
		},
		{
			name: "ambiguous world map",
			entries: []zipEntry{
				{name: "data/characters.json", body: `[]`},
				{name: "data/maps/swordcoast/sword_coast.png", body: string([]byte("\x89PNG\r\n\x1a\none"))},
				{name: "data/maps/swordcoast/sword_coast.webp", body: "RIFF____WEBPtwo"},
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
