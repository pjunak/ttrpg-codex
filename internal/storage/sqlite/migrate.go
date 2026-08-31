package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"time"
)

var migrationNamePattern = regexp.MustCompile(`^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$`)

var (
	ErrMigrationDrift   = errors.New("migration checksum drift")
	ErrUnknownMigration = errors.New("database contains an unknown migration")
)

type MigrationResult struct {
	CurrentVersion int
	Applied        int
}

type migration struct {
	version  int
	name     string
	filename string
	checksum string
	sql      string
}

type appliedMigration struct {
	name     string
	checksum string
}

// Migrate validates the complete embedded migration history before applying
// every pending migration in its own transaction.
func Migrate(ctx context.Context, db *sql.DB, migrationFS fs.FS) (MigrationResult, error) {
	if db == nil {
		return MigrationResult{}, fmt.Errorf("database is required")
	}
	migrations, err := loadMigrations(migrationFS)
	if err != nil {
		return MigrationResult{}, err
	}
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
			applied_at TEXT NOT NULL
		)`); err != nil {
		return MigrationResult{}, fmt.Errorf("ensure schema_migrations: %w", err)
	}

	applied, err := readAppliedMigrations(ctx, db)
	if err != nil {
		return MigrationResult{}, err
	}
	known := make(map[int]migration, len(migrations))
	for _, item := range migrations {
		known[item.version] = item
	}
	for version, item := range applied {
		expected, ok := known[version]
		if !ok {
			return MigrationResult{}, fmt.Errorf("%w: version %04d (%s)", ErrUnknownMigration, version, item.name)
		}
		if expected.name != item.name || expected.checksum != item.checksum {
			return MigrationResult{}, fmt.Errorf("%w: version %04d", ErrMigrationDrift, version)
		}
	}

	result := MigrationResult{}
	for _, item := range migrations {
		result.CurrentVersion = item.version
		if _, ok := applied[item.version]; ok {
			continue
		}
		if err := applyMigration(ctx, db, item); err != nil {
			return MigrationResult{}, err
		}
		result.Applied++
	}
	return result, nil
}

func loadMigrations(migrationFS fs.FS) ([]migration, error) {
	if migrationFS == nil {
		return nil, fmt.Errorf("migration filesystem is required")
	}
	entries, err := fs.ReadDir(migrationFS, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}

	items := make([]migration, 0, len(entries))
	versions := make(map[int]string, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		match := migrationNamePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			return nil, fmt.Errorf("invalid migration filename %q", entry.Name())
		}
		version, err := strconv.Atoi(match[1])
		if err != nil || version < 1 {
			return nil, fmt.Errorf("invalid migration version in %q", entry.Name())
		}
		if previous, exists := versions[version]; exists {
			return nil, fmt.Errorf("duplicate migration version %04d: %s and %s", version, previous, entry.Name())
		}
		body, err := fs.ReadFile(migrationFS, path.Clean(entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", entry.Name(), err)
		}
		if len(body) == 0 {
			return nil, fmt.Errorf("migration %q is empty", entry.Name())
		}
		digest := sha256.Sum256(body)
		items = append(items, migration{
			version:  version,
			name:     match[2],
			filename: entry.Name(),
			checksum: hex.EncodeToString(digest[:]),
			sql:      string(body),
		})
		versions[version] = entry.Name()
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("no migrations found")
	}
	sort.Slice(items, func(i, j int) bool { return items[i].version < items[j].version })
	return items, nil
}

func readAppliedMigrations(ctx context.Context, db *sql.DB) (map[int]appliedMigration, error) {
	rows, err := db.QueryContext(ctx, `SELECT version, name, sha256 FROM schema_migrations ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("read applied migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[int]appliedMigration)
	for rows.Next() {
		var version int
		var item appliedMigration
		if err := rows.Scan(&version, &item.name, &item.checksum); err != nil {
			return nil, fmt.Errorf("scan applied migration: %w", err)
		}
		applied[version] = item
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate applied migrations: %w", err)
	}
	return applied, nil
}

func applyMigration(ctx context.Context, db *sql.DB, item migration) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %04d_%s: %w", item.version, item.name, err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, item.sql); err != nil {
		return fmt.Errorf("apply migration %s: %w", item.filename, err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO schema_migrations(version, name, sha256, applied_at)
		VALUES (?, ?, ?, ?)`,
		item.version,
		item.name,
		item.checksum,
		time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		return fmt.Errorf("record migration %s: %w", item.filename, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", item.filename, err)
	}
	return nil
}
