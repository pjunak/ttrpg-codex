package addondatastore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/events"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

const testGeneration = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

var testTargetCreated = time.Date(2026, time.August, 31, 12, 0, 0, 0, time.UTC)

func TestStoreCommitsMultipleDefinitionsAtomically(t *testing.T) {
	t.Parallel()
	store, broker, database := testStore(t)
	ctx := context.Background()
	public := testDefinition(datacontract.Collection, "notes", datacontract.VisibilityPublic)
	dm := testDefinition(datacontract.RecordExtension, "sheet", datacontract.VisibilityDM)

	commit, err := store.Transact(ctx, Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{
			{Kind: Put, Definition: public, Key: "first", Value: json.RawMessage(` { "id": "first" } `), Audience: events.AudiencePublic},
			{Kind: Put, Definition: dm, Key: "hero", Value: json.RawMessage(`{"level":3}`), TargetCreatedAt: &testTargetCreated, Audience: events.AudienceDM},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if commit.ID < 1 || len(commit.Results) != 2 || commit.Results[0].AfterRevision != 1 ||
		commit.DataRevisions[definitionKey(datacontract.Collection, "notes")] != 1 ||
		commit.DataRevisions[definitionKey(datacontract.RecordExtension, "sheet")] != 1 {
		t.Fatalf("unexpected commit: %+v", commit)
	}
	note, err := store.Get(ctx, "dm-tools", datacontract.Collection, "notes", "first")
	if err != nil {
		t.Fatal(err)
	}
	if string(note.Value) != `{"id":"first"}` || note.Position != 0 || note.Revision != 1 ||
		note.SchemaVersion != public.SchemaVersion || note.SchemaSHA256 != public.SchemaSHA256 {
		t.Fatalf("unexpected stored document: %+v", note)
	}
	sheet, err := store.Get(ctx, "dm-tools", datacontract.RecordExtension, "sheet", "hero")
	if err != nil || sheet.TargetCreatedAt == nil || !sheet.TargetCreatedAt.Equal(testTargetCreated) {
		t.Fatalf("record lifetime was not retained: %+v, %v", sheet, err)
	}
	player, err := broker.Replay(ctx, events.AudiencePublic, 0, 10)
	if err != nil || len(player.Events) != 1 || string(player.Events[0].Metadata) != `{}` {
		t.Fatalf("unexpected player invalidations: %+v, %v", player, err)
	}
	dmReplay, err := broker.Replay(ctx, events.AudienceDM, 0, 10)
	if err != nil || len(dmReplay.Events) != 2 {
		t.Fatalf("unexpected DM invalidations: %+v, %v", dmReplay, err)
	}
	var records int
	if err := database.QueryRow(`SELECT count(*) FROM addon_data_commit_records WHERE commit_id = ?`, commit.ID).Scan(&records); err != nil || records != 2 {
		t.Fatalf("audit record count = %d, %v", records, err)
	}
}

func TestStoreRollsBackWholeTransactionOnConflict(t *testing.T) {
	t.Parallel()
	store, broker, database := testStore(t)
	ctx := context.Background()
	definition := testDefinition(datacontract.Collection, "notes", datacontract.VisibilityPublic)
	seed(t, store, definition, "existing", `{"id":"existing"}`, events.AudiencePublic)

	_, err := store.Transact(ctx, Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{
			{Kind: Put, Definition: definition, Key: "new", Value: json.RawMessage(`{"id":"new"}`), Audience: events.AudiencePublic},
			{Kind: Put, Definition: definition, Key: "existing", Value: json.RawMessage(`{"id":"existing","changed":true}`), ExpectedRevision: 99, Audience: events.AudiencePublic},
		},
	})
	var conflict *ConflictError
	if !errors.As(err, &conflict) || conflict.Actual != 1 || conflict.Expected != 99 {
		t.Fatalf("conflict = %#v, %v", conflict, err)
	}
	if _, err := store.Get(ctx, "dm-tools", datacontract.Collection, "notes", "new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partial document survived: %v", err)
	}
	replay, err := broker.Replay(ctx, events.AudiencePublic, 0, 10)
	if err != nil || len(replay.Events) != 1 {
		t.Fatalf("failed transaction published events: %+v, %v", replay, err)
	}
	var commits int
	if err := database.QueryRow(`SELECT count(*) FROM addon_data_commits`).Scan(&commits); err != nil || commits != 1 {
		t.Fatalf("commit count = %d, %v", commits, err)
	}
}

