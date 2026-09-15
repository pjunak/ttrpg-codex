package campaigndata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

const MaximumRequestedMutations = 500

var (
	ErrInvalidAuthority     = errors.New("invalid campaign mutation authority")
	ErrMutationForbidden    = errors.New("campaign mutation is forbidden")
	ErrManagedCampaignField = errors.New("campaign field is application-managed")
)

type WriteRole string

const (
	WritePlayer WriteRole = "player"
	WriteDM     WriteRole = "dm"
)

type MutationAuthority struct {
	ActorID string
	Role    WriteRole
}

func (service *Service) Mutate(
	ctx context.Context,
	authority MutationAuthority,
	requested []campaign.Mutation,
) (campaign.Commit, error) {
	if service == nil || service.repository == nil ||
		(authority.Role != WritePlayer && authority.Role != WriteDM) ||
		authority.ActorID == "" {
		return campaign.Commit{}, ErrInvalidAuthority
	}
	if len(requested) == 0 || len(requested) > MaximumRequestedMutations {
		return campaign.Commit{}, campaign.ErrInvalidTransaction
	}
	snapshot, err := service.repository.Snapshot(ctx, true)
	if err != nil {
		return campaign.Commit{}, fmt.Errorf("read campaign mutation snapshot: %w", err)
	}
	planner := newMutationPlanner(snapshot, service.now)
	for _, mutation := range requested {
		if err := planner.applyRequested(authority.Role, mutation); err != nil {
			return campaign.Commit{}, err
		}
	}
	if err := planner.applyDerivedPolicies(); err != nil {
		return campaign.Commit{}, err
	}
	prepared, err := planner.transaction(authority.ActorID)
	if err != nil {
		return campaign.Commit{}, err
	}
	commit, err := service.repository.Transact(ctx, prepared)
	if err != nil {
		return campaign.Commit{}, err
	}
	return planner.receipt(commit), nil
}

func prepareRecordWrite(
	role WriteRole,
	descriptor campaign.Descriptor,
	existing campaign.Record,
	found bool,
	value json.RawMessage,
) (json.RawMessage, error) {
	if !descriptor.VisibilityBearing {
		return append(json.RawMessage(nil), value...), nil
	}
	incoming, err := objectValue(value)
	if err != nil {
		return nil, err
	}
	var current map[string]any
	if found {
		current, err = objectValue(existing.Value)
		if err != nil {
			return nil, fmt.Errorf("stored record is invalid: %w", err)
		}
	}

	managedTwin, twinExists := current["linkedTwinId"]
	incomingTwin, incomingTwinExists := incoming["linkedTwinId"]
	if incomingTwinExists && (!twinExists || !reflect.DeepEqual(incomingTwin, managedTwin)) {
		return nil, ErrManagedCampaignField
	}
	if twinExists {
		incoming["linkedTwinId"] = managedTwin
	} else {
		delete(incoming, "linkedTwinId")
	}
	delete(incoming, "secrets")

	if role == WritePlayer {
		if descriptor.Name == campaign.Locations {
			if _, supplied := incoming["notes"]; supplied {
				return nil, ErrManagedCampaignField
			}
			if notes, exists := current["notes"]; exists {
				incoming["notes"] = notes
			}
		}
		visibility := campaign.VisibilityPublic
		if found {
			visibility = existing.Visibility
		}
		incoming["visibility"] = visibility
		mergePlayerAddonData(incoming, current)
	}
	prepared, preparedVisibility, err := normalizeObjectRecord(descriptor, incoming)
	if err != nil {
		return nil, err
	}
	if twinExists && preparedVisibility != existing.Visibility {
		return nil, ErrManagedCampaignField
	}
	if descriptor.Name == campaign.Characters && incoming["faction"] == "party" &&
		preparedVisibility == campaign.VisibilityDM {
		return nil, fmt.Errorf("%w: party characters must be public", campaign.ErrInvalidRecord)
	}
	return prepared, nil
}

func normalizeObjectRecord(
	descriptor campaign.Descriptor,
	value map[string]any,
) (json.RawMessage, campaign.Visibility, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, "", fmt.Errorf("marshal record: %w", err)
	}
	// The key/relationship identity is checked by the store after policy has
	// finished; this pass only normalizes the visibility-bearing object.
	var envelope struct {
		Visibility string `json:"visibility"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, "", campaign.ErrInvalidRecord
	}
	visibility := campaign.VisibilityPublic
	if envelope.Visibility == string(campaign.VisibilityDM) {
		visibility = campaign.VisibilityDM
	} else if envelope.Visibility != "" && envelope.Visibility != string(campaign.VisibilityPublic) {
		return nil, "", campaign.ErrInvalidRecord
	}
	return body, visibility, nil
}

func mergePlayerAddonData(incoming, current map[string]any) {
	existingAddonData, existingOK := current["addonData"].(map[string]any)
	incomingAddonData, incomingOK := incoming["addonData"].(map[string]any)
	if !existingOK && !incomingOK {
		delete(incoming, "addonData")
		return
	}
	merged := make(map[string]any, len(existingAddonData)+len(incomingAddonData))
	for namespace, value := range existingAddonData {
		merged[namespace] = value
	}
	for namespace, value := range incomingAddonData {
		merged[namespace] = value
	}
	incoming["addonData"] = merged
}

func mutationTarget(collection campaign.Collection, key string) string {
	return string(collection) + "\x00" + key
}

func forbiddenMutation(mutation campaign.Mutation) error {
	return fmt.Errorf("%w: %s %s:%s", ErrMutationForbidden, mutation.Kind, mutation.Collection, mutation.Key)
}
