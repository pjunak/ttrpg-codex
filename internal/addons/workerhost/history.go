package workerhost

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/workerbroker"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
)

type historyData interface {
	History(context.Context, addondata.Access, datacontract.Kind, string, string, int64, int) ([]addondatastore.HistoryEntry, error)
	Revision(context.Context, addondata.Access, datacontract.Kind, string, string, int64) (addondatastore.HistoryEntry, error)
}
type historyRequest struct {
	ContractVersion string            `json:"contractVersion"`
	Kind            datacontract.Kind `json:"kind"`
	DataID          string            `json:"dataId"`
	Key             string            `json:"key"`
	Before          int64             `json:"before,omitempty"`
	Revision        int64             `json:"revision,omitempty"`
	Limit           int               `json:"limit"`
}
type historyResponse struct {
	ContractVersion string                        `json:"contractVersion"`
	Entries         []addondatastore.HistoryEntry `json:"entries"`
	NextBefore      int64                         `json:"nextBefore,omitempty"`
}

func dataHistoryMethod(data historyData) workerbroker.Method {
	return workerbroker.Method{
		Name: "host/data.history", Permission: "addon.data", ReadOnlySafe: true,
		ValidateRequest: func(body json.RawMessage) error {
			r, err := decodeExact[historyRequest](body)
			if err != nil || r.ContractVersion != "host-data-history.v1" || r.Kind != datacontract.RecordExtension || !validReference(r.Kind, r.DataID) || !validKey(r.Key) || r.Before < 0 || r.Revision < 0 || r.Limit < 1 || r.Limit > 100 || r.Revision > 0 && (r.Limit != 1 || r.Before != 0) {
				return errors.New("invalid history request")
			}
			return nil
		},
		ValidateResponse: func(body json.RawMessage) error {
			r, err := decodeExact[historyResponse](body)
			if err != nil || r.ContractVersion != "host-data-history-result.v1" || len(r.Entries) > 100 || r.NextBefore < 0 {
				return errors.New("invalid history response")
			}
			for _, e := range r.Entries {
				if e.Revision < 1 || e.ActorID == "" || e.OperationID == "" || e.OccurredAt.IsZero() {
					return errors.New("invalid history entry")
				}
			}
			return nil
		},
		Handle: func(ctx context.Context, inv workerbroker.Invocation) (any, error) {
			r, err := decodeExact[historyRequest](inv.Params)
			if err != nil {
				return nil, err
			}
			result := historyResponse{ContractVersion: "host-data-history-result.v1", Entries: []addondatastore.HistoryEntry{}}
			if r.Revision > 0 {
				entry, err := data.Revision(ctx, dataAccess(inv), r.Kind, r.DataID, r.Key, r.Revision)
				if err != nil {
					return nil, dataError(err)
				}
				result.Entries = append(result.Entries, entry)
			} else {
				result.Entries, err = data.History(ctx, dataAccess(inv), r.Kind, r.DataID, r.Key, r.Before, r.Limit)
				if err != nil {
					return nil, dataError(err)
				}
				if len(result.Entries) == r.Limit {
					result.NextBefore = result.Entries[len(result.Entries)-1].Revision
				}
			}
			return result, nil
		},
	}
}
