// Package addondata owns generation-scoped access to add-on collections and
// record extensions. Package schemas are authoritative; workers never supply
// definitions, visibility, or validators with a data request.
package addondata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/events"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

const (
	MaximumLifecycleIssues = 100
	MaximumQueryConditions = 8
	MaximumQueryDocuments  = 200
	MaximumQueryScan       = 10_000
	MaximumQueryValueBytes = 3 << 19
)

var (
	ErrInvalidConfig       = errors.New("invalid add-on data service configuration")
	ErrInvalidRequest      = errors.New("invalid add-on data request")
	ErrInactiveGeneration  = errors.New("add-on data generation is not active")
	ErrUnauthorized        = errors.New("add-on data access is unauthorized")
	ErrTargetNotFound      = errors.New("record-extension target not found")
	ErrTargetReplaced      = errors.New("record-extension target was replaced")
	ErrUniqueIndexConflict = errors.New("add-on collection unique index conflict")
	ErrMigrationRequired   = errors.New("add-on data migration is required")
)

type Repository interface {
	State(context.Context, string, datacontract.Kind, string) (addondatastore.State, error)
	Get(context.Context, string, datacontract.Kind, string, string) (addondatastore.Document, error)
	List(context.Context, string, datacontract.Kind, string) ([]addondatastore.Document, error)
	QueryPage(context.Context, string, datacontract.Kind, string, int64, int) ([]addondatastore.Document, error)
	SnapshotAddon(context.Context, string) (addondatastore.Snapshot, error)
	Transact(context.Context, addondatastore.Transaction) (addondatastore.Commit, error)
}

type CoreRecords interface {
	Get(context.Context, campaign.Collection, string) (campaign.Record, error)
}

type Role string

const (
	RolePlayer Role = "player"
	RoleDM     Role = "dm"
	RoleSystem Role = "system"
)

type Access struct {
	AddonID    string
	Generation string
	Role       Role
	ActorID    string
}

type Mutation struct {
	Kind             addondatastore.OperationKind
	DataKind         datacontract.Kind
	DataID           string
	Key              string
	Value            json.RawMessage
	ExpectedRevision int64
}

type Transaction struct {
	ExpectedDataSets []addondatastore.DataSetRevision
	Access           Access
	Mutations        []Mutation
}

type QueryCondition struct {
	Path   string
	Equals json.RawMessage
}

type Query struct {
	IncludeDataRevision  bool
	ExpectedDataRevision *int64
	Access               Access
	DataKind             datacontract.Kind
	DataID               string
	AfterPosition        int64
	Limit                int
	Where                []QueryCondition
}

type QueryResult struct {
	DataRevision *int64
	Documents    []addondatastore.Document
	NextPosition *int64
}

type activeRegistry struct {
	generation string
	registry   *datacontract.Registry
}

type Service struct {
	repository Repository
	core       CoreRecords

	// Writes and lifecycle transitions are deliberately serialized. This makes
	// unique indexes deterministic and lets a package switch quiesce all calls.
	mu     sync.RWMutex
	active map[string]activeRegistry
}

func New(repository Repository, core CoreRecords) (*Service, error) {
	if repository == nil || core == nil {
		return nil, ErrInvalidConfig
	}
	return &Service{repository: repository, core: core, active: make(map[string]activeRegistry)}, nil
}

func (service *Service) Get(
	ctx context.Context,
	access Access,
	kind datacontract.Kind,
	dataID string,
	key string,
) (addondatastore.Document, error) {
	service.mu.RLock()
	defer service.mu.RUnlock()
	description, err := service.authorizeDefinition(access, kind, dataID)
	if err != nil {
		return addondatastore.Document{}, err
	}
	document, err := service.repository.Get(ctx, access.AddonID, kind, dataID, key)
	if err != nil {
		return addondatastore.Document{}, err
	}
	if err := service.authorizeDocument(ctx, access.Role, description, document); err != nil {
		return addondatastore.Document{}, err
	}
	return document, nil
}

