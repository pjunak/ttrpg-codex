package addondatastore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/unitofwork"
)

const maximumSchemaSnapshotBytes = 16 << 20
const maximumSchemaDocuments = 10000

type SchemaPlanner func(Snapshot) ([]datalifecycle.SchemaChange, []datalifecycle.Issue, error)

func (store *Store) PrepareSchemaReview(ctx context.Context, input datalifecycle.SchemaReviewRequest, plan SchemaPlanner) (datalifecycle.SchemaReview, error) {
	if !validAddonID(input.AddonID) || !validGenerationID(input.GenerationID) || input.ReviewID == "" || len(input.ReviewID) > 128 || input.ExpectedStateRevision < 0 || plan == nil {
		return datalifecycle.SchemaReview{}, ErrInvalidTransaction
	}
	tx, cleanup, err := unitofwork.Begin(ctx, store.database)
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	defer cleanup()
	if err = checkSchemaState(ctx, tx, input.AddonID, input.GenerationID, input.ExpectedStateRevision); err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	snapshot, raw, err := schemaSnapshot(ctx, tx, input.AddonID)
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	changes, blockers, err := plan(snapshot)
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	now := store.now().UTC()
	review := datalifecycle.SchemaReview{ContractVersion: "addon-schema-review.v1", ReviewID: input.ReviewID, AddonID: input.AddonID, GenerationID: input.GenerationID, ExpectedStateRevision: input.ExpectedStateRevision,
		SnapshotSHA256: schemaHash(raw), Status: "prepared", CreatedAt: now, ExpiresAt: now.Add(30 * time.Minute), Changes: changes, Blockers: blockers, Documents: len(snapshot.Documents)}
	encoded, err := json.Marshal(review)
	if err != nil {
		return review, err
	}
	review.ReviewSHA256 = schemaHash(encoded)
	encoded, err = json.Marshal(review)
	if err != nil {
		return review, err
	}
	// Keep one pending snapshot per namespace. Applied reviews remain recovery evidence.
	if _, err = tx.ExecContext(ctx, "DELETE FROM addon_schema_reviews WHERE addon_id=? AND status='prepared'", input.AddonID); err != nil {
		return review, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO addon_schema_reviews(review_id,addon_id,status,plan_json,snapshot_json) VALUES(?,?,'prepared',?,?)", input.ReviewID, input.AddonID, string(encoded), string(raw)); err != nil {
		return review, err
	}
	err = unitofwork.Commit(ctx, tx, func() {})
	return review, err
}

func (store *Store) GetSchemaReview(ctx context.Context, id string) (datalifecycle.SchemaReview, error) {
	return readSchemaReview(ctx, store.database, id)
}
func (store *Store) SchemaReviewRecovery(ctx context.Context, id string) ([]byte, error) {
	var raw string
	err := store.database.QueryRowContext(ctx, "SELECT snapshot_json FROM addon_schema_reviews WHERE review_id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, datalifecycle.ErrUpgradeNotFound
	}
	return []byte(raw), err
}

type schemaQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readSchemaReview(ctx context.Context, q schemaQuerier, id string) (datalifecycle.SchemaReview, error) {
	var raw, status string
	var applied sql.NullString
	err := q.QueryRowContext(ctx, "SELECT plan_json,status,applied_at FROM addon_schema_reviews WHERE review_id=?", id).Scan(&raw, &status, &applied)
	if errors.Is(err, sql.ErrNoRows) {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeNotFound
	}
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	var review datalifecycle.SchemaReview
	if err = json.Unmarshal([]byte(raw), &review); err != nil {
		return review, err
	}
	digest := review.ReviewSHA256
	review.ReviewSHA256 = ""
	encoded, err := json.Marshal(review)
	if err != nil {
		return review, err
	}
	if schemaHash(encoded) != digest || review.ReviewID != id {
		return review, ErrStorageInvariant
	}
	review.ReviewSHA256 = digest
	review.Status = status
	if applied.Valid {
		value, err := time.Parse(time.RFC3339Nano, applied.String)
		if err != nil {
			return review, err
		}
		review.AppliedAt = &value
	}
	return review, nil
}
func (store *Store) ApplySchemaReview(ctx context.Context, id, digest string) (datalifecycle.SchemaReview, error) {
	tx, cleanup, err := unitofwork.Begin(ctx, store.database)
	if err != nil {
		return datalifecycle.SchemaReview{}, err
	}
	defer cleanup()
	review, err := readSchemaReview(ctx, tx, id)
	if err != nil {
		return review, err
	}
	if review.ReviewSHA256 != digest {
		return review, datalifecycle.ErrUpgradeStale
	}
	// A lost response can be resolved after restart, even after later activation.
	if review.Status == "applied" {
		return review, nil
	}
	if !store.now().Before(review.ExpiresAt) {
		return review, datalifecycle.ErrUpgradeStale
	}
	if len(review.Blockers) > 0 || len(review.Changes) == 0 {
		return review, datalifecycle.ErrUpgradeBlocked
	}
	if err = checkSchemaState(ctx, tx, review.AddonID, review.GenerationID, review.ExpectedStateRevision); err != nil {
		return review, err
	}
	_, raw, err := schemaSnapshot(ctx, tx, review.AddonID)
	if err != nil {
		return review, err
	}
	if schemaHash(raw) != review.SnapshotSHA256 {
		return review, datalifecycle.ErrUpgradeStale
	}
	if store.beforeWrite != nil {
		if err = store.beforeWrite(ctx, tx); err != nil {
			return review, err
		}
	}
	now := store.now().UTC()
	timestamp := now.Format(time.RFC3339Nano)
	for _, change := range review.Changes {
		result, err := tx.ExecContext(ctx, `UPDATE addon_data_sets SET schema_version=?,schema_sha256=?,revision=revision+1,updated_at=?
   WHERE addon_id=? AND data_kind=? AND data_id=? AND schema_version=? AND schema_sha256=? AND materialized=1`,
			change.ToVersion, change.ToSHA256, timestamp, review.AddonID, change.Kind, change.DataID, change.FromVersion, change.FromSHA256)
		if err != nil {
			return review, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return review, err
		}
		if count != 1 {
			return review, ErrStorageInvariant
		}
		// Values, ordering, record revisions, tombstones and detached-target identity
		// stay byte-for-byte unchanged. Only the enclosing schema identity advances.
		if _, err = tx.ExecContext(ctx, `UPDATE addon_documents SET schema_version=?,schema_sha256=? WHERE addon_id=? AND data_kind=? AND data_id=?`,
			change.ToVersion, change.ToSHA256, review.AddonID, change.Kind, change.DataID); err != nil {
			return review, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE addon_package_states SET revision=revision+1,updated_at=? WHERE addon_id=?", timestamp, review.AddonID); err != nil {
		return review, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE addon_schema_reviews SET status='applied',applied_at=? WHERE review_id=?", timestamp, id); err != nil {
		return review, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO addon_lifecycle_events(addon_id,generation_id,kind,message,occurred_at) VALUES(?,?,'schema-upgraded',?,?)`,
		review.AddonID, review.GenerationID, "Reviewed saved-data upgrade "+id, timestamp); err != nil {
		return review, err
	}
	event, err := store.events.Append(ctx, tx, events.Publication{Audience: events.AudienceDM, Topic: "addon-schema-upgraded", ResourceID: review.AddonID, Revision: fmt.Sprint(review.ExpectedStateRevision + 1)})
	if err != nil {
		return review, err
	}
	if err = unitofwork.Commit(ctx, tx, func() { store.events.NotifyCommitted(event) }); err != nil {
		return review, err
	}
	review.Status = "applied"
	review.AppliedAt = &now
	return review, nil
}
func checkSchemaState(ctx context.Context, tx *sql.Tx, addon, generation string, expected int64) error {
	var revision int64
	var active sql.NullString
	err := tx.QueryRowContext(ctx, "SELECT revision,active_generation_id FROM addon_package_states WHERE addon_id=?", addon).Scan(&revision, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return datalifecycle.ErrUpgradeStale
	}
	if err != nil {
		return err
	}
	if active.Valid && active.String != "" {
		return datalifecycle.ErrUpgradeActive
	}
	if revision != expected {
		return datalifecycle.ErrUpgradeStale
	}
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM addon_package_generations WHERE addon_id=? AND generation_id=?", addon, generation).Scan(&exists); err != nil {
		return err
	}
	if exists != 1 {
		return datalifecycle.ErrUpgradeStale
	}
	return nil
}
func schemaHash(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

// Recovery envelopes preserve exact UTF-8 JSON bytes as base64, including
// whitespace and number spellings; metadata and tombstones participate in the hash.
func schemaSnapshot(ctx context.Context, tx *sql.Tx, addon string) (Snapshot, []byte, error) {
	var sets, documents, versions, bytes int64
	err := tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM addon_data_sets WHERE addon_id=?),
 (SELECT count(*) FROM addon_documents WHERE addon_id=?),(SELECT count(*) FROM addon_document_versions WHERE addon_id=?),
 (SELECT COALESCE(sum(length(CAST(body_json AS BLOB))),0) FROM addon_documents WHERE addon_id=?)`, addon, addon, addon, addon).Scan(&sets, &documents, &versions, &bytes)
	if err != nil {
		return Snapshot{}, nil, err
	}
	if sets > 256 || documents > maximumSchemaDocuments || versions > maximumSchemaDocuments || bytes > maximumSchemaSnapshotBytes {
		return Snapshot{}, nil, datalifecycle.ErrUpgradeLimit
	}
	snapshot, err := snapshotAddonTx(ctx, tx, addon)
	if err != nil {
		return Snapshot{}, nil, err
	}
	type version struct {
		Kind, DataID, Key string
		Revision          int64
		Deleted           bool
		UpdatedAt         string
	}
	tombstones := []version{}
	rows, err := tx.QueryContext(ctx, `SELECT data_kind,data_id,document_key,revision,deleted,updated_at FROM addon_document_versions
 WHERE addon_id=? ORDER BY data_kind,data_id,document_key`, addon)
	if err != nil {
		return Snapshot{}, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var value version
		if err = rows.Scan(&value.Kind, &value.DataID, &value.Key, &value.Revision, &value.Deleted, &value.UpdatedAt); err != nil {
			return Snapshot{}, nil, err
		}
		tombstones = append(tombstones, value)
	}
	if err = rows.Err(); err != nil {
		return Snapshot{}, nil, err
	}
	metadata := append([]Document{}, snapshot.Documents...)
	bodies := make([][]byte, len(metadata))
	for i := range metadata {
		bodies[i] = []byte(metadata[i].Value)
		metadata[i].Value = nil
	}
	raw, err := json.Marshal(struct {
		Format    string     `json:"format"`
		AddonID   string     `json:"addonId"`
		States    []State    `json:"states"`
		Documents []Document `json:"documents"`
		Bodies    [][]byte   `json:"bodiesBase64"`
		Versions  []version  `json:"versions"`
	}{"codex-addon-schema-snapshot.v1", addon, snapshot.States, metadata, bodies, tombstones})
	if len(raw) > 2*maximumSchemaSnapshotBytes {
		return Snapshot{}, nil, datalifecycle.ErrUpgradeLimit
	}
	return snapshot, raw, err
}
