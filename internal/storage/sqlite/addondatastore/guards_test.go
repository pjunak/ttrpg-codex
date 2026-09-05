package addondatastore

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

func TestDataSetGuardsProtectUnseenDocumentsAndEmptySets(t *testing.T) {
	t.Parallel()
	store, broker, database := testStore(t)
	ctx := context.Background()
	notes := testDefinition(datacontract.Collection, "notes", datacontract.VisibilityPublic)
	children := testDefinition(datacontract.Collection, "children", datacontract.VisibilityPublic)
	seed(t, store, notes, "parent", `{"id":"parent"}`, events.AudiencePublic)
	input := Transaction{AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "dm",
		ExpectedDataSets: []DataSetRevision{{Kind: datacontract.Collection, DataID: "children", Revision: 0}},
		Mutations:        []Mutation{{Kind: Delete, Definition: notes, Key: "parent", ExpectedRevision: 1, Audience: events.AudiencePublic}},
	}
	seed(t, store, children, "unseen", `{"id":"unseen"}`, events.AudiencePublic)
	if _, err := store.Transact(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("unseen child: %v", err)
	}
	if _, err := store.Get(ctx, "dm-tools", datacontract.Collection, "notes", "parent"); err != nil {
		t.Fatal(err)
	}
	var commits int
	if err := database.QueryRow(`SELECT count(*) FROM addon_data_commits`).Scan(&commits); err != nil || commits != 2 {
		t.Fatalf("audit changed: %d, %v", commits, err)
	}
	replay, err := broker.Replay(ctx, events.AudiencePublic, 0, 20)
	if err != nil || len(replay.Events) != 2 {
		t.Fatalf("events changed: %+v, %v", replay, err)
	}
	state, err := store.State(ctx, "dm-tools", datacontract.Collection, "notes")
	if err != nil || state.Revision != 1 {
		t.Fatalf("revision changed: %+v, %v", state, err)
	}
	// Returning to an empty set must not resurrect the old revision-zero snapshot.
	if _, err := store.Transact(ctx, Transaction{AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "dm", Mutations: []Mutation{{Kind: Delete, Definition: children, Key: "unseen", ExpectedRevision: 1, Audience: events.AudiencePublic}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Transact(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("empty set reused old revision: %v", err)
	}
	input.ExpectedDataSets[0].Revision = 2
	input.ExpectedDataSets = append(input.ExpectedDataSets, DataSetRevision{Kind: datacontract.Collection, DataID: "never_written", Revision: 0})
	if _, err := store.Transact(ctx, input); err != nil {
		t.Fatal(err)
	}
	// Guards are read dependencies, not writes that materialize empty collections.
	if _, err := store.State(ctx, "dm-tools", datacontract.Collection, "never_written"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("guard materialized data: %v", err)
	}
}

func TestDataSetGuardsRejectMalformedAndDuplicateDependencies(t *testing.T) {
	t.Parallel()
	store, _, _ := testStore(t)
	valid := DataSetRevision{Kind: datacontract.Collection, DataID: "notes"}
	for _, guards := range [][]DataSetRevision{
		{valid, valid}, {{Kind: datacontract.Collection, DataID: "notes", Revision: -1}},
		{{Kind: "bad", DataID: "notes"}}, {{Kind: datacontract.Collection, DataID: "../notes"}}, make([]DataSetRevision, 257),
	} {
		_, err := store.Transact(context.Background(), Transaction{AddonID: "dm-tools", GenerationID: testGeneration, ActorID: "dm", ExpectedDataSets: guards,
			Mutations: []Mutation{{Kind: Put, Definition: testDefinition(datacontract.Collection, "notes", datacontract.VisibilityPublic), Key: "a", Value: json.RawMessage(`{"id":"a"}`), Audience: events.AudiencePublic}},
		})
		if !errors.Is(err, ErrInvalidTransaction) {
			t.Fatalf("invalid guards accepted: %v", err)
		}
	}
}