func (service *Service) List(
	ctx context.Context,
	access Access,
	kind datacontract.Kind,
	dataID string,
) ([]addondatastore.Document, error) {
	service.mu.RLock()
	defer service.mu.RUnlock()
	description, err := service.authorizeDefinition(access, kind, dataID)
	if err != nil {
		return nil, err
	}
	documents, err := service.repository.List(ctx, access.AddonID, kind, dataID)
	if err != nil {
		return nil, err
	}
	if kind == datacontract.Collection {
		return documents, nil
	}
	visible := make([]addondatastore.Document, 0, len(documents))
	for _, document := range documents {
		err := service.authorizeDocument(ctx, access.Role, description, document)
		if errors.Is(err, ErrTargetNotFound) || errors.Is(err, ErrTargetReplaced) ||
			errors.Is(err, ErrUnauthorized) {
			continue
		}
		if err != nil {
			return nil, err
		}
		visible = append(visible, document)
	}
	return visible, nil
}

func (service *Service) Query(ctx context.Context, query Query) (QueryResult, error) {
	service.mu.RLock()
	defer service.mu.RUnlock()
	if query.AfterPosition < -1 || query.Limit < 1 || query.Limit > MaximumQueryDocuments ||
		len(query.Where) > MaximumQueryConditions || (query.ExpectedDataRevision != nil && *query.ExpectedDataRevision < 0) {
		return QueryResult{}, ErrInvalidRequest
	}
	description, err := service.authorizeDefinition(query.Access, query.DataKind, query.DataID)
	if err != nil {
		return QueryResult{}, err
	}
	conditions, err := prepareConditions(description, query.Where)
	if err != nil {
		return QueryResult{}, err
	}
	result := QueryResult{Documents: make([]addondatastore.Document, 0, query.Limit)}
	if query.IncludeDataRevision || query.ExpectedDataRevision != nil {
		// A set revision includes changes to documents a player may not see.
		if query.Access.Role == RolePlayer {
			return QueryResult{}, ErrUnauthorized
		}
		state, err := service.repository.State(ctx, query.Access.AddonID, query.DataKind, query.DataID)
		if err != nil && !errors.Is(err, addondatastore.ErrNotFound) {
			return QueryResult{}, err
		}
		if query.ExpectedDataRevision != nil && *query.ExpectedDataRevision != state.Revision {
			return QueryResult{}, addondatastore.ErrConflict
		}
		result.DataRevision = &state.Revision
	}
	after := query.AfterPosition
	scanned := 0
	valueBytes := 0
	for scanned < MaximumQueryScan && len(result.Documents) < query.Limit {
		pageLimit := min(addondatastore.MaximumPageDocuments, MaximumQueryScan-scanned)
		page, err := service.repository.QueryPage(
			ctx, query.Access.AddonID, query.DataKind, query.DataID, after, pageLimit,
		)
		if err != nil {
			return QueryResult{}, err
		}
		if len(page) == 0 {
			break
		}
		for index, document := range page {
			previousPosition := after
			after = document.Position
			scanned++
			if err := service.authorizeDocument(ctx, query.Access.Role, description, document); err != nil {
				if errors.Is(err, ErrTargetNotFound) || errors.Is(err, ErrTargetReplaced) || errors.Is(err, ErrUnauthorized) {
					continue
				}
				return QueryResult{}, err
			}
			matches, err := matchesConditions(document.Value, conditions)
			if err != nil {
				return QueryResult{}, err
			}
			if matches {
				documentBytes := len(document.Key) + len(document.Value)
				if len(result.Documents) > 0 && valueBytes+documentBytes > MaximumQueryValueBytes {
					cursor := previousPosition
					result.NextPosition = &cursor
					return result, nil
				}
				result.Documents = append(result.Documents, document)
				valueBytes += documentBytes
			}
			if len(result.Documents) == query.Limit {
				if index+1 < len(page) || len(page) == pageLimit {
					cursor := after
					result.NextPosition = &cursor
				}
				break
			}
		}
		if len(result.Documents) == query.Limit || len(page) < pageLimit {
			break
		}
	}
	if result.NextPosition == nil && scanned == MaximumQueryScan {
		cursor := after
		result.NextPosition = &cursor
	}
	return result, nil
}

