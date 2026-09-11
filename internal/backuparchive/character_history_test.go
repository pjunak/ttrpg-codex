package backuparchive

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/events"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackupReconstructsEveryRetainedCharacterRevision(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	db, err := storage.Open(ctx, filepath.Join(source, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = storage.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	bus, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	store, err := addondatastore.New(addondatastore.Config{DB: db, Events: bus})
	if err != nil {
		t.Fatal(err)
	}
	definition := datacontract.Description{Kind: datacontract.RecordExtension, ID: "sheet", Target: "characters", Retained: true, Visibility: datacontract.VisibilityPublic, SchemaVersion: "4.0.0", SchemaSHA256: strings.Repeat("a", 64)}
	created := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)
	for revision := int64(0); revision < 3; revision++ {
		value := json.RawMessage(fmt.Sprintf(`{"build":{"species":"synthetic"},"play":{"hp":%d},"evidence":{"hash":"saved-source","formula":"retained"}}`, 10-revision))
		_, err = store.Transact(ctx, addondatastore.Transaction{AddonID: "sheets", GenerationID: strings.Repeat("b", 64), ActorID: "player", OperationID: fmt.Sprintf("operation-%d", revision), Operation: "character.play", Summary: "Play change", Mutations: []addondatastore.Mutation{{Kind: addondatastore.Put, Definition: definition, Key: "hero", ExpectedRevision: revision, Value: value, TargetCreatedAt: &created, Audience: events.AudiencePublic}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	archive := filepath.Join(root, "backup.zip")
	if _, err = Create(ctx, CreateConfig{Database: db, DataDirectory: source, OutputPath: archive, HostVersion: "test"}); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "restored")
	if _, err = Restore(ctx, RestoreConfig{ArchivePath: archive, DataDirectory: target, Migrations: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	restoredDB, err := storage.Open(ctx, filepath.Join(target, "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer restoredDB.Close()
	restoredBus, err := events.New(events.Config{DB: restoredDB})
	if err != nil {
		t.Fatal(err)
	}
	restored, err := addondatastore.New(addondatastore.Config{DB: restoredDB, Events: restoredBus})
	if err != nil {
		t.Fatal(err)
	}
	for revision := int64(1); revision <= 3; revision++ {
		before, err := store.Revision(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", revision)
		if err != nil {
			t.Fatal(err)
		}
		after, err := restored.Revision(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", revision)
		if err != nil || string(before.Value) != string(after.Value) || before.OperationID != after.OperationID || before.ActorID != after.ActorID {
			t.Fatalf("revision %d did not survive backup: %+v %v", revision, after, err)
		}
	}
}
