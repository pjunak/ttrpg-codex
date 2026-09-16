// Package cleanup implements explicitly reviewed offline maintenance. Callers
// must hold the exclusive data-directory lock and verify a fresh full backup
// before Apply. It is deliberately absent from host startup and HTTP routes.
package cleanup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"regexp"
)

var ErrStale = errors.New("maintenance preview changed; inspect and review again")
var addonPattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)

type Options struct {
	Kind      string `json:"kind"`
	AddonID   string `json:"addonId,omitempty"`
	Events    int    `json:"keepEventsPerAudience,omitempty"`
	Lifecycle int    `json:"keepLifecycle,omitempty"`
	Audit     int    `json:"keepCommitsPerAudit,omitempty"`
}

type Table struct {
	Name         string `json:"name"`
	Rows         int64  `json:"rows"`
	EncodedBytes int64  `json:"encodedRowBytes"`
	Remove       int64  `json:"remove"`
}

type Report struct {
	Options            Options `json:"options"`
	Tables             []Table `json:"tables"`
	RecoveryPoints     int64   `json:"affectedRecoveryPoints"`
	ArchiveGenerations int64   `json:"preservedPackageGenerations"`
	Review             string  `json:"reviewSHA256"`
}

type target struct {
	name, where string
	args        []any
}

func targets(options Options) ([]target, error) {
	switch options.Kind {
	case "delete-addon-data":
		if !addonPattern.MatchString(options.AddonID) || len(options.AddonID) > 100 {
			return nil, errors.New("a valid add-on ID is required")
		}
		result := []target{}
		for _, name := range []string{"addon_data_sets", "addon_documents", "addon_document_versions", "addon_history_revisions", "addon_data_requests", "addon_data_commits"} {
			result = append(result, target{name, "addon_id = ?", []any{options.AddonID}})
		}
		result = append(result,
			target{"addon_data_commit_records", "commit_id IN (SELECT commit_id FROM addon_data_commits WHERE addon_id=?)", []any{options.AddonID}},
			target{"addon_history_payloads", `sha256 IN (SELECT field.value FROM addon_history_revisions,json_each(fields_json) AS field WHERE addon_id=?)
    AND NOT EXISTS (SELECT 1 FROM addon_history_revisions,json_each(fields_json) AS field WHERE addon_id!=? AND field.value=addon_history_payloads.sha256)`, []any{options.AddonID, options.AddonID}})
		return result, nil
	case "prune-logs":
		if options.Events < 0 || options.Lifecycle < 0 || options.Audit < 0 {
			return nil, errors.New("retained log counts must be non-negative")
		}
		return []target{
			{"change_log", `(audience='public' AND sequence <= COALESCE((SELECT sequence FROM change_log WHERE audience='public' ORDER BY sequence DESC LIMIT 1 OFFSET ?),0))
    OR (audience='dm' AND sequence <= COALESCE((SELECT sequence FROM change_log WHERE audience='dm' ORDER BY sequence DESC LIMIT 1 OFFSET ?),0))
    OR (audience='system' AND sequence <= COALESCE((SELECT sequence FROM change_log WHERE audience='system' ORDER BY sequence DESC LIMIT 1 OFFSET ?),0))`, []any{options.Events, options.Events, options.Events}},
			{"addon_lifecycle_events", "sequence NOT IN (SELECT sequence FROM addon_lifecycle_events ORDER BY sequence DESC LIMIT ?)", []any{options.Lifecycle}},
			{"campaign_commits", "commit_id NOT IN (SELECT commit_id FROM campaign_commits ORDER BY commit_id DESC LIMIT ?)", []any{options.Audit}},
			{"addon_data_commits", "commit_id NOT IN (SELECT commit_id FROM addon_data_commits ORDER BY commit_id DESC LIMIT ?)", []any{options.Audit}},
		}, nil
	default:
		return nil, errors.New("unknown reviewed maintenance operation")
	}
}

func Inspect(ctx context.Context, db *sql.DB, options Options) (Report, error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Report{}, err
	}
	defer tx.Rollback()
	return inspect(ctx, tx, options)
}

func inspect(ctx context.Context, tx *sql.Tx, options Options) (Report, error) {
	report := Report{Options: options, Tables: []Table{}}
	selected, err := targets(options)
	if err != nil {
		return report, err
	}
	digest := sha256.New()
	if err := json.NewEncoder(digest).Encode(options); err != nil {
		return report, err
	}
	if options.Kind == "delete-addon-data" {
		var active, ownedBlobs int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM addon_package_states WHERE addon_id=? AND active_generation_id IS NOT NULL", options.AddonID).Scan(&active); err != nil {
			return report, err
		}
		if active != 0 {
			return report, errors.New("disable or uninstall this add-on before deleting its data")
		}
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM blobs WHERE owner_kind='addon' AND owner_id=?", options.AddonID).Scan(&ownedBlobs); err != nil {
			return report, err
		}
		if ownedBlobs != 0 {
			return report, errors.New("add-on-owned blob handles require a separate reviewed retirement before namespace deletion")
		}
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM addon_package_generations WHERE addon_id=?", options.AddonID).Scan(&report.ArchiveGenerations); err != nil {
			return report, err
		}
		// Recovery images can recreate deleted namespaces, so their affected portions
		// are explicitly included in the same review and atomic removal.
		stats, err := fingerprint(ctx, tx, digest, "recovery_points", "EXISTS (SELECT 1 FROM json_each(image_json, '$.sets') WHERE value ->> 'addon_id'=?) OR EXISTS (SELECT 1 FROM json_each(image_json, '$.documents') WHERE value ->> 'addon_id'=?)", options.AddonID, options.AddonID)
		if err != nil {
			return report, err
		}
		report.RecoveryPoints = stats.Rows
		if _, err := fingerprint(ctx, tx, digest, "recovery_control", "1=1"); err != nil {
			return report, err
		}
	}
	for _, item := range selected {
		// Include all rows for log retention so new arrivals invalidate the preview.
		where, args := item.where, item.args
		if options.Kind == "prune-logs" {
			where = "1=1"
			args = nil
		}
		stats, err := fingerprint(ctx, tx, digest, item.name, where, args...)
		if err != nil {
			return report, err
		}
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM "+item.name+" WHERE "+item.where, item.args...).Scan(&stats.Remove); err != nil {
			return report, err
		}
		report.Tables = append(report.Tables, stats)
	}
	if options.Kind == "prune-logs" {
		for _, name := range []string{"campaign_commit_records", "addon_data_commit_records", "event_replay_checkpoints"} {
			stats, err := fingerprint(ctx, tx, digest, name, "1=1")
			if err != nil {
				return report, err
			}
			if name != "event_replay_checkpoints" {
				parent, keep := "campaign_commits", options.Audit
				if name == "addon_data_commit_records" {
					parent = "addon_data_commits"
				}
				if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM "+name+" WHERE commit_id NOT IN (SELECT commit_id FROM "+parent+" ORDER BY commit_id DESC LIMIT ?)", keep).Scan(&stats.Remove); err != nil {
					return report, err
				}
			}
			report.Tables = append(report.Tables, stats)
		}
	}
	if err := json.NewEncoder(digest).Encode(report); err != nil {
		return report, err
	}
	report.Review = hex.EncodeToString(digest.Sum(nil))
	return report, nil
}

