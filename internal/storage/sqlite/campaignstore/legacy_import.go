package campaignstore

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

const legacyImportActor = "migration:v1-ui-backup"

type LegacyImportResult struct {
	CommitID    int64
	Collections int
	Records     int
	OccurredAt  time.Time
}

// ImportFreshLegacy materializes one decoded v1 dataset into an otherwise
// untouched migrated campaign schema. It is intentionally not an upsert and
// cannot be used against a running or previously populated host.
func ImportFreshLegacy(
	ctx context.Context,
	database *sql.DB,
	dataset campaign.LegacyDataset,
	now time.Time,
) (LegacyImportResult, error) {
	if database == nil || now.IsZero() || len(dataset.Passthrough) != 0 {
		return LegacyImportResult{}, fmt.Errorf("%w: invalid fresh legacy import", campaign.ErrInvalidTransaction)
	}
	if _, err := campaign.EncodeLegacyDataset(dataset); err != nil {
		return LegacyImportResult{}, err
	}
	transaction, err := database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return LegacyImportResult{}, fmt.Errorf("begin fresh legacy import: %w", err)
	}
	defer transaction.Rollback()
	if err := requireFreshCampaignSchema(ctx, transaction); err != nil {
		return LegacyImportResult{}, err
	}

	occurredAt := now.UTC()
	timestamp := occurredAt.Format(time.RFC3339Nano)
	mutationCount := len(dataset.Present) + len(dataset.Records)
	if mutationCount == 0 {
		return LegacyImportResult{}, fmt.Errorf("%w: legacy dataset is empty", campaign.ErrInvalidTransaction)
	}
	result, err := transaction.ExecContext(ctx, `
		INSERT INTO campaign_commits(actor_id, occurred_at, mutation_count)
		VALUES (?, ?, ?)`, legacyImportActor, timestamp, mutationCount)
	if err != nil {
		return LegacyImportResult{}, fmt.Errorf("record legacy import commit: %w", err)
	}
	commitID, err := result.LastInsertId()
	if err != nil {
		return LegacyImportResult{}, fmt.Errorf("read legacy import commit id: %w", err)
	}

	for _, collection := range dataset.Present {
		result, err := transaction.ExecContext(ctx, `
			UPDATE campaign_collections
			SET materialized = 1, revision = 1, updated_at = ?
			WHERE name = ? AND materialized = 0 AND revision = 0`, timestamp, collection)
		if err != nil {
			return LegacyImportResult{}, fmt.Errorf("materialize legacy collection %s: %w", collection, err)
		}
		rows, err := result.RowsAffected()
		if err != nil || rows != 1 {
			return LegacyImportResult{}, fmt.Errorf("%w: collection %s was not fresh", ErrStorageInvariant, collection)
		}
	}

	for ordinal, record := range dataset.Records {
		descriptor, ok := campaign.Describe(record.Collection)
		if !ok {
			return LegacyImportResult{}, campaign.ErrInvalidCollection
		}
		body, visibility, err := campaign.NormalizeRecord(descriptor, record.Key, record.Value)
		if err != nil || record.Position < 0 {
			if err == nil {
				err = campaign.ErrInvalidRecord
			}
			return LegacyImportResult{}, fmt.Errorf("validate legacy record %s:%s: %w", record.Collection, record.Key, err)
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO campaign_records(
				collection_name, record_key, position, body_json, visibility,
				revision, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
			record.Collection, record.Key, record.Position, string(body), visibility,
			timestamp, timestamp,
		); err != nil {
			return LegacyImportResult{}, fmt.Errorf("insert legacy record %s:%s: %w", record.Collection, record.Key, err)
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO campaign_record_versions(
				collection_name, record_key, revision, deleted, updated_at
			) VALUES (?, ?, 1, 0, ?)`, record.Collection, record.Key, timestamp); err != nil {
			return LegacyImportResult{}, fmt.Errorf("version legacy record %s:%s: %w", record.Collection, record.Key, err)
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO campaign_commit_records(
				commit_id, ordinal, collection_name, record_key, action,
				before_revision, after_revision, visibility
			) VALUES (?, ?, ?, ?, 'put', 0, 1, ?)`,
			commitID, ordinal, record.Collection, record.Key, visibility,
		); err != nil {
			return LegacyImportResult{}, fmt.Errorf("audit legacy record %s:%s: %w", record.Collection, record.Key, err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return LegacyImportResult{}, fmt.Errorf("commit fresh legacy import: %w", err)
	}
	return LegacyImportResult{
		CommitID: commitID, Collections: len(dataset.Present),
		Records: len(dataset.Records), OccurredAt: occurredAt,
	}, nil
}

func requireFreshCampaignSchema(ctx context.Context, transaction *sql.Tx) error {
	var records, versions, commits, commitRecords, materialized, revisions int64
	err := transaction.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM campaign_records),
			(SELECT count(*) FROM campaign_record_versions),
			(SELECT count(*) FROM campaign_commits),
			(SELECT count(*) FROM campaign_commit_records),
			(SELECT coalesce(sum(materialized), 0) FROM campaign_collections),
			(SELECT coalesce(sum(revision), 0) FROM campaign_collections)
	`).Scan(&records, &versions, &commits, &commitRecords, &materialized, &revisions)
	if err != nil {
		return fmt.Errorf("inspect fresh campaign schema: %w", err)
	}
	if records != 0 || versions != 0 || commits != 0 || commitRecords != 0 ||
		materialized != 0 || revisions != 0 {
		return fmt.Errorf("%w: campaign schema is already populated", campaign.ErrConflict)
	}
	return nil
}
