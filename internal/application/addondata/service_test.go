package addondata

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
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

const generationOne = "1111111111111111111111111111111111111111111111111111111111111111"

func TestServiceUsesActivePackageSchemasAndVisibility(t *testing.T) {
	t.Parallel()
	service, _, _, _ := testService(t)
	registry := testRegistry(t, "1.0.0", false)
	activate(t, service, registry, generationOne)
	player := Access{AddonID: "dm-tools", Generation: generationOne, Role: RolePlayer, ActorID: "p1"}

	commit, err := service.Transact(context.Background(), Transaction{Access: player, Mutations: []Mutation{{
		Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "n1",
		Value: json.RawMessage(`{"id":"n1","title":"First"}`),
	}}})
	if err != nil || commit.Results[0].AfterRevision != 1 {
		t.Fatalf("valid write = %+v, %v", commit, err)
	}
	_, err = service.Transact(context.Background(), Transaction{Access: player, Mutations: []Mutation{{
		Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "wrong",
		Value: json.RawMessage(`{"id":"other","title":"Wrong"}`),
	}}})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("mismatched id error = %v", err)
	}
	_, err = service.Transact(context.Background(), Transaction{Access: player, Mutations: []Mutation{{
		Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "private_state", Key: "one",
		Value: json.RawMessage(`{"value":true}`),
	}}})
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("private write error = %v", err)
	}
	stale := player
	stale.Generation = "2222222222222222222222222222222222222222222222222222222222222222"
	if _, err := service.List(context.Background(), stale, datacontract.Collection, "notes"); !errors.Is(err, ErrInactiveGeneration) {
		t.Fatalf("stale generation error = %v", err)
	}
}