func (service *Service) Transact(ctx context.Context, input Transaction) (addondatastore.Commit, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if len(input.Mutations) == 0 || !validAccess(input.Access) {
		return addondatastore.Commit{}, ErrInvalidRequest
	}
	active, exists := service.active[input.Access.AddonID]
	if !exists || active.generation != input.Access.Generation {
		return addondatastore.Commit{}, ErrInactiveGeneration
	}
	if len(input.ExpectedDataSets) > addondatastore.MaximumOperations {
		return addondatastore.Commit{}, ErrInvalidRequest
	}
	if len(input.ExpectedDataSets) > 0 && input.Access.Role == RolePlayer {
		return addondatastore.Commit{}, ErrUnauthorized
	}
	seen := make(map[string]struct{}, len(input.ExpectedDataSets))
	for _, expected := range input.ExpectedDataSets {
		if expected.Revision < 0 {
			return addondatastore.Commit{}, ErrInvalidRequest
		}
		if _, err := service.authorizeDefinition(input.Access, expected.Kind, expected.DataID); err != nil {
			return addondatastore.Commit{}, err
		}
		identity := string(expected.Kind) + "\x00" + expected.DataID
		if _, duplicate := seen[identity]; duplicate {
			return addondatastore.Commit{}, ErrInvalidRequest
		}
		seen[identity] = struct{}{}
	}
	prepared := make([]addondatastore.Mutation, 0, len(input.Mutations))
	for _, mutation := range input.Mutations {
		description, err := active.registry.Description(mutation.DataKind, mutation.DataID)
		if err != nil {
			return addondatastore.Commit{}, ErrInvalidRequest
		}
		if !roleCanAccess(input.Access.Role, description.Visibility) {
			return addondatastore.Commit{}, ErrUnauthorized
		}
		stored := addondatastore.Mutation{
			Kind: mutation.Kind, Definition: description, Key: mutation.Key,
			Value:            append(json.RawMessage(nil), mutation.Value...),
			ExpectedRevision: mutation.ExpectedRevision,
		}
		if mutation.Kind == addondatastore.Put {
			if err := active.registry.Validate(mutation.DataKind, mutation.DataID, mutation.Value); err != nil {
				return addondatastore.Commit{}, err
			}
			if mutation.DataKind == datacontract.Collection && !description.Keyed &&
				!documentIDMatches(mutation.Value, mutation.Key) {
				return addondatastore.Commit{}, fmt.Errorf("%w: list collection document id must equal its key", ErrInvalidRequest)
			}
		}
		if mutation.DataKind == datacontract.RecordExtension {
			target, err := service.coreTarget(ctx, description, mutation.Key)
			if err != nil {
				return addondatastore.Commit{}, err
			}
			if input.Access.Role == RolePlayer && target.Visibility != campaign.VisibilityPublic {
				return addondatastore.Commit{}, ErrUnauthorized
			}
			createdAt := target.CreatedAt
			stored.TargetCreatedAt = &createdAt
			stored.Audience = extensionAudience(description.Visibility, target.Visibility)
		} else {
			stored.Audience = collectionAudience(description.Visibility)
		}
		prepared = append(prepared, stored)
	}
	if err := service.validateUniqueIndexes(ctx, input.Access.AddonID, prepared); err != nil {
		return addondatastore.Commit{}, err
	}
	return service.repository.Transact(ctx, addondatastore.Transaction{
		AddonID: input.Access.AddonID, GenerationID: input.Access.Generation,
		ActorID: actorLabel(input.Access), Mutations: prepared, ExpectedDataSets: input.ExpectedDataSets,
	})
}

func (service *Service) ReviewActivation(
	ctx context.Context,
	addonID string,
	registry *datacontract.Registry,
) ([]datalifecycle.Issue, error) {
	service.mu.RLock()
	defer service.mu.RUnlock()
	return service.reviewActivationLocked(ctx, addonID, registry)
}

