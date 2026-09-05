package workerrpc

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestAddonDataClientRevisionRequestsFailClosed(t *testing.T) {
	ctx := context.Background()
	reference := AddonDataReference{Kind: AddonDataCollection, DataID: "notes"}
	zero := int64(0)
	for _, revision := range []string{"", `,"dataRevision":1`, `,"dataRevision":-1`, `,"dataRevision":0`} {
		client, _ := NewAddonDataClient(addonDataCallerFunc(func(_ context.Context, method string, params any, _ *Meta) (json.RawMessage, error) {
			request := params.(map[string]any)
			if method != "host/data.query" || request["includeDataRevision"] != true || request["expectedDataRevision"] != zero {
				t.Fatalf("query fields lost: %+v", request)
			}
			return json.RawMessage(`{"contractVersion":"host-data-query-result.v1","documents":[]` + revision + `}`), nil
		}))
		_, err := client.Query(ctx, nil, AddonDataQuery{Reference: reference, Limit: 1, IncludeDataRevision: true, ExpectedDataRevision: &zero})
		if (err == nil) != (revision == `,"dataRevision":0`) {
			t.Fatalf("revision %s: %v", revision, err)
		}
	}
	guards := []AddonDataSetRevision{{Kind: AddonDataCollection, DataID: "notes", Revision: 0}}
	sentinel := errors.New("conflict")
	client, _ := NewAddonDataClient(addonDataCallerFunc(func(_ context.Context, method string, params any, _ *Meta) (json.RawMessage, error) {
		request := params.(map[string]any)
		actual := request["expectedDataSets"].([]AddonDataSetRevision)
		if method != "host/data.transact" || len(actual) != 1 || actual[0] != guards[0] {
			t.Fatalf("write guard lost: %+v", request)
		}
		return nil, sentinel
	}))
	_, err := client.TransactGuarded(ctx, nil, []AddonDataMutation{{Operation: "delete", Reference: reference, Key: "n1", ExpectedRevision: 1}}, guards)
	if !errors.Is(err, sentinel) {
		t.Fatalf("conflict lost: %v", err)
	}
}
