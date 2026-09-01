package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

var (
	ErrTwinExists     = errors.New("campaign record already has a twin")
	ErrTwinMissing    = errors.New("campaign record does not have a twin")
	ErrTwinVisibility = errors.New("campaign twins must have opposite visibility")
)

type TwinAction string

const (
	TwinCreate TwinAction = "create"
	TwinLink   TwinAction = "link"
	TwinUnlink TwinAction = "unlink"
)

type TwinRequest struct {
	Action                 TwinAction
	Collection             campaign.Collection
	SourceKey              string
	SourceExpectedRevision int64
	TargetKey              string
	TargetExpectedRevision int64
}

type TwinResult struct {
	TwinKey string          `json:"twinKey,omitempty"`
	Commit  campaign.Commit `json:"commit"`
}

var twinCollections = map[campaign.Collection]struct{}{
	campaign.Characters:       {},
	campaign.Locations:        {},
	campaign.Events:           {},
	campaign.Mysteries:        {},
	campaign.Factions:         {},
	campaign.Pantheon:         {},
	campaign.Artifacts:        {},
	campaign.HistoricalEvents: {},
}

func (service *Service) MutateTwin(
	ctx context.Context,
	authority MutationAuthority,
	request TwinRequest,
) (TwinResult, error) {
	if service == nil || service.repository == nil || service.generateTwinID == nil ||
		authority.Role != WriteDM || authority.ActorID == "" {
		return TwinResult{}, ErrInvalidAuthority
	}
	descriptor, ok := campaign.Describe(request.Collection)
	if !ok {
		return TwinResult{}, campaign.ErrInvalidCollection
	}
	if _, ok := twinCollections[request.Collection]; !ok || !descriptor.VisibilityBearing ||
		request.SourceExpectedRevision < 1 {
		return TwinResult{}, campaign.ErrInvalidTransaction
	}
	if err := campaign.ValidateKey(descriptor, request.SourceKey); err != nil {
		return TwinResult{}, err
	}
	snapshot, err := service.repository.Snapshot(ctx, true)
	if err != nil {
		return TwinResult{}, fmt.Errorf("read twin mutation snapshot: %w", err)
	}
	records := make(map[string]campaign.Record, len(snapshot.Records))
	for _, record := range snapshot.Records {
		records[mutationTarget(record.Collection, record.Key)] = record
	}
	source, found := records[mutationTarget(request.Collection, request.SourceKey)]
	if !found {
		return TwinResult{}, campaign.ErrNotFound
	}

	switch request.Action {
	case TwinCreate:
		return service.createTwin(ctx, authority.ActorID, descriptor, source, records, request)
	case TwinLink:
		return service.linkTwin(ctx, authority.ActorID, descriptor, source, records, request)
	case TwinUnlink:
		return service.unlinkTwin(ctx, authority.ActorID, descriptor, source, records, request)
	default:
		return TwinResult{}, campaign.ErrInvalidTransaction
	}
}

func (service *Service) createTwin(
	ctx context.Context,
	actorID string,
	descriptor campaign.Descriptor,
	source campaign.Record,
	records map[string]campaign.Record,
	request TwinRequest,
) (TwinResult, error) {
	sourceValue, err := objectValue(source.Value)
	if err != nil {
		return TwinResult{}, err
	}
	if twinID, exists := twinID(sourceValue); exists {
		return TwinResult{}, fmt.Errorf("%w: %s", ErrTwinExists, twinID)
	}
	var generated string
	for attempt := 0; attempt < 8; attempt++ {
		candidate, err := service.generateTwinID()
		if err != nil {
			return TwinResult{}, fmt.Errorf("generate twin id: %w", err)
		}
		if err := campaign.ValidateKey(descriptor, candidate); err != nil {
			return TwinResult{}, fmt.Errorf("generate twin id: %w", err)
		}
		if _, exists := records[mutationTarget(request.Collection, candidate)]; !exists {
			generated = candidate
			break
		}
	}
	if generated == "" {
		return TwinResult{}, fmt.Errorf("%w: twin id collision", campaign.ErrConflict)
	}
	now := service.now().UTC().UnixMilli()
	clone := cloneObject(sourceValue)
	delete(clone, "linkedTwinId")
	delete(clone, "secrets")
	clone["linkedTwinId"] = source.Key
	clone["visibility"] = oppositeVisibility(source.Visibility)
	clone["updatedAt"] = now
	if descriptor.Shape == campaign.List {
		clone["id"] = generated
	} else {
		delete(clone, "id")
	}
	sourceValue["linkedTwinId"] = generated
	sourceValue["updatedAt"] = now
	sourceBody, sourceVisibility, err := normalizeTwinRecord(descriptor, source.Key, sourceValue)
	if err != nil {
		return TwinResult{}, err
	}
	cloneBody, cloneVisibility, err := normalizeTwinRecord(descriptor, generated, clone)
	if err != nil {
		return TwinResult{}, err
	}
	if sourceVisibility == cloneVisibility {
		return TwinResult{}, ErrTwinVisibility
	}
	commit, err := service.repository.Transact(ctx, campaign.Transaction{
		ActorID: actorID,
		Mutations: []campaign.Mutation{
			{Kind: campaign.Put, Collection: request.Collection, Key: source.Key, Value: sourceBody, ExpectedRevision: request.SourceExpectedRevision},
			{Kind: campaign.Put, Collection: request.Collection, Key: generated, Value: cloneBody, ExpectedRevision: 0},
		},
	})
	if err != nil {
		return TwinResult{}, err
	}
	return TwinResult{TwinKey: generated, Commit: commit}, nil
}

