package addondatastore

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"testing"
)

func TestRetainedRevisionsSharePayloadsAndRejectStaleOrReusedOperations(t *testing.T) {
	t.Parallel()
	store, _, db := testStore(t)
	ctx := context.Background()
	definition := testDefinition(datacontract.RecordExtension, "sheet", datacontract.VisibilityPublic)
	definition.Retained = true
	input := Transaction{AddonID: "sheets", GenerationID: testGeneration, ActorID: "dm:one", OperationID: "create-1", Operation: "character.create", Summary: "Created character", Mutations: []Mutation{{Kind: Put, Definition: definition, Key: "hero", Value: json.RawMessage(`{"build":{"level":1},"play":{"hp":10}}`), TargetCreatedAt: &testTargetCreated, Audience: events.AudiencePublic}}}
	first, err := store.Transact(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := store.Transact(ctx, input)
	if err != nil || replay.ID != first.ID {
		t.Fatalf("retry: %+v %v", replay, err)
	}
	input.Mutations[0].Value = json.RawMessage(`{"build":{"level":1},"play":{"hp":8}}`)
	if _, err = store.Transact(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("reused operation: %v", err)
	}
	input.OperationID = "damage-1"
	input.Operation = "play.damage"
	input.Mutations[0].ExpectedRevision = 1
	if _, err = store.Transact(ctx, input); err != nil {
		t.Fatal(err)
	}
	input.OperationID = "stale-1"
	if _, err = store.Transact(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale: %v", err)
	}
	entries, err := store.History(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", 0, 1)
	if err != nil || len(entries) != 1 || entries[0].Revision != 2 || entries[0].Value != nil {
		t.Fatalf("history: %+v %v", entries, err)
	}
	older, err := store.History(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", 2, 100)
	if err != nil || len(older) != 1 || older[0].Revision != 1 {
		t.Fatalf("page: %+v %v", older, err)
	}
	original, err := store.Revision(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", 1)
	if err != nil || string(original.Value) != `{"build":{"level":1},"play":{"hp":10}}` || original.ActorID != "dm:one" {
		t.Fatalf("revision: %+v %v", original, err)
	}
	var payloads int
	if err = db.QueryRow(`SELECT count(*) FROM addon_history_payloads`).Scan(&payloads); err != nil || payloads != 3 {
		t.Fatalf("shared payloads = %d, %v", payloads, err)
	}
	if _, err = db.Exec(`UPDATE addon_history_revisions SET summary='forged'`); err == nil {
		t.Fatal("history was mutable")
	}
	input.OperationID = "delete-1"
	input.Operation = "character.delete"
	input.Mutations[0].Kind = Delete
	input.Mutations[0].Value = nil
	input.Mutations[0].ExpectedRevision = 2
	if _, err = store.Transact(ctx, input); err != nil {
		t.Fatal(err)
	}
	original, err = store.Revision(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", 1)
	if err != nil || len(original.Value) == 0 {
		t.Fatal("deletion lost history", err)
	}
}