func (service *Service) BeginActivation(
	ctx context.Context,
	addonID string,
	generation string,
	registry *datacontract.Registry,
) (datalifecycle.Transition, error) {
	service.mu.Lock()
	if err := ctx.Err(); err != nil {
		service.mu.Unlock()
		return nil, err
	}
	issues, err := service.reviewActivationLocked(ctx, addonID, registry)
	if err != nil {
		service.mu.Unlock()
		return nil, err
	}
	if len(issues) != 0 {
		service.mu.Unlock()
		return nil, fmt.Errorf("%w: %s", ErrMigrationRequired, issues[0].Message)
	}
	return &transition{
		service: service, addonID: addonID,
		next: &activeRegistry{generation: generation, registry: registry},
	}, nil
}

func (service *Service) BeginDeactivation(addonID string, generation string) datalifecycle.Transition {
	service.mu.Lock()
	current, exists := service.active[addonID]
	remove := exists && current.generation == generation
	return &transition{service: service, addonID: addonID, remove: remove}
}

func (service *Service) reviewActivationLocked(
	ctx context.Context,
	addonID string,
	registry *datacontract.Registry,
) ([]datalifecycle.Issue, error) {
	if addonID == "" || registry == nil {
		return nil, ErrInvalidRequest
	}
	snapshot, err := service.repository.SnapshotAddon(ctx, addonID)
	if err != nil {
		return nil, err
	}
	issues := make([]datalifecycle.Issue, 0)
	appendIssue := func(issue datalifecycle.Issue) {
		if len(issues) < MaximumLifecycleIssues {
			issues = append(issues, issue)
		}
	}
	for _, state := range snapshot.States {
		if !state.Materialized {
			continue
		}
		description, err := registry.Description(state.Kind, state.DataID)
		if errors.Is(err, datacontract.ErrDefinitionNotFound) {
			appendIssue(datalifecycle.Issue{
				Code: "DATA_DEFINITION_REMOVED", Kind: state.Kind, DataID: state.DataID,
				Message: fmt.Sprintf("%s %q still owns campaign data but is not declared by the target package", state.Kind, state.DataID),
			})
			continue
		}
		if err != nil {
			return nil, err
		}
		if state.SchemaVersion != description.SchemaVersion || state.SchemaSHA256 != description.SchemaSHA256 ||
			state.Target != description.Target || state.Keyed != description.Keyed {
			appendIssue(datalifecycle.Issue{
				Code: "DATA_MIGRATION_REQUIRED", Kind: state.Kind, DataID: state.DataID,
				Message: fmt.Sprintf("%s %q has stored data under a different schema, key mode, or target", state.Kind, state.DataID),
			})
		}
	}
	for _, document := range snapshot.Documents {
		if _, err := registry.Description(document.Kind, document.DataID); err != nil {
			continue
		}
		if err := registry.Validate(document.Kind, document.DataID, document.Value); err != nil {
			appendIssue(datalifecycle.Issue{
				Code: "INVALID_STORED_DOCUMENT", Kind: document.Kind, DataID: document.DataID,
				Message: fmt.Sprintf("%s %q contains document %q that fails the target schema", document.Kind, document.DataID, document.Key),
			})
		}
	}
	return issues, nil
}

func (service *Service) authorizeDefinition(
	access Access,
	kind datacontract.Kind,
	dataID string,
) (datacontract.Description, error) {
	if !validAccess(access) {
		return datacontract.Description{}, ErrInvalidRequest
	}
	active, exists := service.active[access.AddonID]
	if !exists || active.generation != access.Generation {
		return datacontract.Description{}, ErrInactiveGeneration
	}
	description, err := active.registry.Description(kind, dataID)
	if err != nil {
		return datacontract.Description{}, ErrInvalidRequest
	}
	if !roleCanAccess(access.Role, description.Visibility) {
		return datacontract.Description{}, ErrUnauthorized
	}
	return description, nil
}

