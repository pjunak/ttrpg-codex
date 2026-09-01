package workerrpc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"time"
)

const (
	AddonDataCollection      = "collection"
	AddonDataRecordExtension = "record-extension"
)

type AddonDataCaller interface {
	Call(context.Context, string, any, *Meta) (json.RawMessage, error)
}

type AddonDataClient struct {
	caller AddonDataCaller
}

type AddonDataReference struct {
	Kind   string `json:"kind"`
	DataID string `json:"dataId"`
}

type AddonDataDocument struct {
	Key      string          `json:"key"`
	Revision int64           `json:"revision"`
	Value    json.RawMessage `json:"value"`
}

type AddonDataQueryCondition struct {
	Path   string `json:"path"`
	Equals any    `json:"equals"`
}

type AddonDataQuery struct {
	Reference AddonDataReference
	Cursor    string
	Limit     int
	Where     []AddonDataQueryCondition
}

type AddonDataQueryResult struct {
	Documents  []AddonDataDocument
	NextCursor string
}

type AddonDataMutation struct {
	Operation        string
	Reference        AddonDataReference
	Key              string
	ExpectedRevision int64
	Value            any
}

type AddonDataMutationResult struct {
	Kind           string `json:"kind"`
	DataID         string `json:"dataId"`
	Key            string `json:"key"`
	BeforeRevision int64  `json:"beforeRevision"`
	AfterRevision  int64  `json:"afterRevision"`
	Deleted        bool   `json:"deleted"`
}

type AddonDataSetRevision struct {
	Kind     string `json:"kind"`
	DataID   string `json:"dataId"`
	Revision int64  `json:"revision"`
}

type AddonDataCommit struct {
	CommitID   int64
	OccurredAt time.Time
	Results    []AddonDataMutationResult
	DataSets   []AddonDataSetRevision
}

func NewAddonDataClient(caller AddonDataCaller) (*AddonDataClient, error) {
	if caller == nil {
		return nil, errors.New("add-on data RPC caller is required")
	}
	return &AddonDataClient{caller: caller}, nil
}

func (client *AddonDataClient) Get(
	ctx context.Context,
	meta *Meta,
	reference AddonDataReference,
	key string,
) (AddonDataDocument, error) {
	if client == nil || client.caller == nil || !validAddonDataReference(reference) || !validAddonDataKey(key) {
		return AddonDataDocument{}, errors.New("add-on data get request is invalid")
	}
	body, err := client.caller.Call(ctx, "host/data.get", map[string]any{
		"contractVersion": "host-data-get.v1",
		"kind":            reference.Kind, "dataId": reference.DataID, "key": key,
	}, meta)
	if err != nil {
		return AddonDataDocument{}, err
	}
	var response struct {
		ContractVersion string          `json:"contractVersion"`
		Key             string          `json:"key"`
		Revision        int64           `json:"revision"`
		Value           json.RawMessage `json:"value"`
	}
	if err := decodeAddonDataExact(body, &response); err != nil ||
		response.ContractVersion != "host-data-document.v1" || !validAddonDataKey(response.Key) ||
		response.Revision < 1 || !json.Valid(response.Value) {
		return AddonDataDocument{}, errors.New("host returned an invalid add-on data document")
	}
	return AddonDataDocument{
		Key: response.Key, Revision: response.Revision,
		Value: append(json.RawMessage(nil), response.Value...),
	}, nil
}

func (client *AddonDataClient) Query(
	ctx context.Context,
	meta *Meta,
	query AddonDataQuery,
) (AddonDataQueryResult, error) {
	if client == nil || client.caller == nil || !validAddonDataReference(query.Reference) ||
		query.Limit < 1 || query.Limit > 200 || len(query.Where) > 8 ||
		!validAddonDataCursor(query.Cursor) {
		return AddonDataQueryResult{}, errors.New("add-on data query request is invalid")
	}
	where := make([]map[string]any, 0, len(query.Where))
	for _, condition := range query.Where {
		if len(condition.Path) < 1 || len(condition.Path) > 300 || condition.Path[0] != '/' {
			return AddonDataQueryResult{}, errors.New("add-on data query condition is invalid")
		}
		where = append(where, map[string]any{"path": condition.Path, "equals": condition.Equals})
	}
	request := map[string]any{
		"contractVersion": "host-data-query.v1",
		"kind":            query.Reference.Kind, "dataId": query.Reference.DataID,
		"limit": query.Limit, "where": where,
	}
	if query.Cursor != "" {
		request["cursor"] = query.Cursor
	}
	body, err := client.caller.Call(ctx, "host/data.query", request, meta)
	if err != nil {
		return AddonDataQueryResult{}, err
	}
	var response struct {
		ContractVersion string              `json:"contractVersion"`
		Documents       []AddonDataDocument `json:"documents"`
		NextCursor      string              `json:"nextCursor,omitempty"`
	}
	if err := decodeAddonDataExact(body, &response); err != nil ||
		response.ContractVersion != "host-data-query-result.v1" || len(response.Documents) > 200 ||
		!validAddonDataCursor(response.NextCursor) {
		return AddonDataQueryResult{}, errors.New("host returned an invalid add-on data query result")
	}
	result := AddonDataQueryResult{
		Documents:  make([]AddonDataDocument, 0, len(response.Documents)),
		NextCursor: response.NextCursor,
	}
	for _, document := range response.Documents {
		if !validAddonDataKey(document.Key) || document.Revision < 1 || !json.Valid(document.Value) {
			return AddonDataQueryResult{}, errors.New("host returned an invalid add-on data query document")
		}
		document.Value = append(json.RawMessage(nil), document.Value...)
		result.Documents = append(result.Documents, document)
	}
	return result, nil
}

