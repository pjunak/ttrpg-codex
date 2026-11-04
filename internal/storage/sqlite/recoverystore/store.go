// Package recoverystore restores campaign state without replacing the database
// or rewinding authentication, installed packages, audit history or revisions.
// Each recovery point holds one part: the campaign or one add-on's data.
package recoverystore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/pjunak/ttrpg-codex/internal/events"
)

var (
	ErrConflict      = errors.New("recovery list or campaign changed")
	ErrNotFound      = errors.New("recovery point not found")
	ErrCompatibility = errors.New("recovery point uses different add-on packages or data definitions")
	ErrInvalid       = errors.New("invalid recovery request")
	ErrTooLarge      = errors.New("campaign part is larger than the 64 MiB recovery point limit")
)

// maxImageBytes is the CHECK limit on recovery_points.image_json (migration 0029).
const maxImageBytes = 64 << 20

// MaxPointsPerPart is the retention of the recovery_point_inserted trigger.
const MaxPointsPerPart = 50

type Journal interface {
	Append(context.Context, *sql.Tx, events.Publication) (events.Event, error)
	NotifyCommitted(events.Event)
}
type Store struct {
	DB     *sql.DB
	Events Journal
	// Logger reports skipped automatic points; nil uses slog.Default.
	Logger *slog.Logger
}
type Point struct {
	ID           int64  `json:"id"`
	CreatedAt    string `json:"createdAt"`
	Reason       string `json:"reason"`
	Bytes        int64  `json:"bytes"`
	Records      int64  `json:"records"`
	Documents    int64  `json:"documents"`
	Media        int64  `json:"media"`
	GenerationID string `json:"generationId"`
	Compatible   bool   `json:"compatible"`
}

// Part lists one part's points, newest first.
type Part struct {
	Scope
	Points []Point `json:"points"`
}
type Listing struct {
	ContractVersion string `json:"contractVersion"`
	Revision        int64  `json:"revision"`
	Parts           []Part `json:"parts"`
}
type RestoreRequest struct {
	Scope
	ID               int64 `json:"id"`
	Count            int   `json:"count"`
	ExpectedRevision int64 `json:"expectedRevision"`
}

// BeforeWrite runs once before a store transaction mutates the part named by
// addonID ("" for the campaign). It captures that part at most once a minute,
// and the capture rolls back with the write. Per-row triggers only track
// revisions, since capturing halfway through a multi-record edit would be
// inconsistent. A part too large for a point is not captured, and the write
// goes ahead.
func (s *Store) BeforeWrite(ctx context.Context, tx *sql.Tx, addonID string) error {
	part := partOf(addonID)
	var due bool
	if err := tx.QueryRowContext(ctx, `SELECT suppressed = 0 AND unixepoch('subsec') - COALESCE(
 (SELECT last_capture FROM recovery_capture WHERE scope = @scope AND addon_id = @addon), 0) >= 60
 FROM recovery_control WHERE singleton = 1`, part.args()...).Scan(&due); err != nil || !due {
		return err
	}
	_, err := capture(ctx, tx, part, "save")
	tooLarge := errors.Is(err, ErrTooLarge)
	if err != nil && !tooLarge {
		return err
	}
	// Measuring the image is the expensive part, so a part too large for a
	// point is tried again a minute later rather than on every write.
	if _, err := tx.ExecContext(ctx, `INSERT INTO recovery_capture(scope, addon_id, last_capture) VALUES (@scope, @addon, unixepoch('subsec'))
 ON CONFLICT(scope, addon_id) DO UPDATE SET last_capture = excluded.last_capture`, part.args()...); err != nil {
		return err
	}
	if tooLarge {
		logger := s.Logger
		if logger == nil {
			logger = slog.Default()
		}
		logger.Warn("automatic recovery point skipped", "scope", part.Scope, "addon", part.AddonID, "error", ErrTooLarge)
	}
	return nil
}

type execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// capture stores one part's current image as a point. The image is built once
// and measured before the insert, so the table's size CHECK never fails the
// surrounding transaction.
func capture(ctx context.Context, db execer, part Scope, reason string) (sql.Result, error) {
	result, err := db.ExecContext(ctx, `WITH image AS MATERIALIZED (`+imageSQL(part)+`)
		INSERT INTO recovery_points(scope, addon_id, created_at, reason, image_json)
		SELECT @scope, @addon, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), @reason, image_json FROM image
		WHERE length(CAST(image_json AS BLOB)) <= @limit`, part.args(sql.Named("reason", reason), sql.Named("limit", maxImageBytes))...)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, ErrTooLarge
	}
	return result, nil
}

func (s *Store) List(ctx context.Context) (Listing, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Listing{}, err
	}
	defer tx.Rollback()
	result := Listing{ContractVersion: "recovery-points.v3", Parts: []Part{{Scope: Scope{Scope: "campaign"}, Points: []Point{}}}}
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM recovery_control WHERE singleton = 1`).Scan(&result.Revision); err != nil {
		return Listing{}, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT point_id, scope, addon_id, created_at, reason, length(CAST(image_json AS BLOB)),
 COALESCE(json_array_length(image_json, '$.records'), 0), COALESCE(json_array_length(image_json, '$.documents'), 0),
 (SELECT count(*) FROM json_each(image_json, '$.blobs') WHERE value ->> 'deleted' = 0),
 COALESCE(image_json ->> '$.packages[0].active_generation_id', '')
 FROM recovery_points ORDER BY scope = 'addon', addon_id, point_id DESC`)
	if err != nil {
		return Listing{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var part Scope
		var point Point
		if err := rows.Scan(&point.ID, &part.Scope, &part.AddonID, &point.CreatedAt, &point.Reason, &point.Bytes, &point.Records, &point.Documents, &point.Media, &point.GenerationID); err != nil {
			return Listing{}, err
		}
		if last := &result.Parts[len(result.Parts)-1]; last.Scope != part {
			result.Parts = append(result.Parts, Part{Scope: part, Points: []Point{}})
		}
		last := &result.Parts[len(result.Parts)-1]
		last.Points = append(last.Points, point)
	}
	if err := rows.Err(); err != nil {
		return Listing{}, err
	}
	if err := rows.Close(); err != nil {
		return Listing{}, err
	}
	for i := range result.Parts {
		part := &result.Parts[i]
		for j := range part.Points {
			point := &part.Points[j]
			if part.Scope.Scope == "campaign" {
				point.Compatible = true
				continue
			}
			var image string
			if err := tx.QueryRowContext(ctx, `SELECT image_json FROM recovery_points WHERE point_id = ?`, point.ID).Scan(&image); err != nil {
				return Listing{}, err
			}
			if point.Compatible, err = compatibleContext(ctx, tx, image, part.Scope); err != nil {
				return Listing{}, err
			}
		}
	}
	return result, tx.Commit()
}

