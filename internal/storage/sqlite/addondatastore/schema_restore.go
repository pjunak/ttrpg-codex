package addondatastore

import (
	"context"
	"encoding/json"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/unitofwork"
)

// RestoreSchemaSnapshot is only used by the coordinator's interrupted-update
// journal while writes are quiesced. It never accepts a browser-supplied image.
func (store *Store) RestoreSchemaSnapshot(ctx context.Context, id string) error {
	tx, cleanup, err := unitofwork.Begin(ctx, store.database)
	if err != nil {
		return err
	}
	defer cleanup()
	review, err := readSchemaReview(ctx, tx, id)
	if err != nil {
		return err
	}
	var raw string
	if err = tx.QueryRowContext(ctx, "SELECT snapshot_json FROM addon_schema_reviews WHERE review_id=?", id).Scan(&raw); err != nil {
		return err
	}
	if !review.ForActivation || schemaHash([]byte(raw)) != review.SnapshotSHA256 {
		return ErrStorageInvariant
	}
	var image struct {
		Format    string     `json:"format"`
		AddonID   string     `json:"addonId"`
		States    []State    `json:"states"`
		Documents []Document `json:"documents"`
		Bodies    [][]byte   `json:"bodiesBase64"`
		Versions  []struct {
			Kind, DataID, Key string
			Revision          int64
			Deleted           bool
			UpdatedAt         string
		} `json:"versions"`
	}
	if err = json.Unmarshal([]byte(raw), &image); err != nil {
		return err
	}
	if image.Format != "codex-addon-schema-snapshot.v1" || image.AddonID != review.AddonID || len(image.Bodies) != len(image.Documents) {
		return ErrStorageInvariant
	}
	for _, table := range []string{"addon_documents", "addon_document_versions"} {
		if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE addon_id=?", review.AddonID); err != nil {
			return err
		}
	}
	for _, state := range image.States {
		if state.AddonID != review.AddonID {
			return ErrStorageInvariant
		}
		var updated any
		if state.UpdatedAt != nil {
			updated = state.UpdatedAt.UTC().Format(time.RFC3339Nano)
		}
		result, err := tx.ExecContext(ctx, `UPDATE addon_data_sets SET materialized=?,revision=?,schema_version=NULLIF(?,''),schema_sha256=NULLIF(?,''),target_collection=NULLIF(?,''),keyed=?,updated_at=? WHERE addon_id=? AND data_kind=? AND data_id=?`,
			state.Materialized, state.Revision, state.SchemaVersion, state.SchemaSHA256, state.Target, state.Keyed, updated, state.AddonID, state.Kind, state.DataID)
		if err != nil {
			return err
		}
		if n, err := result.RowsAffected(); err != nil || n != 1 {
			return ErrStorageInvariant
		}
	}
	for i, document := range image.Documents {
		if document.AddonID != review.AddonID {
			return ErrStorageInvariant
		}
		var target any
		if document.TargetCreatedAt != nil {
			target = document.TargetCreatedAt.UTC().Format(time.RFC3339Nano)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO addon_documents(addon_id,data_kind,data_id,document_key,position,body_json,schema_version,schema_sha256,revision,created_at,updated_at,target_created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			document.AddonID, document.Kind, document.DataID, document.Key, document.Position, string(image.Bodies[i]), document.SchemaVersion, document.SchemaSHA256, document.Revision, document.CreatedAt.UTC().Format(time.RFC3339Nano), document.UpdatedAt.UTC().Format(time.RFC3339Nano), target); err != nil {
			return err
		}
	}
	for _, version := range image.Versions {
		if _, err = tx.ExecContext(ctx, `INSERT INTO addon_document_versions(addon_id,data_kind,data_id,document_key,revision,deleted,updated_at) VALUES(?,?,?,?,?,?,?)`, review.AddonID, version.Kind, version.DataID, version.Key, version.Revision, version.Deleted, version.UpdatedAt); err != nil {
			return err
		}
	}
	return unitofwork.Commit(ctx, tx, func() {})
}
