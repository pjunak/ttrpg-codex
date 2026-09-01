package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

func TestDatasetUsesStableDomainOrderAndRetainsMaterializationState(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{snapshot: campaign.Snapshot{
		States: []campaign.CollectionState{
			{Collection: campaign.Characters, Shape: campaign.List, Materialized: true, Revision: 4},
			{Collection: campaign.Settings, Shape: campaign.Keyed, Materialized: false},
		},
		Records: []campaign.Record{{
			Collection: campaign.Characters, Key: "alice", Position: 0,
			Value:      raw(`{"id":"alice","name":"Alice"}`),
			Visibility: campaign.VisibilityPublic, Revision: 3,
		}},
	}}
	service, err := New(repository)
	if err != nil {
		t.Fatal(err)
	}
	dataset, err := service.Dataset(context.Background(), ViewDM)
	if err != nil {
		t.Fatal(err)
	}
	if dataset.ContractVersion != ContractVersion ||
		len(dataset.Collections) != len(campaign.Descriptors()) {
		t.Fatalf("unexpected dataset envelope: %+v", dataset)
	}
	characters := dataset.Collections[0]
	if characters.Name != campaign.Characters || !characters.Materialized ||
		characters.Revision != 4 || len(characters.Records) != 1 ||
		characters.Records[0].Revision != 3 {
		t.Fatalf("unexpected character collection: %+v", characters)
	}
	settings := collectionView(t, dataset, campaign.Settings)
	if settings.Materialized || settings.Shape != campaign.Keyed || settings.Records == nil {
		t.Fatalf("unexpected absent settings: %+v", settings)
	}
}

func TestDatasetRejectsInvalidRoleAndWrapsRepositoryFailure(t *testing.T) {
	t.Parallel()
	service, err := New(&fakeRepository{err: errors.New("database unavailable")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Dataset(context.Background(), "unknown"); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("invalid role error = %v", err)
	}
	if _, err := service.Dataset(context.Background(), ViewDM); err == nil ||
		err.Error() != "read campaign snapshot: database unavailable" {
		t.Fatalf("repository error = %v", err)
	}
}

type fakeRepository struct {
	snapshot campaign.Snapshot
	err      error
	commit   campaign.Commit
	writes   []campaign.Transaction
}

func (repository *fakeRepository) Snapshot(
	context.Context,
	bool,
) (campaign.Snapshot, error) {
	return repository.snapshot, repository.err
}

func (repository *fakeRepository) Transact(
	_ context.Context,
	transaction campaign.Transaction,
) (campaign.Commit, error) {
	repository.writes = append(repository.writes, transaction)
	return repository.commit, repository.err
}

func raw(value string) json.RawMessage { return json.RawMessage(value) }

func collectionView(
	t *testing.T,
	dataset Dataset,
	name campaign.Collection,
) CollectionView {
	t.Helper()
	for _, collection := range dataset.Collections {
		if collection.Name == name {
			return collection
		}
	}
	t.Fatalf("collection %s was not projected", name)
	return CollectionView{}
}
