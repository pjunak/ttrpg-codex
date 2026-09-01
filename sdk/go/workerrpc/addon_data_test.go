package workerrpc

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestAddonDataClientUsesVersionedWorkerHostContracts(t *testing.T) {
	t.Parallel()
	meta := &Meta{Generation: "generation", RequestID: "request", CorrelationID: "correlation"}
	calls := make([]addonDataCall, 0, 3)
	caller := addonDataCallerFunc(func(
		_ context.Context,
		method string,
		params any,
		actualMeta *Meta,
	) (json.RawMessage, error) {
		body, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		calls = append(calls, addonDataCall{method: method, body: body, meta: actualMeta})
		switch method {
		case "host/data.get":
			return json.RawMessage(`{
				"contractVersion":"host-data-document.v1","key":"n1","revision":2,
				"value":{"title":"Clue"}
			}`), nil
		case "host/data.query":
			return json.RawMessage(`{
				"contractVersion":"host-data-query-result.v1","documents":[{
					"key":"n1","revision":2,"value":{"title":"Clue"}
				}],"nextCursor":"Nw"
			}`), nil
		default:
			return json.RawMessage(`{
				"contractVersion":"host-data-commit.v1","commitId":4,
				"occurredAt":"2026-09-01T12:00:00Z","results":[{
					"kind":"collection","dataId":"notes","key":"n1",
					"beforeRevision":2,"afterRevision":3,"deleted":false
				}],"dataSets":[{"kind":"collection","dataId":"notes","revision":3}]
			}`), nil
		}
	})
	client, err := NewAddonDataClient(caller)
	if err != nil {
		t.Fatal(err)
	}
	reference := AddonDataReference{Kind: AddonDataCollection, DataID: "notes"}

	document, err := client.Get(context.Background(), meta, reference, "n1")
	if err != nil || document.Key != "n1" || document.Revision != 2 {
		t.Fatalf("document = %+v, %v", document, err)
	}
	value, err := DecodeAddonDataValue[struct {
		Title string `json:"title"`
	}](document)
	if err != nil || value.Title != "Clue" {
		t.Fatalf("decoded value = %+v, %v", value, err)
	}
	query, err := client.Query(context.Background(), meta, AddonDataQuery{
		Reference: reference, Cursor: "Nw", Limit: 10,
		Where: []AddonDataQueryCondition{{Path: "/title", Equals: "Clue"}},
	})
	if err != nil || len(query.Documents) != 1 || query.NextCursor != "Nw" {
		t.Fatalf("query = %+v, %v", query, err)
	}
	commit, err := client.Transact(context.Background(), meta, []AddonDataMutation{{
		Operation: "put", Reference: reference, Key: "n1", ExpectedRevision: 2,
		Value: map[string]any{"title": "Changed"},
	}})
	if err != nil || commit.CommitID != 4 || len(commit.Results) != 1 {
		t.Fatalf("commit = %+v, %v", commit, err)
	}

	if len(calls) != 3 || calls[0].method != "host/data.get" ||
		calls[1].method != "host/data.query" || calls[2].method != "host/data.transact" {
		t.Fatalf("calls = %+v", calls)
	}
	for _, call := range calls {
		if call.meta != meta {
			t.Fatal("request metadata was not propagated")
		}
	}
	assertAddonDataJSON(t, calls[0].body, `{
		"contractVersion":"host-data-get.v1","kind":"collection","dataId":"notes","key":"n1"
	}`)
	assertAddonDataJSON(t, calls[1].body, `{
		"contractVersion":"host-data-query.v1","kind":"collection","dataId":"notes",
		"cursor":"Nw","limit":10,"where":[{"path":"/title","equals":"Clue"}]
	}`)
}

func TestAddonDataClientRejectsInvalidLocalAndRemoteBoundaries(t *testing.T) {
	t.Parallel()
	calls := 0
	client, err := NewAddonDataClient(addonDataCallerFunc(func(
		context.Context, string, any, *Meta,
	) (json.RawMessage, error) {
		calls++
		return json.RawMessage(`{
			"contractVersion":"host-data-document.v1","key":"n1","revision":1,
			"value":{},"unexpected":true
		}`), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Get(context.Background(), nil, AddonDataReference{
		Kind: AddonDataCollection, DataID: "notes",
	}, "n1")
	if err == nil || calls != 1 {
		t.Fatalf("malformed response error = %v, calls %d", err, calls)
	}
	_, err = client.Query(context.Background(), nil, AddonDataQuery{
		Reference: AddonDataReference{Kind: AddonDataCollection, DataID: "notes"},
		Cursor:    "not+canonical", Limit: 10,
	})
	if err == nil || calls != 1 {
		t.Fatalf("invalid query error = %v, calls %d", err, calls)
	}
	_, err = client.Transact(context.Background(), nil, []AddonDataMutation{{
		Operation: "put",
		Reference: AddonDataReference{Kind: AddonDataCollection, DataID: "notes"},
		Key:       "n1", Value: nil,
	}})
	if err == nil || calls != 1 {
		t.Fatalf("nil put error = %v, calls %d", err, calls)
	}
}

func TestAddonDataClientPreservesRPCFailures(t *testing.T) {
	t.Parallel()
	want := NewRPCError(JSONRPCApplication, KindConflict, "refresh", true, nil)
	client, err := NewAddonDataClient(addonDataCallerFunc(func(
		context.Context, string, any, *Meta,
	) (json.RawMessage, error) {
		return nil, want
	}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Get(context.Background(), nil, AddonDataReference{
		Kind: AddonDataCollection, DataID: "notes",
	}, "n1")
	if !errors.Is(err, want) {
		t.Fatalf("error = %v", err)
	}
}

type addonDataCall struct {
	method string
	body   json.RawMessage
	meta   *Meta
}

type addonDataCallerFunc func(context.Context, string, any, *Meta) (json.RawMessage, error)

func (caller addonDataCallerFunc) Call(
	ctx context.Context,
	method string,
	params any,
	meta *Meta,
) (json.RawMessage, error) {
	return caller(ctx, method, params, meta)
}

func assertAddonDataJSON(t *testing.T, actual json.RawMessage, expected string) {
	t.Helper()
	var left, right any
	if err := json.Unmarshal(actual, &left); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(expected), &right); err != nil {
		t.Fatal(err)
	}
	leftBody, _ := json.Marshal(left)
	rightBody, _ := json.Marshal(right)
	if string(leftBody) != string(rightBody) {
		t.Fatalf("JSON = %s, want %s", leftBody, rightBody)
	}
}
