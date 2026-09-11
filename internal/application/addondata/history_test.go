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
