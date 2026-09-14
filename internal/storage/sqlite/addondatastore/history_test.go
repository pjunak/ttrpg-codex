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

func TestRecoveryDoesNotResumeExplicitlyRemovedRetention(t *testing.T) {
	store, _, db := testStore(t)
	ctx := context.Background()
	definition := testDefinition(datacontract.RecordExtension, "sheet", datacontract.VisibilityPublic)
	definition.Retained = true
	input := Transaction{AddonID: "sheets", GenerationID: testGeneration, ActorID: "dm:one", OperationID: "old-create", Operation: "character.create", Mutations: []Mutation{{Kind: Put, Definition: definition, Key: "hero", Value: json.RawMessage(`{"level":1}`), TargetCreatedAt: &testTargetCreated, Audience: events.AudiencePublic}}}
	if _, err := store.Transact(ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO addon_package_generations(addon_id,generation_id,addon_version,archive_sha256,manifest_json,installed_at,last_activated_at) VALUES(?,?,?,?,?,?,?)`, "sheets", testGeneration, "4.0.0", testGeneration, `{"recordExtensions":[{"id":"sheet","workerOnly":true}]}`, "2026-09-14T00:00:00Z", "2026-09-14T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO addon_package_states(addon_id,active_generation_id,updated_at) VALUES(?,?,?)`, "sheets", testGeneration, "2026-09-14T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	input.Mutations[0].Definition.Retained = false
	input.Mutations[0].Definition.WorkerOnly = true
	input.OperationID = ""
	input.Operation = ""
	for _, disabled := range []bool{false, true} {
		if disabled {
			if _, err := db.Exec(`UPDATE addon_package_states SET active_generation_id=NULL WHERE addon_id='sheets'`); err != nil {
				t.Fatal(err)
			}
		}
		input.Mutations[0].ExpectedRevision++
		if _, err := store.Transact(ctx, input); err != nil {
			t.Fatal(err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err = RetainRecovery(ctx, tx, "dm:one", "campaign-recovery"); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
		var count int
		if err = db.QueryRow(`SELECT count(*) FROM addon_history_revisions`).Scan(&count); err != nil || count != 1 {
			t.Fatalf("disabled=%v resumed character history: %d %v", disabled, count, err)
		}
	}
}
