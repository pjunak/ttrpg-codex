package campaignstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
)

const MaximumMutations = 500

var (
	ErrInvalidConfig    = errors.New("invalid campaign store configuration")
	ErrStorageInvariant = errors.New("campaign storage invariant failed")
)

var (
	ErrInvalidTransaction = campaign.ErrInvalidTransaction
	ErrConflict           = campaign.ErrConflict
	ErrNotFound           = campaign.ErrNotFound
)

type EventJournal interface {
	Append(context.Context, *sql.Tx, events.Publication) (events.Event, error)
	NotifyCommitted(events.Event)
}

type Config struct {
	DB     *sql.DB
	Events EventJournal
	Now    func() time.Time
}

type Store struct {
	db     *sql.DB
	events EventJournal
	now    func() time.Time
}

type OperationKind = campaign.OperationKind
type Mutation = campaign.Mutation
type Transaction = campaign.Transaction
type MutationResult = campaign.MutationResult
type Commit = campaign.Commit
type Record = campaign.Record
type RecordState = campaign.RecordState
type CollectionState = campaign.CollectionState
type Snapshot = campaign.Snapshot
type ConflictError = campaign.ConflictError

const (
	Put    = campaign.Put
	Delete = campaign.Delete
)

type preparedMutation struct {
	Mutation
	value      json.RawMessage
	visibility campaign.Visibility
}

type collectionChange struct {
	count       int
	publicCount int
}

func New(config Config) (*Store, error) {
	if config.DB == nil || config.Events == nil {
		return nil, fmt.Errorf("%w: database and event journal are required", ErrInvalidConfig)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	store := &Store{db: config.DB, events: config.Events, now: config.Now}
	if err := store.verifySchema(context.Background()); err != nil {
		return nil, err
	}
	return store, nil
}

func (store *Store) Get(
	ctx context.Context,
	collection campaign.Collection,
	key string,
) (Record, error) {
	descriptor, ok := campaign.Describe(collection)
	if !ok {
		return Record{}, campaign.ErrInvalidCollection
	}
	if err := campaign.ValidateKey(descriptor, key); err != nil {
		return Record{}, err
	}
	record, found, err := readRecord(ctx, store.db, collection, key)
	if err != nil {
		return Record{}, err
	}
	if !found {
		return Record{}, ErrNotFound
	}
	return record, nil
}

func (store *Store) State(
	ctx context.Context,
	collection campaign.Collection,
	key string,
) (RecordState, error) {
	descriptor, ok := campaign.Describe(collection)
	if !ok {
		return RecordState{}, campaign.ErrInvalidCollection
	}
	if err := campaign.ValidateKey(descriptor, key); err != nil {
		return RecordState{}, err
	}
	revision, deleted, found, err := readRecordVersion(ctx, store.db, collection, key)
	if err != nil {
		return RecordState{}, err
	}
	if !found {
		return RecordState{}, nil
	}
	return RecordState{Revision: revision, Exists: !deleted}, nil
}

func (store *Store) List(
	ctx context.Context,
	collection campaign.Collection,
	includeDM bool,
) ([]Record, error) {
	return listRecords(ctx, store.db, collection, includeDM)
}

func listRecords(
	ctx context.Context,
	reader recordRowsQuery,
	collection campaign.Collection,
	includeDM bool,
) ([]Record, error) {
	if _, ok := campaign.Describe(collection); !ok {
		return nil, campaign.ErrInvalidCollection
	}
	query := `
		SELECT collection_name, record_key, position, body_json, visibility,
		       revision, created_at, updated_at
		FROM campaign_records
		WHERE collection_name = ?`
	arguments := []any{collection}
	if !includeDM {
		query += ` AND visibility = 'public'`
	}
	query += ` ORDER BY position, record_key`
	rows, err := reader.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("list campaign records: %w", err)
	}
	defer rows.Close()
	result := make([]Record, 0)
	for rows.Next() {
		record, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate campaign records: %w", err)
	}
	return result, nil
}

func (store *Store) Snapshot(ctx context.Context, includeDM bool) (Snapshot, error) {
	transaction, err := store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Snapshot{}, fmt.Errorf("begin campaign snapshot: %w", err)
	}
	defer transaction.Rollback()

	states, err := collectionStates(ctx, transaction)
	if err != nil {
		return Snapshot{}, err
	}
	result := Snapshot{States: states, Records: make([]Record, 0)}
	for _, state := range states {
		if !state.Materialized {
			continue
		}
		records, err := listRecords(ctx, transaction, state.Collection, includeDM)
		if err != nil {
			return Snapshot{}, err
		}
		result.Records = append(result.Records, records...)
	}
	if err := transaction.Commit(); err != nil {
		return Snapshot{}, fmt.Errorf("commit campaign snapshot: %w", err)
	}
	return result, nil
}

