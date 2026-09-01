package backuparchive

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestCreateAndRestoreRoundTripDatabaseAndImmutableAddonFiles(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	sourceDirectory := filepath.Join(root, "source")
	database, err := codexsqlite.Open(ctx, filepath.Join(sourceDirectory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE restore_marker (value TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO restore_marker(value) VALUES ('from-backup')`); err != nil {
		t.Fatal(err)
	}
	blobs, err := blobstore.New(database, filepath.Join(sourceDirectory, "blobs"), blobstore.Options{})
	if err != nil {
		t.Fatal(err)
	}
	blobBody := []byte("immutable blob")
	blob, err := blobs.Create(ctx, blobstore.CreateRequest{
		Content: bytes.NewReader(blobBody), Bytes: uint64(len(blobBody)),
		OwnerKind: blobstore.OwnerCore, OwnerID: "campaign", Purpose: "portrait:hero",
		MediaType: "image/png", OriginalName: "hero.png", Visibility: blobstore.VisibilityPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	addonFile := filepath.Join(sourceDirectory, "addons", "example", "generations", strings.Repeat("a", 64), "root", "worker")
	if err := os.MkdirAll(filepath.Dir(addonFile), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(addonFile, []byte("immutable addon"), 0o750); err != nil {
		t.Fatal(err)
	}
	stagingJunk := filepath.Join(sourceDirectory, "addons", ".staging", "partial", "package.zip")
	if err := os.MkdirAll(filepath.Dir(stagingJunk), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stagingJunk, []byte("partial"), 0o640); err != nil {
		t.Fatal(err)
	}

	archivePath := filepath.Join(root, "backup.zip")
	manifest, err := Create(ctx, CreateConfig{
		Database: database, DataDirectory: sourceDirectory,
		OutputPath: archivePath, HostVersion: "2.0.0-test",
		Now: func() time.Time { return time.Date(2026, time.September, 1, 6, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if manifest.ContractVersion != ContractVersion || len(manifest.Entries) != 3 ||
		manifest.Entries[0].Path != "addons/example/generations/"+strings.Repeat("a", 64)+"/root/worker" ||
		manifest.Entries[1].Path != "blobs/sha256/"+blob.SHA256[:2]+"/"+blob.SHA256 ||
		manifest.Entries[2].Path != "codex.db" {
		t.Fatalf("manifest = %+v", manifest)
	}

	targetDirectory := filepath.Join(root, "restored")
	if err := os.MkdirAll(targetDirectory, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetDirectory, "old.txt"), []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	result, err := Restore(ctx, RestoreConfig{
		ArchivePath: archivePath, DataDirectory: targetDirectory, Migrations: migrations.FS,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Manifest.CreatedAt != "2026-09-01T06:00:00Z" || result.AppliedMigrations != 0 {
		t.Fatalf("restore result = %+v", result)
	}
	if _, err := os.Stat(filepath.Join(targetDirectory, "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("old data survived restore: %v", err)
	}
	addonBody, err := os.ReadFile(filepath.Join(targetDirectory, filepath.FromSlash(manifest.Entries[0].Path)))
	if err != nil || string(addonBody) != "immutable addon" {
		t.Fatalf("restored add-on = %q, %v", addonBody, err)
	}
	restored, err := codexsqlite.Open(ctx, filepath.Join(targetDirectory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var marker string
	if err := restored.QueryRow(`SELECT value FROM restore_marker`).Scan(&marker); err != nil || marker != "from-backup" {
		t.Fatalf("restored marker = %q, %v", marker, err)
	}
	restoredBlobs, err := blobstore.New(restored, filepath.Join(targetDirectory, "blobs"), blobstore.Options{})
	if err != nil {
		t.Fatal(err)
	}
	blobReader, restoredBlob, err := restoredBlobs.Open(ctx, blob.ID)
	if err != nil {
		t.Fatal(err)
	}
	restoredBody, readErr := io.ReadAll(blobReader)
	closeErr := blobReader.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(restoredBody, blobBody) || restoredBlob.SHA256 != blob.SHA256 {
		t.Fatalf("restored blob = %q, %+v, %v", restoredBody, restoredBlob, errors.Join(readErr, closeErr))
	}
	if matches, _ := filepath.Glob(filepath.Join(root, ".restored.restore-*")); len(matches) != 0 {
		t.Fatalf("restore artifacts survived: %v", matches)
	}
}

func TestRestoreRejectsContentThatDiffersFromManifest(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	sourceDirectory := filepath.Join(root, "source")
	database, err := codexsqlite.Open(ctx, filepath.Join(sourceDirectory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	addonFile := filepath.Join(sourceDirectory, "addons", "example", "file.txt")
	if err := os.MkdirAll(filepath.Dir(addonFile), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(addonFile, []byte("good"), 0o640); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(root, "original.zip")
	if _, err := Create(ctx, CreateConfig{
		Database: database, DataDirectory: sourceDirectory,
		OutputPath: original, HostVersion: "test",
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	tampered := filepath.Join(root, "tampered.zip")
	if err := rewriteArchive(original, tampered, "addons/example/file.txt", []byte("evil")); err != nil {
		t.Fatal(err)
	}
	_, err = Restore(ctx, RestoreConfig{
		ArchivePath: tampered, DataDirectory: filepath.Join(root, "target"), Migrations: migrations.FS,
	})
	if !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("tampered restore error = %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, "target")); !os.IsNotExist(statErr) {
		t.Fatalf("tampered restore published target: %v", statErr)
	}
}

func TestVerifyAcceptsLegacyV1ArchiveWithoutBlobReferences(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	root := t.TempDir()
	sourceDirectory := filepath.Join(root, "source")
	database, err := codexsqlite.Open(ctx, filepath.Join(sourceDirectory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	currentArchive := filepath.Join(root, "v2.zip")
	manifest, err := Create(ctx, CreateConfig{
		Database: database, DataDirectory: sourceDirectory,
		OutputPath: currentArchive, HostVersion: "2.0.0-test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	manifest.ContractVersion = LegacyContractVersion
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	legacyArchive := filepath.Join(root, "v1.zip")
	if err := rewriteArchive(currentArchive, legacyArchive, "manifest.json", manifestJSON); err != nil {
		t.Fatal(err)
	}
	result, err := Verify(ctx, VerifyConfig{ArchivePath: legacyArchive, Migrations: migrations.FS})
	if err != nil {
		t.Fatal(err)
	}
	if result.Manifest.ContractVersion != LegacyContractVersion {
		t.Fatalf("verified contract = %s", result.Manifest.ContractVersion)
	}
}

func TestVerifyRejectsLegacyV1DatabaseWhoseBlobObjectsAreMissing(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	root := t.TempDir()
	sourceDirectory := filepath.Join(root, "source")
	database, err := codexsqlite.Open(ctx, filepath.Join(sourceDirectory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	blobs, err := blobstore.New(database, filepath.Join(sourceDirectory, "blobs"), blobstore.Options{})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("must not be omitted")
	if _, err := blobs.Create(ctx, blobstore.CreateRequest{
		Content: bytes.NewReader(body), Bytes: uint64(len(body)),
		OwnerKind: blobstore.OwnerCore, OwnerID: "campaign", Purpose: "test",
		MediaType: "application/octet-stream", Visibility: blobstore.VisibilityDM,
	}); err != nil {
		t.Fatal(err)
	}
	currentArchive := filepath.Join(root, "complete.zip")
	manifest, err := Create(ctx, CreateConfig{
		Database: database, DataDirectory: sourceDirectory,
		OutputPath: currentArchive, HostVersion: "2.0.0-test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	manifest.ContractVersion = LegacyContractVersion
	entries := make([]Entry, 0, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		if !strings.HasPrefix(entry.Path, "blobs/") {
			entries = append(entries, entry)
		}
	}
	manifest.Entries = entries
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	brokenArchive := filepath.Join(root, "broken-v1.zip")
	if err := rewriteArchiveWithoutBlobs(currentArchive, brokenArchive, manifestJSON); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(ctx, VerifyConfig{
		ArchivePath: brokenArchive, Migrations: migrations.FS,
	}); !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("missing blob verification error = %v", err)
	}
}

func TestRecoverRollsBackPublicationThatDidNotInstallStage(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "data")
	stageName := ".data.restore-stage-test"
	previousName := ".data.restore-previous-test"
	stage := filepath.Join(root, stageName)
	previous := filepath.Join(root, previousName)
	if err := os.MkdirAll(target, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "original"), []byte("safe"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stage, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(target, previous); err != nil {
		t.Fatal(err)
	}
	if err := writeRestoreJournal(restoreJournalPath(target), restoreJournal{
		ContractVersion: restoreJournalVersion, TargetName: "data",
		StageName: stageName, PreviousName: previousName,
	}); err != nil {
		t.Fatal(err)
	}
	if err := Recover(context.Background(), target, migrations.FS); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(filepath.Join(target, "original")); err != nil || string(body) != "safe" {
		t.Fatalf("recovered original = %q, %v", body, err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("restore stage survived recovery: %v", err)
	}
	if _, err := os.Stat(restoreJournalPath(target)); !os.IsNotExist(err) {
		t.Fatalf("restore journal survived recovery: %v", err)
	}
}

func rewriteArchive(source, destination, replacePath string, replacement []byte) error {
	input, err := zip.OpenReader(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	archive := zip.NewWriter(output)
	for _, file := range input.File {
		header := file.FileHeader
		writer, err := archive.CreateHeader(&header)
		if err != nil {
			return err
		}
		if file.Name == replacePath {
			if _, err := writer.Write(replacement); err != nil {
				return err
			}
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, reader)
		closeErr := reader.Close()
		if copyErr != nil || closeErr != nil {
			return errors.Join(copyErr, closeErr)
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return output.Close()
}

func rewriteArchiveWithoutBlobs(source, destination string, manifest []byte) error {
	input, err := zip.OpenReader(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	archive := zip.NewWriter(output)
	for _, file := range input.File {
		if strings.HasPrefix(file.Name, "blobs/") {
			continue
		}
		header := file.FileHeader
		writer, err := archive.CreateHeader(&header)
		if err != nil {
			return err
		}
		if file.Name == "manifest.json" {
			if _, err := writer.Write(manifest); err != nil {
				return err
			}
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, reader)
		closeErr := reader.Close()
		if copyErr != nil || closeErr != nil {
			return errors.Join(copyErr, closeErr)
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return output.Close()
}
