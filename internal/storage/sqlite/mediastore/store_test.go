package mediastore

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestBindGetAndLatestSkipDeletedBlobs(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	directory := t.TempDir()
	database, err := codexsqlite.Open(ctx, filepath.Join(directory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	blobs, err := blobstore.New(database, filepath.Join(directory, "blobs"), blobstore.Options{})
	if err != nil {
		t.Fatal(err)
	}
	store, err := New(database)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.September, 1, 16, 0, 0, 0, time.UTC)
	create := func(body string) blobstore.Blob {
		blob, err := blobs.Create(ctx, blobstore.CreateRequest{
			Content: bytes.NewBufferString(body), Bytes: uint64(len(body)),
			OwnerKind: blobstore.OwnerCore, OwnerID: "campaign", Purpose: "media",
			MediaType: "image/png", Visibility: blobstore.VisibilityPublic,
		})
		if err != nil {
			t.Fatal(err)
		}
		return blob
	}
	firstBlob := create("first")
	secondBlob := create("second")
	first, err := store.Bind(ctx, Asset{
		BlobID: firstBlob.ID, Kind: "character-portrait", TargetKey: "hero", CreatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Bind(ctx, Asset{
		BlobID: secondBlob.ID, Kind: "character-portrait", TargetKey: "hero", CreatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Sequence != 1 || second.Sequence != 2 {
		t.Fatalf("sequences = %d, %d", first.Sequence, second.Sequence)
	}
	latest, err := store.Latest(ctx, "character-portrait", "hero")
	if err != nil || latest.BlobID != secondBlob.ID {
		t.Fatalf("latest = %+v, %v", latest, err)
	}
	if _, err := blobs.Delete(ctx, secondBlob.ID, 1); err != nil {
		t.Fatal(err)
	}
	latest, err = store.Latest(ctx, "character-portrait", "hero")
	if err != nil || latest.BlobID != firstBlob.ID {
		t.Fatalf("latest after delete = %+v, %v", latest, err)
	}
	got, err := store.Get(ctx, secondBlob.ID)
	if err != nil || got.Sequence != second.Sequence {
		t.Fatalf("get deleted history = %+v, %v", got, err)
	}
	if _, err := store.Get(ctx, "b_00000000000000000000000000000000"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing get error = %v", err)
	}
}
