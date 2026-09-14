package backuparchive

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestLargeAddonInventoryBackupVerifiesAndRestores(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	database, err := codexsqlite.Open(ctx, filepath.Join(source, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	segment := strings.Repeat("content-", 25)
	directory := filepath.Join(source, "addons", "rules", "generations", strings.Repeat("a", 64), "root", "content", segment, segment, segment)
	if err := os.MkdirAll(directory, 0o750); err != nil {
		t.Fatal(err)
	}
	const fileCount = 1200
	for index := 0; index < fileCount; index++ {
		filename := filepath.Join(directory, fmt.Sprintf("%04d-%s.json", index, strings.Repeat("x", 120)))
		if err := os.WriteFile(filename, []byte("saved rules"), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	archivePath := filepath.Join(root, "backup.zip")
	manifest, err := Create(ctx, CreateConfig{Database: database, DataDirectory: source, OutputPath: archivePath, HostVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	_, archive, err := inspectArchive(archivePath, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	var manifestBytes uint64
	for _, entry := range archive.File {
		if entry.Name == "manifest.json" {
			manifestBytes = entry.UncompressedSize64
		}
	}
	if manifestBytes <= 1<<20 {
		t.Fatalf("fixture did not reproduce large manifest: %d", manifestBytes)
	}
	if len(manifest.Entries) != fileCount+1 {
		t.Fatalf("missing files: %d", len(manifest.Entries))
	}
	if _, err := Verify(ctx, VerifyConfig{ArchivePath: archivePath, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	restored := filepath.Join(root, "restored")
	result, err := Restore(ctx, RestoreConfig{ArchivePath: archivePath, DataDirectory: restored, Migrations: migrations.FS})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifest.Entries) != len(manifest.Entries) {
		t.Fatal("restore lost inventory")
	}
	sample := manifest.Entries[0]
	body, err := os.ReadFile(filepath.Join(restored, filepath.FromSlash(sample.Path)))
	if err != nil || string(body) != "saved rules" {
		t.Fatalf("restored file: %q, %v", body, err)
	}
	oldLimit := DefaultLimits
	oldLimit.MaximumManifestBytes = 1 << 20
	if _, err := Verify(ctx, VerifyConfig{ArchivePath: archivePath, Migrations: migrations.FS, Limits: oldLimit}); !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("explicit manifest size limit was ignored: %v", err)
	}
}

func TestCreateEnforcesVerifierManifestBoundsBeforePublication(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	database, err := codexsqlite.Open(ctx, filepath.Join(source, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"manifest-size", "host-version"} {
		t.Run(scenario, func(t *testing.T) {
			limits := DefaultLimits
			version := "test"
			if scenario == "manifest-size" {
				limits.MaximumManifestBytes = 128
			} else {
				version = strings.Repeat("x", 101)
			}
			output := filepath.Join(root, scenario+".zip")
			if _, err := Create(ctx, CreateConfig{Database: database, DataDirectory: source, OutputPath: output, HostVersion: version, Limits: limits}); err == nil {
				t.Fatal("unverifiable backup was created")
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("invalid backup was published: %v", err)
			}
			if files, err := filepath.Glob(filepath.Join(root, ".codex-backup-*.tmp")); err != nil || len(files) != 0 {
				t.Fatalf("failed backup left temporary archives: %v, %v", files, err)
			}
		})
	}
}
