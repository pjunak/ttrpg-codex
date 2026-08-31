package packagemanager

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
)

type store struct {
	db  *sql.DB
	now func() time.Time
}

func newStore(db *sql.DB, now func() time.Time) (*store, error) {
	if db == nil {
		return nil, fmt.Errorf("%w: database is required", ErrInvalidConfig)
	}
	if now == nil {
		now = time.Now
	}
	return &store{db: db, now: now}, nil
}

func (store *store) recordGeneration(ctx context.Context, report packageRecord) (Generation, error) {
	manifestJSON, err := json.Marshal(report.Manifest)
	if err != nil {
		return Generation{}, fmt.Errorf("encode installed manifest: %w", err)
	}
	now := store.now().UTC()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Generation{}, fmt.Errorf("begin generation install: %w", err)
	}
	defer tx.Rollback()
	inserted, err := tx.ExecContext(ctx, `
		INSERT INTO addon_package_generations(
			addon_id, generation_id, addon_version, archive_sha256,
			manifest_json, installed_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(addon_id, generation_id) DO NOTHING`,
		report.Manifest.ID,
		report.GenerationID,
		report.Manifest.Version,
		report.ArchiveSHA256,
		string(manifestJSON),
		now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Generation{}, fmt.Errorf("record add-on generation: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO addon_package_states(addon_id, updated_at)
		VALUES (?, ?)
		ON CONFLICT(addon_id) DO NOTHING`,
		report.Manifest.ID,
		now.Format(time.RFC3339Nano),
	); err != nil {
		return Generation{}, fmt.Errorf("create add-on package state: %w", err)
	}
	insertedCount, err := inserted.RowsAffected()
	if err != nil {
		return Generation{}, fmt.Errorf("read generation insert result: %w", err)
	}
	if insertedCount == 1 {
		if err := insertEvent(ctx, tx, report.Manifest.ID, report.GenerationID, "staged", "", now); err != nil {
			return Generation{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Generation{}, fmt.Errorf("commit generation install: %w", err)
	}
	return store.generation(ctx, report.Manifest.ID, report.GenerationID)
}

func (store *store) generation(ctx context.Context, addonID, generationID string) (Generation, error) {
	row := store.db.QueryRowContext(ctx, `
		SELECT addon_id, generation_id, addon_version, archive_sha256,
		       installed_at, last_attempt_at, last_activated_at,
		       COALESCE(last_error, '')
		FROM addon_package_generations
		WHERE addon_id = ? AND generation_id = ?`, addonID, generationID)
	return scanGeneration(row)
}

func (store *store) state(ctx context.Context, addonID string) (State, error) {
	row := store.db.QueryRowContext(ctx, `
		SELECT addon_id, COALESCE(active_generation_id, ''), revision,
		       granted_permissions_json, updated_at
		FROM addon_package_states
		WHERE addon_id = ?`, addonID)
	return scanState(row)
}

func (store *store) activeStates(ctx context.Context) ([]State, error) {
	rows, err := store.db.QueryContext(ctx, `
		SELECT addon_id, active_generation_id, revision,
		       granted_permissions_json, updated_at
		FROM addon_package_states
		WHERE active_generation_id IS NOT NULL
		ORDER BY addon_id`)
	if err != nil {
		return nil, fmt.Errorf("list active add-on states: %w", err)
	}
	defer rows.Close()
	result := make([]State, 0)
	for rows.Next() {
		state, err := scanState(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, state)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate active add-on states: %w", err)
	}
	return result, nil
}

func (store *store) activeVersion(ctx context.Context, addonID string) (string, bool, error) {
	row := store.db.QueryRowContext(ctx, `
		SELECT generation.addon_version
		FROM addon_package_states AS state
		JOIN addon_package_generations AS generation
		  ON generation.addon_id = state.addon_id
		 AND generation.generation_id = state.active_generation_id
		WHERE state.addon_id = ?`, addonID)
	var version string
	if err := row.Scan(&version); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read active dependency version: %w", err)
	}
	return version, true, nil
}

func (store *store) setActive(
	ctx context.Context,
	addonID string,
	generationID string,
	expectedRevision int64,
	grantedPermissions []string,
	kind string,
) (State, error) {
	permissionsJSON, err := json.Marshal(grantedPermissions)
	if err != nil {
		return State{}, fmt.Errorf("encode granted permissions: %w", err)
	}
	now := store.now().UTC()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return State{}, fmt.Errorf("begin active generation update: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE addon_package_states
		SET active_generation_id = ?, revision = revision + 1,
		    granted_permissions_json = ?, updated_at = ?
		WHERE addon_id = ? AND revision = ?`,
		generationID,
		string(permissionsJSON),
		now.Format(time.RFC3339Nano),
		addonID,
		expectedRevision,
	)
	if err != nil {
		return State{}, fmt.Errorf("update active generation: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return State{}, fmt.Errorf("read active generation update: %w", err)
	}
	if changed != 1 {
		return State{}, ErrStaleActivationPlan
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE addon_package_generations
		SET last_attempt_at = ?, last_activated_at = ?, last_error = NULL
		WHERE addon_id = ? AND generation_id = ?`,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), addonID, generationID,
	); err != nil {
		return State{}, fmt.Errorf("mark generation activated: %w", err)
	}
	if err := insertEvent(ctx, tx, addonID, generationID, kind, "", now); err != nil {
		return State{}, err
	}
	if err := tx.Commit(); err != nil {
		return State{}, fmt.Errorf("commit active generation: %w", err)
	}
	return store.state(ctx, addonID)
}

func (store *store) recordFailure(ctx context.Context, addonID, generationID, kind string, cause error) error {
	now := store.now().UTC()
	message := cause.Error()
	if len(message) > 2000 {
		message = message[:2000]
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin lifecycle failure record: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE addon_package_generations
		SET last_attempt_at = ?, last_error = ?
		WHERE addon_id = ? AND generation_id = ?`,
		now.Format(time.RFC3339Nano), message, addonID, generationID,
	); err != nil {
		return fmt.Errorf("record generation failure: %w", err)
	}
	if err := insertEvent(ctx, tx, addonID, generationID, kind, message, now); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit lifecycle failure: %w", err)
	}
	return nil
}