// Create saves a manual point of every current part.
func (s *Store) Create(ctx context.Context) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	parts, err := liveParts(ctx, tx)
	if err != nil {
		return err
	}
	for _, part := range parts {
		if _, err := capture(ctx, tx, part, "manual"); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Snapshot is one part's newest point, as a backup bundle carries it.
type Snapshot struct {
	Scope
	PointID      int64
	CreatedAt    string
	Reason       string
	GenerationID string
	AddonVersion string
	Image        string
}

// Latest makes every current part's newest point equal that part's current
// state, saving a "download" point where it differs, and returns those points.
func (s *Store) Latest(ctx context.Context) ([]Snapshot, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	parts, err := liveParts(ctx, tx)
	if err != nil {
		return nil, err
	}
	snapshots := make([]Snapshot, 0, len(parts))
	for _, part := range parts {
		snapshot := Snapshot{Scope: part}
		if err := tx.QueryRowContext(ctx, imageSQL(part), part.args()...).Scan(&snapshot.Image); err != nil {
			return nil, fmt.Errorf("read %s image: %w", part.Scope, err)
		}
		if len(snapshot.Image) > maxImageBytes {
			return nil, ErrTooLarge
		}
		var newest string
		err := tx.QueryRowContext(ctx, `SELECT point_id, created_at, reason, image_json FROM recovery_points
 WHERE scope = @scope AND addon_id = @addon ORDER BY point_id DESC LIMIT 1`, part.args()...).Scan(&snapshot.PointID, &snapshot.CreatedAt, &snapshot.Reason, &newest)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if err != nil || newest != snapshot.Image {
			if err := tx.QueryRowContext(ctx, `INSERT INTO recovery_points(scope, addon_id, created_at, reason, image_json)
 VALUES (@scope, @addon, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'download', @image) RETURNING point_id, created_at, reason`,
				part.args(sql.Named("image", snapshot.Image))...).Scan(&snapshot.PointID, &snapshot.CreatedAt, &snapshot.Reason); err != nil {
				return nil, err
			}
		}
		if part.Scope == "addon" {
			if err := tx.QueryRowContext(ctx, `SELECT COALESCE(state.active_generation_id, ''), COALESCE(generation.addon_version, '')
 FROM (SELECT @addon AS addon_id) AS part LEFT JOIN addon_package_states AS state ON state.addon_id = part.addon_id
 LEFT JOIN addon_package_generations AS generation ON generation.addon_id = state.addon_id AND generation.generation_id = state.active_generation_id`,
				part.args()...).Scan(&snapshot.GenerationID, &snapshot.AddonVersion); err != nil {
				return nil, err
			}
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, tx.Commit()
}

// InsertImported stores one part of an imported backup as a point dated when
// that backup captured it. The caller validates the image and owns tx.
func InsertImported(ctx context.Context, tx *sql.Tx, part Scope, createdAt, image string) error {
	if !part.valid() {
		return ErrInvalid
	}
	if len(image) > maxImageBytes {
		return ErrTooLarge
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO recovery_points(scope, addon_id, created_at, reason, image_json)
 VALUES (@scope, @addon, @created, 'imported', @image)`, part.args(sql.Named("created", createdAt), sql.Named("image", image))...)
	return err
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
	if !request.Scope.valid() || request.ExpectedRevision < 0 || actorID == "" || len(actorID) > 200 ||
		(request.ID > 0) == (request.Count > 0) || request.ID < 0 || request.Count < 0 || request.Count > MaxPointsPerPart {
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
	part := request.Scope
	var image string
	id := request.ID
	// Revert counts the part's automatic edit groups, not manual, download,
	// imported or pre-restore points.
	if request.Count > 0 {
		err = tx.QueryRowContext(ctx, `SELECT point_id, image_json FROM recovery_points
 WHERE scope = @scope AND addon_id = @addon AND reason = 'save' ORDER BY point_id DESC LIMIT 1 OFFSET @offset`,
			part.args(sql.Named("offset", request.Count-1))...).Scan(&id, &image)
	} else {
		err = tx.QueryRowContext(ctx, `SELECT image_json FROM recovery_points WHERE point_id = @id AND scope = @scope AND addon_id = @addon`,
			part.args(sql.Named("id", id))...).Scan(&image)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var validImage bool
	if err := tx.QueryRowContext(ctx, `SELECT json_extract(?, '$.version') = 1`, image).Scan(&validImage); err != nil {
		return err
	}
	if !validImage {
		return ErrCompatibility
	}
	compatible, err := compatibleContext(ctx, tx, image, part)
	if err != nil {
		return err
	}
	if !compatible {
		return ErrCompatibility
	}
	// Without a safety point the current state could not be recovered, so a
	// part too large for one is not restored.
	result, err := capture(ctx, tx, part, "pre-restore")
	if err != nil {
		return err
	}
	safetyID, err := result.LastInsertId()
	if err != nil {
		return err
	}
	// The next edit of this part starts a new group after the safety point.
	if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_capture WHERE scope = @scope AND addon_id = @addon`, part.args()...); err != nil {
		return err
	}
	var statements []string
	if part.Scope == "campaign" {
		statements = append(statements, campaignRestoreStatements...)
		statements = append(statements, blobRestoreStatement)
		statements = append(statements, campaignMediaRestoreStatements...)
	} else {
		statements = append(statements, addonRestoreStatements...)
		statements = append(statements, blobRestoreStatement)
	}
	for index, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement, part.args(sql.Named("image", image))...); err != nil {
			return fmt.Errorf("restore %s step %d: %w", part.Scope, index, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO recovery_restores(point_id, safety_point_id, actor_id, occurred_at, scope, addon_id)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`, id, safetyID, actorID, part.Scope, part.AddonID); err != nil {
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
