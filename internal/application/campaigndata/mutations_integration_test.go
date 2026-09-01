package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/campaignstore"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestCompoundMutationCommitsThroughSQLiteAsOneRevisionedUnit(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := storage.Migrate(ctx, db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	broker, err := events.New(events.Config{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	repository, err := campaignstore.New(campaignstore.Config{DB: db, Events: broker})
	if err != nil {
		t.Fatal(err)
	}
	_, err = repository.Transact(ctx, campaign.Transaction{
		ActorID: "seed",
		Mutations: []campaign.Mutation{
			{Kind: campaign.Put, Collection: campaign.Characters, Key: "alice", Value: raw(`{"id":"alice","visibility":"public"}`)},
			{Kind: campaign.Put, Collection: campaign.Events, Key: "arrival", Value: raw(`{"id":"arrival","characters":["alice","bob"],"visibility":"public"}`)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := New(repository)
	if err != nil {
		t.Fatal(err)
	}
	commit, err := service.Mutate(ctx, MutationAuthority{ActorID: "session:dm", Role: WriteDM}, []campaign.Mutation{{
		Kind: campaign.Delete, Collection: campaign.Characters, Key: "alice", ExpectedRevision: 1,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(commit.Results) != 1 || commit.Results[0].Collection != campaign.Characters ||
		commit.CollectionRevisions[campaign.Characters] != 2 ||
		commit.CollectionRevisions[campaign.Events] != 2 {
		t.Fatalf("public receipt exposed the wrong plan: %+v", commit)
	}
	if _, err := repository.Get(ctx, campaign.Characters, "alice"); !errors.Is(err, campaign.ErrNotFound) {
		t.Fatalf("character delete = %v", err)
	}
	event, err := repository.Get(ctx, campaign.Events, "arrival")
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(event.Value, &value); err != nil {
		t.Fatal(err)
	}
	characters := value["characters"].([]any)
	if len(characters) != 1 || characters[0] != "bob" || event.Revision != 2 {
		t.Fatalf("derived event update = %+v, %#v", event, value)
	}
	replay, err := broker.Replay(ctx, events.AudiencePublic, 0, 10)
	if err != nil || len(replay.Events) != 4 {
		t.Fatalf("atomic invalidations = %+v, %v", replay, err)
	}
}
