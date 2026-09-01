package blobstore

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestCreateReadDeduplicateAndDeleteHandles(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, database, root := newTestStore(t)
	defer database.Close()
	content := []byte("the same immutable bytes")
	first, err := store.Create(ctx, CreateRequest{
		Content: bytes.NewReader(content), Bytes: uint64(len(content)),
		OwnerKind: OwnerCore, OwnerID: "campaign", Purpose: "portrait:hero",
		MediaType: "IMAGE/PNG", OriginalName: "hero.png", Visibility: VisibilityPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Create(ctx, CreateRequest{
		Content: bytes.NewReader(content), Bytes: uint64(len(content)),
		OwnerKind: OwnerAddon, OwnerID: "example.addon", Purpose: "attachment",
		MediaType: "image/png", OriginalName: "copy.png", Visibility: VisibilityDM,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID || first.SHA256 != second.SHA256 ||
		first.MediaType != "image/png" || first.Revision != 1 {
		t.Fatalf("first=%+v second=%+v", first, second)
	}
	objects, err := filepath.Glob(filepath.Join(root, "sha256", "*", "*"))
	if err != nil || len(objects) != 1 {
		t.Fatalf("stored objects = %v, %v", objects, err)
	}

	reader, metadata, err := store.Open(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(body, content) || metadata.Visibility != VisibilityDM {
		t.Fatalf("read body=%q metadata=%+v errors=%v", body, metadata, errors.Join(readErr, closeErr))
	}

	deleted, err := store.Delete(ctx, first.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !deleted.Deleted || deleted.Revision != 2 {
		t.Fatalf("deleted metadata = %+v", deleted)
	}
	if _, _, err := store.Open(ctx, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted open error = %v", err)
	}
	shared, _, err := store.Open(ctx, second.ID)
	if err != nil {
		t.Fatalf("shared object disappeared: %v", err)
	}
	if err := shared.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Delete(ctx, first.ID, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale delete error = %v", err)
	}
}

func TestCreateRequiresExactBoundedContentAndValidOwnership(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, database, root := newTestStoreWithOptions(t, Options{MaximumBytes: 4})
	defer database.Close()
	base := CreateRequest{
		Content: bytes.NewReader([]byte("four")), Bytes: 4,
		OwnerKind: OwnerCore, OwnerID: "campaign", Purpose: "test",
		MediaType: "application/octet-stream", Visibility: VisibilityPublic,
	}
	if _, err := store.Create(ctx, base); err != nil {
		t.Fatal(err)
	}
	tooLong := base
	tooLong.Content = bytes.NewReader([]byte("five!"))
	if _, err := store.Create(ctx, tooLong); err == nil {
		t.Fatal("longer content was accepted")
	}
	tooShort := base
	tooShort.Content = bytes.NewReader([]byte("no"))
	if _, err := store.Create(ctx, tooShort); err == nil {
		t.Fatal("shorter content was accepted")
	}
	tooLarge := base
	tooLarge.Bytes = 5
	if _, err := store.Create(ctx, tooLarge); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversize error = %v", err)
	}
	badOwner := base
	badOwner.OwnerID = "bad\nowner"
	if _, err := store.Create(ctx, badOwner); !errors.Is(err, ErrInvalid) {
		t.Fatalf("owner error = %v", err)
	}
	badName := base
	badName.OriginalName = "../bad"
	if _, err := store.Create(ctx, badName); !errors.Is(err, ErrInvalid) {
		t.Fatalf("name error = %v", err)
	}

	entries, err := os.ReadDir(filepath.Join(root, ".staging"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("staging entries = %v, %v", entries, err)
	}
	var handles int
	if err := database.QueryRow(`SELECT count(*) FROM blobs`).Scan(&handles); err != nil || handles != 1 {
		t.Fatalf("blob handles = %d, %v", handles, err)
	}
}

func TestOpenDetectsMissingOrWrongSizedObject(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, database, _ := newTestStore(t)
	defer database.Close()
	content := []byte("content")
	blob, err := store.Create(ctx, CreateRequest{
		Content: bytes.NewReader(content), Bytes: uint64(len(content)),
		OwnerKind: OwnerSystem, OwnerID: "imports", Purpose: "source",
		MediaType: "application/zip", OriginalName: "source.zip", Visibility: VisibilityDM,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.objectPath(blob.SHA256), []byte("x"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Open(ctx, blob.ID); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("corrupt open error = %v", err)
	}
	if err := store.Validate(ctx); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("corrupt validation error = %v", err)
	}
	if _, err := store.Metadata(ctx, "not-an-id"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("invalid id lookup = %v", err)
	}
}

func TestNewRequiresMigratedSchemaAndRejectsSymlinkRoot(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	directory := t.TempDir()
	database, err := codexsqlite.Open(ctx, filepath.Join(directory, "unmigrated.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := New(database, filepath.Join(directory, "blobs"), Options{}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unmigrated schema error = %v", err)
	}

	realRoot := filepath.Join(directory, "real")
	if err := os.Mkdir(realRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(directory, "linked")
	if err := os.Symlink(realRoot, symlink); err != nil {
		if errors.Is(err, os.ErrPermission) || strings.Contains(strings.ToLower(err.Error()), "privilege") {
			t.Skipf("symlink creation is unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	if _, err := New(database, symlink, Options{}); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("symlink root error = %v", err)
	}
}

func newTestStore(t *testing.T) (*Store, *sql.DB, string) {
	t.Helper()
	return newTestStoreWithOptions(t, Options{
		Now: func() time.Time {
			return time.Date(2026, time.September, 1, 15, 0, 0, 0, time.UTC)
		},
	})
}

func newTestStoreWithOptions(t *testing.T, options Options) (*Store, *sql.DB, string) {
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
	root := filepath.Join(directory, "blobs")
	store, err := New(database, root, options)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	return store, database, root
}
