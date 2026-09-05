package addondata

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

func TestQueryRevisionGuardsPaginationAndWrites(t *testing.T) {
	t.Parallel()
	service, _, _, _ := testService(t)
	activate(t, service, testRegistry(t, "1.0.0", false), generationOne)
	ctx := context.Background()
	dm := Access{AddonID: "dm-tools", Generation: generationOne, Role: RoleDM}
	query := Query{Access: dm, DataKind: datacontract.Collection, DataID: "notes", AfterPosition: -1, Limit: 1, IncludeDataRevision: true}
	empty, err := service.Query(ctx, query)
	if err != nil || empty.DataRevision == nil || *empty.DataRevision != 0 {
		t.Fatalf("empty revision: %+v, %v", empty, err)
	}
	write := func(key string) {
		t.Helper()
		_, err := service.Transact(ctx, Transaction{Access: dm, Mutations: []Mutation{{Kind: addondatastore.Put, DataKind: datacontract.Collection, DataID: "notes", Key: key, Value: json.RawMessage(`{"id":"` + key + `","title":"` + key + `"}`)}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	write("a")
	write("b")
	first, err := service.Query(ctx, query)
	if err != nil || first.NextPosition == nil || first.DataRevision == nil || *first.DataRevision != 2 {
		t.Fatalf("first page: %+v, %v", first, err)
	}
	query.AfterPosition = *first.NextPosition
	query.ExpectedDataRevision = first.DataRevision
	write("unseen")
	if _, err := service.Query(ctx, query); !errors.Is(err, addondatastore.ErrConflict) {
		t.Fatalf("torn page accepted: %v", err)
	}
	transaction := Transaction{Access: dm, ExpectedDataSets: []addondatastore.DataSetRevision{{Kind: datacontract.Collection, DataID: "notes", Revision: 2}}, Mutations: []Mutation{{Kind: addondatastore.Delete, DataKind: datacontract.Collection, DataID: "notes", Key: "a", ExpectedRevision: 1}}}
	if _, err := service.Transact(ctx, transaction); !errors.Is(err, addondatastore.ErrConflict) {
		t.Fatalf("stale deletion accepted: %v", err)
	}
	query.ExpectedDataRevision = nil
	query.IncludeDataRevision = false
	plain, err := service.Query(ctx, query)
	if err != nil || plain.DataRevision != nil {
		t.Fatalf("old query exposed new field: %+v, %v", plain, err)
	}
	query.Access.Role = RolePlayer
	query.IncludeDataRevision = true
	if _, err := service.Query(ctx, query); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("player revision access: %v", err)
	}
	transaction.Access.Role = RolePlayer
	if _, err := service.Transact(ctx, transaction); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("player guard oracle: %v", err)
	}
	transaction.Access = dm
	transaction.ExpectedDataSets[0].DataID = "undeclared"
	if _, err := service.Transact(ctx, transaction); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("undeclared guard: %v", err)
	}
}