func (service *Service) authorizeDocument(
	ctx context.Context,
	role Role,
	description datacontract.Description,
	document addondatastore.Document,
) error {
	if description.Kind != datacontract.RecordExtension {
		return nil
	}
	target, err := service.coreTarget(ctx, description, document.Key)
	if err != nil {
		return err
	}
	if document.TargetCreatedAt == nil || !document.TargetCreatedAt.Equal(target.CreatedAt) {
		return ErrTargetReplaced
	}
	if role == RolePlayer && target.Visibility != campaign.VisibilityPublic {
		return ErrUnauthorized
	}
	return nil
}

func (service *Service) coreTarget(
	ctx context.Context,
	description datacontract.Description,
	key string,
) (campaign.Record, error) {
	collection := campaign.Collection(description.Target)
	if _, exists := campaign.Describe(collection); !exists {
		return campaign.Record{}, fmt.Errorf("%w: invalid core target %q", ErrInvalidRequest, description.Target)
	}
	record, err := service.core.Get(ctx, collection, key)
	if errors.Is(err, campaign.ErrNotFound) {
		return campaign.Record{}, ErrTargetNotFound
	}
	if err != nil {
		return campaign.Record{}, err
	}
	return record, nil
}

func (service *Service) validateUniqueIndexes(
	ctx context.Context,
	addonID string,
	mutations []addondatastore.Mutation,
) error {
	byDefinition := make(map[string][]addondatastore.Mutation)
	for _, mutation := range mutations {
		if mutation.Definition.Kind != datacontract.Collection || !hasUniqueIndex(mutation.Definition.Indexes) {
			continue
		}
		key := string(mutation.Definition.Kind) + "\x00" + mutation.Definition.ID
		byDefinition[key] = append(byDefinition[key], mutation)
	}
	for _, values := range byDefinition {
		definition := values[0].Definition
		documents, err := service.repository.List(ctx, addonID, definition.Kind, definition.ID)
		if err != nil {
			return err
		}
		prospective := make(map[string]json.RawMessage, len(documents)+len(values))
		for _, document := range documents {
			prospective[document.Key] = document.Value
		}
		for _, mutation := range values {
			if mutation.Kind == addondatastore.Delete {
				delete(prospective, mutation.Key)
			} else {
				prospective[mutation.Key] = mutation.Value
			}
		}
		for _, index := range definition.Indexes {
			if !index.Unique {
				continue
			}
			seen := make(map[string]string)
			for key, body := range prospective {
				value, found, err := jsonPointer(body, index.Path)
				if err != nil {
					return fmt.Errorf("%w: index %q", ErrInvalidRequest, index.Path)
				}
				if !found {
					continue
				}
				canonical, err := json.Marshal(value)
				if err != nil {
					return ErrInvalidRequest
				}
				identity := string(canonical)
				if previous, duplicate := seen[identity]; duplicate && previous != key {
					return fmt.Errorf("%w: %s %q conflicts for %s and %s", ErrUniqueIndexConflict, definition.ID, index.Path, previous, key)
				}
				seen[identity] = key
			}
		}
	}
	return nil
}

type transition struct {
	once    sync.Once
	service *Service
	addonID string
	next    *activeRegistry
	remove  bool
}

func (value *transition) Commit() {
	value.once.Do(func() {
		if value.next != nil {
			value.service.active[value.addonID] = *value.next
		} else if value.remove {
			delete(value.service.active, value.addonID)
		}
		value.service.mu.Unlock()
	})
}

func (value *transition) Rollback() {
	value.once.Do(func() { value.service.mu.Unlock() })
}

func validAccess(access Access) bool {
	return access.AddonID != "" && access.Generation != "" &&
		(access.Role == RolePlayer || access.Role == RoleDM || access.Role == RoleSystem) &&
		len(actorLabel(access)) <= 200
}

func actorLabel(access Access) string {
	if access.ActorID == "" {
		return string(access.Role)
	}
	return string(access.Role) + ":" + access.ActorID
}

