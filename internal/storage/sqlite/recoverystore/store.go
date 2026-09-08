// Package recoverystore restores campaign state without replacing the database
// or rewinding authentication, installed packages, audit history or revisions.
package recoverystore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"

	"github.com/pjunak/ttrpg-codex/internal/events"
)

var (
	ErrConflict      = errors.New("recovery list or campaign changed")
	ErrNotFound      = errors.New("recovery point not found")
	ErrCompatibility = errors.New("recovery point uses different add-on packages or data definitions")
	ErrInvalid       = errors.New("invalid recovery request")
)

type Journal interface {
	Append(context.Context, *sql.Tx, events.Publication) (events.Event, error)
	NotifyCommitted(events.Event)
}
type Store struct {
	DB     *sql.DB
	Events Journal
}
type Point struct {
	ID        int64  `json:"id"`
	CreatedAt string `json:"createdAt"`
	Reason    string `json:"reason"`
	Bytes     int64  `json:"bytes"`
	Records   int64  `json:"records"`
	Documents int64  `json:"documents"`
	Media     int64  `json:"media"`
}
type Listing struct {
	ContractVersion string  `json:"contractVersion"`
	Revision        int64   `json:"revision"`
	Points          []Point `json:"points"`
}
type RestoreRequest struct {
	ID               int64 `json:"id"`
	Count            int   `json:"count"`
	ExpectedRevision int64 `json:"expectedRevision"`
}

// BeforeWrite runs once before a store transaction mutates campaign state.
// Capture rolls back with the write. Per-row triggers only track revisions,
// since capturing halfway through a multi-record edit would be inconsistent.
func (s *Store) BeforeWrite(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO recovery_points(created_at, reason, image_json)
		SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'save', (SELECT image_json FROM recovery_image)
		WHERE (SELECT unixepoch('subsec') - last_capture >= 60 AND suppressed = 0 FROM recovery_control WHERE singleton = 1)`)
	return err
}

func (s *Store) List(ctx context.Context) (Listing, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Listing{}, err
	}
	defer tx.Rollback()
	result := Listing{ContractVersion: "recovery-points.v1", Points: []Point{}}
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM recovery_control WHERE singleton = 1`).Scan(&result.Revision); err != nil {
		return Listing{}, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT point_id, created_at, reason, length(CAST(image_json AS BLOB)),
        json_array_length(image_json, '$.records'), json_array_length(image_json, '$.documents'),
        (SELECT count(*) FROM json_each(image_json, '$.blobs') WHERE value ->> 'deleted' = 0)
        FROM recovery_points ORDER BY point_id DESC`)
	if err != nil {
		return Listing{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var point Point
		if err := rows.Scan(&point.ID, &point.CreatedAt, &point.Reason, &point.Bytes, &point.Records, &point.Documents, &point.Media); err != nil {
			return Listing{}, err
		}
		result.Points = append(result.Points, point)
	}
	if err := rows.Err(); err != nil {
		return Listing{}, err
	}
	if err := rows.Close(); err != nil {
		return Listing{}, err
	}
	return result, tx.Commit()
}

func (s *Store) Create(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO recovery_points(created_at, reason, image_json)
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'manual', image_json FROM recovery_image`)
	return err
}

func (s *Store) Delete(ctx context.Context, id, expected int64) error {
	if id < 1 || expected < 0 {
		return ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := claim(ctx, tx, expected); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM recovery_points WHERE point_id = ?`, id)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE recovery_control SET suppressed = 0, revision = revision + 1 WHERE singleton = 1`); err != nil {
		return err
	}
	return tx.Commit()
}

func claim(ctx context.Context, tx *sql.Tx, revision int64) error {
	result, err := tx.ExecContext(ctx, `UPDATE recovery_control SET suppressed = 1 WHERE singleton = 1 AND revision = ? AND suppressed = 0`, revision)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return ErrConflict
	}
	return nil
}

func (s *Store) Restore(ctx context.Context, request RestoreRequest, actorID string) error {
	if request.ExpectedRevision < 0 || actorID == "" || len(actorID) > 200 ||
		(request.ID > 0) == (request.Count > 0) || request.ID < 0 || request.Count < 0 || request.Count > 50 {
		return ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := claim(ctx, tx, request.ExpectedRevision); err != nil {
		return err
	}
	var image string
	id := request.ID
	// Revert counts automatic edit groups, not manual or pre-restore points.
	if request.Count > 0 {
		err = tx.QueryRowContext(ctx, `SELECT point_id, image_json FROM recovery_points WHERE reason = 'save' ORDER BY point_id DESC LIMIT 1 OFFSET ?`, request.Count-1).Scan(&id, &image)
	} else {
		err = tx.QueryRowContext(ctx, `SELECT image_json FROM recovery_points WHERE point_id = ?`, id).Scan(&image)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var compatible bool
	if err := tx.QueryRowContext(ctx, `SELECT json_extract(?, '$.version') = 1 AND
        json_extract(?, '$.packages') = json_extract(image_json, '$.packages') FROM recovery_image`, image, image).Scan(&compatible); err != nil {
		return err
	}
	if !compatible {
		return ErrCompatibility
	}
	// Dataset ownership must still describe the same schema. Missing sets can
	// be recreated because the exact active package generations also match.
	if err := tx.QueryRowContext(ctx, `SELECT NOT EXISTS (
        SELECT 1 FROM json_each(?, '$.sets') AS old JOIN addon_data_sets AS live
        ON live.addon_id = old.value ->> 'addon_id' AND live.data_kind = old.value ->> 'data_kind' AND live.data_id = old.value ->> 'data_id'
        WHERE live.schema_version IS NOT old.value ->> 'schema_version' OR live.schema_sha256 IS NOT old.value ->> 'schema_sha256'
            OR live.target_collection IS NOT old.value ->> 'target_collection' OR live.keyed IS NOT old.value ->> 'keyed'
    )`, image).Scan(&compatible); err != nil {
		return err
	}
	if !compatible {
		return ErrCompatibility
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO recovery_points(created_at, reason, image_json)
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pre-restore', image_json FROM recovery_image`)
	if err != nil {
		return err
	}
	safetyID, err := result.LastInsertId()
	if err != nil {
		return err
	}
	for index, statement := range restoreStatements {
		if _, err := tx.ExecContext(ctx, statement, sql.Named("image", image)); err != nil {
			return fmt.Errorf("restore campaign step %d: %w", index, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO recovery_restores(point_id, safety_point_id, actor_id, occurred_at)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, id, safetyID, actorID); err != nil {
		return err
	}
	var revision int64
	if err := tx.QueryRowContext(ctx, `UPDATE recovery_control SET suppressed = 0, revision = revision + 1 WHERE singleton = 1 RETURNING revision`).Scan(&revision); err != nil {
		return err
	}
	event, err := s.Events.Append(ctx, tx, events.Publication{Audience: events.AudiencePublic, Topic: "campaign-restored", Revision: strconv.FormatInt(revision, 10)})
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.Events.NotifyCommitted(event)
	return nil
}
