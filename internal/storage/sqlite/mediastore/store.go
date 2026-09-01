package mediastore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	ErrInvalidConfig = errors.New("invalid media store configuration")
	ErrNotFound      = errors.New("media asset not found")
)

type Asset struct {
	Sequence  int64
	BlobID    string
	Kind      string
	TargetKey string
	CreatedAt time.Time
}

type Store struct {
	database *sql.DB
}

func New(database *sql.DB) (*Store, error) {
	if database == nil {
		return nil, fmt.Errorf("%w: database is required", ErrInvalidConfig)
	}
	if _, err := database.Exec(`SELECT sequence FROM core_media_assets LIMIT 0`); err != nil {
		return nil, fmt.Errorf("%w: media schema is unavailable: %v", ErrInvalidConfig, err)
	}
	return &Store{database: database}, nil
}

func (store *Store) Bind(ctx context.Context, asset Asset) (Asset, error) {
	if asset.BlobID == "" || asset.Kind == "" || asset.TargetKey == "" || asset.CreatedAt.IsZero() {
		return Asset{}, ErrInvalidConfig
	}
	result, err := store.database.ExecContext(ctx, `
		INSERT INTO core_media_assets(blob_id, kind, target_key, created_at)
		VALUES (?, ?, ?, ?)`,
		asset.BlobID, asset.Kind, asset.TargetKey,
		asset.CreatedAt.UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return Asset{}, fmt.Errorf("bind core media asset: %w", err)
	}
	asset.Sequence, err = result.LastInsertId()
	if err != nil {
		return Asset{}, fmt.Errorf("read core media sequence: %w", err)
	}
	asset.CreatedAt = asset.CreatedAt.UTC()
	return asset, nil
}

func (store *Store) Get(ctx context.Context, blobID string) (Asset, error) {
	return scanAsset(store.database.QueryRowContext(ctx, `
		SELECT sequence, blob_id, kind, target_key, created_at
		FROM core_media_assets WHERE blob_id = ?`, blobID))
}

func (store *Store) Latest(ctx context.Context, kind, targetKey string) (Asset, error) {
	return scanAsset(store.database.QueryRowContext(ctx, `
		SELECT asset.sequence, asset.blob_id, asset.kind, asset.target_key, asset.created_at
		FROM core_media_assets AS asset
		JOIN blobs AS blob ON blob.blob_id = asset.blob_id
		WHERE asset.kind = ? AND asset.target_key = ? AND blob.deleted = 0
		ORDER BY asset.sequence DESC
		LIMIT 1`, kind, targetKey))
}

type rowScanner interface {
	Scan(...any) error
}

func scanAsset(row rowScanner) (Asset, error) {
	var asset Asset
	var createdAt string
	if err := row.Scan(
		&asset.Sequence, &asset.BlobID, &asset.Kind, &asset.TargetKey, &createdAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Asset{}, ErrNotFound
		}
		return Asset{}, fmt.Errorf("read core media asset: %w", err)
	}
	var err error
	asset.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Asset{}, fmt.Errorf("parse core media creation time: %w", err)
	}
	return asset, nil
}
