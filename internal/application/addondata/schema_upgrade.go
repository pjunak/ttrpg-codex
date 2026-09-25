package addondata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/datalifecycle"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

type schemaRepository interface {
	PrepareSchemaReview(context.Context, datalifecycle.SchemaReviewRequest, addondatastore.SchemaPlanner) (datalifecycle.SchemaReview, error)
	GetSchemaReview(context.Context, string) (datalifecycle.SchemaReview, error)
	ApplySchemaReview(context.Context, string, string) (datalifecycle.SchemaReview, error)
	SchemaReviewRecovery(context.Context, string) ([]byte, error)
}

var _ datalifecycle.SchemaUpgrades = (*Service)(nil)

func (service *Service) PrepareSchemaReview(ctx context.Context, input datalifecycle.SchemaReviewRequest, registry *datacontract.Registry) (datalifecycle.SchemaReview, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if _, active := service.active[input.AddonID]; active {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeActive
	}
	repository, ok := service.repository.(schemaRepository)
	if !ok || registry == nil {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeUnavailable
	}
	return repository.PrepareSchemaReview(ctx, input, func(snapshot addondatastore.Snapshot) ([]datalifecycle.SchemaChange, []datalifecycle.Issue, error) {
		changes := []datalifecycle.SchemaChange{}
		issues := []datalifecycle.Issue{}
		issue := func(code string, state addondatastore.State, message string) {
			if len(issues) < 100 {
				issues = append(issues, datalifecycle.Issue{Code: code, Kind: state.Kind, DataID: state.DataID, Message: message})
			}
		}
		for _, state := range snapshot.States {
			if !state.Materialized {
				continue
			}
			definition, err := registry.Description(state.Kind, state.DataID)
			if err != nil {
				issue("DATA_DEFINITION_REMOVED", state, "The target package removes saved data.")
				continue
			}
			if definition.Keyed != state.Keyed || definition.Target != state.Target {
				issue("DATA_STRUCTURE_CHANGED", state, "The target changes document identity or core-record ownership.")
				continue
			}
			count := 0
			values := map[string]json.RawMessage{}
			for _, document := range snapshot.Documents {
				if document.Kind != state.Kind || document.DataID != state.DataID {
					continue
				}
				count++
				if document.SchemaVersion != state.SchemaVersion || document.SchemaSHA256 != state.SchemaSHA256 {
					return nil, nil, addondatastore.ErrStorageInvariant
				}
				if registry.Validate(state.Kind, state.DataID, document.Value) != nil {
					issue("INVALID_STORED_DOCUMENT", state, "Saved values need an explicit conversion.")
					continue
				}
				values[document.Key] = document.Value
			}
			if err := validateUniqueValues(definition, values); errors.Is(err, ErrUniqueIndexConflict) {
				issue("UNIQUE_INDEX_CONFLICT", state, "Saved values conflict with a target unique index.")
			} else if err != nil {
				return nil, nil, err
			}
			if definition.SchemaVersion != state.SchemaVersion || definition.SchemaSHA256 != state.SchemaSHA256 {
				changes = append(changes, datalifecycle.SchemaChange{Kind: state.Kind, DataID: state.DataID, FromVersion: state.SchemaVersion, FromSHA256: state.SchemaSHA256, ToVersion: definition.SchemaVersion, ToSHA256: definition.SchemaSHA256, Documents: count})
			}
		}
		return changes, issues, nil
	})
}
func (service *Service) GetSchemaReview(ctx context.Context, id string) (datalifecycle.SchemaReview, error) {
	repository, ok := service.repository.(schemaRepository)
	if !ok {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeUnavailable
	}
	return repository.GetSchemaReview(ctx, id)
}
func (service *Service) SchemaReviewRecovery(ctx context.Context, id string) ([]byte, error) {
	repository, ok := service.repository.(schemaRepository)
	if !ok {
		return nil, datalifecycle.ErrUpgradeUnavailable
	}
	return repository.SchemaReviewRecovery(ctx, id)
}
func (service *Service) ApplySchemaReview(ctx context.Context, id, digest string) (datalifecycle.SchemaReview, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	repository, ok := service.repository.(schemaRepository)
	if !ok {
		return datalifecycle.SchemaReview{}, datalifecycle.ErrUpgradeUnavailable
	}
	review, err := repository.GetSchemaReview(ctx, id)
	if err != nil {
		return review, err
	}
	if _, active := service.active[review.AddonID]; active && review.Status != "applied" {
		return review, datalifecycle.ErrUpgradeActive
	}
	if digest == "" {
		return review, fmt.Errorf("%w: missing fingerprint", datalifecycle.ErrUpgradeStale)
	}
	return repository.ApplySchemaReview(ctx, id, digest)
}
