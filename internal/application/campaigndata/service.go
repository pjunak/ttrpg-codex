package campaigndata

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/domain/campaign"
)

const ContractVersion = "campaign-data.v1"

var ErrInvalidConfig = errors.New("invalid campaign data service configuration")

type Repository interface {
	Snapshot(context.Context, bool) (campaign.Snapshot, error)
	Transact(context.Context, campaign.Transaction) (campaign.Commit, error)
}

type Service struct {
	repository     Repository
	now            func() time.Time
	generateTwinID func() (string, error)
}

type ViewRole string

const (
	ViewPublic ViewRole = "public"
	ViewDM     ViewRole = "dm"
)

type Dataset struct {
	ContractVersion string           `json:"contractVersion"`
	Collections     []CollectionView `json:"collections"`
}

type CollectionView struct {
	Name         campaign.Collection `json:"name"`
	Shape        campaign.Shape      `json:"shape"`
	Materialized bool                `json:"materialized"`
	Revision     int64               `json:"revision"`
	Records      []RecordView        `json:"records"`
}

type RecordView struct {
	Key      string          `json:"key"`
	Revision int64           `json:"revision"`
	Value    json.RawMessage `json:"value"`
}

func New(repository Repository) (*Service, error) {
	if repository == nil {
		return nil, ErrInvalidConfig
	}
	return &Service{
		repository: repository, now: time.Now,
		generateTwinID: randomTwinID,
	}, nil
}

func randomTwinID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return "twin-" + base64.RawURLEncoding.EncodeToString(buffer), nil
}

func (service *Service) Dataset(ctx context.Context, role ViewRole) (Dataset, error) {
	if service == nil || service.repository == nil || role != ViewPublic && role != ViewDM {
		return Dataset{}, ErrInvalidConfig
	}
	snapshot, err := service.repository.Snapshot(ctx, true)
	if err != nil {
		return Dataset{}, fmt.Errorf("read campaign snapshot: %w", err)
	}
	if role == ViewPublic {
		snapshot, err = projectPublic(snapshot)
		if err != nil {
			return Dataset{}, err
		}
	} else {
		snapshot.Records = append([]campaign.Record(nil), snapshot.Records...)
		for index, record := range snapshot.Records {
			descriptor, _ := campaign.Describe(record.Collection)
			if !descriptor.VisibilityBearing || readStoredActivity(record.Value).Contract != activityContract {
				continue
			}
			snapshot.Records[index].Value, err = transformObject(record.Value, func(value map[string]any) { projectActivity(value, ViewDM) })
			if err != nil {
				return Dataset{}, err
			}
		}
	}
	return datasetView(snapshot), nil
}

func datasetView(snapshot campaign.Snapshot) Dataset {
	states := make(map[campaign.Collection]campaign.CollectionState, len(snapshot.States))
	for _, state := range snapshot.States {
		states[state.Collection] = state
	}
	records := make(map[campaign.Collection][]campaign.Record)
	for _, record := range snapshot.Records {
		records[record.Collection] = append(records[record.Collection], record)
	}
	result := Dataset{
		ContractVersion: ContractVersion,
		Collections:     make([]CollectionView, 0, len(campaign.Descriptors())),
	}
	for _, descriptor := range campaign.Descriptors() {
		state := states[descriptor.Name]
		collection := CollectionView{
			Name: descriptor.Name, Shape: descriptor.Shape,
			Materialized: state.Materialized, Revision: state.Revision,
			Records: make([]RecordView, 0, len(records[descriptor.Name])),
		}
		for _, record := range records[descriptor.Name] {
			collection.Records = append(collection.Records, RecordView{
				Key: record.Key, Revision: record.Revision,
				Value: append(json.RawMessage(nil), record.Value...),
			})
		}
		result.Collections = append(result.Collections, collection)
	}
	return result
}
