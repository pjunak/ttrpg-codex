package githubsource

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
)

type store struct {
	db             *sql.DB
	credentialPath string
}

// Credentials have a separate SQLite database outside the campaign backup's
// allowlist. Open it only for an operation, so no extra runtime handle survives.
func (s *store) credentials(ctx context.Context) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(s.credentialPath), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(s.credentialPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	db, err := sqlite.Open(ctx, s.credentialPath)
	if err != nil {
		return nil, err
	}
	if _, err = db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS github_tokens (repo TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL)`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func (s *store) tokens(ctx context.Context) (map[string]string, error) {
	db, err := s.credentials(ctx)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, `SELECT repo, token FROM github_tokens ORDER BY repo`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]string{}
	for rows.Next() {
		var repo, token string
		if err := rows.Scan(&repo, &token); err != nil {
			return nil, err
		}
		result[repo] = token
	}
	return result, rows.Err()
}

func (s *store) saveToken(ctx context.Context, repo, token string) error {
	db, err := s.credentials(ctx)
	if err != nil {
		return err
	}
	defer db.Close()
	if token == "" {
		_, err = db.ExecContext(ctx, `DELETE FROM github_tokens WHERE repo = ?`, repo)
	} else {
		_, err = db.ExecContext(ctx, `INSERT INTO github_tokens(repo, token) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET token = excluded.token`, repo, token)
	}
	return err
}

func (s *store) sources(ctx context.Context) ([]LinkedSource, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT addon_id, source_json, revision FROM addon_github_sources WHERE deleted = 0 ORDER BY addon_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LinkedSource{}
	for rows.Next() {
		var item LinkedSource
		var body string
		if err := rows.Scan(&item.AddonID, &body, &item.Revision); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(body), &item.Source); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *store) source(ctx context.Context, addonID string) (LinkedSource, error) {
	item := LinkedSource{AddonID: addonID}
	var body string
	err := s.db.QueryRowContext(ctx, `SELECT source_json, revision FROM addon_github_sources WHERE addon_id = ? AND deleted = 0`, addonID).Scan(&body, &item.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return item, ErrSourceMissing
	}
	if err != nil {
		return item, err
	}
	err = json.Unmarshal([]byte(body), &item.Source)
	return item, err
}

func (s *store) saveSource(ctx context.Context, item LinkedSource) error {
	body, _ := json.Marshal(item.Source)
	var result sql.Result
	var err error
	if item.Revision == 0 {
		result, err = s.db.ExecContext(ctx, `INSERT INTO addon_github_sources(addon_id, source_json, revision) VALUES (?, ?, 1) ON CONFLICT(addon_id) DO UPDATE SET source_json = excluded.source_json, deleted = 0, revision = revision + 1 WHERE deleted = 1`, item.AddonID, string(body))
	} else {
		result, err = s.db.ExecContext(ctx, `UPDATE addon_github_sources SET source_json = ?, revision = revision + 1 WHERE addon_id = ? AND revision = ? AND deleted = 0`, string(body), item.AddonID, item.Revision)
	}
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	return nil
}

func (s *store) installed(ctx context.Context, addonID string) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM addon_package_states WHERE addon_id = ?`, addonID).Scan(&count)
	return count == 1, err
}

func (s *store) removeSource(ctx context.Context, addonID string, revision int64) error {
	result, err := s.db.ExecContext(ctx, `UPDATE addon_github_sources SET deleted = 1, source_json = '{}', revision = revision + 1 WHERE addon_id = ? AND revision = ? AND deleted = 0`, addonID, revision)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	return nil
}

func (s *store) record(ctx context.Context, addonID, generationID string, source Source, remoteID string) error {
	body, _ := json.Marshal(source)
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO addon_github_generations(addon_id, generation_id, source_json, remote_id) VALUES (?, ?, ?, ?)`, addonID, generationID, string(body), remoteID)
	return err
}

func (s *store) isActive(ctx context.Context, addonID string, source Source, remoteID string) (bool, error) {
	body, _ := json.Marshal(source)
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM addon_github_generations g JOIN addon_package_states s ON s.addon_id = g.addon_id AND s.active_generation_id = g.generation_id WHERE g.addon_id = ? AND g.source_json = ? AND g.remote_id = ?`, addonID, string(body), remoteID).Scan(&count)
	return count > 0, err
}
