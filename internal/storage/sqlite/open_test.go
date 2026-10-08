package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenAppliesConnectionSafetySettings(t *testing.T) {
	t.Parallel()

	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	assertPragmaText(t, db, "journal_mode", "wal")
	assertPragmaInt(t, db, "foreign_keys", 1)
	assertPragmaInt(t, db, "busy_timeout", busyTimeoutMilliseconds)
	assertPragmaInt(t, db, "synchronous", 2)

	if _, err := db.Exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO child(parent_id) VALUES (42)`); err == nil {
		t.Fatal("foreign-key violation was accepted")
	}
}

// Read-then-write transactions are the normal store pattern. A deferred
// transaction that upgrades after another connection committed fails with
// SQLITE_BUSY without waiting, so writers must take the lock when they begin.
func TestOpenSerializesConcurrentReadThenWriteTransactions(t *testing.T) {
	t.Parallel()

	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`CREATE TABLE counter (value INTEGER NOT NULL); INSERT INTO counter VALUES (0)`); err != nil {
		t.Fatal(err)
	}

	const writers = 8
	const increments = 25
	errs := make(chan error, writers)
	for range writers {
		go func() {
			for range increments {
				if err := incrementCounter(db); err != nil {
					errs <- err
					return
				}
			}
			errs <- nil
		}()
	}
	for range writers {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	var got int
	if err := db.QueryRow(`SELECT value FROM counter`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != writers*increments {
		t.Fatalf("counter = %d, want %d", got, writers*increments)
	}
}

func incrementCounter(db *sql.DB) error {
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var value int
	if err := tx.QueryRow(`SELECT value FROM counter`).Scan(&value); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE counter SET value = ?`, value+1); err != nil {
		return err
	}
	return tx.Commit()
}

func assertPragmaInt(t *testing.T, db *sql.DB, name string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow("PRAGMA " + name).Scan(&got); err != nil {
		t.Fatalf("read PRAGMA %s: %v", name, err)
	}
	if got != want {
		t.Fatalf("PRAGMA %s = %d, want %d", name, got, want)
	}
}

func assertPragmaText(t *testing.T, db *sql.DB, name, want string) {
	t.Helper()
	var got string
	if err := db.QueryRow("PRAGMA " + name).Scan(&got); err != nil {
		t.Fatalf("read PRAGMA %s: %v", name, err)
	}
	if got != want {
		t.Fatalf("PRAGMA %s = %q, want %q", name, got, want)
	}
}
