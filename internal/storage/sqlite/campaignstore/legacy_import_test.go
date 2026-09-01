package campaignstore

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	storage "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func TestImportFreshLegacyMaterializesExactDatasetOnce(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := storage.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	dataset, err := campaign.DecodeLegacyDataset([]byte(`{
		"characters":[
			{"id":"alice","name":"Alice","visibility":"public"},
			{"id":"secret","name":"Secret","visibility":"dm"}
		],
		"relationships":[],
		"campaign":{"main":{"name":"Aethelara"}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)
	result, err := ImportFreshLegacy(ctx, database, dataset, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.CommitID != 1 || result.Collections != 3 || result.Records != 3 || !result.OccurredAt.Equal(now) {
		t.Fatalf("import result = %+v", result)
	}
	var records, hidden, materializedEmpty, audited int
	if err := database.QueryRow(`SELECT count(*), sum(visibility = 'dm') FROM campaign_records`).Scan(&records, &hidden); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT materialized FROM campaign_collections WHERE name = 'relationships'`).Scan(&materializedEmpty); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM campaign_commit_records WHERE commit_id = 1`).Scan(&audited); err != nil {
		t.Fatal(err)
	}
	if records != 3 || hidden != 1 || materializedEmpty != 1 || audited != 3 {
		t.Fatalf("records=%d hidden=%d empty=%d audited=%d", records, hidden, materializedEmpty, audited)
	}
	if _, err := ImportFreshLegacy(ctx, database, dataset, now.Add(time.Second)); !errors.Is(err, campaign.ErrConflict) {
		t.Fatalf("second import error = %v", err)
	}
}

func TestImportFreshLegacyRejectsUnownedPassthrough(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := storage.Migrate(ctx, database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	dataset, err := campaign.DecodeLegacyDataset([]byte(`{"characters":[],"addon:notes":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ImportFreshLegacy(ctx, database, dataset, time.Now()); !errors.Is(err, campaign.ErrInvalidTransaction) {
		t.Fatalf("passthrough import error = %v", err)
	}
}
