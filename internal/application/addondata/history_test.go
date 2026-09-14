package addondata

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"testing"
	"time"
)

func TestRetainedDataRequiresWorkerAuthorityAndCurrentRecordVisibility(t *testing.T) {
	t.Parallel()
	service, core, _, now := testService(t)
	ctx := context.Background()
	registry, err := datacontract.Compile([]datacontract.Declaration{{Kind: datacontract.RecordExtension, ID: "sheet", Target: "characters", Retained: true, Visibility: datacontract.VisibilityPublic, Schema: "contracts/sheet.json", SchemaVersion: "4.0.0"}}, map[string][]byte{"contracts/sheet.json": []byte(`{"type":"object","properties":{"level":{"type":"integer"}}}`)})
	if err != nil {
		t.Fatal(err)
	}
	activate(t, service, registry, generationOne)
	seedCore(t, core, "hero", "public")
	input := Transaction{Access: Access{AddonID: "dm-tools", Generation: generationOne, Role: RolePlayer, ActorID: "player-1"}, OperationID: "create-1", Operation: "character.create", Mutations: []Mutation{{Kind: addondatastore.Put, DataKind: datacontract.RecordExtension, DataID: "sheet", Key: "hero", Value: json.RawMessage(`{"level":1}`)}}}
	if _, err = service.Transact(ctx, input); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("browser write = %v", err)
	}
	input.Access.Role = RoleDM
	if _, err = service.Transact(ctx, input); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("DM browser bypass = %v", err)
	}
	input.Access.Worker = true
	if _, err = service.Transact(ctx, input); err != nil {
		t.Fatal(err)
	}
	player := input.Access
	player.Worker = false
	player.Role = RolePlayer
	history, err := service.History(ctx, player, datacontract.RecordExtension, "sheet", "hero", 0, 10)
	if err != nil || len(history) != 1 || history[0].ActorID != "dm:player-1" {
		t.Fatalf("visible history = %+v %v", history, err)
	}
	if _, err = core.Transact(ctx, campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{Kind: campaign.Put, Collection: campaign.Characters, Key: "hero", ExpectedRevision: 1, Value: json.RawMessage(`{"id":"hero","name":"Hero","visibility":"dm"}`)}}}); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Revision(ctx, player, datacontract.RecordExtension, "sheet", "hero", 1); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("private history = %v", err)
	}
	if _, err = core.Transact(ctx, campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{Kind: campaign.Delete, Collection: campaign.Characters, Key: "hero", ExpectedRevision: 2}}}); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Hour)
	if _, err = core.Transact(ctx, campaign.Transaction{ActorID: "dm", Mutations: []campaign.Mutation{{Kind: campaign.Put, Collection: campaign.Characters, Key: "hero", ExpectedRevision: 3, Value: json.RawMessage(`{"id":"hero","name":"Different","visibility":"public"}`)}}}); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Revision(ctx, player, datacontract.RecordExtension, "sheet", "hero", 1); !errors.Is(err, ErrTargetReplaced) {
		t.Fatalf("recreated record inherited history = %v", err)
	}
}

func TestWorkerOnlyCurrentStateKeepsAuthorityWithoutSnapshots(t *testing.T) {
	service, core, db, _ := testService(t)
	ctx := context.Background()
	declaration := datacontract.Declaration{Kind: datacontract.RecordExtension, ID: "sheet", Target: "characters", Retained: true, Visibility: datacontract.VisibilityPublic, Schema: "contracts/sheet.json", SchemaVersion: "4.0.0"}
	resources := map[string][]byte{"contracts/sheet.json": []byte(`{"type":"object","properties":{"level":{"type":"integer"}}}`)}
	old, err := datacontract.Compile([]datacontract.Declaration{declaration}, resources)
	if err != nil {
		t.Fatal(err)
	}
	activate(t, service, old, generationOne)
	seedCore(t, core, "hero", "public")
	seedCore(t, core, "hidden", "dm")
	input := Transaction{Access: Access{AddonID: "dm-tools", Generation: generationOne, Role: RolePlayer, ActorID: "player-1", Worker: true}, OperationID: "old-save", Operation: "character.create", Mutations: []Mutation{{Kind: addondatastore.Put, DataKind: datacontract.RecordExtension, DataID: "sheet", Key: "hero", Value: json.RawMessage(`{"level":1}`)}}}
	if _, err = service.Transact(ctx, input); err != nil {
		t.Fatal(err)
	}
	declaration.Retained = false
	declaration.WorkerOnly = true
	current, err := datacontract.Compile([]datacontract.Declaration{declaration}, resources)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := old.Description(datacontract.RecordExtension, "sheet")
	after, _ := current.Description(datacontract.RecordExtension, "sheet")
	if before.SchemaSHA256 != after.SchemaSHA256 {
		t.Fatal("current state lost compatible worker authority")
	}
	activate(t, service, current, "2222222222222222222222222222222222222222222222222222222222222222")
	input.Access.Generation = "2222222222222222222222222222222222222222222222222222222222222222"
	input.OperationID = ""
	input.Operation = ""
	input.Mutations[0].ExpectedRevision = 1
	input.Mutations[0].Value = json.RawMessage(`{"level":2}`)
	input.Access.Worker = false
	if _, err = service.Transact(ctx, input); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("browser bypassed worker", err)
	}
	input.Access.Worker = true
	if _, err = service.Transact(ctx, input); err != nil {
		t.Fatal(err)
	}
	document, err := service.Get(ctx, input.Access, datacontract.RecordExtension, "sheet", "hero")
	if err != nil || document.Revision != 2 {
		t.Fatal("head not updated", document, err)
	}
	if _, err = service.History(ctx, input.Access, datacontract.RecordExtension, "sheet", "hero", 0, 10); err == nil {
		t.Fatal("history remained accessible")
	}
	if _, err = service.Get(ctx, input.Access, datacontract.RecordExtension, "sheet", "hidden"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("uninitialized hidden sheet bypass", err)
	}
	var count int
	if err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM addon_history_revisions`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("current saves retained new history", count)
	}
}
