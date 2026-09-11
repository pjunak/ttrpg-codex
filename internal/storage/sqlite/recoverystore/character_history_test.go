package recoverystore

import (
	"context"
	"encoding/json"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"strings"
	"testing"
)

func TestRecoveryAppendsRetainedHeadsAndPreservesOldEvidence(t *testing.T) {
	recovery, records := fixture(t)
	ctx := context.Background()
	put(t, records, "hero", "Hero", 0)
	core, err := records.Get(ctx, campaign.Characters, "hero")
	if err != nil {
		t.Fatal(err)
	}
	store, err := addondatastore.New(addondatastore.Config{DB: recovery.DB, Events: recovery.Events})
	if err != nil {
		t.Fatal(err)
	}
	definition := datacontract.Description{Kind: datacontract.RecordExtension, ID: "sheet", Target: "characters", Retained: true, Visibility: datacontract.VisibilityPublic, SchemaVersion: "4.0.0", SchemaSHA256: strings.Repeat("a", 64)}
	write := func(revision int64, id, body string) {
		t.Helper()
		_, err := store.Transact(ctx, addondatastore.Transaction{AddonID: "sheets", GenerationID: strings.Repeat("b", 64), ActorID: "dm", OperationID: id, Operation: "character.build", Summary: "Build change", Mutations: []addondatastore.Mutation{{Kind: addondatastore.Put, Definition: definition, Key: "hero", ExpectedRevision: revision, Value: json.RawMessage(body), TargetCreatedAt: &core.CreatedAt, Audience: events.AudiencePublic}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	write(0, "before-recovery", `{"build":{"level":1},"evidence":{"formula":"original"}}`)
	if err = recovery.Create(ctx); err != nil {
		t.Fatal(err)
	}
	point := listing(t, recovery).Points[0]
	write(1, "after-recovery", `{"build":{"level":2},"evidence":{"formula":"changed"}}`)
	restore(t, recovery, point.ID)
	entries, err := store.History(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", 0, 100)
	if err != nil || len(entries) != 3 || entries[0].Revision != 3 || entries[0].Operation != "campaign.restore" {
		t.Fatalf("recovery journal: %+v %v", entries, err)
	}
	first, err := store.Revision(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", 1)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := store.Revision(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", 3)
	if err != nil || string(first.Value) != string(restored.Value) {
		t.Fatalf("recovered evidence differs: %+v %v", restored, err)
	}
	second, err := store.Revision(ctx, "sheets", datacontract.RecordExtension, "sheet", "hero", 2)
	if err != nil || !strings.Contains(string(second.Value), "changed") {
		t.Fatal("intervening revision was lost", err)
	}
}