func roleCanAccess(role Role, visibility datacontract.Visibility) bool {
	switch visibility {
	case datacontract.VisibilityPublic:
		return role == RolePlayer || role == RoleDM || role == RoleSystem
	case datacontract.VisibilityDM:
		return role == RoleDM || role == RoleSystem
	case datacontract.VisibilityPrivate:
		return role == RoleSystem
	default:
		return false
	}
}

func collectionAudience(visibility datacontract.Visibility) events.Audience {
	switch visibility {
	case datacontract.VisibilityPublic:
		return events.AudiencePublic
	case datacontract.VisibilityDM:
		return events.AudienceDM
	default:
		return events.AudienceSystem
	}
}

func extensionAudience(visibility datacontract.Visibility, target campaign.Visibility) events.Audience {
	if visibility == datacontract.VisibilityPrivate {
		return events.AudienceSystem
	}
	if visibility == datacontract.VisibilityDM || target == campaign.VisibilityDM {
		return events.AudienceDM
	}
	return events.AudiencePublic
}

func documentIDMatches(body json.RawMessage, key string) bool {
	var value map[string]json.RawMessage
	if err := json.Unmarshal(body, &value); err != nil {
		return false
	}
	var id string
	return json.Unmarshal(value["id"], &id) == nil && id == key
}

func hasUniqueIndex(indexes []datacontract.Index) bool {
	for _, index := range indexes {
		if index.Unique {
			return true
		}
	}
	return false
}

type preparedCondition struct {
	path      string
	canonical string
}

func prepareConditions(
	description datacontract.Description,
	conditions []QueryCondition,
) ([]preparedCondition, error) {
	declared := make(map[string]struct{}, len(description.Indexes))
	for _, index := range description.Indexes {
		declared[index.Path] = struct{}{}
	}
	result := make([]preparedCondition, 0, len(conditions))
	seen := make(map[string]struct{}, len(conditions))
	for _, condition := range conditions {
		if _, allowed := declared[condition.Path]; !allowed {
			return nil, fmt.Errorf("%w: query path %q is not a declared index", ErrInvalidRequest, condition.Path)
		}
		if _, duplicate := seen[condition.Path]; duplicate || !json.Valid(condition.Equals) {
			return nil, ErrInvalidRequest
		}
		seen[condition.Path] = struct{}{}
		var value any
		decoder := json.NewDecoder(strings.NewReader(string(condition.Equals)))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return nil, ErrInvalidRequest
		}
		canonical, err := json.Marshal(value)
		if err != nil {
			return nil, ErrInvalidRequest
		}
		result = append(result, preparedCondition{path: condition.Path, canonical: string(canonical)})
	}
	return result, nil
}

func matchesConditions(body json.RawMessage, conditions []preparedCondition) (bool, error) {
	for _, condition := range conditions {
		value, found, err := jsonPointer(body, condition.path)
		if err != nil {
			return false, err
		}
		if !found {
			return false, nil
		}
		canonical, err := json.Marshal(value)
		if err != nil {
			return false, err
		}
		if string(canonical) != condition.canonical {
			return false, nil
		}
	}
	return true, nil
}

func jsonPointer(body json.RawMessage, pointer string) (any, bool, error) {
	if pointer == "" {
		var value any
		if err := json.Unmarshal(body, &value); err != nil {
			return nil, false, err
		}
		return value, true, nil
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, false, ErrInvalidRequest
	}
	var current any
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	if err := decoder.Decode(&current); err != nil {
		return nil, false, err
	}
	for _, encoded := range strings.Split(pointer[1:], "/") {
		token := strings.ReplaceAll(strings.ReplaceAll(encoded, "~1", "/"), "~0", "~")
		switch value := current.(type) {
		case map[string]any:
			var exists bool
			current, exists = value[token]
			if !exists {
				return nil, false, nil
			}
		case []any:
			index, err := strconv.Atoi(token)
			if err != nil || index < 0 || index >= len(value) {
				return nil, false, nil
			}
			current = value[index]
		default:
			return nil, false, nil
		}
	}
	return current, true, nil
}

var _ datalifecycle.Coordinator = (*Service)(nil)
