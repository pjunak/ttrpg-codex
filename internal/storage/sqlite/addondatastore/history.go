package addondatastore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
)

// HistoryEntry is immutable evidence, separate from the current document. The
// owning application still authorizes the current core record on every read.
type HistoryEntry struct {
	Revision        int64           `json:"revision"`
	TargetCreatedAt time.Time       `json:"-"`
	Generation      string          `json:"generation"`
	ActorID         string          `json:"actorId"`
	OccurredAt      time.Time       `json:"occurredAt"`
	OperationID     string          `json:"operationId"`
	Operation       string          `json:"operation"`
	Summary         string          `json:"summary"`
	Deleted         bool            `json:"deleted"`
	Value           json.RawMessage `json:"value,omitempty"`
}

func (store *Store) History(ctx context.Context, addonID string, kind datacontract.Kind, dataID, key string, before int64, limit int) ([]HistoryEntry, error) {
	if !validIdentity(addonID, kind, dataID, key) || kind != datacontract.RecordExtension || before < 0 || limit < 1 || limit > 100 {
		return nil, ErrInvalidTransaction
	}
	rows, err := store.database.QueryContext(ctx, `SELECT revision, target_created_at, generation_id, actor_id, occurred_at, operation_id, operation, summary, deleted
 FROM addon_history_revisions WHERE addon_id=? AND data_kind=? AND data_id=? AND document_key=? AND (?=0 OR revision<?) ORDER BY revision DESC LIMIT ?`, addonID, kind, dataID, key, before, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []HistoryEntry{}
	for rows.Next() {
		entry, err := scanHistory(rows)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (store *Store) Revision(ctx context.Context, addonID string, kind datacontract.Kind, dataID, key string, revision int64) (HistoryEntry, error) {
	if !validIdentity(addonID, kind, dataID, key) || revision < 1 {
		return HistoryEntry{}, ErrInvalidTransaction
	}
	row := store.database.QueryRowContext(ctx, `SELECT revision, target_created_at, generation_id, actor_id, occurred_at, operation_id, operation, summary, deleted
 FROM addon_history_revisions WHERE addon_id=? AND data_kind=? AND data_id=? AND document_key=? AND revision=?`, addonID, kind, dataID, key, revision)
	entry, err := scanHistory(row)
	if errors.Is(err, sql.ErrNoRows) {
		return entry, ErrNotFound
	}
	if err != nil {
		return entry, err
	}
	var body string
	if err = store.database.QueryRowContext(ctx, `SELECT fields_json FROM addon_history_revisions WHERE addon_id=? AND data_kind=? AND data_id=? AND document_key=? AND revision=?`, addonID, kind, dataID, key, revision).Scan(&body); err != nil {
		return entry, err
	}
	fields := map[string]string{}
	if json.Unmarshal([]byte(body), &fields) != nil {
		return entry, ErrStorageInvariant
	}
	value := map[string]json.RawMessage{}
	total := 0
	for field, hash := range fields {
		var part string
		if err = store.database.QueryRowContext(ctx, `SELECT body_json FROM addon_history_payloads WHERE sha256=?`, hash).Scan(&part); err != nil {
			return entry, ErrStorageInvariant
		}
		total += len(part) + len(field)
		if total > MaximumDocumentBytes*2 || digest([]byte(part)) != hash {
			return entry, ErrStorageInvariant
		}
		value[field] = json.RawMessage(part)
	}
	if !entry.Deleted {
		entry.Value, err = json.Marshal(value)
	}
	return entry, err
}

func scanHistory(row rowScanner) (HistoryEntry, error) {
	var entry HistoryEntry
	var target, occurred string
	err := row.Scan(&entry.Revision, &target, &entry.Generation, &entry.ActorID, &occurred, &entry.OperationID, &entry.Operation, &entry.Summary, &entry.Deleted)
	if err != nil {
		return entry, err
	}
	entry.TargetCreatedAt, err = time.Parse(time.RFC3339Nano, target)
	if err != nil {
		return entry, ErrStorageInvariant
	}
	entry.OccurredAt, err = time.Parse(time.RFC3339Nano, occurred)
	if err != nil {
		return entry, ErrStorageInvariant
	}
	return entry, nil
}

func retainRevision(ctx context.Context, tx *sql.Tx, input Transaction, mutation preparedMutation, revision int64, timestamp string) error {
	if !mutation.Definition.Retained {
		return nil
	}
	if mutation.TargetCreatedAt == nil {
		return ErrInvalidTransaction
	}
	fields := map[string]string{}
	if mutation.Kind == Put {
		parts := map[string]json.RawMessage{}
		if json.Unmarshal(mutation.value, &parts) != nil || parts == nil {
			return ErrInvalidTransaction
		}
		for field, part := range parts {
			hash := digest(part)
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO addon_history_payloads(sha256,body_json) VALUES(?,?)`, hash, string(part)); err != nil {
				return err
			}
			fields[field] = hash
		}
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO addon_history_revisions(addon_id,data_kind,data_id,document_key,revision,target_created_at,generation_id,actor_id,occurred_at,operation_id,operation,summary,deleted,fields_json)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, input.AddonID, mutation.Definition.Kind, mutation.Definition.ID, mutation.Key, revision, mutation.TargetCreatedAt.UTC().Format(time.RFC3339Nano), input.GenerationID, input.ActorID, timestamp, input.OperationID, input.Operation, input.Summary, boolInt(mutation.Kind == Delete), string(body))
	return err
}

func validateOperation(input Transaction) error {
	if input.OperationID == "" {
		if input.Operation != "" || input.Summary != "" {
			return ErrInvalidTransaction
		}
		return nil
	}
	if len(input.OperationID) > 96 || !validDocumentKey(input.OperationID) || len(input.Operation) > 80 || !localIDPattern.MatchString(input.Operation) || len(input.Summary) > 1000 || strings.ContainsAny(input.Summary, "\x00\r") {
		return ErrInvalidTransaction
	}
	return nil
}

func operationReceipt(ctx context.Context, tx *sql.Tx, input Transaction) (*Commit, error) {
	if input.OperationID == "" {
		return nil, nil
	}
	var fingerprint, body string
	err := tx.QueryRowContext(ctx, `SELECT fingerprint,receipt_json FROM addon_data_requests WHERE addon_id=? AND operation_id=?`, input.AddonID, input.OperationID).Scan(&fingerprint, &body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if fingerprint != transactionFingerprint(input) {
		return nil, fmt.Errorf("%w: operation ID was used for different input", ErrConflict)
	}
	var commit Commit
	if json.Unmarshal([]byte(body), &commit) != nil {
		return nil, ErrStorageInvariant
	}
	return &commit, nil
}

func saveOperationReceipt(ctx context.Context, tx *sql.Tx, input Transaction, commit Commit) error {
	if input.OperationID == "" {
		return nil
	}
	body, err := json.Marshal(commit)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO addon_data_requests(addon_id,operation_id,fingerprint,receipt_json) VALUES(?,?,?,?)`, input.AddonID, input.OperationID, transactionFingerprint(input), string(body))
	return err
}

func transactionFingerprint(input Transaction) string {
	body, _ := json.Marshal(input)
	return digest(body)
}
func digest(body []byte) string { sum := sha256.Sum256(body); return hex.EncodeToString(sum[:]) }
