package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"

	moderncsqlite "modernc.org/sqlite"
)

const busyTimeoutMilliseconds = 5000

// Open creates a database handle whose connection-level safety settings are
// applied by the driver whenever database/sql opens a physical connection.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	if path == "" {
		return nil, fmt.Errorf("database path is required")
	}

	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absolutePath), 0o750); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}

	// Opaque produces file:C:/... on Windows. A hierarchical file:///C:/ URI
	// is interpreted by SQLite as having the invalid authority "C:".
	dsn := url.URL{Scheme: "file", Opaque: filepath.ToSlash(absolutePath)}
	query := dsn.Query()
	query.Set("_busy_timeout", strconv.Itoa(busyTimeoutMilliseconds))
	query.Set("_defensive", "true")
	query.Set("_dqs", "false")
	query.Set("_foreign_keys", "true")
	query.Set("_journal_mode", "WAL")
	query.Set("_synchronous", "FULL")
	dsn.RawQuery = query.Encode()

	connector, err := moderncsqlite.NewConnector(dsn.String())
	if err != nil {
		return nil, fmt.Errorf("configure sqlite connector: %w", err)
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite database: %w", err)
	}
	return db, nil
}
