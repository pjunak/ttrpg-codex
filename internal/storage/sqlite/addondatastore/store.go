package addondatastore

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/unitofwork"
)

const (
	MaximumOperations    = 256
	MaximumDocumentBytes = 256 << 10
	MaximumPayloadBytes  = 2 << 20
	MaximumPageDocuments = 500
)

var (
	ErrInvalidConfig      = errors.New("invalid add-on data store configuration")
	ErrInvalidTransaction = errors.New("invalid add-on data transaction")
	ErrConflict           = errors.New("add-on document revision conflict")
	ErrNotFound           = errors.New("add-on document not found")
	ErrSchemaMismatch     = errors.New("add-on data schema identity mismatch")
	ErrStorageInvariant   = errors.New("add-on document storage invariant failed")
	addonIDPattern        = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)
	localIDPattern        = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`)
)

type OperationKind string

const (
	Put    OperationKind = "put"
	Delete OperationKind = "delete"
)

type Document struct {
	AddonID         string
	Kind            datacontract.Kind
	DataID          string
	Key             string
	Position        int64
	Value           json.RawMessage
	SchemaVersion   string
	SchemaSHA256    string
	TargetCreatedAt *time.Time
	Revision        int64
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type State struct {
	AddonID       string
	Kind          datacontract.Kind
	DataID        string
	Materialized  bool
	Revision      int64
	SchemaVersion string
	SchemaSHA256  string
	Target        string
	Keyed         bool
	UpdatedAt     *time.Time
}

type Mutation struct {
	Kind             OperationKind
	Definition       datacontract.Description
	Key              string
	Value            json.RawMessage
	ExpectedRevision int64
	TargetCreatedAt  *time.Time
	Audience         events.Audience
}

type DataSetRevision struct {
	Kind     datacontract.Kind
	DataID   string
	Revision int64
}

type Transaction struct {
	OperationID      string
	Operation        string
	Summary          string
	ExpectedDataSets []DataSetRevision
	AddonID          string
	GenerationID     string
	ActorID          string
	Mutations        []Mutation
}

type MutationResult struct {
	Kind           datacontract.Kind
	DataID         string
	Key            string
	BeforeRevision int64
	AfterRevision  int64
	Deleted        bool
}

type Commit struct {
	ID            int64
	OccurredAt    time.Time
	Results       []MutationResult
	DataRevisions map[string]int64
}

type Snapshot struct {
	States    []State
	Documents []Document
}

type EventJournal interface {
	Append(context.Context, *sql.Tx, events.Publication) (events.Event, error)
	NotifyCommitted(events.Event)
}

type Config struct {
	BeforeWrite func(context.Context, *sql.Tx) error
	DB          *sql.DB
	Events      EventJournal
	Now         func() time.Time
}

type Store struct {
	beforeWrite func(context.Context, *sql.Tx) error
	database    *sql.DB
	events      EventJournal
	now         func() time.Time
}

type preparedMutation struct {
	Mutation
	value json.RawMessage
}

type setChange struct {
	audience events.Audience
}

func New(config Config) (*Store, error) {
	if config.DB == nil || config.Events == nil {
		return nil, fmt.Errorf("%w: database and event journal are required", ErrInvalidConfig)
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if _, err := config.DB.Exec(`SELECT addon_id FROM addon_data_sets LIMIT 0`); err != nil {
		return nil, fmt.Errorf("%w: add-on data schema is unavailable: %v", ErrInvalidConfig, err)
	}
	return &Store{database: config.DB, events: config.Events, now: config.Now, beforeWrite: config.BeforeWrite}, nil
}

func (store *Store) Get(
	ctx context.Context,
	addonID string,
	kind datacontract.Kind,
	dataID string,
	key string,
) (Document, error) {
	if !validIdentity(addonID, kind, dataID, key) {
		return Document{}, ErrInvalidTransaction
	}
	document, found, err := readDocument(ctx, store.database, addonID, kind, dataID, key)
	if err != nil {
		return Document{}, err
	}
	if !found {
		return Document{}, ErrNotFound
	}
	return document, nil
}

func (store *Store) List(
	ctx context.Context,
	addonID string,
	kind datacontract.Kind,
	dataID string,
) ([]Document, error) {
	if !validDataIdentity(addonID, kind, dataID) {
		return nil, ErrInvalidTransaction
	}
	return listDocuments(ctx, store.database, addonID, kind, dataID)
}

// QueryPage returns one stable insertion-order page after the supplied
// position. Callers own visibility filtering and higher-level declared-index
// predicates; this storage boundary never accepts raw SQL fragments.
func (store *Store) QueryPage(
	ctx context.Context,
	addonID string,
	kind datacontract.Kind,
	dataID string,
	afterPosition int64,
	limit int,
) ([]Document, error) {
	if !validDataIdentity(addonID, kind, dataID) || afterPosition < -1 ||
		limit < 1 || limit > MaximumPageDocuments {
		return nil, ErrInvalidTransaction
	}
	rows, err := store.database.QueryContext(ctx, `
		SELECT addon_id, data_kind, data_id, document_key, position, body_json,
		       schema_version, schema_sha256, revision, created_at, updated_at,
		       target_created_at
		FROM addon_documents
		WHERE addon_id = ? AND data_kind = ? AND data_id = ? AND position > ?
		ORDER BY position, document_key
		LIMIT ?`, addonID, kind, dataID, afterPosition, limit)
	if err != nil {
		return nil, fmt.Errorf("query add-on document page: %w", err)
	}
	defer rows.Close()
	result := make([]Document, 0, limit)
	for rows.Next() {
		document, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, document)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate add-on document page: %w", err)
	}
	return result, nil
}

func (store *Store) State(
	ctx context.Context,
	addonID string,
	kind datacontract.Kind,
	dataID string,
) (State, error) {
	if !validDataIdentity(addonID, kind, dataID) {
		return State{}, ErrInvalidTransaction
	}
	return readState(ctx, store.database, addonID, kind, dataID)
}

func (store *Store) SnapshotAddon(ctx context.Context, addonID string) (Snapshot, error) {
	if !validAddonID(addonID) {
		return Snapshot{}, ErrInvalidTransaction
	}
	transaction, err := store.database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Snapshot{}, fmt.Errorf("begin add-on data snapshot: %w", err)
	}
	defer transaction.Rollback()
	snapshot, err := snapshotAddonTx(ctx, transaction, addonID)
	if err != nil {
		return Snapshot{}, err
	}
	if err := transaction.Commit(); err != nil {
		return Snapshot{}, err
	}
	return snapshot, nil
}

func snapshotAddonTx(ctx context.Context, transaction *sql.Tx, addonID string) (Snapshot, error) {
	rows, err := transaction.QueryContext(ctx, `
  SELECT addon_id, data_kind, data_id, materialized, revision,
		       schema_version, schema_sha256, target_collection, keyed, updated_at
		FROM addon_data_sets WHERE addon_id = ?
		ORDER BY data_kind, data_id`, addonID)
	if err != nil {
		return Snapshot{}, fmt.Errorf("list add-on data states: %w", err)
	}
	states := make([]State, 0)
	for rows.Next() {
		state, err := scanState(rows)
		if err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		states = append(states, state)
	}
	rowsErr := rows.Err()
	closeErr := rows.Close()
	if err := errors.Join(rowsErr, closeErr); err != nil {
		return Snapshot{}, fmt.Errorf("iterate add-on data states: %w", err)
	}
	documents := make([]Document, 0)
	for _, state := range states {
		values, err := listDocuments(ctx, transaction, addonID, state.Kind, state.DataID)
		if err != nil {
			return Snapshot{}, err
		}
		documents = append(documents, values...)
	}
	return Snapshot{States: states, Documents: documents}, nil
}

func (store *Store) Transact(ctx context.Context, input Transaction) (Commit, error) {
	if err := validateOperation(input); err != nil {
		return Commit{}, err
	}
	prepared, err := prepareTransaction(input)
	if err != nil {
		return Commit{}, err
	}
	transaction, cleanup, err := unitofwork.Begin(ctx, store.database)
	if err != nil {
		return Commit{}, fmt.Errorf("begin add-on data transaction: %w", err)
	}
	defer cleanup()
	if store.beforeWrite != nil {
		if err := store.beforeWrite(ctx, transaction); err != nil {
			return Commit{}, err
		}
	}
	if receipt, err := operationReceipt(ctx, transaction, input); err != nil {
		return Commit{}, err
	} else if receipt != nil {
		return *receipt, nil
	}
	// Check the entire read set before touching documents, journal, or revisions.
	for _, expected := range input.ExpectedDataSets {
		state, err := readState(ctx, transaction, input.AddonID, expected.Kind, expected.DataID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return Commit{}, err
		}
		if state.Revision != expected.Revision {
			return Commit{}, fmt.Errorf("%w: %s %q changed since it was read", ErrConflict, expected.Kind, expected.DataID)
		}
	}
	occurredAt := store.now().UTC()
	timestamp := occurredAt.Format(time.RFC3339Nano)
	results := make([]MutationResult, 0, len(prepared))
	changes := make(map[string]*setChange)

	for _, mutation := range prepared {
		definition := mutation.Definition
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO addon_data_sets(
				addon_id, data_kind, data_id, schema_version, schema_sha256, target_collection, keyed
			) VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?)
			ON CONFLICT(addon_id, data_kind, data_id) DO UPDATE SET
				schema_version = excluded.schema_version,
				schema_sha256 = excluded.schema_sha256,
				target_collection = excluded.target_collection,
				keyed = excluded.keyed
			WHERE addon_data_sets.materialized = 0 OR (
				addon_data_sets.schema_version = excluded.schema_version AND
				addon_data_sets.schema_sha256 = excluded.schema_sha256 AND
				addon_data_sets.target_collection IS excluded.target_collection AND
				addon_data_sets.keyed = excluded.keyed
			)`,
			input.AddonID, definition.Kind, definition.ID, definition.SchemaVersion,
			definition.SchemaSHA256, definition.Target, boolInt(definition.Keyed),
		); err != nil {
			return Commit{}, fmt.Errorf("materialize add-on data set: %w", err)
		}
		var storedSchemaVersion, storedSchemaSHA256 string
		var storedTarget sql.NullString
		var storedKeyed int
		if err := transaction.QueryRowContext(ctx, `
			SELECT schema_version, schema_sha256, target_collection, keyed
			FROM addon_data_sets
			WHERE addon_id = ? AND data_kind = ? AND data_id = ?`,
			input.AddonID, definition.Kind, definition.ID,
		).Scan(&storedSchemaVersion, &storedSchemaSHA256, &storedTarget, &storedKeyed); err != nil {
			return Commit{}, fmt.Errorf("read add-on data schema identity: %w", err)
		}
		if storedSchemaVersion != definition.SchemaVersion || storedSchemaSHA256 != definition.SchemaSHA256 ||
			storedTarget.String != definition.Target || storedTarget.Valid != (definition.Target != "") ||
			storedKeyed != boolInt(definition.Keyed) {
			return Commit{}, ErrSchemaMismatch
		}
		current, found, err := readDocument(
			ctx, transaction, input.AddonID, definition.Kind, definition.ID, mutation.Key,
		)
		if err != nil {
			return Commit{}, err
		}
		actualRevision, deleted, versionFound, err := readDocumentVersion(
			ctx, transaction, input.AddonID, definition.Kind, definition.ID, mutation.Key,
		)
		if err != nil {
			return Commit{}, err
		}
		if found && (!versionFound || deleted || current.Revision != actualRevision) ||
			!found && versionFound && !deleted {
			return Commit{}, ErrStorageInvariant
		}
		if mutation.ExpectedRevision != actualRevision {
			return Commit{}, &ConflictError{
				Kind: definition.Kind, DataID: definition.ID, Key: mutation.Key,
				Expected: mutation.ExpectedRevision, Actual: actualRevision,
			}
		}
		afterRevision := actualRevision + 1
		if mutation.Kind == Put {
			position := current.Position
			createdAt := current.CreatedAt
			if !found {
				position, err = nextPosition(ctx, transaction, input.AddonID, definition.Kind, definition.ID)
				if err != nil {
					return Commit{}, err
				}
				createdAt = occurredAt
			}
			if _, err := transaction.ExecContext(ctx, `
				INSERT INTO addon_documents(
					addon_id, data_kind, data_id, document_key, position, body_json,
					schema_version, schema_sha256, revision, created_at, updated_at,
					target_created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(addon_id, data_kind, data_id, document_key) DO UPDATE SET
					body_json = excluded.body_json,
					schema_version = excluded.schema_version,
					schema_sha256 = excluded.schema_sha256,
					revision = excluded.revision,
					updated_at = excluded.updated_at,
					target_created_at = excluded.target_created_at`,
				input.AddonID, definition.Kind, definition.ID, mutation.Key, position,
				string(mutation.value), definition.SchemaVersion, definition.SchemaSHA256,
				afterRevision, createdAt.Format(time.RFC3339Nano), timestamp,
				nullTime(mutation.TargetCreatedAt),
			); err != nil {
				return Commit{}, fmt.Errorf("put add-on document: %w", err)
			}
		} else {
			if !found {
				return Commit{}, ErrNotFound
			}
			result, err := transaction.ExecContext(ctx, `
				DELETE FROM addon_documents
				WHERE addon_id = ? AND data_kind = ? AND data_id = ? AND document_key = ?`,
				input.AddonID, definition.Kind, definition.ID, mutation.Key,
			)
			if err != nil {
				return Commit{}, fmt.Errorf("delete add-on document: %w", err)
			}
			changed, err := result.RowsAffected()
			if err != nil || changed != 1 {
				return Commit{}, ErrStorageInvariant
			}
		}
		deletedValue := 0
		if mutation.Kind == Delete {
			deletedValue = 1
		}
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO addon_document_versions(
				addon_id, data_kind, data_id, document_key, revision, deleted, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(addon_id, data_kind, data_id, document_key) DO UPDATE SET
				revision = excluded.revision,
				deleted = excluded.deleted,
				updated_at = excluded.updated_at`,
			input.AddonID, definition.Kind, definition.ID, mutation.Key,
			afterRevision, deletedValue, timestamp,
		); err != nil {
			return Commit{}, fmt.Errorf("advance add-on document revision: %w", err)
		}
		if err := retainRevision(ctx, transaction, input, mutation, afterRevision, timestamp); err != nil {
			return Commit{}, err
		}
		setKey := definitionKey(definition.Kind, definition.ID)
		change := changes[setKey]
		if change == nil {
			change = &setChange{audience: mutation.Audience}
			changes[setKey] = change
		} else {
			change.audience = broaderAudience(change.audience, mutation.Audience)
		}
		results = append(results, MutationResult{
			Kind: definition.Kind, DataID: definition.ID, Key: mutation.Key,
			BeforeRevision: actualRevision, AfterRevision: afterRevision,
			Deleted: mutation.Kind == Delete,
		})
	}

	commitID, err := recordCommit(ctx, transaction, input, occurredAt, prepared, results)
	if err != nil {
		return Commit{}, err
	}
	setKeys := make([]string, 0, len(changes))
	for key := range changes {
		setKeys = append(setKeys, key)
	}
	sort.Strings(setKeys)
	dataRevisions := make(map[string]int64, len(setKeys))
	committedEvents := make([]events.Event, 0, len(setKeys))
	for _, setKey := range setKeys {
		kind, dataID := splitDefinitionKey(setKey)
		var revision int64
		if err := transaction.QueryRowContext(ctx, `
			UPDATE addon_data_sets
			SET materialized = 1, revision = revision + 1, updated_at = ?
			WHERE addon_id = ? AND data_kind = ? AND data_id = ?
			RETURNING revision`, timestamp, input.AddonID, kind, dataID,
		).Scan(&revision); err != nil {
			return Commit{}, fmt.Errorf("advance add-on data revision: %w", err)
		}
		dataRevisions[setKey] = revision
		event, err := store.events.Append(ctx, transaction, events.Publication{
			Audience: changes[setKey].audience, Topic: "addon-data-changed",
			ResourceID: input.AddonID + "/" + string(kind) + "/" + dataID,
			Revision:   fmt.Sprintf("%d", revision),
		})
		if err != nil {
			return Commit{}, fmt.Errorf("append add-on data event: %w", err)
		}
		committedEvents = append(committedEvents, event)
	}
	commit := Commit{ID: commitID, OccurredAt: occurredAt, Results: results, DataRevisions: dataRevisions}
	if err := saveOperationReceipt(ctx, transaction, input, commit); err != nil {
		return Commit{}, err
	}
	if err := unitofwork.Commit(ctx, transaction, func() {
		for _, event := range committedEvents {
			store.events.NotifyCommitted(event)
		}
	}); err != nil {
		return Commit{}, fmt.Errorf("commit add-on data transaction: %w", err)
	}
	return Commit{ID: commitID, OccurredAt: occurredAt, Results: results, DataRevisions: dataRevisions}, nil
}

type ConflictError struct {
	Kind     datacontract.Kind
	DataID   string
	Key      string
	Expected int64
	Actual   int64
}

func (err *ConflictError) Error() string {
	return fmt.Sprintf("%s %q document %q revision is %d, expected %d", err.Kind, err.DataID, err.Key, err.Actual, err.Expected)
}

func (err *ConflictError) Unwrap() error { return ErrConflict }

func prepareTransaction(input Transaction) ([]preparedMutation, error) {
	if !validAddonID(input.AddonID) || !validGenerationID(input.GenerationID) ||
		!validActorID(input.ActorID) || len(input.Mutations) == 0 || len(input.Mutations) > MaximumOperations {
		return nil, ErrInvalidTransaction
	}
	if len(input.ExpectedDataSets) > MaximumOperations {
		return nil, ErrInvalidTransaction
	}
	guards := make(map[string]struct{}, len(input.ExpectedDataSets))
	for _, expected := range input.ExpectedDataSets {
		if !validDataIdentity(input.AddonID, expected.Kind, expected.DataID) || expected.Revision < 0 {
			return nil, ErrInvalidTransaction
		}
		identity := definitionKey(expected.Kind, expected.DataID)
		if _, duplicate := guards[identity]; duplicate {
			return nil, ErrInvalidTransaction
		}
		guards[identity] = struct{}{}
	}
	prepared := make([]preparedMutation, 0, len(input.Mutations))
	targets := make(map[string]struct{}, len(input.Mutations))
	totalBytes := 0
	for _, mutation := range input.Mutations {
		definition := mutation.Definition
		if definition.Retained && (input.OperationID == "" || input.Operation == "") {
			return nil, ErrInvalidTransaction
		}
		if !validDefinition(definition) || !validDocumentKey(mutation.Key) ||
			mutation.ExpectedRevision < 0 || (mutation.Kind != Put && mutation.Kind != Delete) ||
			!validAudience(definition.Visibility, mutation.Audience) ||
			(definition.Kind == datacontract.Collection && mutation.TargetCreatedAt != nil) ||
			(definition.Kind == datacontract.RecordExtension && mutation.TargetCreatedAt == nil) {
			return nil, ErrInvalidTransaction
		}
		target := definitionKey(definition.Kind, definition.ID) + "\x00" + mutation.Key
		if _, duplicate := targets[target]; duplicate {
			return nil, fmt.Errorf("%w: duplicate document target", ErrInvalidTransaction)
		}
		targets[target] = struct{}{}
		preparedMutation := preparedMutation{Mutation: mutation}
		if mutation.Kind == Put {
			trimmed := strings.TrimSpace(string(mutation.Value))
			totalBytes += len(trimmed)
			if len(trimmed) == 0 || len(trimmed) > MaximumDocumentBytes || totalBytes > MaximumPayloadBytes ||
				!json.Valid([]byte(trimmed)) {
				return nil, ErrInvalidTransaction
			}
			buffer := &bytes.Buffer{}
			if err := json.Compact(buffer, []byte(trimmed)); err != nil {
				return nil, ErrInvalidTransaction
			}
			preparedMutation.value = json.RawMessage(buffer.String())
		} else if mutation.ExpectedRevision == 0 || len(mutation.Value) != 0 {
			return nil, ErrInvalidTransaction
		}
		prepared = append(prepared, preparedMutation)
	}
	return prepared, nil
}

func validDefinition(value datacontract.Description) bool {
	return (value.Kind == datacontract.Collection && value.Target == "" ||
		value.Kind == datacontract.RecordExtension && localIDPattern.MatchString(value.Target)) &&
		localIDPattern.MatchString(value.ID) && len(value.ID) <= 100 && value.SchemaVersion != "" &&
		len(value.SchemaSHA256) == 64 && lowercaseHex(value.SchemaSHA256)
}

func validAudience(visibility datacontract.Visibility, audience events.Audience) bool {
	switch visibility {
	case datacontract.VisibilityPublic:
		return audience == events.AudiencePublic || audience == events.AudienceDM || audience == events.AudienceSystem
	case datacontract.VisibilityDM:
		return audience == events.AudienceDM || audience == events.AudienceSystem
	case datacontract.VisibilityPrivate:
		return audience == events.AudienceSystem
	default:
		return false
	}
}

func broaderAudience(left, right events.Audience) events.Audience {
	if left == events.AudiencePublic || right == events.AudiencePublic {
		return events.AudiencePublic
	}
	if left == events.AudienceDM || right == events.AudienceDM {
		return events.AudienceDM
	}
	return events.AudienceSystem
}

func validIdentity(addonID string, kind datacontract.Kind, dataID, key string) bool {
	return validDataIdentity(addonID, kind, dataID) && validDocumentKey(key)
}

func validDataIdentity(addonID string, kind datacontract.Kind, dataID string) bool {
	return validAddonID(addonID) && (kind == datacontract.Collection || kind == datacontract.RecordExtension) &&
		localIDPattern.MatchString(dataID) && len(dataID) <= 100
}

func validAddonID(value string) bool { return len(value) <= 80 && addonIDPattern.MatchString(value) }

func validGenerationID(value string) bool { return len(value) == 64 && lowercaseHex(value) }

func lowercaseHex(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && hex.EncodeToString(decoded) == value
}

func validDocumentKey(value string) bool {
	if len(value) == 0 || len(value) > 1024 || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return value != "__proto__" && value != "constructor" && value != "prototype"
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

type documentQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type documentRowsQuery interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readDocument(
	ctx context.Context,
	query documentQuery,
	addonID string,
	kind datacontract.Kind,
	dataID string,
	key string,
) (Document, bool, error) {
	document, err := scanDocument(query.QueryRowContext(ctx, `
		SELECT addon_id, data_kind, data_id, document_key, position, body_json,
		       schema_version, schema_sha256, revision, created_at, updated_at,
		       target_created_at
		FROM addon_documents
		WHERE addon_id = ? AND data_kind = ? AND data_id = ? AND document_key = ?`,
		addonID, kind, dataID, key,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return Document{}, false, nil
	}
	if err != nil {
		return Document{}, false, err
	}
	return document, true, nil
}

func listDocuments(
	ctx context.Context,
	query documentRowsQuery,
	addonID string,
	kind datacontract.Kind,
	dataID string,
) ([]Document, error) {
	rows, err := query.QueryContext(ctx, `
		SELECT addon_id, data_kind, data_id, document_key, position, body_json,
		       schema_version, schema_sha256, revision, created_at, updated_at,
		       target_created_at
		FROM addon_documents
		WHERE addon_id = ? AND data_kind = ? AND data_id = ?
		ORDER BY position, document_key`, addonID, kind, dataID)
	if err != nil {
		return nil, fmt.Errorf("list add-on documents: %w", err)
	}
	defer rows.Close()
	result := make([]Document, 0)
	for rows.Next() {
		document, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, document)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate add-on documents: %w", err)
	}
	return result, nil
}

type rowScanner interface{ Scan(...any) error }

func scanDocument(row rowScanner) (Document, error) {
	var document Document
	var value, createdAt, updatedAt string
	var targetCreatedAt sql.NullString
	if err := row.Scan(
		&document.AddonID, &document.Kind, &document.DataID, &document.Key,
		&document.Position, &value, &document.SchemaVersion, &document.SchemaSHA256,
		&document.Revision, &createdAt, &updatedAt,
		&targetCreatedAt,
	); err != nil {
		return Document{}, err
	}
	var createdErr, updatedErr error
	document.CreatedAt, createdErr = time.Parse(time.RFC3339Nano, createdAt)
	document.UpdatedAt, updatedErr = time.Parse(time.RFC3339Nano, updatedAt)
	if targetCreatedAt.Valid {
		parsed, targetErr := time.Parse(time.RFC3339Nano, targetCreatedAt.String)
		if targetErr != nil {
			return Document{}, ErrStorageInvariant
		}
		document.TargetCreatedAt = &parsed
	}
	if createdErr != nil || updatedErr != nil || document.Position < 0 || document.Revision < 1 ||
		!json.Valid([]byte(value)) || !lowercaseHex(document.SchemaSHA256) {
		return Document{}, ErrStorageInvariant
	}
	document.Value = json.RawMessage(value)
	return document, nil
}

func readDocumentVersion(
	ctx context.Context,
	query documentQuery,
	addonID string,
	kind datacontract.Kind,
	dataID string,
	key string,
) (revision int64, deleted bool, found bool, err error) {
	var deletedValue int
	err = query.QueryRowContext(ctx, `
		SELECT revision, deleted FROM addon_document_versions
		WHERE addon_id = ? AND data_kind = ? AND data_id = ? AND document_key = ?`,
		addonID, kind, dataID, key,
	).Scan(&revision, &deletedValue)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, false, nil
	}
	if err != nil {
		return 0, false, false, fmt.Errorf("read add-on document revision: %w", err)
	}
	if revision < 1 || (deletedValue != 0 && deletedValue != 1) {
		return 0, false, false, ErrStorageInvariant
	}
	return revision, deletedValue == 1, true, nil
}

func readState(
	ctx context.Context,
	query documentQuery,
	addonID string,
	kind datacontract.Kind,
	dataID string,
) (State, error) {
	return scanState(query.QueryRowContext(ctx, `
		SELECT addon_id, data_kind, data_id, materialized, revision,
		       schema_version, schema_sha256, target_collection, keyed, updated_at
		FROM addon_data_sets
		WHERE addon_id = ? AND data_kind = ? AND data_id = ?`, addonID, kind, dataID))
}

func scanState(row rowScanner) (State, error) {
	var state State
	var materialized int
	var schemaVersion, schemaSHA256, target sql.NullString
	var keyed sql.NullInt64
	var updatedAt sql.NullString
	if err := row.Scan(
		&state.AddonID, &state.Kind, &state.DataID, &materialized, &state.Revision,
		&schemaVersion, &schemaSHA256, &target, &keyed, &updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return State{}, ErrNotFound
		}
		return State{}, err
	}
	if (materialized != 0 && materialized != 1) || state.Revision < 0 {
		return State{}, ErrStorageInvariant
	}
	state.Materialized = materialized == 1
	state.SchemaVersion = schemaVersion.String
	state.SchemaSHA256 = schemaSHA256.String
	state.Target = target.String
	state.Keyed = keyed.Int64 == 1
	if state.Materialized && (!schemaVersion.Valid || !schemaSHA256.Valid || len(state.SchemaSHA256) != 64 ||
		!lowercaseHex(state.SchemaSHA256) || !keyed.Valid || (keyed.Int64 != 0 && keyed.Int64 != 1) ||
		(state.Kind == datacontract.RecordExtension) != target.Valid ||
		(state.Kind == datacontract.RecordExtension && state.Keyed)) {
		return State{}, ErrStorageInvariant
	}
	if updatedAt.Valid {
		parsed, err := time.Parse(time.RFC3339Nano, updatedAt.String)
		if err != nil {
			return State{}, ErrStorageInvariant
		}
		state.UpdatedAt = &parsed
	}
	return state, nil
}

func nextPosition(
	ctx context.Context,
	transaction *sql.Tx,
	addonID string,
	kind datacontract.Kind,
	dataID string,
) (int64, error) {
	var position int64
	if err := transaction.QueryRowContext(ctx, `
		UPDATE addon_data_sets
		SET next_position = next_position + 1
		WHERE addon_id = ? AND data_kind = ? AND data_id = ?
		RETURNING next_position - 1`, addonID, kind, dataID,
	).Scan(&position); err != nil {
		return 0, fmt.Errorf("allocate add-on document position: %w", err)
	}
	return position, nil
}

func recordCommit(
	ctx context.Context,
	transaction *sql.Tx,
	input Transaction,
	occurredAt time.Time,
	mutations []preparedMutation,
	results []MutationResult,
) (int64, error) {
	result, err := transaction.ExecContext(ctx, `
		INSERT INTO addon_data_commits(addon_id, generation_id, actor_id, occurred_at, operation_count)
		VALUES (?, ?, ?, ?, ?)`, input.AddonID, input.GenerationID, input.ActorID,
		occurredAt.Format(time.RFC3339Nano), len(mutations))
	if err != nil {
		return 0, fmt.Errorf("record add-on data commit: %w", err)
	}
	commitID, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("read add-on data commit id: %w", err)
	}
	for ordinal, mutation := range mutations {
		mutationResult := results[ordinal]
		if _, err := transaction.ExecContext(ctx, `
			INSERT INTO addon_data_commit_records(
				commit_id, ordinal, data_kind, data_id, document_key, action,
				before_revision, after_revision
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, commitID, ordinal,
			mutation.Definition.Kind, mutation.Definition.ID, mutation.Key, mutation.Kind,
			mutationResult.BeforeRevision, mutationResult.AfterRevision,
		); err != nil {
			return 0, fmt.Errorf("record add-on data commit target: %w", err)
		}
	}
	return commitID, nil
}

func definitionKey(kind datacontract.Kind, id string) string { return string(kind) + "\x00" + id }

func splitDefinitionKey(value string) (datacontract.Kind, string) {
	parts := strings.SplitN(value, "\x00", 2)
	return datacontract.Kind(parts[0]), parts[1]
}

func nullTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
