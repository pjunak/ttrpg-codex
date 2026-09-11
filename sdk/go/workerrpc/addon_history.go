package workerrpc

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

type RecordedOperation struct {
	ID        string `json:"operationId"`
	Operation string `json:"operation"`
	Summary   string `json:"summary"`
}
type AddonHistoryEntry struct {
	Revision    int64           `json:"revision"`
	Generation  string          `json:"generation"`
	ActorID     string          `json:"actorId"`
	OccurredAt  time.Time       `json:"occurredAt"`
	OperationID string          `json:"operationId"`
	Operation   string          `json:"operation"`
	Summary     string          `json:"summary"`
	Deleted     bool            `json:"deleted"`
	Value       json.RawMessage `json:"value,omitempty"`
}
type AddonHistoryResult struct {
	ContractVersion string              `json:"contractVersion"`
	Entries         []AddonHistoryEntry `json:"entries"`
	NextBefore      int64               `json:"nextBefore,omitempty"`
}

func (client *AddonDataClient) TransactRecorded(ctx context.Context, meta *Meta, mutations []AddonDataMutation, operation RecordedOperation) (AddonDataCommit, error) {
	if operation.ID == "" || operation.Operation == "" || len(operation.ID) > 96 || len(operation.Summary) > 1000 {
		return AddonDataCommit{}, errors.New("invalid recorded operation")
	}
	return client.transact(ctx, meta, mutations, nil, &operation)
}

func (client *AddonDataClient) History(ctx context.Context, meta *Meta, reference AddonDataReference, key string, before int64, limit int) (AddonHistoryResult, error) {
	return client.history(ctx, meta, reference, key, before, 0, limit)
}
func (client *AddonDataClient) Revision(ctx context.Context, meta *Meta, reference AddonDataReference, key string, revision int64) (AddonHistoryEntry, error) {
	if revision < 1 {
		return AddonHistoryEntry{}, errors.New("invalid revision")
	}
	result, err := client.history(ctx, meta, reference, key, 0, revision, 1)
	if err != nil {
		return AddonHistoryEntry{}, err
	}
	if len(result.Entries) != 1 || result.Entries[0].Revision != revision {
		return AddonHistoryEntry{}, errors.New("host returned wrong revision")
	}
	return result.Entries[0], nil
}
func (client *AddonDataClient) history(ctx context.Context, meta *Meta, reference AddonDataReference, key string, before, revision int64, limit int) (AddonHistoryResult, error) {
	if client == nil || client.caller == nil || !validAddonDataReference(reference) || reference.Kind != AddonDataRecordExtension || !validAddonDataKey(key) || before < 0 || revision < 0 || limit < 1 || limit > 100 {
		return AddonHistoryResult{}, errors.New("invalid history request")
	}
	request := map[string]any{"contractVersion": "host-data-history.v1", "kind": reference.Kind, "dataId": reference.DataID, "key": key, "limit": limit}
	if before > 0 {
		request["before"] = before
	}
	if revision > 0 {
		request["revision"] = revision
	}
	body, err := client.caller.Call(ctx, "host/data.history", request, meta)
	if err != nil {
		return AddonHistoryResult{}, err
	}
	var result AddonHistoryResult
	if decodeAddonDataExact(body, &result) != nil || result.ContractVersion != "host-data-history-result.v1" || len(result.Entries) > limit || result.NextBefore < 0 {
		return result, errors.New("invalid history response")
	}
	for i, entry := range result.Entries {
		if entry.Revision < 1 || entry.ActorID == "" || entry.OccurredAt.IsZero() || entry.OperationID == "" || i > 0 && result.Entries[i-1].Revision <= entry.Revision || before > 0 && entry.Revision >= before {
			return AddonHistoryResult{}, errors.New("invalid history entry")
		}
	}
	return result, nil
}