func TestRecordExtensionsFollowCoreVisibilityAndLifetime(t *testing.T) {
	t.Parallel()
	service, core, _, clock := testService(t)
	registry := testRegistry(t, "1.0.0", false)
	activate(t, service, registry, generationOne)
	seedCore(t, core, "alice", "public")
	seedCore(t, core, "secret", "dm")
	player := Access{AddonID: "dm-tools", Generation: generationOne, Role: RolePlayer, ActorID: "p1"}
	dm := Access{AddonID: "dm-tools", Generation: generationOne, Role: RoleDM, ActorID: "dm1"}

	writeExtension := func(access Access, key string) error {
		_, err := service.Transact(context.Background(), Transaction{Access: access, Mutations: []Mutation{{
			Kind: addondatastore.Put, DataKind: datacontract.RecordExtension, DataID: "sheet", Key: key,
			Value: json.RawMessage(`{"level":3}`),
		}}})
		return err
	}
	if err := writeExtension(player, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := writeExtension(player, "secret"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("hidden target write error = %v", err)
	}
	if err := writeExtension(dm, "secret"); err != nil {
		t.Fatal(err)
	}
	visible, err := service.List(context.Background(), player, datacontract.RecordExtension, "sheet")
	if err != nil || len(visible) != 1 || visible[0].Key != "alice" {
		t.Fatalf("player extension view = %+v, %v", visible, err)
	}

	alice, err := core.Get(context.Background(), campaign.Characters, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := core.Transact(context.Background(), campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{
		Kind: campaign.Delete, Collection: campaign.Characters, Key: "alice", ExpectedRevision: alice.Revision,
	}}}); err != nil {
		t.Fatal(err)
	}
	*clock = clock.Add(time.Second)
	state, err := core.State(context.Background(), campaign.Characters, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := core.Transact(context.Background(), campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.Characters, Key: "alice", ExpectedRevision: state.Revision,
		Value: json.RawMessage(`{"id":"alice","name":"New Alice","visibility":"public"}`),
	}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(context.Background(), player, datacontract.RecordExtension, "sheet", "alice"); !errors.Is(err, ErrTargetReplaced) {
		t.Fatalf("replacement target error = %v", err)
	}
}

func TestLifecycleRequiresReviewedMigrationForStoredData(t *testing.T) {
	t.Parallel()
	service, _, _, _ := testService(t)
	first := testRegistry(t, "1.0.0", false)
	activate(t, service, first, generationOne)
	system := Access{AddonID: "dm-tools", Generation: generationOne, Role: RoleSystem}
	commit, err := service.Transact(context.Background(), Transaction{Access: system, Mutations: []Mutation{{
		Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "n1",
		Value: json.RawMessage(`{"id":"n1","title":"First"}`),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Transact(context.Background(), Transaction{Access: system, Mutations: []Mutation{{
		Kind: addondatastore.Delete, DataKind: datacontract.Collection, DataID: "notes", Key: "n1",
		ExpectedRevision: commit.Results[0].AfterRevision,
	}}}); err != nil {
		t.Fatal(err)
	}

	changed := testRegistry(t, "2.0.0", false)
	issues, err := service.ReviewActivation(context.Background(), "dm-tools", changed)
	if err != nil || len(issues) != 1 || issues[0].Code != "DATA_MIGRATION_REQUIRED" {
		t.Fatalf("schema review = %+v, %v", issues, err)
	}
	transition, err := service.BeginActivation(context.Background(), "dm-tools", generationOne, changed)
	if transition != nil || !errors.Is(err, ErrMigrationRequired) {
		t.Fatalf("blocked transition = %#v, %v", transition, err)
	}
}

func TestUniqueIndexesAreEnforcedAcrossAtomicWrites(t *testing.T) {
	t.Parallel()
	service, _, _, _ := testService(t)
	registry := testRegistry(t, "1.0.0", true)
	activate(t, service, registry, generationOne)
	system := Access{AddonID: "dm-tools", Generation: generationOne, Role: RoleSystem}
	_, err := service.Transact(context.Background(), Transaction{Access: system, Mutations: []Mutation{
		{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "one", Value: json.RawMessage(`{"id":"one","title":"same"}`)},
		{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: "two", Value: json.RawMessage(`{"id":"two","title":"same"}`)},
	}})
	if !errors.Is(err, ErrUniqueIndexConflict) {
		t.Fatalf("unique conflict error = %v", err)
	}
	documents, err := service.List(context.Background(), system, datacontract.Collection, "notes")
	if err != nil || len(documents) != 0 {
		t.Fatalf("conflicting transaction wrote documents: %+v, %v", documents, err)
	}
}

func TestQueryIsBoundedPagedAndRestrictedToDeclaredIndexes(t *testing.T) {
	t.Parallel()
	service, _, _, _ := testService(t)
	registry := testRegistry(t, "1.0.0", false)
	activate(t, service, registry, generationOne)
	system := Access{AddonID: "dm-tools", Generation: generationOne, Role: RoleSystem}
	for _, item := range []struct{ id, title string }{{"one", "match"}, {"two", "other"}, {"three", "match"}} {
		if _, err := service.Transact(context.Background(), Transaction{Access: system, Mutations: []Mutation{{
			Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: item.id,
			Value: json.RawMessage(`{"id":"` + item.id + `","title":"` + item.title + `"}`),
		}}}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := service.Query(context.Background(), Query{
		Access: system, DataKind: datacontract.Collection, DataID: "notes",
		AfterPosition: -1, Limit: 1,
		Where: []QueryCondition{{Path: "/title", Equals: json.RawMessage(`"match"`)}},
	})
	if err != nil || len(first.Documents) != 1 || first.Documents[0].Key != "one" || first.NextPosition == nil {
		t.Fatalf("first query = %+v, %v", first, err)
	}
	second, err := service.Query(context.Background(), Query{
		Access: system, DataKind: datacontract.Collection, DataID: "notes",
		AfterPosition: *first.NextPosition, Limit: 2,
		Where: []QueryCondition{{Path: "/title", Equals: json.RawMessage(`"match"`)}},
	})
	if err != nil || len(second.Documents) != 1 || second.Documents[0].Key != "three" || second.NextPosition != nil {
		t.Fatalf("second query = %+v, %v", second, err)
	}
	_, err = service.Query(context.Background(), Query{
		Access: system, DataKind: datacontract.Collection, DataID: "notes",
		AfterPosition: -1, Limit: 10,
		Where: []QueryCondition{{Path: "/undeclared", Equals: json.RawMessage(`true`)}},
	})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("undeclared index error = %v", err)
	}
}

func TestQueryBoundsAggregateResponsePayload(t *testing.T) {
	t.Parallel()
	service, _, _, _ := testService(t)
	registry := testRegistry(t, "1.0.0", false)
	activate(t, service, registry, generationOne)
	system := Access{AddonID: "dm-tools", Generation: generationOne, Role: RoleSystem}
	largeTitle := strings.Repeat("x", 250_000)
	for index := range 7 {
		key := string(rune('a' + index))
		body, err := json.Marshal(map[string]string{"id": key, "title": largeTitle})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := service.Transact(context.Background(), Transaction{Access: system, Mutations: []Mutation{{
			Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes",
			Key: key, Value: body,
		}}}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := service.Query(context.Background(), Query{
		Access: system, DataKind: datacontract.Collection, DataID: "notes",
		AfterPosition: -1, Limit: MaximumQueryDocuments,
	})
	if err != nil || len(first.Documents) != 6 || first.NextPosition == nil {
		t.Fatalf("bounded query = %d documents, cursor %v, error %v", len(first.Documents), first.NextPosition, err)
	}
	second, err := service.Query(context.Background(), Query{
		Access: system, DataKind: datacontract.Collection, DataID: "notes",
		AfterPosition: *first.NextPosition, Limit: MaximumQueryDocuments,
	})
	if err != nil || len(second.Documents) != 1 || second.Documents[0].Key != "g" || second.NextPosition != nil {
		t.Fatalf("continued query = %+v, %v", second, err)
	}
}

func testService(t *testing.T) (*Service, *campaignstore.Store, *sql.DB, *time.Time) {
	t.Helper()
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	if _, err := storage.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	current := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	now := func() time.Time { return current }
	broker, err := events.New(events.Config{DB: database, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	core, err := campaignstore.New(campaignstore.Config{DB: database, Events: broker, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	repository, err := addondatastore.New(addondatastore.Config{DB: database, Events: broker, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	service, err := New(repository, core)
	if err != nil {
		t.Fatal(err)
	}
	return service, core, database, &current
}

func testRegistry(t *testing.T, version string, uniqueTitle bool) *datacontract.Registry {
	t.Helper()
	indexes := []datacontract.Index{{Path: "/title", Unique: uniqueTitle}}
	registry, err := datacontract.Compile([]datacontract.Declaration{
		{Kind: datacontract.Collection, ID: "notes", Visibility: datacontract.VisibilityPublic, Schema: "contracts/note.json", SchemaVersion: version, Indexes: indexes},
		{Kind: datacontract.Collection, ID: "private_state", Keyed: true, Visibility: datacontract.VisibilityPrivate, Schema: "contracts/private.json", SchemaVersion: "1.0.0"},
		{Kind: datacontract.RecordExtension, ID: "sheet", Target: "characters", Visibility: datacontract.VisibilityPublic, Schema: "contracts/sheet.json", SchemaVersion: "1.0.0"},
	}, map[string][]byte{
		"contracts/note.json":    []byte(`{"type":"object","additionalProperties":false,"required":["id","title"],"properties":{"id":{"type":"string"},"title":{"type":"string"}}}`),
		"contracts/private.json": []byte(`{"type":"object","required":["value"],"properties":{"value":{"type":"boolean"}}}`),
		"contracts/sheet.json":   []byte(`{"type":"object","required":["level"],"properties":{"level":{"type":"integer","minimum":1}}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func activate(t *testing.T, service *Service, registry *datacontract.Registry, generation string) {
	t.Helper()
	transition, err := service.BeginActivation(context.Background(), "dm-tools", generation, registry)
	if err != nil {
		t.Fatal(err)
	}
	transition.Commit()
}

func seedCore(t *testing.T, core *campaignstore.Store, id, visibility string) {
	t.Helper()
	if _, err := core.Transact(context.Background(), campaign.Transaction{ActorID: "seed", Mutations: []campaign.Mutation{{
		Kind: campaign.Put, Collection: campaign.Characters, Key: id,
		Value: json.RawMessage(`{"id":"` + id + `","name":"` + id + `","visibility":"` + visibility + `"}`),
	}}}); err != nil {
		t.Fatal(err)
	}
}