func (client *AddonDataClient) Transact(
	ctx context.Context,
	meta *Meta,
	mutations []AddonDataMutation,
) (AddonDataCommit, error) {
	if client == nil || client.caller == nil || len(mutations) < 1 || len(mutations) > 256 {
		return AddonDataCommit{}, errors.New("add-on data transaction is invalid")
	}
	wireMutations := make([]map[string]any, 0, len(mutations))
	for _, mutation := range mutations {
		if !validAddonDataReference(mutation.Reference) || !validAddonDataKey(mutation.Key) ||
			mutation.ExpectedRevision < 0 || (mutation.Operation != "put" && mutation.Operation != "delete") ||
			mutation.Operation == "delete" && mutation.Value != nil ||
			mutation.Operation == "put" && mutation.Value == nil {
			return AddonDataCommit{}, errors.New("add-on data mutation is invalid")
		}
		if mutation.Operation == "put" {
			body, err := json.Marshal(mutation.Value)
			if err != nil || string(body) == "null" {
				return AddonDataCommit{}, errors.New("add-on data put value is invalid")
			}
		}
		wire := map[string]any{
			"operation": mutation.Operation,
			"kind":      mutation.Reference.Kind, "dataId": mutation.Reference.DataID,
			"key": mutation.Key, "expectedRevision": mutation.ExpectedRevision,
		}
		if mutation.Operation == "put" {
			wire["value"] = mutation.Value
		}
		wireMutations = append(wireMutations, wire)
	}
	body, err := client.caller.Call(ctx, "host/data.transact", map[string]any{
		"contractVersion": "host-data-transaction.v1", "mutations": wireMutations,
	}, meta)
	if err != nil {
		return AddonDataCommit{}, err
	}
	var response struct {
		ContractVersion string                    `json:"contractVersion"`
		CommitID        int64                     `json:"commitId"`
		OccurredAt      time.Time                 `json:"occurredAt"`
		Results         []AddonDataMutationResult `json:"results"`
		DataSets        []AddonDataSetRevision    `json:"dataSets"`
	}
	if err := decodeAddonDataExact(body, &response); err != nil ||
		response.ContractVersion != "host-data-commit.v1" || response.CommitID < 1 ||
		response.OccurredAt.IsZero() || len(response.Results) < 1 || len(response.DataSets) < 1 {
		return AddonDataCommit{}, errors.New("host returned an invalid add-on data commit")
	}
	for _, result := range response.Results {
		if !validAddonDataReference(AddonDataReference{Kind: result.Kind, DataID: result.DataID}) ||
			!validAddonDataKey(result.Key) || result.BeforeRevision < 0 ||
			result.AfterRevision != result.BeforeRevision+1 {
			return AddonDataCommit{}, errors.New("host returned an invalid add-on data mutation result")
		}
	}
	for _, dataSet := range response.DataSets {
		if !validAddonDataReference(AddonDataReference{Kind: dataSet.Kind, DataID: dataSet.DataID}) ||
			dataSet.Revision < 1 {
			return AddonDataCommit{}, errors.New("host returned an invalid add-on data set revision")
		}
	}
	return AddonDataCommit{
		CommitID: response.CommitID, OccurredAt: response.OccurredAt,
		Results:  append([]AddonDataMutationResult(nil), response.Results...),
		DataSets: append([]AddonDataSetRevision(nil), response.DataSets...),
	}, nil
}

func DecodeAddonDataValue[T any](document AddonDataDocument) (T, error) {
	var value T
	if !json.Valid(document.Value) {
		return value, errors.New("add-on data document contains invalid JSON")
	}
	if err := json.Unmarshal(document.Value, &value); err != nil {
		return value, err
	}
	return value, nil
}

func validAddonDataReference(reference AddonDataReference) bool {
	return (reference.Kind == AddonDataCollection || reference.Kind == AddonDataRecordExtension) &&
		validAddonDataID(reference.DataID)
}

func validAddonDataID(value string) bool {
	if len(value) < 1 || len(value) > 100 || value[0] < 'a' || value[0] > 'z' {
		return false
	}
	separator := false
	for _, character := range value[1:] {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			separator = false
			continue
		}
		if (character == '.' || character == '_' || character == '-') && !separator {
			separator = true
			continue
		}
		return false
	}
	return !separator
}

func validAddonDataKey(value string) bool {
	return len(value) > 0 && len(value) <= 1_024
}

func validAddonDataCursor(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 32 {
		return false
	}
	body, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return false
	}
	position, err := strconv.ParseInt(string(body), 10, 64)
	return err == nil && position >= 0 &&
		base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(position, 10))) == value
}

func decodeAddonDataExact(body json.RawMessage, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains more than one value")
	}
	return nil
}