// fingerprint streams rows instead of constructing a second campaign image.
// EncodedBytes measures logical row payloads; it is not SQLite file allocation.
func fingerprint(ctx context.Context, tx *sql.Tx, digest hash.Hash, table, where string, args ...any) (Table, error) {
	stats := Table{Name: table}
	rows, err := tx.QueryContext(ctx, "SELECT * FROM "+table+" WHERE "+where+" ORDER BY rowid", args...)
	if err != nil {
		return stats, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return stats, err
	}
	if err := json.NewEncoder(digest).Encode([]any{table, where, columns, args}); err != nil {
		return stats, err
	}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return stats, err
		}
		encoded, err := json.Marshal(values)
		if err != nil {
			return stats, err
		}
		digest.Write(encoded)
		digest.Write([]byte("\n"))
		stats.Rows++
		stats.EncodedBytes += int64(len(encoded))
	}
	return stats, rows.Err()
}

func Apply(ctx context.Context, db *sql.DB, options Options, reviewed string) (Report, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Report{}, err
	}
	defer tx.Rollback()
	report, err := inspect(ctx, tx, options)
	if err != nil {
		return report, err
	}
	if reviewed == "" || reviewed != report.Review {
		return report, ErrStale
	}
	if options.Kind == "delete-addon-data" {
		// Remember only this namespace's payload hashes; never sweep unrelated
		// unreferenced payloads as a side effect of deleting one add-on.
		if _, err = tx.ExecContext(ctx, `CREATE TEMP TABLE cleanup_payloads AS
   SELECT DISTINCT field.value AS sha256 FROM addon_history_revisions, json_each(fields_json) AS field WHERE addon_id=?`, options.AddonID); err != nil {
			return report, err
		}
		defer tx.ExecContext(context.Background(), "DROP TABLE IF EXISTS cleanup_payloads")
		if _, err = tx.ExecContext(ctx, `UPDATE recovery_points SET image_json=json_set(image_json,
   '$.sets',json(COALESCE((SELECT json_group_array(json(value)) FROM json_each(image_json,'$.sets') WHERE value ->> 'addon_id' != ?),'[]')),
   '$.documents',json(COALESCE((SELECT json_group_array(json(value)) FROM json_each(image_json,'$.documents') WHERE value ->> 'addon_id' != ?),'[]')))
   WHERE EXISTS (SELECT 1 FROM json_each(image_json,'$.sets') WHERE value ->> 'addon_id'=?)
      OR EXISTS (SELECT 1 FROM json_each(image_json,'$.documents') WHERE value ->> 'addon_id'=?)`,
			options.AddonID, options.AddonID, options.AddonID, options.AddonID); err != nil {
			return report, err
		}
		for _, table := range []string{"addon_history_revisions", "addon_data_requests", "addon_data_commits", "addon_data_sets"} {
			if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE addon_id=?", options.AddonID); err != nil {
				return report, err
			}
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM addon_history_payloads WHERE sha256 IN (SELECT sha256 FROM cleanup_payloads)
   AND NOT EXISTS (SELECT 1 FROM addon_history_revisions, json_each(fields_json) AS field WHERE field.value=addon_history_payloads.sha256)`); err != nil {
			return report, err
		}
		if _, err = tx.ExecContext(ctx, "DROP TABLE cleanup_payloads"); err != nil {
			return report, err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE recovery_control SET revision=revision+1 WHERE singleton=1"); err != nil {
			return report, err
		}
	} else {
		selected, _ := targets(options)
		if _, err = tx.ExecContext(ctx, `UPDATE event_replay_checkpoints SET sequence=max(sequence,COALESCE((
   SELECT sequence FROM change_log WHERE audience=event_replay_checkpoints.audience
   ORDER BY sequence DESC LIMIT 1 OFFSET ?),0))`, options.Events); err != nil {
			return report, err
		}
		for _, item := range selected {
			if _, err = tx.ExecContext(ctx, "DELETE FROM "+item.name+" WHERE "+item.where, item.args...); err != nil {
				return report, fmt.Errorf("prune %s: %w", item.name, err)
			}
		}
	}
	return report, tx.Commit()
}
