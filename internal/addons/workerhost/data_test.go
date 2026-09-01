package workerhost

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pjunak/ttrpg-codex/internal/addons/datacontract"
	"github.com/pjunak/ttrpg-codex/internal/addons/packageinspect"
	"github.com/pjunak/ttrpg-codex/internal/addons/workerbroker"
	"github.com/pjunak/ttrpg-codex/internal/application/addondata"
	"github.com/pjunak/ttrpg-codex/internal/storage/sqlite/addondatastore"
	"github.com/pjunak/ttrpg-codex/sdk/go/workerrpc"
)

const testGeneration = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestWorkerDataMethodsBindDeclarationGenerationAndAuthority(t *testing.T) {
	t.Parallel()
	next := int64(7)
	data := &dataStub{
		document: addondatastore.Document{
			Key: "n1", Revision: 3, Value: json.RawMessage(`{"id":"n1","title":"Clue"}`),
		},
		queryResult: addondata.QueryResult{
			Documents: []addondatastore.Document{{
				Key: "n1", Revision: 3, Value: json.RawMessage(`{"id":"n1","title":"Clue"}`),
			}},
			NextPosition: &next,
		},
		commit: addondatastore.Commit{
			ID: 11, OccurredAt: time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC),
			Results: []addondatastore.MutationResult{{
				Kind: datacontract.Collection, DataID: "notes", Key: "n1",
				BeforeRevision: 3, AfterRevision: 4,
			}},
			DataRevisions: map[string]int64{"collection\x00notes": 5},
		},
	}
	dispatcher := testDispatcher(t, data, "system")

	result := call(t, dispatcher, "host/data.get", `{
		"contractVersion":"host-data-get.v1","kind":"collection","dataId":"notes","key":"n1"
	}`)
	assertJSONEqual(t, result, `{
		"contractVersion":"host-data-document.v1","key":"n1","revision":3,
		"value":{"id":"n1","title":"Clue"}
	}`)
	if data.access.AddonID != "dm-tools" || data.access.Generation != testGeneration ||
		data.access.Role != addondata.RoleSystem || data.access.ActorID != "worker:dm-tools:job-1" {
		t.Fatalf("data access = %+v", data.access)
	}

	result = call(t, dispatcher, "host/data.query", `{
		"contractVersion":"host-data-query.v1","kind":"record-extension","dataId":"sheet",
		"cursor":"Nw","limit":10,"where":[]
	}`)
	assertJSONEqual(t, result, `{
		"contractVersion":"host-data-query-result.v1","documents":[{
			"key":"n1","revision":3,"value":{"id":"n1","title":"Clue"}
		}],"nextCursor":"Nw"
	}`)
	if data.query.AfterPosition != 7 || data.query.DataKind != datacontract.RecordExtension ||
		data.query.DataID != "sheet" {
		t.Fatalf("query = %+v", data.query)
	}

	result = call(t, dispatcher, "host/data.transact", `{
		"contractVersion":"host-data-transaction.v1","mutations":[{
			"operation":"put","kind":"collection","dataId":"notes","key":"n1",
			"expectedRevision":3,"value":{"id":"n1","title":"Changed"}
		}]
	}`)
	assertJSONEqual(t, result, `{
		"contractVersion":"host-data-commit.v1","commitId":11,
		"occurredAt":"2026-09-01T12:00:00Z","results":[{
			"kind":"collection","dataId":"notes","key":"n1",
			"beforeRevision":3,"afterRevision":4,"deleted":false
		}],"dataSets":[{"kind":"collection","dataId":"notes","revision":5}]
	}`)
	if len(data.transaction.Mutations) != 1 ||
		string(data.transaction.Mutations[0].Value) != `{"id":"n1","title":"Changed"}` {
		t.Fatalf("transaction = %+v", data.transaction)
	}
}

