package credentialstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/pjunak/ttrpg-codex/internal/auth"
)

type Store struct{ DB *sql.DB }

func (store Store) Load(ctx context.Context) (auth.Credentials, bool, error) {
	var value []byte
	var credentials auth.Credentials
	err := store.DB.QueryRowContext(ctx, "SELECT value_json FROM host_credentials WHERE singleton = 1").Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return credentials, false, nil
	}
	if err != nil {
		return credentials, false, err
	}
	err = json.Unmarshal(value, &credentials)
	return credentials, err == nil, err
}

func (store Store) Save(ctx context.Context, credentials auth.Credentials, expected int64) error {
	value, err := json.Marshal(credentials)
	if err != nil {
		return err
	}
	var result sql.Result
	if expected == 0 {
		result, err = store.DB.ExecContext(ctx, "INSERT INTO host_credentials (singleton, revision, value_json) VALUES (1, ?, ?) ON CONFLICT(singleton) DO NOTHING", credentials.Revision, string(value))
	} else {
		result, err = store.DB.ExecContext(ctx, "UPDATE host_credentials SET revision = ?, value_json = ? WHERE singleton = 1 AND revision = ?", credentials.Revision, string(value), expected)
	}
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return auth.ErrCredentialConflict
	}
	return nil
}