func (store *Store) Transact(ctx context.Context, input Transaction) (Commit, error) {
	prepared, err := prepareTransaction(input)
	if err != nil {
		return Commit{}, err
	}
	transaction, err := store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return Commit{}, fmt.Errorf("begin campaign transaction: %w", err)
	}
	defer transaction.Rollback()

	occurredAt := store.now().UTC()
	results := make([]MutationResult, 0, len(prepared))
	changes := make(map[campaign.Collection]*collectionChange)
	for _, mutation := range prepared {
		current, found, err := readRecord(ctx, transaction, mutation.Collection, mutation.Key)
		if err != nil {
			return Commit{}, err
		}
		actualRevision, deleted, versionFound, err := readRecordVersion(
			ctx,
			transaction,
			mutation.Collection,
			mutation.Key,
		)
		if err != nil {
			return Commit{}, err
		}
		if found && (!versionFound || deleted || current.Revision != actualRevision) ||
			!found && versionFound && !deleted {
			return Commit{}, fmt.Errorf(
				"%w: record and revision state disagree for %s:%s",
				ErrStorageInvariant,
				mutation.Collection,
				mutation.Key,
			)
		}
		if mutation.ExpectedRevision != actualRevision {
			return Commit{}, &ConflictError{
				Collection: mutation.Collection,
				Key:        mutation.Key,
				Expected:   mutation.ExpectedRevision,
				Actual:     actualRevision,
			}
		}

		visibility := mutation.visibility
		afterRevision := actualRevision + 1
		if mutation.Kind == Put {
			position := current.Position
			createdAt := current.CreatedAt
			if !found {
				position, err = nextPosition(ctx, transaction, mutation.Collection)
				if err != nil {
					return Commit{}, err
				}
				createdAt = occurredAt
			}
			if _, err := transaction.ExecContext(ctx, `
				INSERT INTO campaign_records(
					collection_name, record_key, position, body_json, visibility,
					revision, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(collection_name, record_key) DO UPDATE SET
					body_json = excluded.body_json,
					visibility = excluded.visibility,
					revision = excluded.revision,
					updated_at = excluded.updated_at`,
				mutation.Collection,
				mutation.Key,
				position,
				string(mutation.value),
				visibility,
				afterRevision,
				createdAt.Format(time.RFC3339Nano),
				occurredAt.Format(time.RFC3339Nano),
			); err != nil {
				return Commit{}, fmt.Errorf("put campaign record: %w", err)
			}
		} else {
			if !found {
				return Commit{}, ErrNotFound
			}
			visibility = current.Visibility
			result, err := transaction.ExecContext(ctx, `
				DELETE FROM campaign_records
				WHERE collection_name = ? AND record_key = ?`,
				mutation.Collection,
				mutation.Key,
			)
			if err != nil {
				return Commit{}, fmt.Errorf("delete campaign record: %w", err)
			}
			rows, err := result.RowsAffected()
			if err != nil {
				return Commit{}, fmt.Errorf("read deleted campaign row count: %w", err)
			}
			if rows != 1 {
				return Commit{}, fmt.Errorf("%w: delete affected %d rows", ErrStorageInvariant, rows)
			}
		}
		deletedValue := 0
		if mutation.Kind == Delete {
			deletedValue = 1
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO campaign_record_versions(
				collection_name, record_key, revision, deleted, updated_at
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(collection_name, record_key) DO UPDATE SET
				revision = excluded.revision,
				deleted = excluded.deleted,
				updated_at = excluded.updated_at`,
			mutation.Collection,
			mutation.Key,
			afterRevision,
			deletedValue,
			occurredAt.Format(time.RFC3339Nano),
		); err != nil {
			return Commit{}, fmt.Errorf("advance campaign record revision: %w", err)
		}
		change := changes[mutation.Collection]
		if change == nil {
			change = &collectionChange{}
			changes[mutation.Collection] = change
		}
		change.count++
		if visibility == campaign.VisibilityPublic ||
			(found && current.Visibility == campaign.VisibilityPublic) {
			change.publicCount++
		}
		results = append(results, MutationResult{
			Collection:     mutation.Collection,
			Key:            mutation.Key,
			BeforeRevision: actualRevision,
			AfterRevision:  afterRevision,
			Deleted:        mutation.Kind == Delete,
			Visibility:     visibility,
		})
	}

	commitID, err := recordCommit(ctx, transaction, input.ActorID, occurredAt, prepared, results)
	if err != nil {
		return Commit{}, err
	}
	collectionRevisions := make(map[campaign.Collection]int64, len(changes))
	committedEvents := make([]events.Event, 0, len(changes))
	collections := make([]campaign.Collection, 0, len(changes))
	for collection := range changes {
		collections = append(collections, collection)
	}
	sort.Slice(collections, func(left, right int) bool { return collections[left] < collections[right] })
	for _, collection := range collections {
		var revision int64
		if err := transaction.QueryRowContext(ctx, `
			UPDATE campaign_collections
			SET materialized = 1, revision = revision + 1, updated_at = ?
			WHERE name = ?
			RETURNING revision`,
			occurredAt.Format(time.RFC3339Nano),
			collection,
		).Scan(&revision); err != nil {
			return Commit{}, fmt.Errorf("advance campaign collection revision: %w", err)
		}
		collectionRevisions[collection] = revision
		audience := events.AudienceDM
		visibleCount := changes[collection].count
		if changes[collection].publicCount > 0 {
			audience = events.AudiencePublic
			visibleCount = changes[collection].publicCount
		}
		event, err := store.events.Append(ctx, transaction, events.Publication{
			Audience:   audience,
			Topic:      "campaign-data-changed",
			ResourceID: string(collection),
			Revision:   strconv.FormatInt(revision, 10),
			Metadata: map[string]any{
				"commitId": commitID,
				"records":  visibleCount,
			},
		})
		if err != nil {
			return Commit{}, fmt.Errorf("append campaign change event: %w", err)
		}
		committedEvents = append(committedEvents, event)
	}

	if err := transaction.Commit(); err != nil {
		return Commit{}, fmt.Errorf("commit campaign transaction: %w", err)
	}
	for _, event := range committedEvents {
		store.events.NotifyCommitted(event)
	}
	return Commit{
		ID:                  commitID,
		OccurredAt:          occurredAt,
		Results:             results,
		CollectionRevisions: collectionRevisions,
	}, nil
}

func (store *Store) verifySchema(ctx context.Context) error {
	rows, err := store.db.QueryContext(ctx, `SELECT name, shape FROM campaign_collections ORDER BY name`)
	if err != nil {
		return fmt.Errorf("%w: read campaign collection schema: %v", ErrInvalidConfig, err)
	}
	defer rows.Close()
	actual := make(map[campaign.Collection]campaign.Shape)
	for rows.Next() {
		var collection campaign.Collection
		var shape campaign.Shape
		if err := rows.Scan(&collection, &shape); err != nil {
			return fmt.Errorf("%w: scan campaign collection schema: %v", ErrInvalidConfig, err)
		}
		actual[collection] = shape
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("%w: iterate campaign collection schema: %v", ErrInvalidConfig, err)
	}
	if len(actual) != len(campaign.Descriptors()) {
		return fmt.Errorf("%w: campaign collection schema is incomplete", ErrInvalidConfig)
	}
	for _, descriptor := range campaign.Descriptors() {
		if actual[descriptor.Name] != descriptor.Shape {
			return fmt.Errorf(
				"%w: collection %s shape is %q, want %q",
				ErrInvalidConfig,
				descriptor.Name,
				actual[descriptor.Name],
				descriptor.Shape,
			)
		}
	}
	return nil
}

func collectionStates(ctx context.Context, reader recordRowsQuery) ([]CollectionState, error) {
	rows, err := reader.QueryContext(ctx, `
		SELECT name, shape, materialized, revision, updated_at
		FROM campaign_collections
		ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("read campaign collection states: %w", err)
	}
	defer rows.Close()
	states := make([]CollectionState, 0, len(campaign.Descriptors()))
	for rows.Next() {
		var state CollectionState
		var materialized int
		var updatedAt sql.NullString
		if err := rows.Scan(
			&state.Collection,
			&state.Shape,
			&materialized,
			&state.Revision,
			&updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan campaign collection state: %w", err)
		}
		state.Materialized = materialized == 1
		if updatedAt.Valid {
			parsed, err := time.Parse(time.RFC3339Nano, updatedAt.String)
			if err != nil {
				return nil, fmt.Errorf("%w: invalid collection timestamp", ErrStorageInvariant)
			}
			state.UpdatedAt = &parsed
		}
		states = append(states, state)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate campaign collection states: %w", err)
	}
	return states, nil
}

func prepareTransaction(input Transaction) ([]preparedMutation, error) {
	if !validActorID(input.ActorID) || len(input.Mutations) == 0 || len(input.Mutations) > MaximumMutations {
		return nil, fmt.Errorf(
			"%w: actor and 1-%d mutations are required",
			ErrInvalidTransaction,
			MaximumMutations,
		)
	}
	prepared := make([]preparedMutation, 0, len(input.Mutations))
	targets := make(map[string]struct{}, len(input.Mutations))
	for _, mutation := range input.Mutations {
		descriptor, ok := campaign.Describe(mutation.Collection)
		if !ok || mutation.ExpectedRevision < 0 ||
			(mutation.Kind != Put && mutation.Kind != Delete) {
			return nil, fmt.Errorf("%w: malformed mutation", ErrInvalidTransaction)
		}
		if err := campaign.ValidateKey(descriptor, mutation.Key); err != nil {
			return nil, err
		}
		target := string(mutation.Collection) + "\x00" + mutation.Key
		if _, duplicate := targets[target]; duplicate {
			return nil, fmt.Errorf("%w: duplicate mutation target", ErrInvalidTransaction)
		}
		targets[target] = struct{}{}
		entry := preparedMutation{Mutation: mutation}
		if mutation.Kind == Put {
			value, visibility, err := campaign.NormalizeRecord(descriptor, mutation.Key, mutation.Value)
			if err != nil {
				return nil, err
			}
			entry.value = value
			entry.visibility = visibility
		} else if mutation.ExpectedRevision == 0 || len(mutation.Value) != 0 {
			return nil, fmt.Errorf(
				"%w: delete requires a positive expected revision and no value",
				ErrInvalidTransaction,
			)
		}
		prepared = append(prepared, entry)
	}
	return prepared, nil
}

func validActorID(value string) bool {
	if len(value) == 0 || len(value) > 200 || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

type recordScanner interface {
	Scan(...any) error
}

type recordRowsQuery interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type recordQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readRecordVersion(
	ctx context.Context,
	query recordQuery,
	collection campaign.Collection,
	key string,
) (revision int64, deleted bool, found bool, err error) {
	var deletedValue int
	err = query.QueryRowContext(ctx, `
		SELECT revision, deleted
		FROM campaign_record_versions
		WHERE collection_name = ? AND record_key = ?`,
		collection,
		key,
	).Scan(&revision, &deletedValue)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, false, nil
	}
	if err != nil {
		return 0, false, false, fmt.Errorf("read campaign record revision: %w", err)
	}
	if revision < 1 || (deletedValue != 0 && deletedValue != 1) {
		return 0, false, false, ErrStorageInvariant
	}
	return revision, deletedValue == 1, true, nil
}

func readRecord(
	ctx context.Context,
	query recordQuery,
	collection campaign.Collection,
	key string,
) (Record, bool, error) {
	record, err := scanRecord(query.QueryRowContext(ctx, `
		SELECT collection_name, record_key, position, body_json, visibility,
		       revision, created_at, updated_at
		FROM campaign_records
		WHERE collection_name = ? AND record_key = ?`,
		collection,
		key,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, err
	}
	return record, true, nil
}

func scanRecord(scanner recordScanner) (Record, error) {
	var record Record
	var value, createdAt, updatedAt string
	if err := scanner.Scan(
		&record.Collection,
		&record.Key,
		&record.Position,
		&value,
		&record.Visibility,
		&record.Revision,
		&createdAt,
		&updatedAt,
	); err != nil {
		return Record{}, err
	}
	created, createdErr := time.Parse(time.RFC3339Nano, createdAt)
	updated, updatedErr := time.Parse(time.RFC3339Nano, updatedAt)
	if createdErr != nil || updatedErr != nil || !json.Valid([]byte(value)) ||
		record.Revision < 1 || record.Position < 0 ||
		(record.Visibility != campaign.VisibilityPublic && record.Visibility != campaign.VisibilityDM) {
		return Record{}, ErrStorageInvariant
	}
	record.Value = json.RawMessage(value)
	record.CreatedAt = created
	record.UpdatedAt = updated
	return record, nil
}

func nextPosition(
	ctx context.Context,
	transaction *sql.Tx,
	collection campaign.Collection,
) (int64, error) {
	var position int64
	if err := transaction.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(position), -1) + 1
		FROM campaign_records
		WHERE collection_name = ?`,
		collection,
	).Scan(&position); err != nil {
		return 0, fmt.Errorf("allocate campaign record position: %w", err)
	}
	return position, nil
}

func recordCommit(
	ctx context.Context,
	transaction *sql.Tx,
	actorID string,
	occurredAt time.Time,
	mutations []preparedMutation,
	results []MutationResult,
) (int64, error) {
	insert, err := transaction.ExecContext(ctx, `
		INSERT INTO campaign_commits(actor_id, occurred_at, mutation_count)
		VALUES (?, ?, ?)`,
		actorID,
		occurredAt.Format(time.RFC3339Nano),
		len(mutations),
	)
	if err != nil {
		return 0, fmt.Errorf("record campaign commit: %w", err)
	}
	commitID, err := insert.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("read campaign commit id: %w", err)
	}
	for index, mutation := range mutations {
		result := results[index]
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO campaign_commit_records(
				commit_id, ordinal, collection_name, record_key, action,
				before_revision, after_revision, visibility
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			commitID,
			index,
			mutation.Collection,
			mutation.Key,
			mutation.Kind,
			result.BeforeRevision,
			result.AfterRevision,
			result.Visibility,
		); err != nil {
			return 0, fmt.Errorf("record campaign commit target: %w", err)
		}
	}
	return commitID, nil
}