func (store *store) recordRecovery(ctx context.Context, addonID, generationID string) error {
	now := store.now().UTC()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin lifecycle recovery record: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE addon_package_generations
		SET last_attempt_at = ?, last_activated_at = ?, last_error = NULL
		WHERE addon_id = ? AND generation_id = ?`,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), addonID, generationID,
	); err != nil {
		return fmt.Errorf("mark generation recovered: %w", err)
	}
	if err := insertEvent(ctx, tx, addonID, generationID, "recovered", "", now); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit lifecycle recovery: %w", err)
	}
	return nil
}

func (store *store) snapshot(ctx context.Context, addonID string, eventLimit int) (Snapshot, error) {
	state, err := store.state(ctx, addonID)
	if err != nil {
		return Snapshot{}, err
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT addon_id, generation_id, addon_version, archive_sha256,
		       installed_at, last_attempt_at, last_activated_at,
		       COALESCE(last_error, '')
		FROM addon_package_generations
		WHERE addon_id = ?
		ORDER BY installed_at DESC, generation_id`, addonID)
	if err != nil {
		return Snapshot{}, fmt.Errorf("list add-on generations: %w", err)
	}
	generations := make([]Generation, 0)
	for rows.Next() {
		generation, err := scanGeneration(rows)
		if err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		generations = append(generations, generation)
	}
	if err := rows.Close(); err != nil {
		return Snapshot{}, err
	}
	if eventLimit <= 0 || eventLimit > 500 {
		eventLimit = 100
	}
	eventRows, err := store.db.QueryContext(ctx, `
		SELECT sequence, addon_id, generation_id, kind, message, occurred_at
		FROM addon_lifecycle_events
		WHERE addon_id = ?
		ORDER BY sequence DESC
		LIMIT ?`, addonID, eventLimit)
	if err != nil {
		return Snapshot{}, fmt.Errorf("list add-on lifecycle events: %w", err)
	}
	defer eventRows.Close()
	events := make([]Event, 0)
	for eventRows.Next() {
		var event Event
		var occurredAt string
		if err := eventRows.Scan(&event.Sequence, &event.AddonID, &event.GenerationID, &event.Kind, &event.Message, &occurredAt); err != nil {
			return Snapshot{}, fmt.Errorf("scan add-on lifecycle event: %w", err)
		}
		event.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
		if err != nil {
			return Snapshot{}, fmt.Errorf("parse lifecycle event time: %w", err)
		}
		events = append(events, event)
	}
	if err := eventRows.Err(); err != nil {
		return Snapshot{}, fmt.Errorf("iterate add-on lifecycle events: %w", err)
	}
	return Snapshot{State: state, Generations: generations, Events: events}, nil
}

type packageRecord struct {
	Manifest      packageinspect.Manifest
	GenerationID  string
	ArchiveSHA256 string
}

func insertEvent(
	ctx context.Context,
	tx *sql.Tx,
	addonID, generationID, kind, message string,
	at time.Time,
) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO addon_lifecycle_events(
			addon_id, generation_id, kind, message, occurred_at
		) VALUES (?, ?, ?, ?, ?)`,
		addonID, generationID, kind, message, at.UTC().Format(time.RFC3339Nano),
	); err != nil {
		return fmt.Errorf("record add-on lifecycle event: %w", err)
	}
	return nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanGeneration(row rowScanner) (Generation, error) {
	var generation Generation
	var installedAt string
	var attemptAt, activatedAt sql.NullString
	if err := row.Scan(
		&generation.AddonID,
		&generation.GenerationID,
		&generation.Version,
		&generation.ArchiveSHA256,
		&installedAt,
		&attemptAt,
		&activatedAt,
		&generation.LastError,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Generation{}, ErrGenerationNotFound
		}
		return Generation{}, fmt.Errorf("scan add-on generation: %w", err)
	}
	var err error
	generation.InstalledAt, err = time.Parse(time.RFC3339Nano, installedAt)
	if err != nil {
		return Generation{}, fmt.Errorf("parse generation install time: %w", err)
	}
	if attemptAt.Valid {
		value, err := time.Parse(time.RFC3339Nano, attemptAt.String)
		if err != nil {
			return Generation{}, fmt.Errorf("parse generation attempt time: %w", err)
		}
		generation.LastAttemptAt = &value
	}
	if activatedAt.Valid {
		value, err := time.Parse(time.RFC3339Nano, activatedAt.String)
		if err != nil {
			return Generation{}, fmt.Errorf("parse generation activated time: %w", err)
		}
		generation.LastActivatedAt = &value
	}
	return generation, nil
}

func scanState(row rowScanner) (State, error) {
	var state State
	var permissionsJSON, updatedAt string
	if err := row.Scan(
		&state.AddonID,
		&state.ActiveGenerationID,
		&state.Revision,
		&permissionsJSON,
		&updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return State{}, ErrGenerationNotFound
		}
		return State{}, fmt.Errorf("scan add-on package state: %w", err)
	}
	if err := json.Unmarshal([]byte(permissionsJSON), &state.GrantedPermissionIDs); err != nil {
		return State{}, fmt.Errorf("decode granted permissions: %w", err)
	}
	var err error
	state.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return State{}, fmt.Errorf("parse package state time: %w", err)
	}
	return state, nil
}
