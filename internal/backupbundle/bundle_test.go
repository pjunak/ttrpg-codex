package backupbundle

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/recoverystore"
)

var generation = strings.Repeat("c", 64)

type host struct {
	bundles Bundles
	records *campaignstore.Store
}

func newHost(t *testing.T) host {
	t.Helper()
	ctx := context.Background()
	directory := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(directory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := sqlite.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	broker, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	points := &recoverystore.Store{DB: db, Events: broker}
	records, err := campaignstore.New(campaignstore.Config{DB: db, Events: broker, BeforeWrite: points.BeforeWrite})
	if err != nil {
		t.Fatal(err)
	}
	blobs, err := blobstore.New(db, filepath.Join(directory, "blobs"), blobstore.Options{BeforeWrite: points.BeforeWrite})
	if err != nil {
		t.Fatal(err)
	}
	return host{
		bundles: Bundles{DB: db, Points: points, Blobs: blobs, HostVersion: "test",
			Now: func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) }},
		records: records,
	}
}

func (h host) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := h.bundles.DB.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func (h host) installSheets(t *testing.T) {
	t.Helper()
	h.exec(t, `INSERT INTO addon_package_generations(addon_id, generation_id, addon_version, archive_sha256, manifest_json, installed_at) VALUES ('sheets', ?, '5.2.0', ?, '{}', 'then')`, generation, generation)
	h.exec(t, `INSERT INTO addon_package_states(addon_id, active_generation_id, updated_at) VALUES ('sheets', ?, 'then')`, generation)
}

