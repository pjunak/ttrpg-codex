package addondata

import (
	"context"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

type historyRepository interface {
	History(context.Context, string, datacontract.Kind, string, string, int64, int) ([]addondatastore.HistoryEntry, error)
	Revision(context.Context, string, datacontract.Kind, string, string, int64) (addondatastore.HistoryEntry, error)
}

func (service *Service) History(ctx context.Context, access Access, kind datacontract.Kind, dataID, key string, before int64, limit int) ([]addondatastore.HistoryEntry, error) {
	service.mu.RLock()
	defer service.mu.RUnlock()
	target, err := service.historyTarget(ctx, access, kind, dataID, key)
	if err != nil {
		return nil, err
	}
	repository, ok := service.repository.(historyRepository)
	if !ok {
		return nil, ErrInvalidConfig
	}
	entries, err := repository.History(ctx, access.AddonID, kind, dataID, key, before, limit)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.TargetCreatedAt.Equal(target.CreatedAt) {
			return nil, ErrTargetReplaced
		}
	}
	return entries, nil
}

func (service *Service) Revision(ctx context.Context, access Access, kind datacontract.Kind, dataID, key string, revision int64) (addondatastore.HistoryEntry, error) {
	service.mu.RLock()
	defer service.mu.RUnlock()
	target, err := service.historyTarget(ctx, access, kind, dataID, key)
	if err != nil {
		return addondatastore.HistoryEntry{}, err
	}
	repository, ok := service.repository.(historyRepository)
	if !ok {
		return addondatastore.HistoryEntry{}, ErrInvalidConfig
	}
	entry, err := repository.Revision(ctx, access.AddonID, kind, dataID, key, revision)
	if err != nil {
		return entry, err
	}
	if !entry.TargetCreatedAt.Equal(target.CreatedAt) {
		return addondatastore.HistoryEntry{}, ErrTargetReplaced
	}
	return entry, nil
}

func (service *Service) historyTarget(ctx context.Context, access Access, kind datacontract.Kind, dataID, key string) (campaign.Record, error) {
	description, err := service.authorizeDefinition(access, kind, dataID)
	if err != nil {
		return campaign.Record{}, err
	}
	if !description.Retained || kind != datacontract.RecordExtension {
		return campaign.Record{}, ErrUnauthorized
	}
	target, err := service.coreTarget(ctx, description, key)
	if err != nil {
		return target, err
	}
	if access.Role == RolePlayer && target.Visibility != campaign.VisibilityPublic {
		return campaign.Record{}, ErrUnauthorized
	}
	return target, nil
}
