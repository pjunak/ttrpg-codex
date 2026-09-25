package addondata

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

func TestActivationRejectsNewUniqueIndexWithoutSchemaIdentityChange(t *testing.T) {
	service, _, _, _ := testService(t)
	ctx := context.Background()
	old := testRegistry(t, "1.0.0", false)
	next := testRegistry(t, "1.0.0", true)
	before, _ := old.Description(datacontract.Collection, "notes")
	after, _ := next.Description(datacontract.Collection, "notes")
	if before.SchemaSHA256 != after.SchemaSHA256 {
		t.Fatal("fixture must keep the same schema identity")
	}
	activate(t, service, old, generationOne)
	for _, key := range []string{"one", "two"} {
		if _, err := service.Transact(ctx, Transaction{Access: Access{AddonID: "dm-tools", Generation: generationOne, Role: RoleSystem}, Mutations: []Mutation{{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: key, Value: json.RawMessage(`{"id":"` + key + `","title":"same"}`)}}}); err != nil {
			t.Fatal(err)
		}
	}
	issues, err := service.ReviewActivation(ctx, "dm-tools", next)
	if err != nil || len(issues) != 1 || issues[0].Code != "UNIQUE_INDEX_CONFLICT" {
		t.Fatalf("review: %+v %v", issues, err)
	}
	if transition, err := service.BeginActivation(ctx, "dm-tools", "next", next); !errors.Is(err, ErrMigrationRequired) {
		if transition != nil {
			transition.Rollback()
		}
		t.Fatal("activation bypass", err)
	}
}
