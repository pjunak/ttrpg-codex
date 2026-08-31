package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestMigrateAppliesHistoryOnce(t *testing.T) {
	t.Parallel()

	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	history := fstest.MapFS{
		"0001_first.sql":  {Data: []byte(`CREATE TABLE first (id INTEGER PRIMARY KEY);`)},
		"0002_second.sql": {Data: []byte(`CREATE TABLE second (id INTEGER PRIMARY KEY);`)},
	}
	result, err := Migrate(context.Background(), db, history)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != 2 || result.CurrentVersion != 2 {
		t.Fatalf("unexpected first result: %+v", result)
	}

	result, err = Migrate(context.Background(), db, history)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != 0 || result.CurrentVersion != 2 {
		t.Fatalf("unexpected second result: %+v", result)
	}
}

func TestMigrateRejectsChecksumDrift(t *testing.T) {
	t.Parallel()

	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	history := fstest.MapFS{
		"0001_first.sql": {Data: []byte(`CREATE TABLE first (id INTEGER PRIMARY KEY);`)},
	}
	if _, err := Migrate(context.Background(), db, history); err != nil {
		t.Fatal(err)
	}
	history["0001_first.sql"] = &fstest.MapFile{Data: []byte(`CREATE TABLE changed (id INTEGER PRIMARY KEY);`)}
	if _, err := Migrate(context.Background(), db, history); !errors.Is(err, ErrMigrationDrift) {
		t.Fatalf("got %v, want ErrMigrationDrift", err)
	}
}

func TestMigrateRollsBackFailedFile(t *testing.T) {
	t.Parallel()

	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	history := fstest.MapFS{
		"0001_broken.sql": {Data: []byte(`
			CREATE TABLE must_not_survive (id INTEGER PRIMARY KEY);
			THIS IS NOT SQL;
		`)},
	}
	if _, err := Migrate(context.Background(), db, history); err == nil {
		t.Fatal("broken migration succeeded")
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='must_not_survive'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("partial migration table survived rollback")
	}
}
