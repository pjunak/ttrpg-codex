package backuparchive

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"

	"github.com/pjunak/ttrpg-codex/internal/jsonexact"
)

func TestStagedRestoreInstallsOnNextStartInsideTheDataDirectory(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	archive := markedArchive(t, root, "backup")
	data := markedDataDirectory(t, root, "live")
	tokens := filepath.Join(data, serverCredentials, "github.db")
	mustMkdir(t, filepath.Dir(tokens))
	if err := os.WriteFile(tokens, []byte("server token"), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := Stage(ctx, StageConfig{ArchivePath: archive, DataDirectory: data, Migrations: migrations.FS})
	if err != nil {
		t.Fatal(err)
	}
	if result.Manifest.HostVersion != "2.0.0-test" {
		t.Fatalf("stage result = %+v", result)
	}
	if marker(t, data) != "live" {
		t.Fatal("staging changed the running installation")
	}
	if _, err := Stage(ctx, StageConfig{ArchivePath: archive, DataDirectory: data, Migrations: migrations.FS}); !errors.Is(err, ErrRestorePending) {
		t.Fatalf("second stage = %v", err)
	}

	if err := Recover(ctx, data, migrations.FS); err != nil {
		t.Fatal(err)
	}
	assertInstalledBackup(t, data)
	if body, err := os.ReadFile(tokens); err != nil || string(body) != "server token" {
		t.Fatalf("restore dropped the server's GitHub tokens: %q, %v", body, err)
	}
}

func TestStagedRestoreResumesEveryInterruptedPhase(t *testing.T) {
	interruptions := map[string]func(t *testing.T, data, stage, previous string){
		"staged": func(t *testing.T, data, stage, previous string) {},
		"partly moved aside": func(t *testing.T, data, stage, previous string) {
			mustMkdir(t, previous)
			mustRename(t, filepath.Join(data, "old.txt"), filepath.Join(previous, "old.txt"))
			setPhase(t, data, phaseMovingOut)
		},
		"partly published": func(t *testing.T, data, stage, previous string) {
			mustMkdir(t, previous)
			for _, name := range []string{"old.txt", "codex.db"} {
				mustRename(t, filepath.Join(data, name), filepath.Join(previous, name))
			}
			mustRename(t, filepath.Join(stage, "codex.db"), filepath.Join(data, "codex.db"))
			setPhase(t, data, phaseMovingIn)
		},
		"published before validation": func(t *testing.T, data, stage, previous string) {
			mustMkdir(t, previous)
			for _, name := range []string{"old.txt", "codex.db"} {
				mustRename(t, filepath.Join(data, name), filepath.Join(previous, name))
			}
			entries, err := os.ReadDir(stage)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				mustRename(t, filepath.Join(stage, entry.Name()), filepath.Join(data, entry.Name()))
			}
			if err := os.Remove(stage); err != nil {
				t.Fatal(err)
			}
			setPhase(t, data, phaseMovingIn)
		},
	}
	for name, interrupt := range interruptions {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			archive := markedArchive(t, root, "backup")
			data := markedDataDirectory(t, root, "live")
			if _, err := Stage(ctx, StageConfig{ArchivePath: archive, DataDirectory: data, Migrations: migrations.FS}); err != nil {
				t.Fatal(err)
			}
			journal := readStagedJournal(t, data)
			interrupt(t, data, filepath.Join(data, journal.StageName), filepath.Join(data, journal.PreviousName))
			if err := Recover(ctx, data, migrations.FS); err != nil {
				t.Fatal(err)
			}
			assertInstalledBackup(t, data)
		})
	}
}

