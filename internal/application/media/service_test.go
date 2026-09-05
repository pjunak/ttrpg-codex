package media

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/mediastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

var pngImage = []byte("\x89PNG\r\n\x1a\npayload")

func TestPublicMediaUploadReadDeleteAndLatest(t *testing.T) {
	t.Parallel()
	records := recordMap{
		"characters:hero": {
			Collection: campaign.Characters, Key: "hero",
			Value: []byte(`{"id":"hero","name":"Hero"}`), Visibility: campaign.VisibilityPublic,
		},
	}
	service, database := newTestService(t, records)
	defer database.Close()
	ctx := context.Background()
	asset, err := service.Upload(ctx, Authority{Role: RolePlayer}, UploadRequest{
		Kind: CharacterPortrait, TargetKey: "hero",
		Content: bytes.NewReader(pngImage), Bytes: uint64(len(pngImage)),
		MediaType: "image/png", OriginalName: "hero.png",
	})
	if err != nil {
		t.Fatal(err)
	}
	if asset.Blob.Visibility != blobstore.VisibilityPublic || asset.Binding.Sequence != 1 {
		t.Fatalf("asset = %+v", asset)
	}
	reader, opened, err := service.Open(ctx, Authority{Role: RoleAnonymous}, asset.Blob.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(body, pngImage) || opened.Binding.Kind != string(CharacterPortrait) {
		t.Fatalf("opened body=%q asset=%+v errors=%v", body, opened, errors.Join(readErr, closeErr))
	}
	latest, err := service.Latest(ctx, Authority{Role: RoleAnonymous}, CharacterPortrait, "hero")
	if err != nil || latest.Blob.ID != asset.Blob.ID {
		t.Fatalf("latest = %+v, %v", latest, err)
	}
	hiddenRecord := records["characters:hero"]
	hiddenRecord.Visibility = campaign.VisibilityDM
	records["characters:hero"] = hiddenRecord
	if _, _, err := service.Open(ctx, Authority{Role: RoleAnonymous}, asset.Blob.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("public blob after hidden owner = %v", err)
	}
	hiddenRecord.Visibility = campaign.VisibilityPublic
	records["characters:hero"] = hiddenRecord
	deleted, err := service.Delete(ctx, Authority{Role: RolePlayer}, asset.Blob.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !deleted.Blob.Deleted || deleted.Blob.Revision != 2 {
		t.Fatalf("deleted = %+v", deleted)
	}
	if _, _, err := service.Open(ctx, Authority{Role: RoleDM}, asset.Blob.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted open error = %v", err)
	}
}

func TestHiddenAndPrivilegedMediaRespectEffectiveRole(t *testing.T) {
	t.Parallel()
	records := recordMap{
		"characters:secret": {
			Collection: campaign.Characters, Key: "secret",
			Value: []byte(`{"id":"secret","visibility":"dm"}`), Visibility: campaign.VisibilityDM,
		},
	}
	service, database := newTestService(t, records)
	defer database.Close()
	ctx := context.Background()
	hiddenRequest := UploadRequest{
		Kind: CharacterPortrait, TargetKey: "secret",
		Content: bytes.NewReader(pngImage), Bytes: uint64(len(pngImage)), MediaType: "image/png",
	}
	if _, err := service.Upload(ctx, Authority{Role: RolePlayer}, hiddenRequest); !errors.Is(err, ErrForbidden) {
		t.Fatalf("player hidden upload = %v", err)
	}
	hiddenRequest.Content = bytes.NewReader(pngImage)
	hidden, err := service.Upload(ctx, Authority{Role: RoleDM}, hiddenRequest)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.Open(ctx, Authority{Role: RolePlayer}, hidden.Blob.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("player hidden read = %v", err)
	}
	publicRecord := records["characters:secret"]
	publicRecord.Visibility = campaign.VisibilityPublic
	records["characters:secret"] = publicRecord
	if _, _, err := service.Open(ctx, Authority{Role: RolePlayer}, hidden.Blob.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("originally hidden blob became public without replacement = %v", err)
	}
	reader, _, err := service.Open(ctx, Authority{Role: RoleDM}, hidden.Blob.ID)
	if err != nil {
		t.Fatal(err)
	}
	reader.Close()

	worldRequest := UploadRequest{
		Kind: WorldMap, TargetKey: "main",
		Content: bytes.NewReader(pngImage), Bytes: uint64(len(pngImage)), MediaType: "image/png",
	}
	if _, err := service.Upload(ctx, Authority{Role: RolePlayer}, worldRequest); !errors.Is(err, ErrForbidden) {
		t.Fatalf("player world-map upload = %v", err)
	}
	worldRequest.Content = bytes.NewReader(pngImage)
	world, err := service.Upload(ctx, Authority{Role: RoleDM}, worldRequest)
	if err != nil {
		t.Fatal(err)
	}
	if world.Blob.Visibility != blobstore.VisibilityPublic {
		t.Fatalf("world map visibility = %s", world.Blob.Visibility)
	}
	if _, err := service.Delete(ctx, Authority{Role: RolePlayer}, world.Blob.ID, 1); !errors.Is(err, ErrForbidden) {
		t.Fatalf("player world-map delete = %v", err)
	}
}

func TestMediaRejectsMismatchedImagesAndUnknownTargets(t *testing.T) {
	t.Parallel()
	service, database := newTestService(t, map[string]campaign.Record{})
	defer database.Close()
	ctx := context.Background()
	if _, err := service.Upload(ctx, Authority{Role: RoleDM}, UploadRequest{
		Kind: CharacterPortrait, TargetKey: "missing",
		Content: bytes.NewReader(pngImage), Bytes: uint64(len(pngImage)), MediaType: "image/png",
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing target error = %v", err)
	}
	if _, err := service.Upload(ctx, Authority{Role: RoleDM}, UploadRequest{
		Kind: BrandingLogo, TargetKey: "main",
		Content: bytes.NewReader([]byte("not png")), Bytes: uint64(len("not png")), MediaType: "image/png",
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mismatched image error = %v", err)
	}
	validSVG := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	if _, err := service.Upload(ctx, Authority{Role: RoleDM}, UploadRequest{
		Kind: BrandingLogo, TargetKey: "main", Content: bytes.NewReader(validSVG),
		Bytes: uint64(len(validSVG)), MediaType: "image/svg+xml", OriginalName: "logo.svg",
	}); err != nil {
		t.Fatalf("valid SVG rejected: %v", err)
	}
	unsafeSVG := []byte(`<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	if _, err := service.Upload(ctx, Authority{Role: RoleDM}, UploadRequest{
		Kind: BrandingLogo, TargetKey: "main", Content: bytes.NewReader(unsafeSVG),
		Bytes: uint64(len(unsafeSVG)), MediaType: "image/svg+xml",
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("directive SVG error = %v", err)
	}
	var handles int
	if err := database.QueryRow(`SELECT count(*) FROM blobs`).Scan(&handles); err != nil || handles != 1 {
		t.Fatalf("stored handles = %d, %v", handles, err)
	}
}

type recordMap map[string]campaign.Record

func (records recordMap) Get(
	_ context.Context,
	collection campaign.Collection,
	key string,
) (campaign.Record, error) {
	record, ok := records[string(collection)+":"+key]
	if !ok {
		return campaign.Record{}, campaign.ErrNotFound
	}
	return record, nil
}

func newTestService(t *testing.T, records recordMap) (*Service, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	directory := t.TempDir()
	database, err := codexsqlite.Open(ctx, filepath.Join(directory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		database.Close()
		t.Fatal(err)
	}
	blobs, err := blobstore.New(database, filepath.Join(directory, "blobs"), blobstore.Options{})
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	assets, err := mediastore.New(database)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	service, err := New(Config{Blobs: blobs, Assets: assets, Records: records, MapTileDirectory: filepath.Join(directory, "map-tiles-v1")})
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	return service, database
}
