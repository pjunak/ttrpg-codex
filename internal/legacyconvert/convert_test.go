package legacyconvert

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
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
			{"id":"hero","name":"Hero","visibility":"public","species":"human","portrait":"/portraits/hero/portrait.png?v=old"},
			{"id":"villain","name":"Villain","visibility":"dm","species":"dragon","portrait":"/portraits/villain/portrait.png"}
		]`},
		{name: "data/species.json", body: `[{"id":"human","name":"Human"},{"id":"dragon","name":"Dragon"}]`},
		{name: "data/mapPins.json", body: `[]`},
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
	if report.ContractVersion != "codex-v1-conversion-report.v3" ||
		report.ConvertedAt != convertedAt.Format(time.RFC3339Nano) ||
		report.CommitID != 1 || report.CoreRecords != 7 {
		t.Fatalf("report = %+v", report)
	}
	if report.CoreCollections["characters"] != 2 ||
		report.CoreCollections["relationships"] != 0 ||
		report.CoreCollections["campaign"] != 1 ||
		report.CoreCollections["locations"] != 1 ||
		report.CoreCollections["settings"] != 3 {
		t.Fatalf("core collection counts = %#v", report.CoreCollections)
	}
	if report.Media.Imported != (InventoryGroup{Files: 6, Bytes: uint64(6 * len(image))}) ||
		report.Media.Bindings != 6 || report.Media.RewrittenRecords != 5 ||
		report.Media.DiscardedDerived != (InventoryGroup{Files: 1, Bytes: uint64(len("derived tile"))}) {
		t.Fatalf("media report = %+v", report.Media)
	}
	if report.Legacy != (LegacyAdjustmentReport{
		SpeciesDefinitions: 2, CharacterSpecies: 2, DiscardedMapPinFile: 1, SidebarLayouts: 1,
	}) {
		t.Fatalf("legacy adjustments = %+v", report.Legacy)
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
	if !strings.Contains(body, `"portrait":"/api/media/b_`) ||
		!strings.Contains(body, `"species":"Dragon"`) || visibility != "dm" {
		t.Fatalf("villain = %s, %s", body, visibility)
	}
	if err := database.QueryRow(`
		SELECT body_json FROM campaign_records
		WHERE collection_name = 'characters' AND record_key = 'hero'
	`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, `"portrait":"/api/media/b_`) || strings.Contains(body, "/portraits/") ||
		!strings.Contains(body, `"species":"Human"`) {
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

func TestConvertRejectsNonEmptyRetiredMapPins(t *testing.T) {
	directory := t.TempDir()
	archive := filepath.Join(directory, "old-ui-backup.zip")
	writeLegacyZip(t, archive, []zipEntry{
		{name: "data/characters.json", body: `[]`},
		{name: "data/mapPins.json", body: `[{"id":"unmapped"}]`},
	})
	output := filepath.Join(directory, "converted")
	_, err := Convert(context.Background(), Config{ArchivePath: archive, OutputDirectory: output})
	if err == nil || !strings.Contains(err.Error(), "map pins cannot be discarded safely") {
		t.Fatalf("conversion error = %v", err)
	}
	if _, statErr := os.Stat(output); !os.IsNotExist(statErr) {
		t.Fatalf("failed conversion published output: %v", statErr)
	}
}

func TestConvertMigratesFirstPartyAddonDataAgainstTargetPackages(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	archive := filepath.Join(directory, "old-ui-backup.zip")
	writeLegacyZip(t, archive, []zipEntry{
		{name: "data/characters.json", body: `[{
			"id":"hero","name":"Hero","visibility":"public",
			"addonData":{"dnd-sheets":{"className":"Wizard","custom":{"kept":true}},"unknown-addon":{"value":1}}
		}]`},
		{name: "data/addon-data/dm-tools/planning_items.json", body: `{
			"quest-a":{"schemaVersion":2,"title":"Quest A"}
		}`},
		{name: "data/addon-data/dm-tools/planning_views.json", body: `{
			"planner-schema-v2":{"id":"planner-schema-v2","schemaVersion":2,"completedAt":1,"updatedAt":1}
		}`},
		{name: "data/addon-data/dm-tools/dm_notes.json", body: `{}`},
		{name: "data/addon-data/demo/rules.json", body: `{"rule-a":{"id":"rule-a"}}`},
	})
	dmTools := writeTargetPackage(t, "dm-tools")
	dndSheets := writeTargetPackage(t, "dnd-sheets")
	output := filepath.Join(directory, "converted")
	report, err := Convert(context.Background(), Config{
		ArchivePath: archive, OutputDirectory: output,
		AddonPackages: []string{dmTools, dndSheets},
		Now:           func() time.Time { return time.Date(2026, 9, 1, 13, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Addons.Documents["dm-tools/collection/planning_items"] != 1 ||
		report.Addons.Documents["dnd-sheets/record-extension/dnd-sheets"] != 1 ||
		report.Addons.NormalizedRecordIDs != 1 ||
		report.Addons.UpgradedSchemaV2 != 1 ||
		report.Addons.DiscardedMarkers != 1 ||
		report.Addons.StrippedCoreRecords != 1 ||
		report.Addons.ImportedSourceFiles.Files != 3 ||
		report.Addons.DeferredEmbedded["unknown-addon"] != 1 ||
		report.Deferred["addonData"].Files != 1 {
		t.Fatalf("add-on report = %+v, deferred = %+v", report.Addons, report.Deferred)
	}
	if len(report.Addons.TargetPackages["dm-tools"].ArchiveSHA256) != 64 ||
		len(report.Addons.TargetPackages["dnd-sheets"].ArchiveSHA256) != 64 {
		t.Fatalf("target packages = %+v", report.Addons.TargetPackages)
	}

	database, err := sql.Open("sqlite", filepath.Join(output, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var character, planningItem, sheet string
	if err := database.QueryRow(`SELECT body_json FROM campaign_records WHERE collection_name = 'characters' AND record_key = 'hero'`).Scan(&character); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(character, "dnd-sheets") || !strings.Contains(character, "unknown-addon") {
		t.Fatalf("converted character = %s", character)
	}
	if err := database.QueryRow(`
		SELECT body_json FROM addon_documents
		WHERE addon_id = 'dm-tools' AND data_kind = 'collection'
		  AND data_id = 'planning_items' AND document_key = 'quest-a'
	`).Scan(&planningItem); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(planningItem, `"id":"quest-a"`) ||
		!strings.Contains(planningItem, `"schemaVersion":3`) {
		t.Fatalf("converted planning item = %s", planningItem)
	}
	if err := database.QueryRow(`
		SELECT body_json FROM addon_documents
		WHERE addon_id = 'dnd-sheets' AND data_kind = 'record-extension'
		  AND data_id = 'dnd-sheets' AND document_key = 'hero'
	`).Scan(&sheet); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sheet, `"v":3`) || !strings.Contains(sheet, `"kept":true`) {
		t.Fatalf("converted sheet = %s", sheet)
	}
	var materialized, records int
	if err := database.QueryRow(`
		SELECT materialized FROM addon_data_sets
		WHERE addon_id = 'dm-tools' AND data_kind = 'collection' AND data_id = 'dm_notes'
	`).Scan(&materialized); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM addon_documents`).Scan(&records); err != nil {
		t.Fatal(err)
	}
	if materialized != 1 || records != 2 {
		t.Fatalf("add-on persistence = materialized %d, records %d", materialized, records)
	}
}

func TestConvertRequiresTargetPackageForOwnedLegacyData(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	archive := filepath.Join(directory, "old-ui-backup.zip")
	writeLegacyZip(t, archive, []zipEntry{
		{name: "data/characters.json", body: `[{"id":"hero","addonData":{"dnd-sheets":{"className":"Wizard"}}}]`},
	})
	output := filepath.Join(directory, "converted")
	_, err := Convert(context.Background(), Config{ArchivePath: archive, OutputDirectory: output})
	if err == nil || !strings.Contains(err.Error(), "provide its v3 ZIP") {
		t.Fatalf("conversion error = %v", err)
	}
	if _, statErr := os.Stat(output); !os.IsNotExist(statErr) {
		t.Fatalf("failed conversion published output: %v", statErr)
	}
}

func TestValidateDMPlanningRejectsCrossRecordDamage(t *testing.T) {
	records := map[string]map[string]json.RawMessage{
		"planning_items": {
			"quest-a": json.RawMessage(`{"id":"quest-a","kind":"quest","parentId":null}`),
		},
		"planning_flow_links": {
			"flow-a": json.RawMessage(`{"id":"flow-a","sourceId":"quest-a","targetId":"missing","kind":"continues"}`),
		},
	}
	if err := validateDMPlanning(records); err == nil || !strings.Contains(err.Error(), "missing endpoint") {
		t.Fatalf("validation error = %v", err)
	}
}

func TestNormalizeDMToolsRecordAcceptsOnlyKnownLegacyShape(t *testing.T) {
	normalized, injected, upgraded, err := normalizeDMToolsRecord(
		json.RawMessage(`{"schemaVersion":2,"title":"Quest"}`),
		"quest-a",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !injected || !upgraded || !strings.Contains(string(normalized), `"id":"quest-a"`) ||
		!strings.Contains(string(normalized), `"schemaVersion":3`) {
		t.Fatalf("normalized record = %s, injected = %v, upgraded = %v", normalized, injected, upgraded)
	}

	for name, body := range map[string]json.RawMessage{
		"conflicting id":      json.RawMessage(`{"id":"quest-b","schemaVersion":2}`),
		"unsupported version": json.RawMessage(`{"id":"quest-a","schemaVersion":1}`),
		"missing version":     json.RawMessage(`{"id":"quest-a"}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, _, err := normalizeDMToolsRecord(body, "quest-a"); err == nil {
				t.Fatal("normalization unexpectedly accepted the record")
			}
		})
	}
}

func TestLegacyPlannerSchemaMarkerMustMatchExactShape(t *testing.T) {
	valid := json.RawMessage(`{"id":"planner-schema-v2","schemaVersion":2,"completedAt":1,"updatedAt":2}`)
	if !isLegacyPlannerSchemaMarker(valid, "planner-schema-v2") {
		t.Fatal("exact legacy marker was rejected")
	}
	withPayload := json.RawMessage(`{"id":"planner-schema-v2","schemaVersion":2,"completedAt":1,"updatedAt":2,"payload":true}`)
	if isLegacyPlannerSchemaMarker(withPayload, "planner-schema-v2") {
		t.Fatal("marker containing user data was accepted")
	}
}

func TestConvertLegacyCrossScopeFlowsPreservesReferenceAndConsequence(t *testing.T) {
	records := map[string]map[string]json.RawMessage{
		"planning_items": {
			"source": json.RawMessage(`{"id":"source","parentId":"quest-a"}`),
			"target": json.RawMessage(`{"id":"target","parentId":"quest-b"}`),
		},
		"planning_flow_links": {
			"flow-a": json.RawMessage(`{"id":"flow-a","sourceId":"source","targetId":"target","kind":"continues","label":"Next quest","updatedAt":12}`),
		},
		"planning_references": {},
		"planning_consequences": {
			"effect-a": json.RawMessage(`{"anchor":{"scope":"flow","flowId":"flow-a"}}`),
		},
	}
	converted, reanchored, err := convertLegacyCrossScopeFlows(records)
	if err != nil {
		t.Fatal(err)
	}
	if converted != 1 || reanchored != 1 || len(records["planning_flow_links"]) != 0 {
		t.Fatalf("conversion = flows %d, effects %d, remaining %+v", converted, reanchored, records["planning_flow_links"])
	}
	var reference struct {
		ItemID string `json:"itemId"`
		Target struct {
			Scope  string `json:"scope"`
			ItemID string `json:"itemId"`
		} `json:"target"`
	}
	if err := json.Unmarshal(records["planning_references"]["flow-a"], &reference); err != nil {
		t.Fatal(err)
	}
	if reference.ItemID != "source" || reference.Target.Scope != "planning" || reference.Target.ItemID != "target" {
		t.Fatalf("reference = %+v", reference)
	}
	var consequence struct {
		Anchor struct {
			Scope  string `json:"scope"`
			ItemID string `json:"itemId"`
		} `json:"anchor"`
	}
	if err := json.Unmarshal(records["planning_consequences"]["effect-a"], &consequence); err != nil {
		t.Fatal(err)
	}
	if consequence.Anchor.Scope != "item" || consequence.Anchor.ItemID != "target" {
		t.Fatalf("consequence = %+v", consequence)
	}
}

func writeTargetPackage(t *testing.T, id string) string {
	t.Helper()
	manifest := map[string]any{
		"packageFormat": 1, "id": id, "name": id, "version": "3.0.0",
		"compatibility": map[string]any{"host": ">=2.0.0 <3.0.0", "addonApi": "^3.0.0"},
		"capabilities":  map[string]any{"required": []string{}, "optional": []string{}},
		"permissions":   []any{},
	}
	files := map[string][]byte{}
	if id == "dm-tools" {
		collections := make([]any, 0, len(dmToolsCollections))
		for _, collection := range dmToolsCollections {
			collections = append(collections, map[string]any{
				"id": collection, "keyed": true, "visibility": "dm",
				"schema": "contracts/planning.schema.json", "schemaVersion": "3.0.0",
			})
		}
		manifest["collections"] = collections
		files["contracts/planning.schema.json"] = []byte(`{"type":"object","required":["id"],"properties":{"id":{"type":"string"}},"additionalProperties":true}`)
	} else {
		manifest["recordExtensions"] = []any{map[string]any{
			"id": "dnd-sheets", "target": "characters", "visibility": "public",
			"schema": "contracts/sheet.schema.json", "schemaVersion": "3.0.0",
		}}
		files["contracts/sheet.schema.json"] = []byte(`{"type":"object","required":["v"],"properties":{"v":{"const":3}},"additionalProperties":true}`)
	}
	files["addon.json"], _ = json.Marshal(manifest)
	digests := make(map[string]string, len(files))
	for name, body := range files {
		digest := sha256.Sum256(body)
		digests[name] = hex.EncodeToString(digest[:])
	}
	files["checksums.json"], _ = json.Marshal(map[string]any{"algorithm": "sha256", "files": digests})
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	filename := filepath.Join(t.TempDir(), id+".zip")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	for _, name := range names {
		writer, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(files[name]); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
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
