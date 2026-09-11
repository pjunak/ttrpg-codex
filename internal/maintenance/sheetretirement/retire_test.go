package sheetretirement

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/migrations"
)

func fixture(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sqlite.Open(context.Background(), filepath.Join(t.TempDir(), "codex.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := sqlite.Migrate(context.Background(), db, migrations.FS); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"dnd-sheets", "dm-tools"} {
		if _, err := db.Exec(`INSERT INTO addon_data_sets(addon_id,data_kind,data_id,materialized,revision,schema_version,schema_sha256,target_collection,keyed) VALUES(?,'record-extension',?,1,4,'3.0.0',?,'characters',1)`, id, id, strings.Repeat("a", 64)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at) VALUES(?,'record-extension',?,'hero',0,'{"note":"keep in backup"}','3.0.0',?,4,'now','now')`, id, id, strings.Repeat("a", 64)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO addon_document_versions VALUES(?,'record-extension',?,'hero',4,0,'now')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func TestRetirementIsReviewedAndRemovesOnlyRetiredNamespace(t *testing.T) {
	db := fixture(t)
	ctx := context.Background()
	report, err := Inspect(ctx, db)
	if err != nil || !reflect.DeepEqual(report.Keys, []string{"hero"}) || report.Tombstones != 1 {
		t.Fatalf("preview: %+v %v", report, err)
	}
	if _, err := Apply(ctx, db, "stale-review"); err == nil {
		t.Fatal("unreviewed reset succeeded")
	}
	if _, err := db.Exec(`UPDATE addon_documents SET body_json='{"changed":true}' WHERE ` + namespace); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, db, report.Review); err == nil {
		t.Fatal("changed sheet reset succeeded")
	}
	report, err = Inspect(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, db, report.Review); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"addon_data_sets", "addon_documents", "addon_document_versions"} {
		var count int
		if err := db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s: count=%d err=%v", table, count, err)
		}
	}
	var body string
	if err := db.QueryRow(`SELECT body_json FROM addon_documents WHERE addon_id='dm-tools'`).Scan(&body); err != nil || body != `{"note":"keep in backup"}` {
		t.Fatal("unrelated extension changed", err)
	}
}

func TestRetirementRefusesCurrentSchemasAndAnyRetainedHistory(t *testing.T) {
	for _, scenario := range []string{"current-schema", "history"} {
		t.Run(scenario, func(t *testing.T) {
			db := fixture(t)
			ctx := context.Background()
			var err error
			if scenario == "current-schema" {
				_, err = db.Exec(`UPDATE addon_data_sets SET schema_version='4.0.0' WHERE ` + namespace)
			} else {
				_, err = db.Exec(`INSERT INTO addon_history_revisions VALUES('dnd-sheets','record-extension','dnd-sheets','deleted-hero',1,'now','generation','dm','now','operation','create','Current history',1,'{}')`)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Inspect(ctx, db); err == nil {
				t.Fatal("protected character state could be retired")
			}
			var count int
			_ = db.QueryRow(`SELECT count(*) FROM addon_documents WHERE ` + namespace).Scan(&count)
			if count != 1 {
				t.Fatal("inspection changed data")
			}
		})
	}
}
