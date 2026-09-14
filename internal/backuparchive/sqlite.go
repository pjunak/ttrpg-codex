package backuparchive

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/pjunak/ttrpg-codex/internal/storage/blobstore"
	codexsqlite "github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	moderncsqlite "modernc.org/sqlite"
)

type onlineBackuper interface {
	NewBackup(string) (*moderncsqlite.Backup, error)
}

func createDatabaseImage(ctx context.Context, database *sql.DB, destination string) error {
	if database == nil {
		return fmt.Errorf("database is required")
	}
	if err := os.Remove(destination); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("prepare database image: %w", err)
	}
	connection, err := database.Conn(ctx)
	if err != nil {
		return fmt.Errorf("reserve database backup connection: %w", err)
	}
	defer connection.Close()
	err = connection.Raw(func(driverConnection any) error {
		backuper, ok := driverConnection.(onlineBackuper)
		if !ok {
			return fmt.Errorf("sqlite driver does not expose online backup")
		}
		backup, err := backuper.NewBackup(destination)
		if err != nil {
			return err
		}
		finished := false
		defer func() {
			if !finished {
				_ = backup.Finish()
			}
		}()
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			more, err := backup.Step(256)
			if err != nil {
				return err
			}
			if !more {
				break
			}
		}
		if err := backup.Finish(); err != nil {
			return err
		}
		finished = true
		return nil
	})
	if err != nil {
		_ = os.Remove(destination)
		return fmt.Errorf("create online database image: %w", err)
	}
	return nil
}

func validateAndMigrateDatabase(
	ctx context.Context,
	databasePath string,
	migrationFS fs.FS,
) (int, error) {
	database, err := codexsqlite.Open(ctx, databasePath)
	if err != nil {
		return 0, fmt.Errorf("open restored database: %w", err)
	}
	result, migrationErr := codexsqlite.Migrate(ctx, database, migrationFS)
	if migrationErr == nil {
		migrationErr = integrityCheck(ctx, database)
	}
	if migrationErr == nil {
		var blobs *blobstore.Store
		blobs, migrationErr = blobstore.New(
			database,
			filepath.Join(filepath.Dir(databasePath), "blobs"),
			blobstore.Options{},
		)
		if migrationErr == nil {
			migrationErr = blobs.Validate(ctx)
		}
		if migrationErr != nil {
			migrationErr = fmt.Errorf("%w: validate restored blobs: %v", ErrInvalidArchive, migrationErr)
		}
	}
	if migrationErr == nil {
		migrationErr = validatePackageReferences(ctx, database, filepath.Join(filepath.Dir(databasePath), "addons"), nil)
	}
	if migrationErr == nil {
		migrationErr = normalizeRestoredPackageFiles(ctx, database)
	}
	if migrationErr == nil {
		_, migrationErr = database.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	}
	closeErr := database.Close()
	if migrationErr != nil {
		return 0, migrationErr
	}
	if closeErr != nil {
		return 0, fmt.Errorf("close restored database: %w", closeErr)
	}
	return result.Applied, nil
}

func integrityCheck(ctx context.Context, database *sql.DB) error {
	rows, err := database.QueryContext(ctx, `PRAGMA quick_check`)
	if err != nil {
		return fmt.Errorf("run database quick check: %w", err)
	}
	checked := false
	for rows.Next() {
		var message string
		if err := rows.Scan(&message); err != nil {
			rows.Close()
			return fmt.Errorf("read database quick check: %w", err)
		}
		checked = true
		if message != "ok" {
			rows.Close()
			return fmt.Errorf("%w: sqlite quick check: %s", ErrInvalidArchive, message)
		}
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close database quick check: %w", err)
	}
	if !checked {
		return fmt.Errorf("%w: sqlite quick check returned no result", ErrInvalidArchive)
	}

	foreignKeys, err := database.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return fmt.Errorf("run database foreign key check: %w", err)
	}
	violated := foreignKeys.Next()
	iterationErr := foreignKeys.Err()
	closeErr := foreignKeys.Close()
	if iterationErr != nil {
		return fmt.Errorf("read database foreign key check: %w", iterationErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close database foreign key check: %w", closeErr)
	}
	if violated {
		return fmt.Errorf("%w: restored database violates foreign keys", ErrInvalidArchive)
	}
	return nil
}