func (service *Service) linkTwin(
	ctx context.Context,
	actorID string,
	descriptor campaign.Descriptor,
	source campaign.Record,
	records map[string]campaign.Record,
	request TwinRequest,
) (TwinResult, error) {
	if request.TargetExpectedRevision < 1 || request.TargetKey == request.SourceKey {
		return TwinResult{}, campaign.ErrInvalidTransaction
	}
	if err := campaign.ValidateKey(descriptor, request.TargetKey); err != nil {
		return TwinResult{}, err
	}
	target, found := records[mutationTarget(request.Collection, request.TargetKey)]
	if !found {
		return TwinResult{}, campaign.ErrNotFound
	}
	sourceValue, err := objectValue(source.Value)
	if err != nil {
		return TwinResult{}, err
	}
	targetValue, err := objectValue(target.Value)
	if err != nil {
		return TwinResult{}, err
	}
	if _, exists := twinID(sourceValue); exists {
		return TwinResult{}, ErrTwinExists
	}
	if _, exists := twinID(targetValue); exists {
		return TwinResult{}, ErrTwinExists
	}
	if source.Visibility == target.Visibility {
		return TwinResult{}, ErrTwinVisibility
	}
	now := service.now().UTC().UnixMilli()
	sourceValue["linkedTwinId"] = target.Key
	sourceValue["updatedAt"] = now
	targetValue["linkedTwinId"] = source.Key
	targetValue["updatedAt"] = now
	sourceBody, _, err := normalizeTwinRecord(descriptor, source.Key, sourceValue)
	if err != nil {
		return TwinResult{}, err
	}
	targetBody, _, err := normalizeTwinRecord(descriptor, target.Key, targetValue)
	if err != nil {
		return TwinResult{}, err
	}
	commit, err := service.repository.Transact(ctx, campaign.Transaction{
		ActorID: actorID,
		Mutations: []campaign.Mutation{
			{Kind: campaign.Put, Collection: request.Collection, Key: source.Key, Value: sourceBody, ExpectedRevision: request.SourceExpectedRevision},
			{Kind: campaign.Put, Collection: request.Collection, Key: target.Key, Value: targetBody, ExpectedRevision: request.TargetExpectedRevision},
		},
	})
	if err != nil {
		return TwinResult{}, err
	}
	return TwinResult{TwinKey: target.Key, Commit: commit}, nil
}

func (service *Service) unlinkTwin(
	ctx context.Context,
	actorID string,
	descriptor campaign.Descriptor,
	source campaign.Record,
	records map[string]campaign.Record,
	request TwinRequest,
) (TwinResult, error) {
	sourceValue, err := objectValue(source.Value)
	if err != nil {
		return TwinResult{}, err
	}
	targetKey, exists := twinID(sourceValue)
	if !exists {
		return TwinResult{}, ErrTwinMissing
	}
	target, found := records[mutationTarget(request.Collection, targetKey)]
	if !found {
		return TwinResult{}, fmt.Errorf("%w: linked record is unavailable", ErrTwinMissing)
	}
	targetValue, err := objectValue(target.Value)
	if err != nil {
		return TwinResult{}, err
	}
	backLink, reciprocal := twinID(targetValue)
	if !reciprocal || backLink != source.Key {
		return TwinResult{}, fmt.Errorf("%w: twin link is not reciprocal", ErrManagedCampaignField)
	}
	now := service.now().UTC().UnixMilli()
	delete(sourceValue, "linkedTwinId")
	sourceValue["updatedAt"] = now
	delete(targetValue, "linkedTwinId")
	targetValue["updatedAt"] = now
	sourceBody, _, err := normalizeTwinRecord(descriptor, source.Key, sourceValue)
	if err != nil {
		return TwinResult{}, err
	}
	targetBody, _, err := normalizeTwinRecord(descriptor, target.Key, targetValue)
	if err != nil {
		return TwinResult{}, err
	}
	commit, err := service.repository.Transact(ctx, campaign.Transaction{
		ActorID: actorID,
		Mutations: []campaign.Mutation{
			{Kind: campaign.Put, Collection: request.Collection, Key: source.Key, Value: sourceBody, ExpectedRevision: request.SourceExpectedRevision},
			{Kind: campaign.Put, Collection: request.Collection, Key: target.Key, Value: targetBody, ExpectedRevision: target.Revision},
		},
	})
	if err != nil {
		return TwinResult{}, err
	}
	return TwinResult{TwinKey: target.Key, Commit: commit}, nil
}

func normalizeTwinRecord(
	descriptor campaign.Descriptor,
	key string,
	value map[string]any,
) (json.RawMessage, campaign.Visibility, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, "", err
	}
	return campaign.NormalizeRecord(descriptor, key, body)
}

func twinID(value map[string]any) (string, bool) {
	id, exists := value["linkedTwinId"].(string)
	return id, exists && id != ""
}

func oppositeVisibility(value campaign.Visibility) campaign.Visibility {
	if value == campaign.VisibilityDM {
		return campaign.VisibilityPublic
	}
	return campaign.VisibilityDM
}

func cloneObject(value map[string]any) map[string]any {
	result := make(map[string]any, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}