func TestStoreKeepsTombstoneRevisionAndStableOrdering(t *testing.T) {
	t.Parallel()
	store, _, _ := testStore(t)
	ctx := context.Background()
	definition := testDefinition(datacontract.Collection, "notes", datacontract.VisibilityPublic)
	seed(t, store, definition, "first", `{"id":"first"}`, events.AudiencePublic)
	seed(t, store, definition, "second", `{"id":"second"}`, events.AudiencePublic)
	if _, err := store.Transact(ctx, Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{{Kind: Delete, Definition: definition, Key: "first", ExpectedRevision: 1, Audience: events.AudiencePublic}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Transact(ctx, Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{{Kind: Put, Definition: definition, Key: "first", Value: json.RawMessage(`{"id":"first","restored":true}`), ExpectedRevision: 2, Audience: events.AudiencePublic}},
	}); err != nil {
		t.Fatal(err)
	}
	documents, err := store.List(ctx, "dm-tools", datacontract.Collection, "notes")
	if err != nil {
		t.Fatal(err)
	}
	if len(documents) != 2 || documents[0].Key != "second" || documents[0].Position != 1 ||
		documents[1].Key != "first" || documents[1].Position != 2 || documents[1].Revision != 3 {
		t.Fatalf("unexpected recreated ordering: %+v", documents)
	}
}

func TestQueryPageUsesExclusiveStablePositionCursor(t *testing.T) {
	t.Parallel()
	store, _, _ := testStore(t)
	definition := testDefinition(datacontract.Collection, "notes", datacontract.VisibilityPublic)
	seed(t, store, definition, "first", `{"id":"first"}`, events.AudiencePublic)
	seed(t, store, definition, "second", `{"id":"second"}`, events.AudiencePublic)
	seed(t, store, definition, "third", `{"id":"third"}`, events.AudiencePublic)

	first, err := store.QueryPage(context.Background(), "dm-tools", datacontract.Collection, "notes", -1, 2)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.QueryPage(context.Background(), "dm-tools", datacontract.Collection, "notes", first[1].Position, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].Key != "first" || first[1].Key != "second" ||
		len(second) != 1 || second[0].Key != "third" {
		t.Fatalf("pages = %+v then %+v", first, second)
	}
	if _, err := store.Transact(context.Background(), Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{{
			Kind: Delete, Definition: definition, Key: "third",
			ExpectedRevision: 1, Audience: events.AudiencePublic,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	seed(t, store, definition, "fourth", `{"id":"fourth"}`, events.AudiencePublic)
	afterDeletion, err := store.QueryPage(
		context.Background(), "dm-tools", datacontract.Collection, "notes", second[0].Position, 2,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterDeletion) != 1 || afterDeletion[0].Key != "fourth" ||
		afterDeletion[0].Position <= second[0].Position {
		t.Fatalf("cursor position was reused after deletion: %+v", afterDeletion)
	}
}

func TestSnapshotPreservesMaterializedEmptySets(t *testing.T) {
	t.Parallel()
	store, _, _ := testStore(t)
	definition := testDefinition(datacontract.Collection, "notes", datacontract.VisibilityPrivate)
	seed(t, store, definition, "only", `{"id":"only"}`, events.AudienceSystem)
	if _, err := store.Transact(context.Background(), Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{{Kind: Delete, Definition: definition, Key: "only", ExpectedRevision: 1, Audience: events.AudienceSystem}},
	}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.SnapshotAddon(context.Background(), "dm-tools")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.States) != 1 || !snapshot.States[0].Materialized || snapshot.States[0].Revision != 2 ||
		snapshot.States[0].SchemaVersion != definition.SchemaVersion ||
		snapshot.States[0].SchemaSHA256 != definition.SchemaSHA256 ||
		len(snapshot.Documents) != 0 {
		t.Fatalf("unexpected empty snapshot: %+v", snapshot)
	}
}

func TestStoreRefusesSchemaIdentityChangeForMaterializedSet(t *testing.T) {
	t.Parallel()
	store, _, _ := testStore(t)
	definition := testDefinition(datacontract.Collection, "notes", datacontract.VisibilityDM)
	seed(t, store, definition, "first", `{"id":"first"}`, events.AudienceDM)
	changed := definition
	changed.SchemaVersion = "2.0.0"
	changed.SchemaSHA256 = strings.Repeat("b", 64)

	_, err := store.Transact(context.Background(), Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{{
			Kind: Put, Definition: changed, Key: "second",
			Value: json.RawMessage(`{"id":"second"}`), Audience: events.AudienceDM,
		}},
	})
	if !errors.Is(err, ErrSchemaMismatch) {
		t.Fatalf("schema mismatch error = %v", err)
	}
	state, err := store.State(context.Background(), "dm-tools", datacontract.Collection, "notes")
	if err != nil || state.SchemaVersion != definition.SchemaVersion || state.Revision != 1 {
		t.Fatalf("stored schema identity changed: %+v, %v", state, err)
	}
}

func TestStoreRejectsInvalidOrDuplicateMutationsBeforeWriting(t *testing.T) {
	t.Parallel()
	store, _, database := testStore(t)
	definition := testDefinition(datacontract.Collection, "notes", datacontract.VisibilityDM)
	mutation := Mutation{Kind: Put, Definition: definition, Key: "same", Value: json.RawMessage(`{"id":"same"}`), Audience: events.AudienceDM}
	_, err := store.Transact(context.Background(), Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{mutation, mutation},
	})
	if !errors.Is(err, ErrInvalidTransaction) {
		t.Fatalf("duplicate error = %v", err)
	}
	tooLarge := json.RawMessage(`"` + strings.Repeat("x", MaximumDocumentBytes) + `"`)
	_, err = store.Transact(context.Background(), Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "worker:dm-tools",
		Mutations: []Mutation{{Kind: Put, Definition: definition, Key: "large", Value: tooLarge, Audience: events.AudienceDM}},
	})
	if !errors.Is(err, ErrInvalidTransaction) {
		t.Fatalf("oversized error = %v", err)
	}
	var sets int
	if err := database.QueryRow(`SELECT count(*) FROM addon_data_sets`).Scan(&sets); err != nil || sets != 0 {
		t.Fatalf("invalid transactions wrote %d sets, %v", sets, err)
	}
}

func testStore(t *testing.T) (*Store, *events.Broker, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	result, err := storage.Migrate(ctx, database, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if result.CurrentVersion != 14 {
		t.Fatalf("migration version = %d, want 14", result.CurrentVersion)
	}
	now := func() time.Time { return time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC) }
	broker, err := events.New(events.Config{DB: database, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	store, err := New(Config{DB: database, Events: broker, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	return store, broker, database
}

func testDefinition(kind datacontract.Kind, id string, visibility datacontract.Visibility) datacontract.Description {
	result := datacontract.Description{
		Kind: kind, ID: id, Visibility: visibility, Schema: "contracts/" + id + ".schema.json",
		SchemaVersion: "1.0.0", SchemaSHA256: strings.Repeat("a", 64),
	}
	if kind == datacontract.RecordExtension {
		result.Target = "characters"
	}
	return result
}

func seed(t *testing.T, store *Store, definition datacontract.Description, key, value string, audience events.Audience) {
	t.Helper()
	if _, err := store.Transact(context.Background(), Transaction{
		AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "seed",
		Mutations: []Mutation{{Kind: Put, Definition: definition, Key: key, Value: json.RawMessage(value), Audience: audience}},
	}); err != nil {
		t.Fatal(err)
	}
}