func TestWorkerDataMethodsFailClosedBeforeApplicationAccess(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		method string
		body   string
		kind   string
	}{
		{
			name: "undeclared collection", method: "host/data.get", kind: workerrpc.KindUnauthorized,
			body: `{"contractVersion":"host-data-get.v1","kind":"collection","dataId":"foreign","key":"n1"}`,
		},
		{
			name: "unknown field", method: "host/data.get", kind: workerrpc.KindValidationFailed,
			body: `{"contractVersion":"host-data-get.v1","kind":"collection","dataId":"notes","key":"n1","extra":true}`,
		},
		{
			name: "undeclared transaction member", method: "host/data.transact", kind: workerrpc.KindUnauthorized,
			body: `{"contractVersion":"host-data-transaction.v1","mutations":[{"operation":"delete","kind":"record-extension","dataId":"foreign","key":"n1","expectedRevision":1}]}`,
		},
		{
			name: "delete carries value", method: "host/data.transact", kind: workerrpc.KindValidationFailed,
			body: `{"contractVersion":"host-data-transaction.v1","mutations":[{"operation":"delete","kind":"collection","dataId":"notes","key":"n1","expectedRevision":1,"value":{}}]}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			data := &dataStub{}
			dispatcher := testDispatcher(t, data, "system")
			_, err := dispatcher.HandleRPC(context.Background(), rpcRequest(test.method, test.body))
			assertRPCError(t, err, test.kind)
			if data.calls != 0 {
				t.Fatalf("application calls = %d", data.calls)
			}
		})
	}
}

func TestWorkerDataMethodsMapSafeApplicationFailures(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name string
		err  error
		kind string
	}{
		{"stale generation", addondata.ErrInactiveGeneration, workerrpc.KindStaleBinding},
		{"role denied", addondata.ErrUnauthorized, workerrpc.KindUnauthorized},
		{"missing document", addondatastore.ErrNotFound, workerrpc.KindNotFound},
		{"write conflict", addondatastore.ErrConflict, workerrpc.KindConflict},
		{"schema failure", datacontract.ErrInvalidDocument, workerrpc.KindValidationFailed},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			dispatcher := testDispatcher(t, &dataStub{err: test.err}, "dm")
			_, err := dispatcher.HandleRPC(context.Background(), rpcRequest("host/data.get", `{
				"contractVersion":"host-data-get.v1","kind":"collection","dataId":"notes","key":"n1"
			}`))
			assertRPCError(t, err, test.kind)
		})
	}
}

type dataStub struct {
	calls       int
	access      addondata.Access
	document    addondatastore.Document
	query       addondata.Query
	queryResult addondata.QueryResult
	transaction addondata.Transaction
	commit      addondatastore.Commit
	err         error
}

func (stub *dataStub) Get(
	_ context.Context,
	access addondata.Access,
	_ datacontract.Kind,
	_, _ string,
) (addondatastore.Document, error) {
	stub.calls++
	stub.access = access
	return stub.document, stub.err
}

func (stub *dataStub) Query(_ context.Context, query addondata.Query) (addondata.QueryResult, error) {
	stub.calls++
	stub.access = query.Access
	stub.query = query
	return stub.queryResult, stub.err
}

func (stub *dataStub) Transact(
	_ context.Context,
	transaction addondata.Transaction,
) (addondatastore.Commit, error) {
	stub.calls++
	stub.access = transaction.Access
	stub.transaction = transaction
	return stub.commit, stub.err
}

func testDispatcher(t *testing.T, data Data, role string) *workerbroker.Dispatcher {
	t.Helper()
	dispatcher, err := New(Config{
		AddonID: "dm-tools", Generation: testGeneration, Data: data,
		Manifest: packageinspect.Manifest{
			ID:               "dm-tools",
			Collections:      []packageinspect.Collection{{ID: "notes"}},
			RecordExtensions: []packageinspect.RecordExtension{{ID: "sheet", Target: "characters"}},
		},
		ContextResolver: workerbroker.ContextResolverFunc(func(
			_ context.Context,
			request workerbroker.ContextRequest,
		) (workerbroker.Authority, error) {
			if request.AddonID != "dm-tools" || request.Generation != testGeneration {
				return workerbroker.Authority{}, errors.New("wrong generation")
			}
			return workerbroker.Authority{
				RequestID: "verified", CorrelationID: "correlation",
				Deadline: time.Now().Add(time.Minute),
				Actor:    workerrpc.Actor{Role: role, ID: "job-1"},
			}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	return dispatcher
}

func call(t *testing.T, dispatcher *workerbroker.Dispatcher, method, params string) json.RawMessage {
	t.Helper()
	result, err := dispatcher.HandleRPC(context.Background(), rpcRequest(method, params))
	if err != nil {
		t.Fatal(err)
	}
	body, ok := result.(json.RawMessage)
	if !ok {
		t.Fatalf("response type = %T", result)
	}
	return body
}

func rpcRequest(method, params string) workerrpc.Request {
	return workerrpc.Request{
		ID: json.RawMessage(`"worker-1"`), Method: method, Params: json.RawMessage(params),
		Meta: &workerrpc.Meta{
			RequestID: "wire", CorrelationID: "correlation", Generation: testGeneration,
			Deadline: time.Now().Add(time.Minute),
		},
	}
}

func assertRPCError(t *testing.T, err error, kind string) {
	t.Helper()
	var failure *workerrpc.RPCError
	if !errors.As(err, &failure) || failure.Data == nil || failure.Data.Kind != kind {
		t.Fatalf("error = %T %v, want %s", err, err, kind)
	}
}

func assertJSONEqual(t *testing.T, actual json.RawMessage, expected string) {
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