func (h host) blob(t *testing.T, kind blobstore.OwnerKind, owner, content string) blobstore.Blob {
	t.Helper()
	blob, err := h.bundles.Blobs.Create(context.Background(), blobstore.CreateRequest{
		Content: strings.NewReader(content), Bytes: uint64(len(content)), OwnerKind: kind, OwnerID: owner,
		Purpose: "media", MediaType: "image/png", OriginalName: "map.png", Visibility: blobstore.VisibilityPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	return blob
}

// seed gives the host a campaign record with a world map and a sheets add-on
// with one document and one file.
func (h host) seed(t *testing.T) (core, addon blobstore.Blob) {
	t.Helper()
	_, err := h.records.Transact(context.Background(), campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.Characters, Key: "hero", Value: []byte(`{"id":"hero","name":"Hero"}`),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	core = h.blob(t, blobstore.OwnerCore, "campaign", "world map")
	h.exec(t, `INSERT INTO core_media_assets(blob_id, kind, target_key, created_at) VALUES (?, 'world-map', 'main', 'then')`, core.ID)
	h.installSheets(t)
	h.exec(t, `INSERT INTO addon_data_sets(addon_id, data_kind, data_id, materialized, schema_version, schema_sha256, keyed) VALUES ('sheets', 'collection', 'notes', 1, '1.0.0', ?, 1)`, generation)
	h.exec(t, `INSERT INTO addon_documents(addon_id, data_kind, data_id, document_key, position, body_json, schema_version, schema_sha256, revision, created_at, updated_at)
		VALUES ('sheets', 'collection', 'notes', 'one', 0, '{"text":"saved"}', '1.0.0', ?, 1, 'then', 'then')`, generation)
	h.exec(t, `INSERT INTO addon_document_versions VALUES ('sheets', 'collection', 'notes', 'one', 1, 0, 'then')`)
	addon = h.blob(t, blobstore.OwnerAddon, "sheets", "sheet portrait")
	return core, addon
}

func (h host) export(t *testing.T) ([]byte, Manifest) {
	t.Helper()
	var buffer bytes.Buffer
	manifest, err := h.bundles.Export(context.Background(), &buffer)
	if err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes(), manifest
}

func (h host) importBytes(t *testing.T, body []byte) (Manifest, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bundle.zip")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return h.bundles.Import(context.Background(), path)
}

func (h host) restore(t *testing.T, scope recoverystore.Scope, id int64) {
	t.Helper()
	listing, err := h.bundles.Points.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := h.bundles.Points.Restore(context.Background(), recoverystore.RestoreRequest{Scope: scope, ID: id, ExpectedRevision: listing.Revision}, "dm"); err != nil {
		t.Fatal(err)
	}
}

func (h host) newest(t *testing.T, scope recoverystore.Scope) recoverystore.Point {
	t.Helper()
	listing, err := h.bundles.Points.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range listing.Parts {
		if part.Scope == scope && len(part.Points) > 0 {
			return part.Points[0]
		}
	}
	t.Fatalf("no %v points", scope)
	return recoverystore.Point{}
}

func entryNames(t *testing.T, body []byte) []string {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, file := range archive.File {
		names = append(names, file.Name)
	}
	sort.Strings(names)
	return names
}

var (
	campaignPart = recoverystore.Scope{Scope: "campaign"}
	sheetsPart   = recoverystore.Scope{Scope: "addon", AddonID: "sheets"}
)

func TestBundleRoundTripsIntoAFreshHost(t *testing.T) {
	source := newHost(t)
	core, addon := source.seed(t)
	body, manifest := source.export(t)
	if len(manifest.Parts) != 2 || manifest.Parts[0].Reason != "download" || manifest.Parts[1].AddonVersion != "5.2.0" ||
		manifest.Parts[1].GenerationID != generation || len(manifest.Blobs) != 2 || manifest.Migration < 29 {
		t.Fatalf("manifest: %+v", manifest)
	}
	want := []string{"blobs/sha256/" + addon.SHA256, "blobs/sha256/" + core.SHA256, "manifest.json", "parts/addons/sheets.json", "parts/campaign.json"}
	sort.Strings(want)
	if got := entryNames(t, body); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("entries %v, want %v", got, want)
	}
	// An unchanged host reuses the newest points.
	_, again := source.export(t)
	if again.Parts[0].PointID != manifest.Parts[0].PointID || again.Parts[1].PointID != manifest.Parts[1].PointID {
		t.Fatal("second download saved new points")
	}

	target := newHost(t)
	target.installSheets(t)
	if _, err := target.importBytes(t, body); err != nil {
		t.Fatal(err)
	}
	var deleted int
	if err := target.bundles.DB.QueryRow(`SELECT deleted FROM blobs WHERE blob_id = ?`, core.ID).Scan(&deleted); err != nil || deleted != 1 {
		t.Fatalf("imported file is live before a restore: %d %v", deleted, err)
	}
	campaignPoint, sheetsPoint := target.newest(t, campaignPart), target.newest(t, sheetsPart)
	if campaignPoint.Reason != "imported" || campaignPoint.CreatedAt != manifest.Parts[0].CreatedAt || !sheetsPoint.Compatible {
		t.Fatalf("imported points: %+v %+v", campaignPoint, sheetsPoint)
	}
	target.restore(t, campaignPart, campaignPoint.ID)
	target.restore(t, sheetsPart, sheetsPoint.ID)
	hero, err := target.records.Get(context.Background(), campaign.Characters, "hero")
	if err != nil || !strings.Contains(string(hero.Value), "Hero") {
		t.Fatalf("campaign not restored: %+v %v", hero, err)
	}
	var text string
	if err := target.bundles.DB.QueryRow(`SELECT body_json FROM addon_documents WHERE addon_id = 'sheets'`).Scan(&text); err != nil || !strings.Contains(text, "saved") {
		t.Fatalf("add-on not restored: %q %v", text, err)
	}
	for _, blob := range []blobstore.Blob{core, addon} {
		file, opened, err := target.bundles.Blobs.Open(context.Background(), blob.ID)
		if err != nil {
			t.Fatalf("file %s not restored: %v", blob.ID, err)
		}
		content, _ := io.ReadAll(file)
		file.Close()
		if opened.SHA256 != blob.SHA256 || len(content) != int(blob.Bytes) {
			t.Fatalf("file %s content differs", blob.ID)
		}
	}
	// Importing again, or into the source itself, only adds points.
	for _, h := range []host{target, source} {
		if _, err := h.importBytes(t, body); err != nil {
			t.Fatal(err)
		}
		if h.newest(t, campaignPart).Reason != "imported" {
			t.Fatal("repeated import added no point")
		}
	}
}

// rewrite rebuilds a bundle after change edits its manifest and files.
func rewrite(t *testing.T, body []byte, change func(*Manifest, map[string][]byte)) []byte {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, file := range archive.File {
		content, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		files[file.Name], _ = io.ReadAll(content)
		content.Close()
	}
	var manifest Manifest
	if err := json.Unmarshal(files[manifestPath], &manifest); err != nil {
		t.Fatal(err)
	}
	change(&manifest, files)
	if files[manifestPath] != nil {
		files[manifestPath], _ = json.Marshal(manifest)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		entry.Write(files[name])
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// setPart replaces a part's image and its declared size and digest.
func setPart(manifest *Manifest, files map[string][]byte, index int, image []byte) {
	part := &manifest.Parts[index]
	files[part.Path] = image
	part.Bytes, part.SHA256 = int64(len(image)), digestOf(image)
}

func TestImportRefusesInvalidBundlesWithoutChanges(t *testing.T) {
	source := newHost(t)
	core, _ := source.seed(t)
	body, _ := source.export(t)
	campaignImage := func(files map[string][]byte) map[string]json.RawMessage {
		var image map[string]json.RawMessage
		json.Unmarshal(files["parts/campaign.json"], &image)
		return image
	}
	encode := func(value any) []byte {
		encoded, _ := json.Marshal(value)
		return encoded
	}
	cases := map[string][]byte{
		"not a zip": []byte("PK but not really"),
		"undeclared file": rewrite(t, body, func(_ *Manifest, files map[string][]byte) {
			files["../escape.txt"] = []byte("x")
		}),
		"missing manifest": rewrite(t, body, func(_ *Manifest, files map[string][]byte) { delete(files, manifestPath) }),
		"changed part": rewrite(t, body, func(_ *Manifest, files map[string][]byte) {
			files["parts/campaign.json"] = bytes.Replace(files["parts/campaign.json"], []byte("Hero"), []byte("Evil"), 1)
		}),
		"changed file": rewrite(t, body, func(_ *Manifest, files map[string][]byte) {
			files["blobs/sha256/"+core.SHA256] = bytes.Repeat([]byte("x"), int(core.Bytes))
		}),
		"newer host":   rewrite(t, body, func(manifest *Manifest, _ map[string][]byte) { manifest.Migration = 9999 }),
		"other format": rewrite(t, body, func(manifest *Manifest, _ map[string][]byte) { manifest.Format = "codex-backup.v2" }),
		"traversing add-on": rewrite(t, body, func(manifest *Manifest, files map[string][]byte) {
			manifest.Parts[1].AddonID = "../sheets"
		}),
		"add-on data in campaign": rewrite(t, body, func(manifest *Manifest, files map[string][]byte) {
			image := campaignImage(files)
			image["sets"] = json.RawMessage(`[{"addon_id":"sheets"}]`)
			setPart(manifest, files, 0, encode(image))
		}),
		"missing live file": rewrite(t, body, func(manifest *Manifest, files map[string][]byte) {
			delete(files, "blobs/sha256/"+core.SHA256)
			kept := manifest.Blobs[:0]
			for _, blob := range manifest.Blobs {
				if blob.ID != core.ID {
					kept = append(kept, blob)
				}
			}
			manifest.Blobs = kept
		}),
		"unknown image version": rewrite(t, body, func(manifest *Manifest, files map[string][]byte) {
			image := campaignImage(files)
			image["version"] = json.RawMessage(`2`)
			setPart(manifest, files, 0, encode(image))
		}),
	}
	target := newHost(t)
	for name, bundle := range cases {
		_, err := target.importBytes(t, bundle)
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: error = %v", name, err)
		}
		t.Logf("%s: %v", name, err)
	}
	if count := target.pointCount(t); count != 0 {
		t.Fatalf("refused imports saved %d points", count)
	}
	// A handle this host already has must name the same content.
	clash := target.blob(t, blobstore.OwnerCore, "campaign", "different bytes")
	target.exec(t, `UPDATE blobs SET blob_id = ? WHERE blob_id = ?`, core.ID, clash.ID)
	before := target.pointCount(t)
	if _, err := target.importBytes(t, body); !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "other content") {
		t.Errorf("blob clash: error = %v", err)
	}
	if after := target.pointCount(t); after != before {
		t.Fatal("refused import saved points")
	}
}

func (h host) pointCount(t *testing.T) int {
	t.Helper()
	var count int
	if err := h.bundles.DB.QueryRow(`SELECT count(*) FROM recovery_points`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
