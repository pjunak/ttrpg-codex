// Package sheetretirement owns the one-time, offline removal of the retired
// character extension. It is deliberately absent from host startup and HTTP.
package sheetretirement

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
)

const namespace = `addon_id = 'dnd-sheets' AND data_kind = 'record-extension' AND data_id = 'dnd-sheets'`

type Report struct {
	SchemaVersion string   `json:"schemaVersion"`
	SchemaHash    string   `json:"schemaHash"`
	DataRevision  int64    `json:"dataRevision"`
	Keys          []string `json:"removedSheetKeys"`
	Tombstones    int      `json:"removedRevisionMarkers"`
	Review        string   `json:"reviewSHA256"`
}

// Inspect refuses ambiguous ownership, an active writer, or ANY retained
// revision, including history whose current head has already been deleted.
func Inspect(ctx context.Context, db *sql.DB) (Report, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Report{}, err
	}
	defer tx.Rollback()
	return inspect(ctx, tx)
}

func inspect(ctx context.Context, tx *sql.Tx) (Report, error) {
	var report Report
	var active, history int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM addon_package_states WHERE addon_id='dnd-sheets' AND active_generation_id IS NOT NULL`).Scan(&active); err != nil {
		return report, err
	}
	if active != 0 {
		return report, errors.New("disable the character sheets add-on before retirement")
	}
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM addon_history_revisions WHERE `+namespace).Scan(&history); err != nil {
		return report, err
	}
	if history != 0 {
		return report, errors.New("retained character history exists; retirement is forbidden")
	}
	var target string
	if err := tx.QueryRowContext(ctx, `SELECT schema_version, schema_sha256, revision, target_collection FROM addon_data_sets WHERE `+namespace).Scan(&report.SchemaVersion, &report.SchemaHash, &report.DataRevision, &target); err != nil {
		return report, err
	}
	if report.SchemaVersion != "3.0.0" || target != "characters" {
		return report, errors.New("only the retired dnd-sheets 3.0.0 character extension can be removed")
	}
	rows, err := tx.QueryContext(ctx, `SELECT document_key, schema_version, body_json, revision FROM addon_documents WHERE `+namespace+` ORDER BY document_key`)
	if err != nil {
		return report, err
	}
	defer rows.Close()
	report.Keys = []string{}
	hash := sha256.New()
	for rows.Next() {
		var key, schema, body string
		var revision int64
		if err := rows.Scan(&key, &schema, &body, &revision); err != nil {
			return report, err
		}
		if schema != "3.0.0" {
			return report, errors.New("a sheet document has a different schema; retirement is forbidden")
		}
		report.Keys = append(report.Keys, key)
		if err := json.NewEncoder(hash).Encode([]any{key, schema, body, revision}); err != nil {
			return report, err
		}
	}
	if err := rows.Err(); err != nil {
		return report, err
	}
	if err := rows.Close(); err != nil {
		return report, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM addon_document_versions WHERE `+namespace).Scan(&report.Tombstones); err != nil {
		return report, err
	}
	if err := json.NewEncoder(hash).Encode(report); err != nil {
		return report, err
	}
	report.Review = hex.EncodeToString(hash.Sum(nil))
	return report, nil
}

// Apply runs only after the CLI has created a fresh complete backup while
// holding the exclusive data-directory lock. The review is checked again in
// the same transaction as deletion; no history/payload tables are writable here.
func Apply(ctx context.Context, db *sql.DB, reviewed string) (Report, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Report{}, err
	}
	defer tx.Rollback()
	report, err := inspect(ctx, tx)
	if err != nil {
		return report, err
	}
	if reviewed == "" || reviewed != report.Review {
		return report, errors.New("retirement preview changed; inspect and review again")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM addon_data_sets WHERE `+namespace); err != nil {
		return report, err
	}
	return report, tx.Commit()
}
