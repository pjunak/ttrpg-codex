package campaignstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestStorePersistsRevisionedRoleVisibleRecordsAndEvents(t *testing.T) {
	t.Parallel()
	store, broker, _ := testStore(t)
	ctx := context.Background()

	publicCommit, err := store.Transact(ctx, Transaction{
		ActorID: "session-dm",
		Mutations: []Mutation{{
			Kind: Put, Collection: campaign.Characters, Key: "alice",
			Value:            json.RawMessage(`{"id":"alice","name":"Alice","visibility":"public"}`),
			ExpectedRevision: 0,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if publicCommit.ID < 1 || publicCommit.Results[0].AfterRevision != 1 ||
		publicCommit.CollectionRevisions[campaign.Characters] != 1 {
		t.Fatalf("unexpected first commit: %+v", publicCommit)
	}

	privateCommit, err := store.Transact(ctx, Transaction{
		ActorID: "session-dm",
		Mutations: []Mutation{{
			Kind: Put, Collection: campaign.Characters, Key: "secret",
			Value:            json.RawMessage(`{"id":"secret","name":"Secret","visibility":"dm"}`),
			ExpectedRevision: 0,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if privateCommit.CollectionRevisions[campaign.Characters] != 2 {
		t.Fatalf("unexpected private commit: %+v", privateCommit)
	}

	playerRecords, err := store.List(ctx, campaign.Characters, false)
	if err != nil {
		t.Fatal(err)
	}
	dmRecords, err := store.List(ctx, campaign.Characters, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(playerRecords) != 1 || playerRecords[0].Key != "alice" ||
		len(dmRecords) != 2 || dmRecords[1].Key != "secret" {
		t.Fatalf("role projection mismatch: player=%+v dm=%+v", playerRecords, dmRecords)
	}
	if dmRecords[0].Position != 0 || dmRecords[1].Position != 1 {
		t.Fatalf("list positions changed: %+v", dmRecords)
	}

	playerReplay, err := broker.Replay(ctx, events.AudiencePublic, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	dmReplay, err := broker.Replay(ctx, events.AudienceDM, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(playerReplay.Events) != 1 || len(dmReplay.Events) != 2 ||
		dmReplay.Events[1].Audience != events.AudienceDM {
		t.Fatalf("event audiences mismatch: player=%+v dm=%+v", playerReplay, dmReplay)
	}
}

func TestStoreRollsBackCompleteTransactionOnConflict(t *testing.T) {
	t.Parallel()
	store, broker, _ := testStore(t)
	ctx := context.Background()
	seedRecord(t, store, "alice", "public")

	_, err := store.Transact(ctx, Transaction{
		ActorID: "session-player",
		Mutations: []Mutation{
			{
				Kind: Put, Collection: campaign.Characters, Key: "bob",
				Value:            json.RawMessage(`{"id":"bob","name":"Bob"}`),
				ExpectedRevision: 0,
			},
			{
				Kind: Put, Collection: campaign.Characters, Key: "alice",
				Value:            json.RawMessage(`{"id":"alice","name":"Changed"}`),
				ExpectedRevision: 99,
			},
		},
	})
	var conflict *ConflictError
	if !errors.As(err, &conflict) || conflict.Actual != 1 || conflict.Expected != 99 {
		t.Fatalf("conflict = %#v, %v", conflict, err)
	}
	if _, err := store.Get(ctx, campaign.Characters, "bob"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partial create survived: %v", err)
	}
	alice, err := store.Get(ctx, campaign.Characters, "alice")
	if err != nil || alice.Revision != 1 {
		t.Fatalf("existing record changed: %+v, %v", alice, err)
	}
	replay, err := broker.Replay(ctx, events.AudiencePublic, 0, 10)
	if err != nil || len(replay.Events) != 1 {
		t.Fatalf("failed transaction published an event: %+v, %v", replay, err)
	}
}

func TestStorePublishesPublicInvalidationWhenRecordBecomesPrivate(t *testing.T) {
	t.Parallel()
	store, broker, _ := testStore(t)
	ctx := context.Background()
	seedRecord(t, store, "alice", "public")

	_, err := store.Transact(ctx, Transaction{
		ActorID: "session-dm",
		Mutations: []Mutation{{
			Kind: Put, Collection: campaign.Characters, Key: "alice",
			Value:            json.RawMessage(`{"id":"alice","name":"Alice","visibility":"dm"}`),
			ExpectedRevision: 1,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	visible, err := store.List(ctx, campaign.Characters, false)
	if err != nil || len(visible) != 0 {
		t.Fatalf("private record remained player-visible: %+v, %v", visible, err)
	}
	replay, err := broker.Replay(ctx, events.AudiencePublic, 0, 10)
	if err != nil || len(replay.Events) != 2 {
		t.Fatalf("player was not told to remove hidden record: %+v, %v", replay, err)
	}
}

func TestStoreDoesNotLeakPrivateMutationCountThroughPublicEvent(t *testing.T) {
	t.Parallel()
	store, broker, _ := testStore(t)
	ctx := context.Background()
	_, err := store.Transact(ctx, Transaction{
		ActorID: "session-dm",
		Mutations: []Mutation{
			{
				Kind: Put, Collection: campaign.Characters, Key: "alice",
				Value: json.RawMessage(`{"id":"alice","visibility":"public"}`),
			},
			{
				Kind: Put, Collection: campaign.Characters, Key: "secret",
				Value: json.RawMessage(`{"id":"secret","visibility":"dm"}`),
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	replay, err := broker.Replay(ctx, events.AudiencePublic, 0, 10)
	if err != nil || len(replay.Events) != 1 {
		t.Fatalf("public replay = %+v, %v", replay, err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(replay.Events[0].Metadata, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["records"] != float64(1) {
		t.Fatalf("public metadata leaked private count: %#v", metadata)
	}
}

func TestStorePreservesListOrderAndAuditsDeletes(t *testing.T) {
	t.Parallel()
	store, _, db := testStore(t)
	ctx := context.Background()
	seedRecord(t, store, "alice", "public")
	seedRecord(t, store, "bob", "public")

	commit, err := store.Transact(ctx, Transaction{
		ActorID: "session-dm",
		Mutations: []Mutation{{
			Kind: Delete, Collection: campaign.Characters, Key: "alice",
			ExpectedRevision: 1,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !commit.Results[0].Deleted || commit.Results[0].AfterRevision != 2 {
		t.Fatalf("unexpected delete result: %+v", commit)
	}
	seedRecord(t, store, "cara", "public")
	records, err := store.List(ctx, campaign.Characters, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || records[0].Key != "bob" || records[0].Position != 1 ||
		records[1].Key != "cara" || records[1].Position != 2 {
		t.Fatalf("unexpected post-delete order: %+v", records)
	}
	var action, visibility string
	var before, after int64
	if err := db.QueryRowContext(ctx, `
		SELECT action, before_revision, after_revision, visibility
		FROM campaign_commit_records
		WHERE commit_id = ? AND ordinal = 0`,
		commit.ID,
	).Scan(&action, &before, &after, &visibility); err != nil {
		t.Fatal(err)
	}
	if action != "delete" || before != 1 || after != 2 || visibility != "public" {
		t.Fatalf("unexpected audit row: %s %d %d %s", action, before, after, visibility)
	}
}

func TestStoreRetainsTombstoneRevisionAcrossDeleteAndRecreate(t *testing.T) {
	t.Parallel()
	store, _, _ := testStore(t)
	ctx := context.Background()
	seedRecord(t, store, "alice", "public")
	deleted, err := store.Transact(ctx, Transaction{
		ActorID: "session-dm",
		Mutations: []Mutation{{
			Kind: Delete, Collection: campaign.Characters, Key: "alice",
			ExpectedRevision: 1,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.State(ctx, campaign.Characters, "alice")
	if err != nil || state.Exists || state.Revision != 2 {
		t.Fatalf("tombstone state = %+v, %v", state, err)
	}
	value := json.RawMessage(`{"id":"alice","name":"Restored"}`)
	_, err = store.Transact(ctx, Transaction{
		ActorID: "stale-session",
		Mutations: []Mutation{{
			Kind: Put, Collection: campaign.Characters, Key: "alice",
			Value: value, ExpectedRevision: 1,
		}},
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("stale pre-delete write error = %v", err)
	}
	restored, err := store.Transact(ctx, Transaction{
		ActorID: "session-dm",
		Mutations: []Mutation{{
			Kind: Put, Collection: campaign.Characters, Key: "alice",
			Value: value, ExpectedRevision: deleted.Results[0].AfterRevision,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Results[0].AfterRevision != 3 {
		t.Fatalf("restored revision = %+v", restored.Results[0])
	}
}

func TestSnapshotRetainsMaterializedEmptyDistinction(t *testing.T) {
	t.Parallel()
	store, _, _ := testStore(t)
	ctx := context.Background()
	initial, err := store.Snapshot(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(initial.Records) != 0 || materializedCount(initial.States) != 0 {
		t.Fatalf("fresh database synthesized collections: %+v", initial)
	}
	seedRecord(t, store, "alice", "public")
	snapshot, err := store.Snapshot(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Records) != 1 || materializedCount(snapshot.States) != 1 {
		t.Fatalf("materialized state mismatch: %+v", snapshot)
	}
	if _, err := store.Transact(ctx, Transaction{
		ActorID: "seed",
		Mutations: []Mutation{{
			Kind: Delete, Collection: campaign.Characters, Key: "alice",
			ExpectedRevision: 1,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	empty, err := store.Snapshot(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := campaign.EncodeLegacyDataset(empty.LegacyDataset(nil))
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &root); err != nil {
		t.Fatal(err)
	}
	if string(root["characters"]) != "[]" {
		t.Fatalf("materialized empty characters = %s", root["characters"])
	}
	if _, exists := root["relationships"]; exists {
		t.Fatal("absent relationships collection was synthesized")
	}
}

func TestStoreRejectsDuplicateTargetsBeforeOpeningAWrite(t *testing.T) {
	t.Parallel()
	store, _, db := testStore(t)
	value := json.RawMessage(`{"id":"alice","name":"Alice"}`)
	_, err := store.Transact(context.Background(), Transaction{
		ActorID: "session-dm",
		Mutations: []Mutation{
			{Kind: Put, Collection: campaign.Characters, Key: "alice", Value: value},
			{Kind: Put, Collection: campaign.Characters, Key: "alice", Value: value},
		},
	})
	if !errors.Is(err, ErrInvalidTransaction) {
		t.Fatalf("error = %v", err)
	}
	var commits int
	if err := db.QueryRow(`SELECT count(*) FROM campaign_commits`).Scan(&commits); err != nil {
		t.Fatal(err)
	}
	if commits != 0 {
		t.Fatalf("invalid request wrote %d commits", commits)
	}
}

func testStore(t *testing.T) (*Store, *events.Broker, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := storage.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	now := func() time.Time { return time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC) }
	broker, err := events.New(events.Config{DB: db, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	store, err := New(Config{DB: db, Events: broker, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	return store, broker, db
}

func seedRecord(t *testing.T, store *Store, id, visibility string) {
	t.Helper()
	value := map[string]any{"id": id, "name": id}
	if visibility != "" {
		value["visibility"] = visibility
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Transact(context.Background(), Transaction{
		ActorID: "seed",
		Mutations: []Mutation{{
			Kind: Put, Collection: campaign.Characters, Key: id,
			Value: body, ExpectedRevision: 0,
		}},
	}); err != nil {
		t.Fatal(err)
	}
}

func materializedCount(states []CollectionState) int {
	count := 0
	for _, state := range states {
		if state.Materialized {
			count++
		}
	}
	return count
}