func TestInvalidStagedRestoreLeavesTheInstallationUntouched(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	archive := markedArchive(t, root, "backup")
	corrupt := filepath.Join(root, "corrupt.zip")
	if err := rewriteArchive(archive, corrupt, "codex.db", []byte("not sqlite")); err != nil {
		t.Fatal(err)
	}
	data := markedDataDirectory(t, root, "live")
	if _, err := Stage(ctx, StageConfig{ArchivePath: corrupt, DataDirectory: data, Migrations: migrations.FS}); !errors.Is(err, ErrInvalidArchive) {
		t.Fatalf("corrupt stage = %v", err)
	}
	assertNoRestoreArtifacts(t, data)
	if err := Recover(ctx, data, migrations.FS); err != nil || marker(t, data) != "live" {
		t.Fatalf("recover after rejected stage = %v", err)
	}
}

func TestStagedRestoreWithMissingFilesRefusesToStart(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	data := markedDataDirectory(t, root, "live")
	if _, err := Stage(ctx, StageConfig{ArchivePath: markedArchive(t, root, "backup"), DataDirectory: data, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(data, readStagedJournal(t, data).StageName)); err != nil {
		t.Fatal(err)
	}
	if err := Recover(ctx, data, migrations.FS); !errors.Is(err, ErrRestorePending) {
		t.Fatalf("recover without stage = %v", err)
	}
	if marker(t, data) != "live" {
		t.Fatal("refused restore changed the installation")
	}
}

func markedArchive(t *testing.T, root, value string) string {
	t.Helper()
	ctx := context.Background()
	source := markedDataDirectory(t, root, value)
	database, err := codexsqlite.Open(ctx, filepath.Join(source, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	archive := filepath.Join(root, value+".zip")
	if _, err := Create(ctx, CreateConfig{
		Database: database, DataDirectory: source, OutputPath: archive, HostVersion: "2.0.0-test",
		Now: func() time.Time { return time.Date(2026, time.October, 4, 12, 0, 0, 0, time.UTC) },
	}); err != nil {
		t.Fatal(err)
	}
	return archive
}

func markedDataDirectory(t *testing.T, root, value string) string {
	t.Helper()
	ctx := context.Background()
	directory := filepath.Join(root, value)
	database, err := codexsqlite.Open(ctx, filepath.Join(directory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := codexsqlite.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE restore_marker (value TEXT NOT NULL); INSERT INTO restore_marker(value) VALUES (?)`, value); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "old.txt"), []byte(value), 0o640); err != nil {
		t.Fatal(err)
	}
	return directory
}

func marker(t *testing.T, directory string) string {
	t.Helper()
	database, err := codexsqlite.Open(context.Background(), filepath.Join(directory, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var value string
	if err := database.QueryRow(`SELECT value FROM restore_marker`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func assertInstalledBackup(t *testing.T, data string) {
	t.Helper()
	if marker(t, data) != "backup" {
		t.Fatal("restored database was not installed")
	}
	if _, err := os.Stat(filepath.Join(data, "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("previous data survived the restore: %v", err)
	}
	assertNoRestoreArtifacts(t, data)
}

func assertNoRestoreArtifacts(t *testing.T, data string) {
	t.Helper()
	entries, err := os.ReadDir(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".restore") {
			t.Fatalf("restore artifact survived: %s", entry.Name())
		}
	}
}

func readStagedJournal(t *testing.T, data string) stagedJournal {
	t.Helper()
	journal := stagedJournal{}
	body, err := os.ReadFile(filepath.Join(data, stagedJournalName))
	if err != nil {
		t.Fatal(err)
	}
	if err := jsonexact.Decode(body, &journal); err != nil {
		t.Fatal(err)
	}
	return journal
}

func setPhase(t *testing.T, data, phase string) {
	t.Helper()
	journal := readStagedJournal(t, data)
	if err := advanceStagedJournal(filepath.Join(data, stagedJournalName), &journal, phase); err != nil {
		t.Fatal(err)
	}
}

func mustMkdir(t *testing.T, directory string) {
	t.Helper()
	if err := os.MkdirAll(directory, 0o750); err != nil {
		t.Fatal(err)
	}
}

func mustRename(t *testing.T, from, to string) {
	t.Helper()
	if err := os.Rename(from, to); err != nil {
		t.Fatal(err)
	}
}
